/**
 * NotificationChannel 行为测试（fork 新增）
 *
 * 覆盖：任务完成推送（含 QQ 会话跳过 / 冷却 / 根会话过滤）、提问推送与
 * QQ 作答（宿主竞速 / 无目标透传 / 无效选择重答 / 多选）、审批推送与
 * 文本/按钮决策（QQ 会话放行）、按钮发送失败降级纯文本。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import { describe, expect, it, vi } from 'vitest';
import { NotificationChannel } from './notification-channel.ts';
import { NotificationTargetStore } from './target-store.ts';
import type {
  ApprovalOutcome,
  NotificationAskResult,
  NotificationContextLike,
  NotificationManagerLike,
  NotificationSenderLike,
  UserQuestionsLike,
} from './types.ts';
import type { ImQQBotConfig, NotificationsConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const baseNotifications: NotificationsConfig = {
  enabled: true,
  target: { kind: 'c2c', id: 'owner' },
  learnFromChats: true,
  onDone: { enabled: true, previewChars: 0, header: '## ✅ DSH 任务完成' },
  onQuestion: { enabled: true, questionChars: 120, optionChars: 60 },
  onApproval: { enabled: true, commandChars: 500 },
  cooldownMs: 0,
};

function makeConfig(notifications: Partial<NotificationsConfig> = {}): ImQQBotConfig {
  const config: ImQQBotConfig = {
    appId: 'app-id',
    appSecret: 'app-secret',
    requireMention: true,
    textChunkLimit: 4500,
    streaming: true,
    sessionIdleTimeout: 30 * 60 * 1000,
    maxQueue: 20,
    processingTimeoutMs: 30 * 60 * 1000,
    askTimeoutMs: 5 * 60 * 1000,
    historyLimit: 10,
    access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
    showToolResults: false,
    debug: false,
    media: { enabled: true, maxMB: 200, ttlHours: 24 },
    vision: {
      enabled: false,
      provider: '',
      model: '',
      defaultPrompt: 'Describe this image in detail.',
      maxBytes: 10 * 1024 * 1024,
      maxTokens: 1024,
      timeoutMs: 120000,
    },
    sendFile: { restrictPaths: true, extraRoots: [], sendPresentedFiles: true, maxFiles: 4 },
    notifications: { ...baseNotifications, ...notifications },
  };
  return config;
}

/** QQ 侧发送器替身：记录所有推送，可模拟「主动消息带按钮被拒」 */
class FakeSender implements NotificationSenderLike {
  public readonly sends: Array<{ target: ReplyTarget; content: string; keyboard?: InlineKeyboard }> = [];
  public failKeyboard = false;

  public async sendMarkdown(
    target: ReplyTarget,
    content: string,
    opts?: { keyboard?: InlineKeyboard },
  ): Promise<unknown> {
    if (opts?.keyboard && this.failKeyboard) throw new Error('keyboard not allowed on proactive message');
    this.sends.push({ target, content, ...(opts?.keyboard ? { keyboard: opts.keyboard } : {}) });
    return {};
  }
}

/** 事件上下文替身：捕获 ctx.on 注册的 handler 供测试直接触发 */
class MockContext implements NotificationContextLike {
  public readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  private readonly services: Record<string, unknown>;

  public constructor(services: Record<string, unknown> = {}) {
    this.services = services;
  }

  public on(event: string, handler: (...args: unknown[]) => unknown): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => undefined;
  }

  public effect(fn: () => (() => void) | void): unknown {
    return fn();
  }

  public get(name: string): unknown {
    return this.services[name];
  }

  /** 测试用：模拟服务晚挂载（internal/service 事件由测试显式触发） */
  public setService(name: string, value: unknown): void {
    this.services[name] = value;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) void handler(...args);
  }

  public firstHandler(event: string): (...args: unknown[]) => unknown {
    const handler = this.handlers.get(event)?.[0];
    if (!handler) throw new Error(`no handler registered for ${event}`);
    return handler;
  }
}

function makeManager(qqSessionIds: string[] = []): NotificationManagerLike {
  return {
    findBySessionId: (sessionId: string) => (qqSessionIds.includes(sessionId) ? { sessionKey: `qq:${sessionId}` } : undefined),
  };
}

function makeChannel(options: {
  config?: ImQQBotConfig;
  qqSessions?: string[];
  services?: Record<string, unknown>;
  agents?: { roots?(): ReadonlyArray<{ session?: { id?: string } }> };
} = {}) {
  const config = options.config ?? makeConfig();
  const sender = new FakeSender();
  const store = new NotificationTargetStore(config.notifications, logger, {
    stateFile: join(tmpdir(), `dsh-qqbot-notify-${Math.random().toString(16).slice(2)}.json`),
  });
  const channel = new NotificationChannel({
    manager: makeManager(options.qqSessions),
    sender,
    config,
    logger,
    store,
    ...(options.agents ? { agents: options.agents } : {}),
  });
  const ctx = new MockContext(options.services);
  channel.install(ctx);
  return { config, sender, store, channel, ctx };
}

/** 等一轮微任务 + 定时器，让 fire-and-forget 的推送落地 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function assistantEvent(turn: number, text: string) {
  return { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } };
}

function turnEndEvent(turn: number, kind = 'completed') {
  return { type: 'turn/end', data: { turn, reason: { kind } } };
}

describe('任务完成推送', () => {
  it('turn/end completed 时把最终文本带页眉推到配置目标', async () => {
    const { sender, ctx } = makeChannel();
    ctx.emit('session/event', { header: { id: 'web-1' } }, assistantEvent(1, '已完成构建'));
    ctx.emit('session/event', { header: { id: 'web-1' } }, turnEndEvent(1));
    await settle();
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.target).toEqual({ scope: 'c2c', targetId: 'owner' });
    expect(sender.sends[0]?.content).toBe('## ✅ DSH 任务完成\n已完成构建');
  });

  it('QQ 会话自身的轮次不重复推送', async () => {
    const { sender, ctx } = makeChannel({ qqSessions: ['qq-1'] });
    ctx.emit('session/event', { header: { id: 'qq-1' } }, assistantEvent(1, 'QQ 回复'));
    ctx.emit('session/event', { header: { id: 'qq-1' } }, turnEndEvent(1));
    await settle();
    expect(sender.sends).toHaveLength(0);
  });

  it('cooldownMs 抑制连续推送', async () => {
    const { sender, ctx } = makeChannel({ config: makeConfig({ cooldownMs: 60_000 }) });
    ctx.emit('session/event', { header: { id: 'web-1' } }, assistantEvent(1, '第一次'));
    ctx.emit('session/event', { header: { id: 'web-1' } }, turnEndEvent(1));
    ctx.emit('session/event', { header: { id: 'web-1' } }, assistantEvent(2, '第二次'));
    ctx.emit('session/event', { header: { id: 'web-1' } }, turnEndEvent(2));
    await settle();
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.content).toContain('第一次');
  });

  it('非根会话不推送（子 agent 轮次）', async () => {
    const { sender, ctx } = makeChannel({ agents: { roots: () => [{ session: { id: 'web-root' } }] } });
    ctx.emit('session/event', { header: { id: 'sub-1' } }, assistantEvent(1, '子 agent 输出'));
    ctx.emit('session/event', { header: { id: 'sub-1' } }, turnEndEvent(1));
    ctx.emit('session/event', { header: { id: 'web-root' } }, assistantEvent(1, '主 agent 输出'));
    ctx.emit('session/event', { header: { id: 'web-root' } }, turnEndEvent(1));
    await settle();
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.content).toContain('主 agent 输出');
  });

  it('未完成（error）的轮次不推送', async () => {
    const { sender, ctx } = makeChannel();
    ctx.emit('session/event', { header: { id: 'web-1' } }, assistantEvent(1, 'partial'));
    ctx.emit('session/event', { header: { id: 'web-1' } }, turnEndEvent(1, 'error'));
    await settle();
    expect(sender.sends).toHaveLength(0);
  });
});

describe('提问推送与 QQ 作答', () => {
  it('非 QQ 会话的提问推到 QQ，QQ 回复编号完成作答', async () => {
    const hostAsk = (): Promise<NotificationAskResult> => new Promise(() => undefined);
    const uq: UserQuestionsLike = { ask: hostAsk };
    const { sender, channel } = makeChannel({ services: { userQuestions: uq } });

    const pending = uq.ask({
      agent: { id: 'web-2' },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }],
    });
    await settle();
    expect(sender.sends[0]?.content).toContain('❓ DSH 需要你回答');
    expect(sender.sends[0]?.content).toContain('1. 甲');

    expect(channel.tryAnswer('c2c', 'owner', '2')).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['乙'] }] });
    await settle();
    expect(sender.sends.some((send) => send.content.startsWith('✅ 已收到回答：乙'))).toBe(true);
  });

  it('宿主先答则采用宿主答案，QQ 不再消费后续消息', async () => {
    const uq: UserQuestionsLike = {
      ask: async (request) => ({
        answers: request.questions.map((question) => ({ id: question.id, selected: [question.options?.[0]?.label ?? ''] })),
      }),
    };
    const { sender, channel } = makeChannel({ services: { userQuestions: uq } });
    const result = await uq.ask({
      agent: { id: 'web-3' },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }] }],
    });
    expect(result.answers[0]?.selected).toEqual(['甲']);
    await settle();
    expect(channel.tryAnswer('c2c', 'owner', '1')).toBe(false);
    expect(sender.sends.some((send) => send.content.startsWith('✅'))).toBe(false);
  });

  it('没有 QQ 目标时直接透传宿主回答者', async () => {
    const uq: UserQuestionsLike = {
      ask: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: [] })) }),
    };
    const { sender } = makeChannel({
      config: makeConfig({ target: { kind: 'c2c', id: '' }, learnFromChats: false }),
      services: { userQuestions: uq },
    });
    await uq.ask({ agent: { id: 'web-4' }, questions: [{ id: 'q1', question: '随便问' }] });
    await settle();
    expect(sender.sends).toHaveLength(0);
  });

  it('无效选项提示重答，仍可继续作答', async () => {
    const uq: UserQuestionsLike = { ask: () => new Promise(() => undefined) };
    const { sender, channel } = makeChannel({ services: { userQuestions: uq } });
    const pending = uq.ask({
      agent: { id: 'web-5' },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }],
    });
    await settle();
    expect(channel.tryAnswer('c2c', 'owner', '9')).toBe(true);
    await settle();
    expect(sender.sends.some((send) => send.content.includes('无效选择'))).toBe(true);
    expect(channel.tryAnswer('c2c', 'owner', '1')).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['甲'] }] });
  });

  it('多选题用逗号分隔编号作答', async () => {
    const uq: UserQuestionsLike = { ask: () => new Promise(() => undefined) };
    const { channel } = makeChannel({ services: { userQuestions: uq } });
    const pending = uq.ask({
      agent: { id: 'web-6' },
      questions: [
        {
          id: 'q1',
          question: '选要跑的检查',
          multiSelect: true,
          options: [{ label: '类型检查' }, { label: '单测' }, { label: 'Lint' }],
        },
      ],
    });
    await settle();
    expect(channel.tryAnswer('c2c', 'owner', '1,3')).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['类型检查', 'Lint'] }] });
  });

  it('按钮点击也能作答，且按钮发送失败时降级纯文本', async () => {
    const uq: UserQuestionsLike = { ask: () => new Promise(() => undefined) };
    const { sender, channel } = makeChannel({ services: { userQuestions: uq } });
    sender.failKeyboard = true;
    const pending = uq.ask({
      agent: { id: 'web-7' },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }],
    });
    await settle();
    expect(sender.sends[0]?.keyboard).toBeUndefined();
    expect(sender.sends[0]?.content).toContain('❓ DSH 需要你回答');

    const handled = channel.handleInteraction({
      scene: 'c2c',
      user_openid: 'owner',
      data: { resolved: { button_data: JSON.stringify({ t: 'question', q: 'q1', i: 1 }) } },
    });
    expect(handled).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['乙'] }] });
  });

  it('userQuestions 晚挂载时通过 internal/service 补装回答者', async () => {    const { sender, channel, ctx } = makeChannel();
    const uq: UserQuestionsLike = { ask: () => new Promise<NotificationAskResult>(() => undefined) };
    ctx.setService('userQuestions', uq);
    ctx.emit('internal/service', 'userQuestions', uq);

    const pending = uq.ask({
      agent: { id: 'web-late' },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }] }],
    });
    await settle();
    expect(sender.sends[0]?.content).toContain('❓ DSH 需要你回答');
    expect(channel.tryAnswer('c2c', 'owner', '1')).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['甲'] }] });
  });

  it('QQ 先答时取消宿主侧已弹出的问题卡片（typertGateway）', async () => {
    const uq: UserQuestionsLike = { ask: () => new Promise<NotificationAskResult>(() => undefined) };
    const pendingRemoteEvents = new Map<string, { source?: { event?: unknown; request?: unknown } }>();
    const cancelRemoteEvent = vi.fn();
    const { channel } = makeChannel({
      services: {
        userQuestions: uq,
        typertGateway: { pendingRemoteEvents, cancelRemoteEvent },
      },
    });

    const request = {
      agent: { id: 'web-cancel' },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }],
    };
    const pending = uq.ask(request);
    await settle();
    pendingRemoteEvents.set('e1', { source: { event: 'user-questions/request', request } });

    expect(channel.tryAnswer('c2c', 'owner', '1')).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['甲'] }] });
    expect(cancelRemoteEvent).toHaveBeenCalledTimes(1);
    expect(pendingRemoteEvents.get('e1')).toBe(cancelRemoteEvent.mock.calls[0]?.[0]);
  });
});

describe('审批推送与决策', () => {
  it('宿主无审批通道时推 QQ，回复「允许」得到 allowed-once', async () => {
    const { sender, channel, ctx } = makeChannel();
    const handler = ctx.firstHandler('approval/request');
    const outcome = handler(
      { agent: { id: 'web-8' }, toolName: 'bash', callId: 'call-1', reason: '需要执行构建' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    ) as Promise<ApprovalOutcome>;
    await settle();
    expect(sender.sends[0]?.content).toContain('🔐 **执行审批**');
    expect(sender.sends[0]?.content).toContain('工具: bash');

    expect(channel.tryAnswer('c2c', 'owner', '允许')).toBe(true);
    await expect(outcome).resolves.toBe('allowed-once');
  });

  it('点击「拒绝」按钮得到 rejected', async () => {
    const { channel, ctx } = makeChannel();
    const handler = ctx.firstHandler('approval/request');
    const outcome = handler(
      { agent: { id: 'web-9' }, toolName: 'bash' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    ) as Promise<ApprovalOutcome>;
    await settle();
    const handled = channel.handleInteraction({
      scene: 'c2c',
      user_openid: 'owner',
      data: { resolved: { button_data: JSON.stringify({ t: 'approval', d: 'deny' }) } },
    });
    expect(handled).toBe(true);
    await expect(outcome).resolves.toBe('rejected');
  });

  it('QQ 会话的审批直接放行给宿主处理，不重复推送', async () => {
    const { sender, ctx } = makeChannel({ qqSessions: ['qq-9'] });
    const handler = ctx.firstHandler('approval/request');
    const outcome = await (handler(
      { agent: { id: 'qq-9' }, toolName: 'bash' },
      () => Promise.resolve<ApprovalOutcome>('allowed-once'),
    ) as Promise<ApprovalOutcome>);
    expect(outcome).toBe('allowed-once');
    expect(sender.sends).toHaveLength(0);
  });
});
