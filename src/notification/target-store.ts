/**
 * 通知目标存储（fork 新增）
 *
 * 推送目标按优先级解析：
 *   1. 配置里显式写的 `notifications.target`（id 非空才生效）
 *   2. 学习到的私聊目标（`notifications.learnFromChats` 打开时，首次私聊消息学到）
 *   3. 最近一次收到消息的 QQ 会话（仅作为提问/审批的兜底目标）
 *
 * 学习到的目标落盘到 `<DSH home>/storages/im-qqbot/notification-target.json`，
 * 重启后无需再等用户发消息即可继续推送。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../types.ts';
import type { NotificationsConfig } from '../config.ts';
import type { NotificationTarget } from './types.ts';
import type { ChatScope } from '../types.ts';

/** 缺省状态文件：<DSH home>/storages/im-qqbot/notification-target.json */
export function defaultNotificationStateFile(dshHome?: string): string {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'im-qqbot', 'notification-target.json');
}

export class NotificationTargetStore {
  private readonly config: NotificationsConfig;
  private readonly logger: Logger;
  private readonly stateFile: string;
  private learned?: NotificationTarget;
  private lastSeen?: NotificationTarget;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(
    config: NotificationsConfig,
    logger: Logger,
    options: { stateFile?: string } = {},
  ) {
    this.config = config;
    this.logger = logger;
    this.stateFile = options.stateFile ?? defaultNotificationStateFile();
  }

  /** 状态文件路径（测试/排障用） */
  public get stateFilePath(): string {
    return this.stateFile;
  }

  /** 推送用目标：配置目标 → 学习目标。都没有时返回 undefined */
  public resolve(): NotificationTarget | undefined {
    const configured = this.config.target;
    if (configured && typeof configured.id === 'string' && configured.id.length > 0) {
      return { kind: configured.kind, id: configured.id };
    }
    return this.learned;
  }

  /** 最近一次收到消息的 QQ 会话（任意 scope），作为提问/审批的最后兜底 */
  public lastSeenTarget(): NotificationTarget | undefined {
    return this.lastSeen;
  }

  /**
   * 记录一条入站消息：更新最近会话；learnFromChats 打开时学习私聊目标并落盘。
   * 群聊不参与学习（群里推送会打扰其他人），只更新 recent。
   */
  public observeInbound(scope: ChatScope, peerId: string): void {
    if (!peerId) return;
    const target: NotificationTarget = { kind: scope, id: peerId };
    this.lastSeen = target;
    if (!this.config.learnFromChats || scope !== 'c2c') return;
    if (this.learned && this.learned.kind === target.kind && this.learned.id === target.id) return;
    this.learned = target;
    this.logger.debug(`im-qqbot: notification target learned ${target.kind}:${target.id}`);
    void this.persist(target);
  }

  /** 启动时恢复上次学习的私聊目标（文件缺失/损坏时静默跳过） */
  public async restore(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const saved = JSON.parse(raw) as { kind?: unknown; id?: unknown };
      if ((saved.kind === 'c2c' || saved.kind === 'group') && typeof saved.id === 'string' && saved.id) {
        this.learned = { kind: saved.kind, id: saved.id };
        this.logger.info(`im-qqbot: notification target restored ${saved.kind}:${saved.id}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') {
        this.logger.warn(
          `im-qqbot: restore notification target failed (${this.stateFile}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** 等待落盘链完成（生命周期收尾用） */
  public async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  private persist(target: NotificationTarget): Promise<void> {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(path.dirname(this.stateFile), { recursive: true });
          const payload = JSON.stringify(
            { kind: target.kind, id: target.id, learnedAt: new Date().toISOString() },
            null,
            2,
          );
          await writeFile(this.stateFile, `${payload}\n`, 'utf8');
        } catch (error) {
          this.logger.warn(
            `im-qqbot: persist notification target failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    return this.writeChain;
  }
}
