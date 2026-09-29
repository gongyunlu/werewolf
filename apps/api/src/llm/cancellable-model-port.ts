import { ModelCallError, type ModelPort } from './model-port';

/** 对局停止与单次行动取消都能中止请求，也能打断重试等待。 */
export function cancellableModelPort(port: ModelPort, signal: AbortSignal): ModelPort {
  return {
    async generate(request, access, call = {}) {
      const combined = call.signal ? AbortSignal.any([signal, call.signal]) : signal;
      if (combined.aborted)
        throw new ModelCallError('deadline', '这次调用已被中止', { cause: combined.reason });
      return port.generate(request, access, { ...call, signal: combined });
    },
  };
}
