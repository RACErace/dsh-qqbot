/**
 * 通知推送模块（fork 新增）
 *
 * 对外入口：target-store（目标解析/持久化）、notification-channel（推送与作答）、
 * service（ctx.get('im-qqbot') 通知服务）、format（渲染与解析纯函数）。
 */
export { NotificationTargetStore, defaultNotificationStateFile } from './target-store.ts';
export { NotificationChannel } from './notification-channel.ts';
export type { NotificationChannelOptions } from './notification-channel.ts';
export { ImQQBotNotificationService, NOTIFICATION_SERVICE_NAME } from './service.ts';
export type { NotificationServiceContract } from './service.ts';
export type { ParsedAnswer } from './format.ts';
export type {
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
  NotificationQuestionOption,
  NotificationRootsLike,
  NotificationSenderLike,
  NotificationTarget,
  UserQuestionsLike,
} from './types.ts';
