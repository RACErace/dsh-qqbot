/**
 * interaction 分发器回归测试
 *
 * 回归点：通道 handleInteraction 返回 boolean，串联不能用 `??`——
 * 曾经用 `??` 导致「QQ 会话通道返回 false」把兜底的通知通道短路掉，
 * 通知卡片上的按钮点击永远不生效（QQ 客户端提示「请勿重复操作」）。
 */
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { describe, expect, it, vi } from 'vitest';
import { dispatchInteraction } from './interaction-dispatch.ts';
import type { InteractionDispatchManagerLike } from './interaction-dispatch.ts';

function event(button: unknown): InteractionEvent {
  return {
    id: 'interaction-1',
    data: { resolved: { button_data: JSON.stringify(button) } },
  } as unknown as InteractionEvent;
}

describe('dispatchInteraction', () => {
  it('QQ 会话通道返回 false 时，仍会尝试通知通道（`??` 回归）', () => {
    const notificationChannel = { handleInteraction: vi.fn(() => true) };
    const manager: InteractionDispatchManagerLike = {
      questionChannel: { handleInteraction: vi.fn(() => false) },
      notificationChannel,
    };
    expect(dispatchInteraction(event({ t: 'question', q: 'q1', i: 0 }), manager)).toBe(true);
    expect(notificationChannel.handleInteraction).toHaveBeenCalledTimes(1);
  });

  it('通知通道返回 true 时不再重复调用后续通道', () => {
    const manager: InteractionDispatchManagerLike = {
      approvalChannel: { handleInteraction: vi.fn(() => true) },
      notificationChannel: { handleInteraction: vi.fn(() => true) },
    };
    expect(dispatchInteraction(event({ t: 'approval', d: 'allow' }), manager)).toBe(true);
    expect(manager.notificationChannel?.handleInteraction).not.toHaveBeenCalled();
  });

  it('所有通道都未处理时返回 false', () => {
    const manager: InteractionDispatchManagerLike = {
      questionChannel: { handleInteraction: () => false },
      notificationChannel: { handleInteraction: () => false },
    };
    expect(dispatchInteraction(event({ t: 'question', q: 'q1', i: 0 }), manager)).toBe(false);
  });

  it('缺少通道/缺 button_data/未知判别字段时返回 false', () => {
    expect(dispatchInteraction(event({ t: 'question', q: 'q1', i: 0 }), {})).toBe(false);
    const empty = { data: {} } as unknown as InteractionEvent;
    expect(dispatchInteraction(empty, {})).toBe(false);
    const manager: InteractionDispatchManagerLike = {
      questionChannel: { handleInteraction: vi.fn(() => true) },
      approvalChannel: { handleInteraction: vi.fn(() => true) },
      notificationChannel: { handleInteraction: vi.fn(() => true) },
    };
    expect(dispatchInteraction(event({ t: 'unknown' }), manager)).toBe(false);
    expect(manager.questionChannel?.handleInteraction).not.toHaveBeenCalled();
    expect(manager.approvalChannel?.handleInteraction).not.toHaveBeenCalled();
  });
});
