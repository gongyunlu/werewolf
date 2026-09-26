import { createHash } from 'node:crypto';
import { endpointOf } from './model-capability';
import { ModelCallError } from './model-port';
import type { CallCompletion, CallIdentity, CallRecording } from './observation';
import { callSpan, finishCall, finishRequest, requestSpan, traceIds } from './telemetry';
import type {
  ModelAccess,
  ModelCallOptions,
  ModelPort,
  ModelRequest,
  ModelTool,
} from './model-port';

async function persist<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw new Error('模型观测写入失败', { cause: error });
  }
}

/** 一次提问：题面送出去那一刻的样子。答复是另一回事，崩掉的那一问根本没有答复。 */
export interface AskedPrompt {
  experiences?: ModelRequest['experiences'];
  observation?: CallIdentity & { endpointKey: string; traceId?: string; spanId?: string };
  /** 用的哪个型号：同一局换过型号的话，题面一样也不是同一问。 */
  model: string;
  system: string;
  prompt: string;
  /** 这一问要它走的工具定义；要让模型写一段话的那几问（发言）不走工具。 */
  tool?: ModelTool;
}

/**
 * 给端口加一层：每一问送出去之前，先把这份提问落一份。
 *
 * 落的是发出去那一刻，不是答完之后：卡死在某一问时，那一问当初看到了什么在库里查得到——
 * 答完才写的那份快照这时候还不存在。
 *
 * 记不下来就当场抛、不往下发：库都写不进去了，这一局后面每一步的记录也写不进去，
 * 瞒着这一次发出去只是再欠一次「为什么库里没有那一行」。
 *
 * 这一层要包在重试那一层外面（见 retrying-model-port）：那边重发的是同一份题面，
 * 包在里面就是把同一份落好几遍；而「重问时附了什么」是解析那一层的重问，本来各是一次调用。
 */
export function recordingModelPort(
  port: ModelPort,
  record: (asked: AskedPrompt) => Promise<CallRecording | void>,
  scope?: { gameId: string; actionKey: string | null; summaryKey?: string },
): ModelPort {
  return {
    async generate(request: ModelRequest, access: ModelAccess, call: ModelCallOptions = {}) {
      const started = performance.now();
      const span =
        scope && call.identity
          ? callSpan(scope.gameId, { ...scope, ...call.identity, prompts: request.prompts ?? [] })
          : undefined;
      const recording = await record({
        model: access.model,
        system: request.system,
        prompt: request.prompt,
        tool: request.tool,
        experiences: request.experiences,
        ...(call.identity
          ? {
              observation: {
                ...call.identity,
                endpointKey: createHash('sha256').update(endpointOf(access.baseUrl)).digest('hex'),
                ...traceIds(span),
              },
            }
          : {}),
      }).catch((error: unknown) => {
        finishCall(span, {
          status: 'failed',
          failureCode: 'storage',
          durationMs: performance.now() - started,
        });
        throw error;
      });
      if (!recording) return port.generate(request, access, call);
      let attemptNo = 0;
      const finish = async (
        status: 'accepted' | 'invalid_output' | 'failed' | 'cancelled',
        failureCode: string | null,
        beforeWrite?: (result: CallCompletion) => void,
      ) => {
        const result = { status, failureCode, durationMs: performance.now() - started };
        beforeWrite?.(result);
        finishCall(span, result);
        await persist(() => recording.finish(result));
      };
      try {
        const response = await port.generate(request, access, {
          ...call,
          startAttempt: async () => {
            const number = ++attemptNo;
            await persist(() => recording.startAttempt(number));
            let generation: ReturnType<typeof requestSpan>;
            return {
              dispatched() {
                generation = requestSpan(
                  span,
                  access.model,
                  number,
                  {
                    ...scope,
                    ...call.identity,
                  },
                  request,
                );
              },
              async finish(result) {
                finishRequest(generation, result);
                await persist(() =>
                  recording.finishAttempt(number, { ...result, ...traceIds(generation) }),
                );
              },
            };
          },
        });
        return {
          ...response,
          completeObservation: (status, beforeWrite) =>
            finish(
              status,
              status === 'accepted' ? null : status === 'failed' ? 'internal' : status,
              beforeWrite,
            ),
        };
      } catch (error) {
        const code = error instanceof ModelCallError ? error.code : 'internal';
        await finish(code === 'deadline' ? 'cancelled' : 'failed', code);
        throw error;
      }
    },
  };
}
