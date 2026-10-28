/**
 * 取消宿主侧通知卡片（cancelPendingClientEvent）测试
 *
 * 覆盖：命中 pending 时调用 cancelRemoteEvent、宿主 pending 晚登记时按重试节奏
 * 命中、事件名不匹配/无 typertGateway 时静默降级、定时器句柄可清理。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingClientEvent } from './client-cancel.ts';
import type { NotificationContextLike } from './types.ts';

interface PendingLike {
  source?: { event?: unknown; request?: unknown };
}

function makeCtx(pending: Map<string, PendingLike> | undefined, cancelRemoteEvent = vi.fn()): {
  ctx: NotificationContextLike;
  cancelRemoteEvent: ReturnType<typeof vi.fn>;
} {
  const services: Record<string, unknown> = {};
  if (pending !== undefined) {
    services.typertGateway = { pendingRemoteEvents: pending, cancelRemoteEvent };
  }
  const ctx = {
    on: () => () => undefined,
    effect: () => () => undefined,
    get: (name: string) => services[name],
  } as unknown as NotificationContextLike;
  return { ctx, cancelRemoteEvent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cancelPendingClientEvent', () => {
  it('命中同一请求的 pending 时调用 cancelRemoteEvent', () => {
    const request = { questions: [{ id: 'q1' }] };
    const pending = new Map<string, PendingLike>([
      ['e1', { source: { event: 'user-questions/request', request } }],
    ]);
    const { ctx, cancelRemoteEvent } = makeCtx(pending);
    cancelPendingClientEvent(ctx, 'user-questions/request', request, { label: 'question' });
    expect(cancelRemoteEvent).toHaveBeenCalledTimes(1);
    const [target, error] = cancelRemoteEvent.mock.calls[0] as [unknown, Error];
    expect(target).toBe(pending.get('e1'));
    expect(error.message).toContain('answered via QQ');
  });

  it('宿主投影后的同形副本按 questions 同一性命中', () => {
    const questions = [{ id: 'q1' }];
    const request = { questions };
    const pending = new Map<string, PendingLike>([
      ['e1', { source: { event: 'user-questions/request', request: { questions } } }],
    ]);
    const { ctx, cancelRemoteEvent } = makeCtx(pending);
    cancelPendingClientEvent(ctx, 'user-questions/request', request);
    expect(cancelRemoteEvent).toHaveBeenCalledTimes(1);
  });

  it('事件名不匹配时不取消', () => {
    const request = { questions: [{ id: 'q1' }] };
    const pending = new Map<string, PendingLike>([
      ['e1', { source: { event: 'approval/request', request } }],
    ]);
    const { ctx, cancelRemoteEvent } = makeCtx(pending);
    cancelPendingClientEvent(ctx, 'user-questions/request', request);
    expect(cancelRemoteEvent).not.toHaveBeenCalled();
  });

  it('没有 typertGateway 时静默降级，不抛错', () => {
    const { ctx } = makeCtx(undefined);
    expect(() => cancelPendingClientEvent(ctx, 'user-questions/request', { questions: [] })).not.toThrow();
  });

  it('宿主 pending 晚登记时按重试节奏命中，且定时器句柄可清理', () => {
    vi.useFakeTimers();
    const request = { questions: [{ id: 'q1' }] };
    const pending = new Map<string, PendingLike>();
    const { ctx, cancelRemoteEvent } = makeCtx(pending);
    const timers = new Set<ReturnType<typeof setTimeout>>();

    cancelPendingClientEvent(ctx, 'user-questions/request', request, { timers });
    expect(timers.size).toBe(1);

    pending.set('e1', { source: { event: 'user-questions/request', request } });
    vi.advanceTimersByTime(0);
    expect(cancelRemoteEvent).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);
  });
});
