import type { ActionStep, PreviewChunk } from '@werewolf/shared';

export interface LiveAction {
  actionKey: string;
  seatNo: number;
  day: number;
  actionType: string;
  steps: (ActionStep & { callId?: string })[];
}

/** 按行动和节点分流；模型重试只替换该节点的草稿。 */
export function mergePreview(current: LiveAction | undefined, chunk: PreviewChunk): LiveAction {
  const steps = [...(current?.steps ?? [])];
  const index = steps.findIndex((step) => step.name === chunk.step);
  const previous = steps[index];
  const step = previous ?? {
    id: chunk.step,
    name: chunk.step,
    status: 'running',
    content: '',
    reasoning: null,
  };
  if (chunk.channel === 'node') {
    steps[index < 0 ? steps.length : index] = {
      ...step,
      status: chunk.status,
      thinkingMs: chunk.thinkingMs ?? step.thinkingMs,
      ...(chunk.text ? { content: chunk.text } : {}),
    };
  } else {
    const keeping = previous?.callId === chunk.callId;
    steps[index < 0 ? steps.length : index] = {
      ...step,
      callId: chunk.callId,
      status: 'running',
      thinkingMs: chunk.thinkingMs ?? null,
      reasoning: chunk.channel === 'reasoning' ? chunk.text : keeping ? step.reasoning : null,
      content: chunk.channel === 'content' ? chunk.text : keeping ? step.content : '',
    };
  }
  return {
    actionKey: chunk.actionKey,
    seatNo: chunk.seatNo,
    day: chunk.day,
    actionType: chunk.actionType,
    steps,
  };
}
