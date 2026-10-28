/**
 * 通知推送 — 文本渲染与回复解析（纯函数，便于单测）
 *
 * 覆盖三类推送：
 *   1. 任务完成：页眉 + 最终回复文本（可截断预览）
 *   2. 提问：紧凑问题卡片（问题/选项可独立截断）+ 编号/字母/文字作答解析
 *   3. 审批：工具名 + 被 gate 命令回显 + 「允许/拒绝」文本判定
 */
import type { NotificationApprovalRequest, NotificationAnswer, NotificationQuestion } from './types.ts';

/** 问题答题结果：合法答案，或需要提示用户重答 */
export type ParsedAnswer =
  | { kind: 'answer'; answer: NotificationAnswer }
  | { kind: 'invalid'; note: string };

/** 压平空白并截断（0 = 不截断） */
export function summarize(text: unknown, maxChars = 120): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const limit = Number(maxChars) || 0;
  if (limit <= 0) return flat;
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** 拼接 assistant 消息里的文本块（保留段落换行，供推送展示） */
export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') parts.push(text);
  }
  return parts.join('\n\n');
}

/** 任务完成推送文本：header + 文本（previewChars>0 时截断为单行预览） */
export function formatDoneNotification(input: {
  text: string;
  header: string;
  previewChars: number;
}): string {
  const previewChars = Number(input.previewChars) || 0;
  const body = previewChars > 0 ? summarize(input.text, previewChars) : String(input.text ?? '').trim();
  if (!body) return '';
  const header = String(input.header ?? '').trim();
  return header ? `${header}\n${body}` : body;
}

/** 把单个问题渲染成 QQ 通知卡片（逐题推送，问题/选项可分别截断） */
export function formatNotificationQuestion(
  question: NotificationQuestion,
  index: number,
  total: number,
  limits: { questionChars: number; optionChars: number },
  withButtons: boolean,
): string {
  const title = total === 1 ? '❓ DSH 需要你回答' : `❓ DSH 需要你回答（第 ${index + 1}/${total} 题）`;
  const lines: string[] = [title];

  const header = summarize(question.header, limits.questionChars);
  if (header) lines.push(`**${header}**`);

  const text = summarize(question.question, limits.questionChars);
  lines.push(text || '（无问题文本）');

  const options = question.options ?? [];
  const multi = question.multiSelect === true;
  options.forEach((option, optionIndex) => {
    const label = summarize(option.label, limits.optionChars) || '（未命名选项）';
    const description = summarize(option.description, limits.optionChars);
    lines.push(`${optionIndex + 1}. ${label}${description ? ` · ${description}` : ''}`);
  });

  lines.push('');
  if (options.length > 0) {
    const multiHint = multi ? '（多选可用逗号分隔，如 1,3）' : '';
    lines.push(
      withButtons
        ? `> 👇 点击下方按钮选择，或回复编号/字母${multiHint}，也可直接输入文字`
        : `> 💡 回复编号选择${multiHint}，或直接输入你的想法`,
    );
  } else {
    lines.push('> 💬 直接回复文字回答');
  }
  return lines.join('\n');
}

/** 判断问题能否用按钮作答（单选 + 有选项） */
export function canRenderQuestionKeyboard(question: NotificationQuestion): boolean {
  const options = question.options ?? [];
  return options.length > 0 && question.multiSelect !== true;
}

/**
 * 解析 QQ 文本回复 → 单个问题的答案。
 *
 * 支持：编号 1/2/3、字母 A/B/C、多选用逗号/空格分隔的编号或字母、
 * 与选项 label 完全一致的文本；解析不出选项时视为自定义文字回答。
 */
export function parseNotificationAnswer(question: NotificationQuestion, rawText: string): ParsedAnswer {
  const id = question.id;
  const text = String(rawText ?? '').trim();
  const options = question.options ?? [];
  const labels = options
    .map((option) => option.label)
    .filter((label): label is string => typeof label === 'string' && label.length > 0);
  const multi = question.multiSelect === true;

  if (!text) return { kind: 'invalid', note: '空回复' };

  if (labels.length > 0) {
    // 单字母 A/B/C
    const letter = /^[A-Za-z]$/.exec(text);
    if (letter) {
      const index = letter[0].toUpperCase().charCodeAt(0) - 65;
      const label = labels[index];
      if (index >= 0 && label !== undefined) return { kind: 'answer', answer: { id, selected: [label] } };
      return { kind: 'invalid', note: `选项范围是 A–${String.fromCharCode(65 + labels.length - 1)}` };
    }

    // 纯编号（可含逗号/空格分隔；多选时全部采用，单选取第一个）
    if (/^[\d\s,，、;；./]+$/.test(text)) {
      const picked: string[] = [];
      for (const match of text.matchAll(/\d+/g)) {
        const index = Number(match[0]) - 1;
        const label = labels[index];
        if (index >= 0 && label !== undefined && !picked.includes(label)) picked.push(label);
      }
      if (picked.length > 0) {
        return { kind: 'answer', answer: { id, selected: multi ? picked : picked.slice(0, 1) } };
      }
      return { kind: 'invalid', note: `选项范围是 1–${labels.length}` };
    }

    // 多选：字母序列（A C / A,C）
    if (multi && /^[A-Za-z\s,，、;；]+$/.test(text)) {
      const picked: string[] = [];
      for (const char of text.toUpperCase()) {
        if (!/[A-Z]/.test(char)) continue;
        const index = char.charCodeAt(0) - 65;
        const label = labels[index];
        if (index >= 0 && label !== undefined && !picked.includes(label)) picked.push(label);
      }
      if (picked.length > 0) return { kind: 'answer', answer: { id, selected: picked } };
    }

    // 与某个选项 label 完全一致（忽略大小写）
    const exact = options.find(
      (option) => typeof option.label === 'string' && option.label.toLowerCase() === text.toLowerCase(),
    );
    if (exact) return { kind: 'answer', answer: { id, selected: [exact.label] } };
  }

  // 解析不出选项：视为自定义文字回答（与 dsh 自定义答案语义一致）
  return { kind: 'answer', answer: { id, selected: [], custom: text } };
}

/** 截断被 gate 的命令回显（0 = 不截断） */
export function truncateCommand(command: string, maxChars: number): string {
  const text = String(command ?? '');
  const limit = Number(maxChars) || 0;
  if (limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/** 审批推送文本（含工具名、命令回显、原因与作答引导） */
export function formatNotificationApproval(
  request: Pick<NotificationApprovalRequest, 'toolName' | 'reason'>,
  command: string | undefined,
  limits: { commandChars: number },
  withButtons: boolean,
): string {
  const lines: string[] = ['🔐 **执行审批**', '', `🔧 工具: ${request.toolName}`];
  if (command) {
    lines.push('', '```', truncateCommand(command, limits.commandChars), '```');
  }
  if (request.reason) {
    lines.push('', `📝 ${request.reason}`);
  }
  lines.push('');
  lines.push(
    withButtons
      ? '> 👇 点击下方按钮确认，或回复「允许」/「拒绝」'
      : '> 💬 回复「允许」或「拒绝」（也可回 1/2）',
  );
  return lines.join('\n');
}

const APPROVAL_ALLOW_TOKENS = new Set(['允许', '同意', '批准', '确认', '允许一次', 'y', 'yes', 'ok', '1']);
const APPROVAL_DENY_TOKENS = new Set(['拒绝', '不允许', '否', '不', 'n', 'no', '2']);

/** 解析审批文本回复：允许 / 拒绝 / 无法识别 */
export function parseApprovalDecision(rawText: string): 'allow' | 'deny' | undefined {
  const text = String(rawText ?? '').trim().toLowerCase();
  if (!text) return undefined;
  if (APPROVAL_ALLOW_TOKENS.has(text)) return 'allow';
  if (APPROVAL_DENY_TOKENS.has(text)) return 'deny';
  return undefined;
}

/**
 * 判断错误是否为「宿主没有可用 provider/answerer」。
 *
 * 这种情况下 Web/CLI 无法作答，QQ 通知必须继续等待用户回复，不能把错误抛回去。
 */
export function isNoProviderError(error: unknown): boolean {
  const err = error as { code?: unknown; info?: { code?: unknown }; message?: unknown } | null | undefined;
  const code = String(err?.code ?? err?.info?.code ?? '');
  const message = String(err?.message ?? '');
  if (code === 'NO_PROVIDER' || code === 'NO_APPROVAL_PROVIDER' || code === 'NO_QUESTION_PROVIDER') return true;
  if (/no\s+[\w-]*\s*(provider|answerer|channel)\b/i.test(message)) return true;
  return /没有可用的(确认|回答|问答)通道/.test(message);
}
