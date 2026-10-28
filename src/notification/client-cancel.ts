/**
 * 取消宿主侧（Web / 桌面）已弹出的通知卡片（fork 新增）
 *
 * 通知提问/审批会同时推给 QQ 和宿主 UI；QQ 先答时，宿主侧那张问题卡片 /
 * 审批提示不会自己消失（宿主不知道答案已经来自 QQ）。这里通过宿主
 * `typertGateway` 的待投递事件表做 best-effort 取消：匹配 `source.event` 与
 * 请求对象，调用 `cancelRemoteEvent`，让客户端移除卡片。这与本地 dsh-qqbot
 * 插件的 cancelWeb 行为一致。
 *
 * 私有 API 使用集中在本文件：`pendingRemoteEvents` 是内部 Map，取不到或结构
 * 变化时静默降级（只按固定节奏重试有限次——宿主侧 pending 的登记可能晚于
 * 作答，需要重试几次才能命中）。
 */
import type { NotificationContextLike } from './types.ts';

/** 重试节奏（ms）：宿主侧 pending 可能晚于作答登记，前几次也可能还没登记完 */
const RETRY_DELAYS_MS = [0, 100, 300, 600, 1000, 1500, 2500, 4000, 6000, 9000];

interface PendingRemoteEventLike {
  source?: { event?: unknown; request?: unknown };
}

interface TypertGatewayLike {
  pendingRemoteEvents?: unknown;
  cancelRemoteEvent?: (pending: unknown, error: Error) => unknown;
}

/**
 * 请求匹配：对象同一性优先；宿主投影后可能是同形副本，再按 questions/agent
 * 等关键字段兜底比较（只用于「同一张卡片」判定，不做语义匹配）。
 */
function matchesRequest(candidate: unknown, request: unknown): boolean {
  if (candidate === request) return true;
  if (candidate === null || request === null) return false;
  if (typeof candidate !== 'object' || typeof request !== 'object') return false;
  const a = candidate as { questions?: unknown; agent?: { id?: unknown } };
  const b = request as { questions?: unknown; agent?: { id?: unknown } };
  if (a.questions !== undefined && a.questions === b.questions) return true;
  return a.agent?.id !== undefined && a.agent?.id === b.agent?.id;
}

export interface CancelPendingClientEventOptions {
  /** 重试定时器集合（由调用方持有并在 dispose 时清理） */
  timers?: Set<ReturnType<typeof setTimeout>>;
  /** 日志/错误文案里的标签（question / approval） */
  label?: string;
}

/**
 * 尝试取消宿主侧对应的待投递事件（即关闭客户端上的问题卡片/审批提示）。
 * 找不到或私有 API 不可用时静默放弃，不抛出、不阻塞。
 */
export function cancelPendingClientEvent(
  ctx: NotificationContextLike,
  eventName: string,
  request: unknown,
  options: CancelPendingClientEventOptions = {},
): void {
  const timers = options.timers;
  const label = options.label ?? eventName;

  const attempt = (index: number): void => {
    let candidates: PendingRemoteEventLike[] | undefined;
    try {
      const gateway = ctx.get('typertGateway') as TypertGatewayLike | undefined;
      if (gateway?.pendingRemoteEvents instanceof Map) {
        candidates = [...(gateway.pendingRemoteEvents.values() as Iterable<PendingRemoteEventLike>)];
      }
    } catch {
      candidates = undefined;
    }

    if (candidates !== undefined) {
      for (const pending of candidates) {
        const source = pending?.source;
        if (source?.event !== eventName) continue;
        if (!matchesRequest(source?.request, request)) continue;
        try {
          const gateway = ctx.get('typertGateway') as TypertGatewayLike | undefined;
          gateway?.cancelRemoteEvent?.(pending, new Error(`im-qqbot: ${label} answered via QQ`));
        } catch {
          // 一张陈旧的 pending 取消失败不应阻塞作答
        }
        return;
      }
    }

    if (index >= RETRY_DELAYS_MS.length - 1) return;
    const delay = RETRY_DELAYS_MS[index] ?? 1000;
    const timer = setTimeout(() => {
      timers?.delete(timer);
      attempt(index + 1);
    }, delay);
    timer.unref?.();
    timers?.add(timer);
  };

  attempt(0);
}
