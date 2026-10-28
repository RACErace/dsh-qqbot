/**
 * 通知推送（fork 新增）— 结构化最小契约
 *
 * 通知推送把「非 QQ 会话」里发生的 dsh 事件推到 QQ：
 *   - 任务完成（turn/end completed）→ 推送最终回复文本
 *   - ask_user_question → 推送问题卡片，用户在 QQ 直接回复作答
 *   - approval/request → 推送审批卡片，用户在 QQ 回复「允许/拒绝」或点按钮
 *
 * 这些契约与宿主真实类型对齐但不硬依赖（结构化类型），
 * 便于单测替身，也避免把 dsh 内部类型带进插件发布物。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { ChatScope, ReplyTarget } from '../types.ts';

/** 推送目标：c2c 私聊 / group 群聊（id 为对应 openid） */
export interface NotificationTarget {
  kind: ChatScope;
  id: string;
}

// ── ask_user_question 最小契约（对齐 dsh-user-questions） ──

export interface NotificationQuestionOption {
  label: string;
  description?: string;
}

export interface NotificationQuestion {
  id: string;
  header?: string;
  question: string;
  options?: NotificationQuestionOption[];
  multiSelect?: boolean;
}

export interface NotificationAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface NotificationAskRequest {
  questions: NotificationQuestion[];
  agent?: { id?: string };
  signal?: AbortSignal;
}

export interface NotificationAskResult {
  answers: NotificationAnswer[];
}

/** userQuestions 服务的最小形状（install 时包装其 ask） */
export interface UserQuestionsLike {
  ask(request: NotificationAskRequest): Promise<NotificationAskResult>;
}

// ── approval/request 最小契约（对齐 dsh-user-approval） ──

/** 审批 outcome 是 dsh 协议的闭合集合（无 allow-always） */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** approval/request waterfall 请求的最小形状 */
export interface NotificationApprovalRequest {
  agent: { id: string; session?: unknown };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

// ── 依赖适配器（便于单测替换） ──

/** 发送适配器：与 bootstrap 里的 QQBotSender 同形 */
export interface NotificationSenderLike {
  sendMarkdown(
    target: ReplyTarget,
    content: string,
    opts?: { keyboard?: InlineKeyboard },
  ): Promise<unknown>;
}

/** 媒体发送适配器（对外 sendMessage 允许附图片；source 形态与 send-media 一致） */
export interface NotificationMediaSenderLike {
  sendImage(target: ReplyTarget, source: { localPath?: string }): Promise<unknown>;
}

/** 会话查找：判断某 session 是否由 QQ 通道驱动（QQ 会话不重复推送） */
export interface NotificationManagerLike {
  findBySessionId(sessionId: string): { sessionKey: string } | undefined;
}

/** 根 agent 探测：只给根会话推送，避免子 agent 的轮次重复通知 */
export interface NotificationRootsLike {
  roots?(): ReadonlyArray<{ session?: { id?: string } }>;
}

/** Cordis 上下文的最小契约（便于单测构造替身） */
export interface NotificationContextLike {
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: { global?: boolean; prepend?: boolean },
  ): unknown;
  effect(fn: () => (() => void) | void, name?: string): unknown;
  get(name: string): unknown;
}

/** QQ interaction 事件的最小形状（按钮点击分发用） */
export interface NotificationInteractionLike {
  scene?: string;
  group_openid?: string;
  user_openid?: string;
  id?: string;
  data?: { resolved?: { button_data?: string } };
}
