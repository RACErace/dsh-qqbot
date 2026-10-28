/**
 * 通知目标存储测试（fork 新增）
 *
 * 覆盖：配置目标优先、私聊目标学习与落盘、重启恢复、群聊不学习、
 * 最近会话兜底、损坏状态文件容错。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationTargetStore } from './target-store.ts';
import type { NotificationsConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const tempDirs: string[] = [];

function tempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-notification-'));
  tempDirs.push(dir);
  return join(dir, 'notification-target.json');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function notifications(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return {
    enabled: true,
    target: { kind: 'c2c', id: '' },
    learnFromChats: true,
    onDone: { enabled: true, previewChars: 0, header: '## ✅ DSH 任务完成' },
    onQuestion: { enabled: true, questionChars: 120, optionChars: 60 },
    onApproval: { enabled: true, commandChars: 500 },
    cooldownMs: 0,
    ...overrides,
  };
}

describe('NotificationTargetStore', () => {
  it('配置了 target 时优先使用配置目标', () => {
    const store = new NotificationTargetStore(
      notifications({ target: { kind: 'group', id: 'g-configured' } }),
      logger,
      { stateFile: tempStateFile() },
    );
    store.observeInbound('c2c', 'u-learned');
    expect(store.resolve()).toEqual({ kind: 'group', id: 'g-configured' });
  });

  it('首次私聊消息学习为推送目标并落盘，重启后可恢复', async () => {
    const stateFile = tempStateFile();
    const store = new NotificationTargetStore(notifications(), logger, { stateFile });
    expect(store.resolve()).toBeUndefined();
    store.observeInbound('c2c', 'openid-1');
    expect(store.resolve()).toEqual({ kind: 'c2c', id: 'openid-1' });
    await store.flush();
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ kind: 'c2c', id: 'openid-1' });

    const restored = new NotificationTargetStore(notifications(), logger, { stateFile });
    await restored.restore();
    expect(restored.resolve()).toEqual({ kind: 'c2c', id: 'openid-1' });
  });

  it('后续私聊消息更新学习目标', async () => {
    const stateFile = tempStateFile();
    const store = new NotificationTargetStore(notifications(), logger, { stateFile });
    store.observeInbound('c2c', 'openid-1');
    store.observeInbound('c2c', 'openid-2');
    await store.flush();
    expect(store.resolve()).toEqual({ kind: 'c2c', id: 'openid-2' });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ kind: 'c2c', id: 'openid-2' });
  });

  it('learnFromChats 关闭时只记录最近会话，不学习目标', () => {
    const store = new NotificationTargetStore(
      notifications({ learnFromChats: false }),
      logger,
      { stateFile: tempStateFile() },
    );
    store.observeInbound('c2c', 'openid-1');
    expect(store.resolve()).toBeUndefined();
    expect(store.lastSeenTarget()).toEqual({ kind: 'c2c', id: 'openid-1' });
  });

  it('群聊不参与学习，只更新最近会话', () => {
    const store = new NotificationTargetStore(notifications(), logger, { stateFile: tempStateFile() });
    store.observeInbound('group', 'group-1');
    expect(store.resolve()).toBeUndefined();
    expect(store.lastSeenTarget()).toEqual({ kind: 'group', id: 'group-1' });
  });

  it('状态文件损坏时恢复静默跳过', async () => {
    const stateFile = tempStateFile();
    writeFileSync(stateFile, '{ not json', 'utf8');
    const store = new NotificationTargetStore(notifications(), logger, { stateFile });
    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.resolve()).toBeUndefined();
  });

  it('状态文件字段非法时忽略', async () => {
    const stateFile = tempStateFile();
    writeFileSync(stateFile, JSON.stringify({ kind: 'unknown', id: '' }), 'utf8');
    const store = new NotificationTargetStore(notifications(), logger, { stateFile });
    await store.restore();
    expect(store.resolve()).toBeUndefined();
  });
});
