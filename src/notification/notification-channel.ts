/**
 * NotificationChannel（fork 新增）— 非 QQ 会话的 dsh 事件 → QQ 推送通道
 *
 * 与上游 `QuestionChannel` / `ApprovalChannel`（它们只处理「QQ 会话内」的
 * 提问/审批，并带内联按钮）互补：本通道处理**不是 QQ 会话**的 agent 轮次，
 * 即在桌面 / CLI / Web 里发起的工作：
 *
 *   1. 任务完成：assistant 最终文本 + 页眉推到 QQ（可截断为预览、可冷却）
 *   2. 提问：包装 userQuestions.ask，非 QQ 会话的 ask 同时推 QQ 卡片；
 *      用户直接在 QQ 回「选项编号 / 字母 / 文字」即可作答（与 Web 卡片竞速）
 *   3. 审批：挂 approval/request waterfall，非 QQ 会话的审批推 QQ 卡片；
 *      用户回「允许 / 拒绝」或点内联按钮完成决策
 *   4. 对外服务：把 notify/sendMessage/lastTarget 暴露给兄弟插件（service.ts）
 *
 * 每个 QQ 推送目标只保留一个待答问题/待批审批；QQ 会话自身的提问和审批
 * 仍由上游通道处理，这里直接放行（不重复推送）。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { RawSessionEvent } from '../transport/events.ts';
import { chunkMarkdownText } from '../transport/chunker.ts';
import { buildKeyboard } from '../features/question-renderer.ts';
import { buildApprovalKeyboard } from '../features/approval-renderer.ts';
import { commandOf, type ApprovalRequest } from '../features/approval-channel.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import {
  canRenderQuestionKeyboard,
  extractAssistantText,
  formatDoneNotification,
  formatNotificationApproval,
  formatNotificationQuestion,
  isNoProviderError,
  parseApprovalDecision,
  parseNotificationAnswer,
} from './format.ts';
import type { NotificationTargetStore } from './target-store.ts';
import type {
  ApprovalOutcome,
  NotificationAnswer,
  NotificationApprovalRequest,
  NotificationAskRequest,
  NotificationAskResult,
  NotificationContextLike,
  NotificationInteractionLike,
  NotificationManagerLike,
  NotificationMediaSenderLike,
  NotificationQuestion,
  NotificationRootsLike,
  NotificationSenderLike,
  NotificationTarget,
  UserQuestionsLike,
} from './types.ts';

/** 待答问题状态（key = sessionId） */
interface PendingQuestionEntry {
  sessionId: string;
  target: NotificationTarget;
  request: NotificationAskRequest;
  questions: NotificationQuestion[];
  index: number;
  answers: NotificationAnswer[];
  settled: boolean;
  resolve(value: NotificationAskResult): void;
  reject(error: Error): void;
  onAbort?: () => void;
}

/** 待批审批状态（key = sessionId） */
interface PendingApprovalEntry {
  sessionId: string;
  target: NotificationTarget;
  request: NotificationApprovalRequest;
  settled: boolean;
  resolve(outcome: ApprovalOutcome): void;
  onAbort?: () => void;
}

export interface NotificationChannelOptions {
  manager: NotificationManagerLike;
  sender: NotificationSenderLike;
  media?: NotificationMediaSenderLike;
  config: ImQQBotConfig;
  logger: Logger;
  store: NotificationTargetStore;
  agents?: NotificationRootsLike;
}

/** 把 session 参数（session 对象 / id）归一成 id */
function sessionIdOf(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined;
  const header = (session as { header?: { id?: unknown } }).header;
  if (header !== null && typeof header === 'object' && typeof header.id === 'string' && header.id) return header.id;
  const id = (session as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : undefined;
}

/** 可手动 resolve/reject 的 Promise（竞速用） */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class NotificationChannel {
  private readonly manager: NotificationManagerLike;
  private readonly sender: NotificationSenderLike;
  private readonly media?: NotificationMediaSenderLike;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  private readonly store: NotificationTargetStore;
  private readonly agents?: NotificationRootsLike;

  private readonly pendingQuestions = new Map<string, PendingQuestionEntry>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  /** 每会话最近几轮的 assistant 文本（turn → text），任务完成推送用 */
  private readonly textByTurn = new Map<string, Map<number, string>>();

  private installedUq?: UserQuestionsLike;
  private previousAsk?: (request: NotificationAskRequest) => Promise<NotificationAskResult>;
  private lastDonePushAt = 0;
  private active = false;
  private disposed = false;

  public constructor(options: NotificationChannelOptions) {
    this.manager = options.manager;
    this.sender = options.sender;
    this.media = options.media;
    this.config = options.config;
    this.logger = options.logger;
    this.store = options.store;
    this.agents = options.agents;
  }

  /** 是否已装配（服务层 isActive） */
  public get isActive(): boolean {
    return this.active;
  }

  private get notifications() {
    return this.config.notifications;
  }

  // ── 装配 ──────────────────────────────────────────────────────────────────

  /**
   * 装配通道：
   *   - session/event：记录 assistant 文本 + turn/end 推送
   *   - 包装 userQuestions.ask：非 QQ 会话的问题推 QQ 并等待 QQ 作答
   *   - approval/request：非 QQ 会话的审批推 QQ 并等待 QQ 决策
   *
   * 必须在 `QuestionChannel.install()` / `ApprovalChannel.install()` **之后**调用：
   * 问题包装要包在 QQ 通道的 ask 外层（QQ 会话直接放行），审批监听不带
   * prepend 才会排在上游审批通道之后（对 QQ 会话放行）。
   */
  public install(ctx: NotificationContextLike): void {
    if (this.disposed) return;
    if (!this.notifications.enabled) {
      this.logger.info('im-qqbot: notification bridge disabled by config');
      return;
    }
    this.active = true;
    ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event as RawSessionEvent);
    });
    this.installQuestionWrapper(ctx);
    this.installApprovalAnswerer(ctx);
    this.logger.info('im-qqbot: notification bridge installed');
  }

  /** 注销：恢复被包装的 ask、结束所有 pending、标记非激活 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.cancelAll();
    if (this.installedUq && this.previousAsk) {
      this.installedUq.ask = this.previousAsk;
    }
    this.installedUq = undefined;
    this.previousAsk = undefined;
  }

  private installQuestionWrapper(ctx: NotificationContextLike): void {
    if (this.installedUq || this.disposed) return;
    let uq: UserQuestionsLike | undefined;
    try {
      uq = ctx.get('userQuestions') as UserQuestionsLike | undefined;
    } catch {
      uq = undefined;
    }
    if (!uq || typeof uq.ask !== 'function') {
      // userQuestions 是可选服务，可能晚于本插件挂载：监听 internal/service 补装。
      // 每次只尝试一次包装（installedUq 守卫），不会重复套壳。
      ctx.on(
        'internal/service',
        (name: unknown) => {
          if (name === 'userQuestions') this.installQuestionWrapper(ctx);
        },
        { global: true },
      );
      this.logger.debug('im-qqbot: userQuestions not ready yet — QQ notification Q&A waits for the service');
      return;
    }
    const previousAsk = uq.ask.bind(uq);
    this.installedUq = uq;
    this.previousAsk = previousAsk;
    const self = this;
    uq.ask = (request: NotificationAskRequest) => self.askViaNotification(request, previousAsk);
    ctx.effect(
      () => () => {
        if (self.installedUq === uq) {
          uq.ask = previousAsk;
          self.installedUq = undefined;
          self.previousAsk = undefined;
        }
      },
      'im-qqbot.notification.ask()',
    );
  }

  private installApprovalAnswerer(ctx: NotificationContextLike): void {
    ctx.on(
      'approval/request',
      (request, next) =>
        this.onApprovalRequest(
          request as NotificationApprovalRequest,
          next as () => Promise<ApprovalOutcome>,
        ),
      { global: true },
    );
  }

  // ── 入站：学习推送目标 / 截获 QQ 作答 ─────────────────────────────────────

  /** 记录一条入站消息（由 inbound 在消息进入 agent 前调用） */
  public onInboundMessage(scope: ChatScope, peerId: string): void {
    this.store.observeInbound(scope, peerId);
  }

  /**
   * 尝试把一条 QQ 入站文本当作「通知提问/审批」的答复消费。
   * @returns true = 已消费（该消息不应再进入 agent）
   */
  public tryAnswer(scope: ChatScope, targetId: string, text: string): boolean {
    if (!this.active) return false;
    const body = String(text ?? '').trim();
    if (!body) return false;

    const questionEntry = this.findPendingQuestion(scope, targetId);
    if (questionEntry) {
      const question = questionEntry.questions[questionEntry.index];
      if (question) {
        const parsed = parseNotificationAnswer(question, body);
        if (parsed.kind === 'invalid') {
          this.pushInBackground(questionEntry.target, `⚠️ 无效选择（${parsed.note}），请重新回复`);
          return true;
        }
        this.advanceQuestion(questionEntry, parsed.answer);
        return true;
      }
    }

    const approvalEntry = this.findPendingApproval(scope, targetId);
    if (approvalEntry) {
      const decision = parseApprovalDecision(body);
      if (!decision) {
        this.pushInBackground(approvalEntry.target, '⚠️ 未识别审批答复，请回复「允许」或「拒绝」');
        return true;
      }
      this.finishApproval(approvalEntry);
      approvalEntry.resolve(decision === 'allow' ? 'allowed-once' : 'rejected');
      return true;
    }

    return false;
  }

  /** 尝试把一次按钮点击当作「通知提问/审批」的答复 */
  public handleInteraction(event: NotificationInteractionLike): boolean {
    if (!this.active) return false;
    const raw = event.data?.resolved?.button_data;
    if (!raw) return false;
    const button = decodeButtonData(raw);
    if (!button) return false;

    const scope: ChatScope = event.scene === 'group' || event.group_openid ? 'group' : 'c2c';
    const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
    if (!targetId) return false;

    if (button.t === 'question') {
      const entry = this.findPendingQuestion(scope, targetId);
      if (!entry) return false;
      const question = entry.questions[entry.index];
      if (!question || question.id !== button.q) return false;
      const option = question.options?.[button.i];
      if (!option || typeof option.label !== 'string' || !option.label) return false;
      this.advanceQuestion(entry, { id: question.id, selected: [option.label] });
      return true;
    }

    const approvalEntry = this.findPendingApproval(scope, targetId);
    if (!approvalEntry) return false;
    this.finishApproval(approvalEntry);
    approvalEntry.resolve(button.d === 'allow' ? 'allowed-once' : 'rejected');
    return true;
  }

  // ── 对外服务（service.ts 使用） ───────────────────────────────────────────

  /** 推送一条通知文本到配置/学习到的目标 */
  public async notify(text: string): Promise<void> {
    const target = this.store.resolve() ?? this.store.lastSeenTarget();
    if (!target) {
      throw new Error(
        'im-qqbot: no QQ notification target — configure notifications.target, or message the bot first',
      );
    }
    await this.deliver(target, String(text ?? ''));
  }

  /** 向显式目标发送文本（可附图片路径） */
  public async sendMessage(target: NotificationTarget, text: string, images?: string[]): Promise<number> {
    const normalized = normalizeTarget(target);
    let sent = await this.deliver(normalized, String(text ?? ''));
    for (const image of images ?? []) {
      if (!image || !this.media) continue;
      try {
        await this.media.sendImage({ scope: normalized.kind, targetId: normalized.id }, { localPath: image });
        sent += 1;
      } catch (error) {
        this.logger.error(
          `im-qqbot: notification send image failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return sent;
  }

  /** 最近一次 QQ 会话目标（服务契约） */
  public lastTarget(): NotificationTarget | undefined {
    return this.store.lastSeenTarget() ?? this.store.resolve();
  }

  /** 会话被回收/停用时清理其 pending 提问与审批 */
  public cancelForSession(sessionId: string): void {
    const question = this.pendingQuestions.get(sessionId);
    if (question) {
      this.finishQuestion(question);
      question.reject(new Error('ask_user_question was cancelled before the user answered'));
    }
    const approval = this.pendingApprovals.get(sessionId);
    if (approval) {
      this.finishApproval(approval);
      approval.resolve('cancelled');
    }
  }

  /** 结束所有 pending（卸载 / 停止） */
  public cancelAll(): void {
    for (const entry of [...this.pendingQuestions.values()]) {
      this.finishQuestion(entry);
      entry.reject(new Error('ask_user_question was cancelled before the user answered'));
    }
    for (const entry of [...this.pendingApprovals.values()]) {
      this.finishApproval(entry);
      entry.resolve('cancelled');
    }
    this.textByTurn.clear();
  }

  // ── 任务完成推送 ──────────────────────────────────────────────────────────

  private onSessionEvent(session: unknown, event: RawSessionEvent): void {
    const notifications = this.notifications;
    if (!notifications.enabled) return;
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;

    if (event.type === 'assistant/message') {
      const data = event.data as { turn?: unknown; message?: { content?: unknown } };
      if (typeof data.turn !== 'number') return;
      const text = extractAssistantText(data.message?.content);
      if (!text) return;
      let turns = this.textByTurn.get(sessionId);
      if (!turns) {
        turns = new Map();
        this.textByTurn.set(sessionId, turns);
      }
      turns.set(data.turn, text);
      for (const turn of [...turns.keys()]) {
        if (turn <= data.turn - 3) turns.delete(turn);
      }
      return;
    }

    if (event.type !== 'turn/end') return;
    if (!notifications.onDone.enabled) return;

    const data = event.data as { turn?: unknown; reason?: { kind?: unknown } };
    if (typeof data.turn !== 'number') return;
    if (data.reason?.kind !== 'completed') return;
    if (this.manager.findBySessionId(sessionId)) return;
    if (!this.isRootSession(sessionId)) return;

    const now = Date.now();
    if (notifications.cooldownMs > 0 && now - this.lastDonePushAt < notifications.cooldownMs) return;

    const target = this.store.resolve();
    if (!target) return;

    const tracked = this.textByTurn.get(sessionId)?.get(data.turn) ?? '';
    const body = formatDoneNotification({
      text: tracked,
      header: notifications.onDone.header,
      previewChars: notifications.onDone.previewChars,
    });
    if (!body) return;

    this.lastDonePushAt = now;
    this.pushInBackground(target, body);
  }

  /** 只给根会话推送（子 agent 的轮次不重复通知） */
  private isRootSession(sessionId: string): boolean {
    const roots = this.agents?.roots;
    if (typeof roots !== 'function') return true;
    try {
      const list = roots.call(this.agents);
      if (!Array.isArray(list) || list.length === 0) return true;
      return list.some((agent) => agent?.session?.id === sessionId);
    } catch {
      // 探测失败时按根会话处理：最多多推一条，不能少推
      return true;
    }
  }

  // ── 提问推送与作答 ────────────────────────────────────────────────────────

  private async askViaNotification(
    request: NotificationAskRequest,
    previousAsk: (request: NotificationAskRequest) => Promise<NotificationAskResult>,
  ): Promise<NotificationAskResult> {
    const notifications = this.notifications;
    if (!notifications.enabled || !notifications.onQuestion.enabled) return previousAsk(request);
    const sessionId = request?.agent?.id;
    if (!sessionId) return previousAsk(request);
    // QQ 会话由上游 QuestionChannel 接管（按钮 + askTimeoutMs），这里放行
    if (this.manager.findBySessionId(sessionId)) return previousAsk(request);
    const target = this.store.resolve() ?? this.store.lastSeenTarget();
    if (!target) return previousAsk(request);

    const questions: NotificationQuestion[] = (Array.isArray(request.questions) ? request.questions : [])
      .filter((question) => typeof question?.id === 'string' && question.id.length > 0)
      .map((question) => ({
        id: question.id,
        header: question.header,
        question: String(question.question ?? ''),
        options: Array.isArray(question.options) ? question.options : undefined,
        multiSelect: question.multiSelect === true,
      }));
    if (questions.length === 0) return previousAsk(request);

    return this.parkQuestion(sessionId, target, request, questions, previousAsk);
  }

  private parkQuestion(
    sessionId: string,
    target: NotificationTarget,
    request: NotificationAskRequest,
    questions: NotificationQuestion[],
    previousAsk: (request: NotificationAskRequest) => Promise<NotificationAskResult>,
  ): Promise<NotificationAskResult> {
    if (request.signal?.aborted) {
      return Promise.reject(new Error('ask_user_question was aborted before delivery'));
    }
    // 同一会话已有待答问题（理论上不会发生：回合阻塞在第一个问题上）
    const previous = this.pendingQuestions.get(sessionId);
    if (previous) {
      this.finishQuestion(previous);
      previous.reject(new Error('superseded by a new question'));
    }

    const deferred = createDeferred<NotificationAskResult>();
    const entry: PendingQuestionEntry = {
      sessionId,
      target,
      request,
      questions,
      index: 0,
      answers: [],
      settled: false,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };
    if (request.signal) {
      const onAbort = () => {
        if (this.pendingQuestions.get(sessionId) !== entry) return;
        this.finishQuestion(entry);
        deferred.reject(new Error('ask_user_question was aborted before the user answered'));
      };
      entry.onAbort = onAbort;
      request.signal.addEventListener('abort', onAbort, { once: true });
    }
    this.pendingQuestions.set(sessionId, entry);
    void this.sendQuestion(entry).catch((error: unknown) => {
      this.logger.error(
        `im-qqbot: notification question send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    // 与宿主默认回答者（Web 卡片 / CLI 提示）竞速：谁先答谁赢。
    // 宿主侧没有可用 provider 时继续等 QQ（而不是把「没有通道」抛回调用方）。
    const qq = deferred.promise;
    qq.catch(() => undefined);
    const web = Promise.resolve()
      .then(() => previousAsk(request))
      .catch((error: unknown) => {
        if (isNoProviderError(error)) return qq;
        throw error;
      });
    web.catch(() => undefined);

    return Promise.race([qq, web]).finally(() => {
      if (this.pendingQuestions.get(sessionId) === entry) this.pendingQuestions.delete(sessionId);
      this.removeQuestionAbort(entry);
      entry.settled = true;
    });
  }

  private async sendQuestion(entry: PendingQuestionEntry): Promise<void> {
    const question = entry.questions[entry.index];
    if (!question) return;
    const limits = {
      questionChars: Number(this.notifications.onQuestion.questionChars) || 0,
      optionChars: Number(this.notifications.onQuestion.optionChars) || 0,
    };
    const keyboard = canRenderQuestionKeyboard(question) ? buildKeyboard(question) : undefined;
    const text = formatNotificationQuestion(question, entry.index, entry.questions.length, limits, keyboard !== undefined);
    await this.deliver(entry.target, text, keyboard);
  }

  /** 收集答案；有下一题就继续推送，否则 resolve 并回复确认 */
  private advanceQuestion(entry: PendingQuestionEntry, answer: NotificationAnswer): void {
    entry.answers.push(answer);
    entry.index += 1;

    if (entry.index < entry.questions.length) {
      void this.sendQuestion(entry).catch((error: unknown) => {
        this.logger.error(
          `im-qqbot: notification question send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }

    this.finishQuestion(entry);
    entry.resolve({ answers: entry.answers });
    const picked = answer.selected.length > 0 ? answer.selected.join('、') : (answer.custom ?? '');
    this.pushInBackground(entry.target, `✅ 已收到回答：${picked}`);
  }

  private finishQuestion(entry: PendingQuestionEntry): void {
    entry.settled = true;
    if (this.pendingQuestions.get(entry.sessionId) === entry) this.pendingQuestions.delete(entry.sessionId);
    this.removeQuestionAbort(entry);
  }

  private removeQuestionAbort(entry: PendingQuestionEntry): void {
    if (entry.onAbort && entry.request.signal) entry.request.signal.removeEventListener('abort', entry.onAbort);
  }

  private findPendingQuestion(scope: ChatScope, targetId: string): PendingQuestionEntry | undefined {
    for (const entry of this.pendingQuestions.values()) {
      if (entry.settled) continue;
      if (entry.target.kind === scope && entry.target.id === targetId) return entry;
    }
    return undefined;
  }

  // ── 审批推送与决策 ────────────────────────────────────────────────────────

  private onApprovalRequest(
    request: NotificationApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const notifications = this.notifications;
    if (!notifications.enabled || !notifications.onApproval.enabled) return next();
    const sessionId = request?.agent?.id;
    if (!sessionId) return next();
    // QQ 会话由上游 ApprovalChannel 接管（两按钮审批），这里放行
    if (this.manager.findBySessionId(sessionId)) return next();
    const target = this.store.resolve() ?? this.store.lastSeenTarget();
    if (!target) return next();
    return this.parkApproval(sessionId, target, request, next);
  }

  private parkApproval(
    sessionId: string,
    target: NotificationTarget,
    request: NotificationApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return Promise.resolve('cancelled');

    const previous = this.pendingApprovals.get(sessionId);
    if (previous) {
      this.finishApproval(previous);
      previous.resolve('cancelled');
    }

    const deferred = createDeferred<ApprovalOutcome>();
    const entry: PendingApprovalEntry = {
      sessionId,
      target,
      request,
      settled: false,
      resolve: deferred.resolve,
    };
    if (request.signal) {
      const onAbort = () => {
        if (this.pendingApprovals.get(sessionId) !== entry) return;
        this.finishApproval(entry);
        deferred.resolve('cancelled');
      };
      entry.onAbort = onAbort;
      request.signal.addEventListener('abort', onAbort, { once: true });
    }
    this.pendingApprovals.set(sessionId, entry);
    void this.sendApproval(target, request).catch((error: unknown) => {
      this.logger.error(
        `im-qqbot: notification approval send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const qq = deferred.promise;
    qq.catch(() => undefined);
    // 宿主侧没有可用审批通道（outcome=unavailable / 抛 NO_PROVIDER）时继续等 QQ
    const host = Promise.resolve()
      .then(() => next())
      .then((outcome) => (outcome === 'unavailable' && !entry.settled ? qq : outcome))
      .catch((error: unknown) => {
        if (isNoProviderError(error)) return qq;
        throw error;
      });
    host.catch(() => undefined);

    return Promise.race([qq, host]).finally(() => {
      if (this.pendingApprovals.get(sessionId) === entry) this.pendingApprovals.delete(sessionId);
      this.removeApprovalAbort(entry);
      entry.settled = true;
    });
  }

  private async sendApproval(target: NotificationTarget, request: NotificationApprovalRequest): Promise<void> {
    const command = commandOf(request as unknown as ApprovalRequest);
    const limits = { commandChars: Number(this.notifications.onApproval.commandChars) || 0 };
    const keyboard = buildApprovalKeyboard();
    const text = formatNotificationApproval(request, command, limits, true);
    await this.deliver(target, text, keyboard);
  }

  private finishApproval(entry: PendingApprovalEntry): void {
    entry.settled = true;
    if (this.pendingApprovals.get(entry.sessionId) === entry) this.pendingApprovals.delete(entry.sessionId);
    this.removeApprovalAbort(entry);
  }

  private removeApprovalAbort(entry: PendingApprovalEntry): void {
    if (entry.onAbort && entry.request.signal) entry.request.signal.removeEventListener('abort', entry.onAbort);
  }

  private findPendingApproval(scope: ChatScope, targetId: string): PendingApprovalEntry | undefined {
    for (const entry of this.pendingApprovals.values()) {
      if (entry.settled) continue;
      if (entry.target.kind === scope && entry.target.id === targetId) return entry;
    }
    return undefined;
  }

  // ── 发送 ──────────────────────────────────────────────────────────────────

  /**
   * 分块发送一条通知（长文本按 textChunkLimit 切分）。
   * 带按钮的首块发送失败时降级为纯文本重发（正文已含作答引导）。
   */
  private async deliver(
    target: NotificationTarget,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<number> {
    const body = String(text ?? '');
    if (!body.trim()) return 0;
    const limit = Math.max(1, Number(this.config.textChunkLimit) || 4500);
    const chunks = chunkMarkdownText(body, limit);
    const replyTarget: ReplyTarget = { scope: target.kind, targetId: target.id };
    let sent = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      const chunkKeyboard = index === 0 ? keyboard : undefined;
      try {
        await this.sender.sendMarkdown(replyTarget, chunk, chunkKeyboard ? { keyboard: chunkKeyboard } : undefined);
        sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (chunkKeyboard) {
          this.logger.warn(`im-qqbot: notification keyboard send failed, fallback to text: ${message}`);
          try {
            await this.sender.sendMarkdown(replyTarget, chunk);
            sent += 1;
            continue;
          } catch (fallbackError) {
            this.logger.error(
              `im-qqbot: notification send failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            );
            continue;
          }
        }
        this.logger.error(`im-qqbot: notification send failed: ${message}`);
      }
    }
    return sent;
  }

  /** fire-and-forget 推送：失败只记日志，不打断事件流 */
  private pushInBackground(target: NotificationTarget, text: string): void {
    void this.deliver(target, text).catch((error: unknown) => {
      this.logger.error(
        `im-qqbot: notification push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

/** 校验并归一化目标 */
function normalizeTarget(target: NotificationTarget): NotificationTarget {
  const kind = target?.kind;
  const id = String(target?.id ?? '').trim();
  if (kind !== 'c2c' && kind !== 'group') {
    throw new Error(`im-qqbot: notification target kind must be 'c2c' or 'group', got ${String(kind)}`);
  }
  if (!id) throw new Error('im-qqbot: notification target id must be a non-empty string');
  return { kind, id };
}
