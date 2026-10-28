/**
 * 通知渲染/解析纯函数测试（fork 新增）
 *
 * 覆盖：任务完成文本、提问卡片、答题解析（编号/字母/多选/自定义）、
 * 审批文本与决策解析、无 provider 错误识别。
 */
import { describe, expect, it } from 'vitest';
import {
  canRenderQuestionKeyboard,
  extractAssistantText,
  formatDoneNotification,
  formatNotificationApproval,
  formatNotificationQuestion,
  isNoProviderError,
  parseApprovalDecision,
  parseNotificationAnswer,
  summarize,
  truncateCommand,
} from './format.ts';
import type { NotificationQuestion } from './types.ts';

describe('summarize', () => {
  it('压平空白并截断', () => {
    expect(summarize('  a\n\n  b  ')).toBe('a b');
    expect(summarize('abcdef', 4)).toBe('abc…');
    expect(summarize('abcdef', 0)).toBe('abcdef');
    expect(summarize('')).toBe('');
  });
});

describe('extractAssistantText', () => {
  it('拼接文本块并保留段落换行', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: '第一段' },
        { type: 'tool-call', name: 'x' },
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段\n\n第二段');
    expect(extractAssistantText('纯字符串')).toBe('纯字符串');
    expect(extractAssistantText(undefined)).toBe('');
  });
});

describe('formatDoneNotification', () => {
  it('页眉 + 完整最终文本', () => {
    expect(
      formatDoneNotification({ text: ' 完成内容 ', header: '## ✅ DSH 任务完成', previewChars: 0 }),
    ).toBe('## ✅ DSH 任务完成\n完成内容');
  });

  it('previewChars 截断为单行预览', () => {
    expect(formatDoneNotification({ text: 'line1\nline2', header: '', previewChars: 6 })).toBe('line1…');
  });

  it('空文本返回空串（不推送）', () => {
    expect(formatDoneNotification({ text: '   ', header: 'x', previewChars: 0 })).toBe('');
  });
});

const single: NotificationQuestion = {
  id: 'q1',
  question: '选择部署环境',
  options: [{ label: '生产环境' }, { label: '测试环境' }],
};

const multi: NotificationQuestion = {
  id: 'q2',
  question: '选择要运行的检查',
  multiSelect: true,
  options: [{ label: '类型检查' }, { label: '单元测试' }, { label: 'Lint' }],
};

describe('parseNotificationAnswer', () => {
  it('编号选择', () => {
    expect(parseNotificationAnswer(single, '2')).toEqual({ kind: 'answer', answer: { id: 'q1', selected: ['测试环境'] } });
  });

  it('字母选择（大小写不敏感）', () => {
    expect(parseNotificationAnswer(single, 'a')).toEqual({ kind: 'answer', answer: { id: 'q1', selected: ['生产环境'] } });
  });

  it('多选编号', () => {
    expect(parseNotificationAnswer(multi, '1,3')).toEqual({
      kind: 'answer',
      answer: { id: 'q2', selected: ['类型检查', 'Lint'] },
    });
  });

  it('多选字母', () => {
    expect(parseNotificationAnswer(multi, 'a c')).toEqual({
      kind: 'answer',
      answer: { id: 'q2', selected: ['类型检查', 'Lint'] },
    });
  });

  it('选项 label 完全匹配', () => {
    expect(parseNotificationAnswer(single, '测试环境').answer.selected).toEqual(['测试环境']);
  });

  it('解析不出选项视为自定义文字回答', () => {
    expect(parseNotificationAnswer(single, '我想先看日志')).toEqual({
      kind: 'answer',
      answer: { id: 'q1', selected: [], custom: '我想先看日志' },
    });
  });

  it('越界编号提示重答', () => {
    expect(parseNotificationAnswer(single, '9')).toEqual({ kind: 'invalid', note: '选项范围是 1–2' });
    expect(parseNotificationAnswer(single, 'z')).toEqual({ kind: 'invalid', note: '选项范围是 A–B' });
  });

  it('无选项问题任意文字都是自定义答案', () => {
    const free: NotificationQuestion = { id: 'q3', question: '项目名？' };
    expect(parseNotificationAnswer(free, 'dsh-qqbot')).toEqual({
      kind: 'answer',
      answer: { id: 'q3', selected: [], custom: 'dsh-qqbot' },
    });
  });
});

describe('formatNotificationQuestion', () => {
  it('标题/问题/选项/引导齐全', () => {
    const text = formatNotificationQuestion(single, 0, 2, { questionChars: 120, optionChars: 60 }, true);
    expect(text).toContain('❓ DSH 需要你回答（第 1/2 题）');
    expect(text).toContain('选择部署环境');
    expect(text).toContain('1. 生产环境');
    expect(text).toContain('点击下方按钮选择');
  });

  it('按配置截断问题与选项', () => {
    const long: NotificationQuestion = {
      id: 'q4',
      question: '这是一个很长很长很长的问题',
      options: [{ label: '这是一个很长很长很长的选项' }],
    };
    const text = formatNotificationQuestion(long, 0, 1, { questionChars: 6, optionChars: 5 }, false);
    expect(text).toContain('这是一个很…');
    expect(text).toContain('这是一个…');
    expect(text).toContain('回复编号选择');
  });

  it('多选给出逗号分隔提示', () => {
    const text = formatNotificationQuestion(multi, 0, 1, { questionChars: 120, optionChars: 60 }, false);
    expect(text).toContain('（多选可用逗号分隔，如 1,3）');
  });

  it('按钮可用性：单选有选项才生成键盘', () => {
    expect(canRenderQuestionKeyboard(single)).toBe(true);
    expect(canRenderQuestionKeyboard(multi)).toBe(false);
    expect(canRenderQuestionKeyboard({ id: 'q5', question: '自由回答' })).toBe(false);
  });
});

describe('审批文本与决策', () => {
  it('渲染工具名/命令/原因/引导', () => {
    const text = formatNotificationApproval(
      { toolName: 'bash', reason: '需要执行构建' },
      'rm -rf dist',
      { commandChars: 500 },
      true,
    );
    expect(text).toContain('🔐 **执行审批**');
    expect(text).toContain('工具: bash');
    expect(text).toContain('rm -rf dist');
    expect(text).toContain('需要执行构建');
    expect(text).toContain('点击下方按钮确认');
  });

  it('命令回显按配置截断', () => {
    expect(truncateCommand('abcdef', 3)).toBe('abc…');
    expect(truncateCommand('abcdef', 0)).toBe('abcdef');
  });

  it('允许/拒绝文本判定', () => {
    expect(parseApprovalDecision('允许')).toBe('allow');
    expect(parseApprovalDecision('YES')).toBe('allow');
    expect(parseApprovalDecision('1')).toBe('allow');
    expect(parseApprovalDecision('拒绝')).toBe('deny');
    expect(parseApprovalDecision('no')).toBe('deny');
    expect(parseApprovalDecision('稍等')).toBeUndefined();
  });
});

describe('isNoProviderError', () => {
  it('识别宿主没有可用通道的错误', () => {
    expect(isNoProviderError({ code: 'NO_PROVIDER' })).toBe(true);
    expect(isNoProviderError(new Error('no user-questions answerer registered'))).toBe(true);
    expect(isNoProviderError(new Error('没有可用的确认通道'))).toBe(true);
    expect(isNoProviderError(new Error('network timeout'))).toBe(false);
    expect(isNoProviderError(undefined)).toBe(false);
  });
});
