/**
 * QuestionChannel HMR 自愈测试
 *
 * 回归点：userQuestions 是进程级服务，旧 fiber 的补丁若在 fiber 卸载后残留，
 * 新 fiber 不能因为 `__qqQuestionPatched` 标记就跳过安装——否则 QQ 会话里的
 * ask_user_question 会落到旧 fiber 的死闭包上，问题永远送不到 QQ。
 */
import { describe, expect, it, vi } from 'vitest';
import { QuestionChannel } from './question-channel.ts';
import type { QuestionChannelManagerLike } from './question-channel.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 宿主 userQuestions 服务替身：真实 ask 定义在原型上（与宿主实现一致） */
class HostQuestions {
  public hostCalls: unknown[] = [];
  public async ask(request: unknown): Promise<{ answers: never[] }> {
    this.hostCalls.push(request);
    return { answers: [] };
  }
}

interface TestRecord {
  sessionKey: string;
  scope: 'c2c' | 'group';
  replyTarget: { scope: 'c2c' | 'group'; targetId: string; msgId?: string };
}

function makeManager(qqSessionId: string): QuestionChannelManagerLike {
  const record: TestRecord = {
    sessionKey: 'qqbot:app:c2c:u1',
    scope: 'c2c',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'msg-1' },
  };
  return {
    findBySessionId: (id: string) => (id === qqSessionId ? record : undefined),
    getSessionRecord: () => record,
  };
}

function makeChannel(qqSessionId = 'qq-session') {
  const sender = { sendMarkdown: vi.fn(async () => ({})) };
  const channel = new QuestionChannel(
    makeManager(qqSessionId),
    sender,
    { requireMention: true, askTimeoutMs: 1000 },
    logger,
  );
  return { channel, sender };
}

function makeCtx(svc: HostQuestions): {
  get(name: string): unknown;
  effect: (fn: () => () => void, name?: string) => unknown;
  cleanups: Array<() => void>;
} {
  const cleanups: Array<() => void> = [];
  return {
    get: (name: string) => (name === 'userQuestions' ? svc : undefined),
    effect: (fn: () => () => void) => {
      cleanups.push(fn());
      return () => undefined;
    },
    cleanups,
  };
}

function question(id = 'q1') {
  return { id, question: '选一个', options: [{ label: '甲' }, { label: '乙' }] };
}

describe('QuestionChannel HMR 自愈', () => {
  it('旧 fiber 遗留补丁（只有标记、没有保存原始 ask）时，新安装会从原型恢复并接管', async () => {
    const svc = new HostQuestions();
    const stale = vi.fn(async () => ({ answers: [] }));
    // 模拟 ≤0.6.3 的旧 fiber：实例属性被覆盖 + 打了标记，但没保存原始实现
    (svc as unknown as { ask: unknown }).ask = stale;
    (svc as unknown as { __qqQuestionPatched?: boolean }).__qqQuestionPatched = true;

    const { channel, sender } = makeChannel();
    const ctx = makeCtx(svc);
    channel.install(ctx);

    // 宿主会话：应调用原型上的真实实现，而不是旧 fiber 的死闭包
    const hostResult = await svc.ask({ agent: { id: 'web-session' }, questions: [question()] });
    expect(hostResult).toEqual({ answers: [] });
    expect(svc.hostCalls).toHaveLength(1);
    expect(stale).not.toHaveBeenCalled();

    // QQ 会话：应路由到新通道（发出问题卡片）
    const pending = svc.ask({ agent: { id: 'qq-session' }, questions: [question()] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sender.sendMarkdown).toHaveBeenCalledTimes(1);
    channel.uninstall();
    await expect(pending).rejects.toThrow(/unloaded/);
  });

  it('服务上已保存原始 ask 时优先用它（不依赖原型）', async () => {
    const svc = new HostQuestions();
    const stored = vi.fn(async () => ({ answers: [] }));
    (svc as unknown as { ask: unknown }).ask = vi.fn(async () => ({ answers: [] }));
    (svc as unknown as { __qqQuestionPatched?: boolean }).__qqQuestionPatched = true;
    (svc as unknown as { __qqQuestionOriginalAsk?: unknown }).__qqQuestionOriginalAsk = stored;

    const { channel } = makeChannel();
    channel.install(makeCtx(svc));

    await svc.ask({ agent: { id: 'web-session' }, questions: [question()] });
    expect(stored).toHaveBeenCalledTimes(1);
    channel.uninstall();
  });

  it('fiber 清理时还原宿主原始 ask 并清除标记', async () => {
    const svc = new HostQuestions();
    const { channel } = makeChannel();
    const ctx = makeCtx(svc);
    channel.install(ctx);
    expect((svc as unknown as { __qqQuestionPatched?: boolean }).__qqQuestionPatched).toBe(true);

    for (const cleanup of ctx.cleanups) cleanup();

    expect((svc as unknown as { __qqQuestionPatched?: boolean }).__qqQuestionPatched).toBeUndefined();
    // 还原后宿主会话直接走原型实现
    await svc.ask({ agent: { id: 'web-session' }, questions: [question()] });
    expect(svc.hostCalls).toHaveLength(1);
  });

  it('旧实例卸载不会覆盖新实例的补丁', async () => {
    const svc = new HostQuestions();
    const first = makeChannel();
    const ctx = makeCtx(svc);
    first.channel.install(ctx);

    const second = makeChannel();
    second.channel.install(makeCtx(svc));

    // 旧实例卸载：新 fiber 已接管，补丁必须保持
    first.channel.uninstall();
    expect((svc as unknown as { __qqQuestionPatched?: boolean }).__qqQuestionPatched).toBe(true);
    expect((svc as unknown as { __qqQuestionOwner?: unknown }).__qqQuestionOwner).toBe(second.channel);

    second.channel.uninstall();
    expect((svc as unknown as { __qqQuestionPatched?: boolean }).__qqQuestionPatched).toBeUndefined();
    await svc.ask({ agent: { id: 'web-session' }, questions: [question()] });
    expect(svc.hostCalls).toHaveLength(1);
  });
});
