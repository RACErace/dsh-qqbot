/**
 * 对外通知服务（fork 新增）
 *
 * 兄弟插件通过 `ctx.get('im-qqbot')` 拿到本服务，把文本/图片推到
 * QQ 通知目标（配置目标或学习到的私聊目标），无需与 QQ 通道代码耦合。
 *
 * 服务名与插件 id 保持一致（`im-qqbot`）；可用性随插件 fiber 自动回收，
 * 插件停用时 get 返回 undefined。未装配通知桥（通知关闭）时 isActive=false，
 * 调用 notify/sendMessage 会抛出明确错误。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { NotificationChannel } from './notification-channel.ts';
import type { NotificationTarget } from './types.ts';

/** 服务名（ctx.get('im-qqbot')） */
export const NOTIFICATION_SERVICE_NAME = 'im-qqbot';

/** 对外通知服务契约（sibling 插件可据此做结构性类型标注） */
export interface NotificationServiceContract {
  /** 通知桥是否已装配（插件在线且通知功能开启） */
  readonly isActive: boolean;
  /** 推送一条通知文本到通知目标（无目标时抛错） */
  notify(text: string): Promise<void>;
  /** 向显式 QQ 目标发送文本（可附图片路径），返回发送条数 */
  sendMessage(target: NotificationTarget, text: string, images?: string[]): Promise<number>;
  /** 最近一次 QQ 会话目标（可能为 undefined） */
  lastTarget(): NotificationTarget | undefined;
}

export class ImQQBotNotificationService extends Service implements NotificationServiceContract {
  private channel: NotificationChannel | null;

  public constructor(ctx: Context, channel: NotificationChannel | null) {
    super(ctx, NOTIFICATION_SERVICE_NAME);
    this.channel = channel;
  }

  public get isActive(): boolean {
    return this.channel?.isActive ?? false;
  }

  public async notify(text: string): Promise<void> {
    await this.requireChannel().notify(text);
  }

  public async sendMessage(
    target: NotificationTarget,
    text: string,
    images?: string[],
  ): Promise<number> {
    return this.requireChannel().sendMessage(target, text, images);
  }

  public lastTarget(): NotificationTarget | undefined {
    return this.channel?.lastTarget();
  }

  /** 插件停止时解绑（fiber 回收之外再显式失效，避免停用瞬间仍可推送） */
  public detach(): void {
    this.channel = null;
  }

  private requireChannel(): NotificationChannel {
    if (!this.channel) throw new Error('im-qqbot: notification bridge is not active');
    return this.channel;
  }
}
