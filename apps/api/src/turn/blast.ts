import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import { ModelCallError } from '../llm/model-port';
import type { ActionControl, AcceptedGeneration } from './graph';

const BlastState = new StateSchema({
  winnerId: z.string().nullable().default(null),
  generated: z.custom<AcceptedGeneration | null>().default(null),
});

/** 窗口裁决独立落检查点；恢复复用裁决，不按行动记录的读取顺序重新竞速。 */
export async function chooseBlaster(
  saver: BaseCheckpointSaver,
  threadId: string,
  wolfIds: readonly string[],
  request: (wolfId: string, control: ActionControl) => Promise<boolean>,
): Promise<string | null> {
  let winnerId: string | null = null;
  let pending: Promise<PromiseSettledResult<boolean>[]> | undefined;
  const graph = new StateGraph(BlastState)
    .addNode('decide', async () => {
      const controllers = new Map(wolfIds.map((id) => [id, new AbortController()]));
      let resolve!: (value: typeof BlastState.State) => void;
      let reject!: (error: unknown) => void;
      const decision = new Promise<typeof BlastState.State>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const accept = (id: string, value: unknown) => {
        if (value !== true || winnerId !== null) return;
        winnerId = id;
        for (const [other, controller] of controllers) {
          if (other !== id) controller.abort();
        }
      };
      pending = Promise.allSettled(
        wolfIds.map(async (id) => {
          const value = await request(id, {
            signal: controllers.get(id)!.signal,
            onAnswer: (answer) => accept(id, answer),
            onGenerated: (generated) => {
              if (winnerId === id) resolve({ winnerId: id, generated });
            },
          });
          // 从行动检查点复用结果时，不会再触发生成回调。
          accept(id, value);
          if (winnerId === id) resolve({ winnerId: id, generated: null });
          return value;
        }),
      );
      void pending.then((results) => {
        const failed =
          results.find(
            (result) => result.status === 'rejected' && !(result.reason instanceof ModelCallError),
          ) ?? results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') reject(failed.reason);
        else resolve({ winnerId, generated: null });
        return undefined;
      });
      return decision;
    })
    .addEdge(START, 'decide')
    .addEdge('decide', END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: threadId }, durability: 'sync' as const };
  const saved = await saver.getTuple(config);
  let decision: typeof BlastState.State;
  try {
    decision = await graph.invoke(saved ? null : {}, config);
  } finally {
    // 裁决写入失败也必须等已发出的调用收尾，不能遗留后台任务。
    await pending;
  }
  for (const [index, result] of ((await pending) ?? []).entries()) {
    if (result.status !== 'rejected') continue;
    // 败方的模型失败不推翻赢家；权威记录写入失败仍然阻止业务推进。
    if (
      wolfIds[index] !== decision.winnerId &&
      decision.winnerId !== null &&
      result.reason instanceof ModelCallError
    )
      continue;
    throw result.reason;
  }
  if (!pending && decision.winnerId !== null) {
    // 裁决可能早于赢家行动的检查点/提交落库；只用已保存答复补完，绝不重新询问模型。
    await request(decision.winnerId, {
      signal: new AbortController().signal,
      onAnswer: () => {},
      onGenerated: () => {},
      ...(decision.generated ? { generated: decision.generated } : {}),
    });
  }
  return decision.winnerId;
}
