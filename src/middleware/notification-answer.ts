/**
 * 通知答复截获中间件 — 通知提问/审批的 QQ 回复（fork 新增）
 *
 * 必须放在 questionAnswer 之后、concurrencyGuard 之前：
 * 与 QQ 会话问答同理，答复消息不能排进并发队列——此时 agent 的 turn 正阻塞
 * 等待这个答复，进队列会形成「turn 等答复 ↔ 答复被缓冲」的死锁。
 *
 * 只消费「推送目标正有 pending 提问/审批」的消息；其余消息照常进入 agent。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import { cacheMsgId } from '../transport/msgid-cache.ts';

export function notificationAnswer(manager: SessionManager) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const notificationChannel = manager.notificationChannel;
    if (!notificationChannel) {
      await next();
      return;
    }
    const text = (ctx.message.content ?? '').trim();
    if (!text) {
      await next();
      return;
    }
    if (notificationChannel.tryAnswer(ctx.replyTarget.scope, ctx.replyTarget.targetId, text)) {
      // 答复消息被截获（不再走到 bot.on('message')），补录 msgId 供被动回复使用
      cacheMsgId(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.replyTarget.msgId);
      ctx.stop('notification-answer');
      return;
    }
    await next();
  };
}
