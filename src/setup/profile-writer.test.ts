/**
 * profile 配置写入（configEditor 优先 / 文件直写退化）测试
 *
 * 覆盖：configEditor 保存配置与凭据、按行 id 查找、编辑失败回退、
 * 解绑移除凭据字段、无 configEditor 时退回文件直写（本机 link 安装场景
 * 的回归：getProfileDir 找不到 profile 时返回 persisted=false 而不是抛错）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  clearCredentials,
  saveConfigPatch,
  saveCredentials,
  type ConfigEditorEntryLike,
  type ConfigEditorLike,
} from './profile-writer.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

interface FakeEditor extends ConfigEditorLike {
  entry: ConfigEditorEntryLike;
  calls: Array<Record<string, unknown>>;
  fail?: Error;
}

function makeEditor(config: Record<string, unknown> = {}): FakeEditor {
  const entry: ConfigEditorEntryLike = { options: { id: 'im-qqbot', name: '@tencent-connect/dsh-qqbot', config } };
  const calls: Array<Record<string, unknown>> = [];
  return {
    entry,
    calls,
    entries: () => [entry],
    async edit(target, change) {
      if (target !== entry) throw new Error('entry mismatch');
      calls.push(change(config, {}));
    },
  };
}

function makeCtx(editor?: ConfigEditorLike): Context {
  return {
    get: (name: string) => (name === 'configEditor' ? editor : undefined),
  } as unknown as Context;
}

describe('saveConfigPatch', () => {
  it('把补丁合并进当前行配置并交给 configEditor 落盘', async () => {
    const editor = makeEditor({ appId: '1905556937', appSecret: 'secret', showToolResults: false });
    const result = await saveConfigPatch(makeCtx(editor), { showToolResults: true }, logger);
    expect(result).toEqual({ persisted: true });
    expect(editor.calls[0]).toEqual({ appId: '1905556937', appSecret: 'secret', showToolResults: true });
  });

  it('按包名兜底查找行（行 id 不同也能命中）', async () => {
    const editor = makeEditor({ showToolResults: false });
    editor.entry.options = { name: '@tencent-connect/dsh-qqbot', config: { showToolResults: false } };
    const result = await saveConfigPatch(makeCtx(editor), { showToolResults: true }, logger);
    expect(result.persisted).toBe(true);
  });

  it('找不到行时返回可展示错误', async () => {
    const editor = makeEditor();
    editor.entries = () => [{ options: { id: 'other', name: 'other' } }];
    const result = await saveConfigPatch(makeCtx(editor), { showToolResults: true }, logger);
    expect(result.persisted).toBe(false);
    expect(result.error).toContain('未找到 im-qqbot 行');
  });

  it('configEditor 编辑失败时返回该错误（不再写文件）', async () => {
    const editor = makeEditor();
    editor.edit = async () => {
      throw new Error('Configuration entry is no longer available');
    };
    const result = await saveConfigPatch(makeCtx(editor), { showToolResults: true }, logger);
    expect(result.persisted).toBe(false);
    expect(result.error).toContain('no longer available');
  });

  it('无 configEditor 时退回文件直写：无 profile 目录返回 failure 而非抛错', async () => {
    const result = await saveConfigPatch(makeCtx(), { showToolResults: true }, logger);
    expect(result.persisted).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('saveCredentials / clearCredentials', () => {
  it('凭据写入合并到当前行配置（保留其他键）', async () => {
    const editor = makeEditor({ showToolResults: true, notifications: { enabled: true } });
    const result = await saveCredentials(
      makeCtx(editor),
      { appId: '1905556937', appSecret: 'new-secret' },
      logger,
    );
    expect(result.persisted).toBe(true);
    expect(editor.calls[0]).toEqual({
      showToolResults: true,
      notifications: { enabled: true },
      appId: '1905556937',
      appSecret: 'new-secret',
    });
  });

  it('解绑移除 appId/appSecret 但保留其他配置', async () => {
    const editor = makeEditor({ appId: 'a', appSecret: 'b', showToolResults: true });
    const result = await clearCredentials(makeCtx(editor), logger);
    expect(result.persisted).toBe(true);
    expect(editor.calls[0]).toEqual({ showToolResults: true });
  });

  it('configEditor 失败时回退（不抛错）', async () => {
    const editor = makeEditor();
    editor.edit = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await clearCredentials(makeCtx(editor), logger);
    expect(result.persisted).toBe(false);
  });
});
