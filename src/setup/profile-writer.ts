/**
 * profile 配置写入（fork 新增）— 优先宿主 ConfigEditor，退化到直接写 profile patch
 *
 * 背景：上游用「从插件路径向上探测 node_modules 之上的 profile」定位 profile。
 * 插件以 `link:` / 源码方式安装（本机就是 link）时插件根不在任何 profile 的
 * node_modules 下，探测必然失败，保存配置/凭据会报
 * 「⚠️ 无法定位 profile 目录或写入失败」。
 *
 * 宿主提供了 `configEditor` 服务（内置 config-editor 插件）：
 *   - `entries()` 返回可寻址的 profile 行（Loader Entry，`.options.id/name/config`）
 *   - `edit(entry, change)` 校验、落盘 profile patch 并交给 Loader 协调热重载，
 *     内部处理 `!!js` 自定义标签与原子写、文件锁
 * 因此优先走它；老宿主没有该服务时退回原有的 `persist.ts` 直写路径。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import { getProfileDir } from '../shared/index.ts';
import {
  persistCredentialsToProfile,
  removeCredentialsFromProfile,
  updateProfileConfig,
  type SetupCredentials,
} from './persist.ts';

/** 插件在 profile patch 里的行 id（bundle 层插入的 id） */
const PLUGIN_ROW_ID = 'im-qqbot';
/** 包名（行未显式写 id 时的兜底匹配） */
const PLUGIN_NAME = '@tencent-connect/dsh-qqbot';

/** 写入结果：persisted=false 时 error 回传给 UI 展示 */
export interface ProfileWriteResult {
  persisted: boolean;
  error?: string;
}

/** 宿主 ConfigEditor 的最小契约（避免硬依赖宿主包） */
export interface ConfigEditorEntryLike {
  options?: { id?: unknown; name?: unknown; config?: Record<string, unknown> };
}

export interface ConfigEditorLike {
  entries(): ConfigEditorEntryLike[];
  edit(
    entry: ConfigEditorEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

/** 可选探测宿主 configEditor 服务（不存在时返回 undefined，不抛错） */
function resolveConfigEditor(ctx: Context): ConfigEditorLike | undefined {
  try {
    const editor = ctx.get('configEditor') as ConfigEditorLike | undefined;
    if (editor && typeof editor.edit === 'function' && typeof editor.entries === 'function') return editor;
  } catch {
    // 可选服务：旧宿主无 configEditor，走文件直写
  }
  return undefined;
}

/** 在可寻址行里找本插件的行（id 优先，包名兜底） */
function findPluginEntry(editor: ConfigEditorLike): ConfigEditorEntryLike | undefined {
  let entries: ConfigEditorEntryLike[];
  try {
    entries = editor.entries();
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry?.options?.id === PLUGIN_ROW_ID) return entry;
  }
  for (const entry of entries) {
    if (entry?.options?.name === PLUGIN_NAME) return entry;
  }
  return undefined;
}

/** 统一编辑：找行 → 合并 → 落盘；由 configEditor 写入并返回结果 */
async function editPluginRow(
  ctx: Context,
  logger: Logger,
  scope: string,
  merge: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<ProfileWriteResult> {
  const editor = resolveConfigEditor(ctx);
  if (!editor) return { persisted: false, error: '宿主未提供 configEditor（旧版本）' };

  const entry = findPluginEntry(editor);
  if (!entry) {
    return { persisted: false, error: 'profile 中未找到 im-qqbot 行（请确认插件 bundle 已装载）' };
  }
  try {
    await editor.edit(entry, (current) => merge(current));
    logger.info(`im-qqbot: ${scope} 已通过宿主 configEditor 保存`);
    return { persisted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`im-qqbot: ${scope} 经 configEditor 保存失败: ${message}`);
    return { persisted: false, error: message };
  }
}

/**
 * 保存可编辑配置（配置面板「保存」）。
 * 与 profile patch 的 id 定向行合并：保留现有凭据/通知等键，只覆盖提交的键。
 *
 * 宿主有 configEditor 时以其结果为准（它负责 !!js 标签、文件锁与 Loader 协调）；
 * 只有旧宿主没有该服务时才退回文件直写。
 */
export async function saveConfigPatch(
  ctx: Context,
  patch: Record<string, unknown>,
  logger: Logger,
): Promise<ProfileWriteResult> {
  if (resolveConfigEditor(ctx)) {
    return editPluginRow(ctx, logger, '配置', (current) => ({ ...current, ...patch }));
  }
  const persisted = updateProfileConfig(patch, getProfileDir() ?? undefined, undefined);
  return persisted
    ? { persisted: true }
    : { persisted: false, error: '无法定位 profile 目录或写入失败' };
}

/** 保存扫码/手动提交的凭据（写入 profile patch 的 id 定向行） */
export async function saveCredentials(
  ctx: Context,
  credentials: SetupCredentials,
  logger: Logger,
): Promise<ProfileWriteResult> {
  if (resolveConfigEditor(ctx)) {
    return editPluginRow(ctx, logger, '凭据', (current) => ({
      ...current,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
    }));
  }
  const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
  return persisted
    ? { persisted: true }
    : { persisted: false, error: '无法定位 profile 目录或写入失败，请改用环境变量配置' };
}

/** 解绑：从 profile patch 的 id 定向行移除 appId/appSecret */
export async function clearCredentials(ctx: Context, logger: Logger): Promise<ProfileWriteResult> {
  if (resolveConfigEditor(ctx)) {
    return editPluginRow(ctx, logger, '解绑', (current) => {
      const next = { ...current };
      delete next.appId;
      delete next.appSecret;
      return next;
    });
  }
  const removed = removeCredentialsFromProfile(getProfileDir() ?? undefined, undefined);
  return removed
    ? { persisted: true }
    : { persisted: false, error: '无法定位 profile 目录或写入失败，请手动编辑 cordis.patch.yml' };
}
