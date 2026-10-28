/**
 * interaction 统一分发器 — 按 button_data 的顶层 `t` 判别字段路由到对应通道。
 *
 * QQ 只有一个 interaction 入口：QQ 会话的问答/审批由上游 `QuestionChannel` /
 * `ApprovalChannel` 处理，非 QQ 会话（通知推送的卡片）由 `NotificationChannel`
 * 兜底。集中路由避免多通道各自 try 导致误判、也避免重复 acknowledge。
 *
 * 关键点：各通道的 `handleInteraction` 返回 boolean，串联必须用 `||`——
 * `??` 只在 null/undefined 时兜底，`false` 会直接短路，兜底通道永远收不到点击
 * （QQ 会话通道对非 QQ 会话返回 false 是常态）。
 * 回归用例见 interaction-dispatch.test.ts。
 */
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { decodeButtonData } from './button-utils.ts';

/** QQ 会话通道（QuestionChannel / ApprovalChannel）的最小契约 */
export interface InteractionChannelLike {
  handleInteraction(event: InteractionEvent): boolean;
}

/** 通知通道（NotificationChannel）的最小契约：参数是结构化 interaction，不做强类型耦合 */
export interface NotificationInteractionChannelLike {
  handleInteraction(event: unknown): boolean;
}

/** 分发所需的管理器视图 */
export interface InteractionDispatchManagerLike {
  questionChannel?: InteractionChannelLike;
  approvalChannel?: InteractionChannelLike;
  notificationChannel?: NotificationInteractionChannelLike;
}

export function dispatchInteraction(
  event: InteractionEvent,
  manager: InteractionDispatchManagerLike,
): boolean {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return false;
  const button = decodeButtonData(raw);
  if (!button) return false;
  if (button.t === 'question') {
    return (
      manager.questionChannel?.handleInteraction(event) === true ||
      manager.notificationChannel?.handleInteraction(event) === true
    );
  }
  if (button.t === 'approval') {
    return (
      manager.approvalChannel?.handleInteraction(event) === true ||
      manager.notificationChannel?.handleInteraction(event) === true
    );
  }
  return false;
}
