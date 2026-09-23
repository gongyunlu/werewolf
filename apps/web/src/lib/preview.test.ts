import type { PreviewChunk } from '@werewolf/shared';
import { describe, expect, it } from 'vitest';
import { mergePreview } from './preview';

describe('行动预览', () => {
  const base = {
    actionKey: 'a1',
    day: 1,
    seatNo: 1,
    actionType: 'vote',
    step: 'generate',
    callId: 'c1',
  };

  it('节点完成保留思考，下一节点重试不清掉已完成节点', () => {
    const chunks: PreviewChunk[] = [
      { ...base, channel: 'reasoning', text: '生成时的思考' },
      { ...base, channel: 'node', callId: 'task1', status: 'completed', text: '2' },
      { ...base, step: 'critique', callId: 'c2', channel: 'reasoning', text: '复核初稿' },
      { ...base, step: 'critique', callId: 'c3', channel: 'reasoning', text: '复核重试' },
    ];
    const result = chunks.reduce<ReturnType<typeof mergePreview> | undefined>(
      mergePreview,
      undefined,
    )!;
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      status: 'completed',
      content: '2',
      reasoning: '生成时的思考',
    });
    expect(result.steps[1]).toMatchObject({ status: 'running', reasoning: '复核重试' });
  });
});
