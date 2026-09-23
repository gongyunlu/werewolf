import { z } from 'zod';

/**
 * 一个模型接入点的能力。
 * 只记「问法要不要变」的差异：同一套问法就能问出来的模型，不必在这儿多写一笔。
 * 具体哪个模型是哪一档由接入时声明，不在这份类型里枚举。
 */
export interface ModelCapability {
  /** 默认 required；不支持强制工具的端点显式声明 auto，结果仍由行动层校验。 */
  toolChoice?: 'required' | 'auto';
  /**
   * 关掉供应商自己思维链的请求体片段，直接并进请求。
   * 各家的参数名和形状都不一样，所以记的是片段本身而不是一个开关。
   * null 是不写这一段——端点默认是什么就是什么。默认开着思考的端点写 null，正好就是不关它。
   */
  reasoningOff: Record<string, unknown> | null;
}

/** 端点写法归一：协议与主机名的大小写、末尾斜杠、默认端口都归成一种，免得同一台机器被当成两台。 */
export function endpointOf(baseUrl: string): string {
  return new URL(baseUrl).href.replace(/\/$/, '');
}

/** 环境变量里那份声明的取值域；只在代码里存在的隐式配置不算配置。 */
const CAPABILITY_DECLARATIONS = z.array(
  z.object({
    baseUrl: z.url(),
    model: z.string().min(1),
    reasoningOff: z.record(z.string(), z.unknown()).nullable(),
    toolChoice: z.enum(['required', 'auto']).optional(),
  }),
);

/**
 * 取这个端点加型号的能力。
 * 只认环境变量里那份声明，没有就抛——拿一份猜的能力跑，错的是整局的结构化输出，
 * 比一开始就停下来难查得多。
 *
 * @param model 型号，按端点加型号两个一起认
 * @param baseUrl 端点
 * @param declarations 环境变量里那份 JSON 数组，没配就是空串
 */
export function resolveModelCapability(
  model: string,
  baseUrl: string,
  declarations: string,
): ModelCapability {
  const endpoint = endpointOf(baseUrl);
  const entries = declarations ? CAPABILITY_DECLARATIONS.parse(JSON.parse(declarations)) : [];
  const matched = entries.filter(
    (entry) => endpointOf(entry.baseUrl) === endpoint && entry.model === model,
  );
  if (matched.length > 1) throw new Error(`模型能力声明重复：${endpoint} / ${model}`);

  const declared = matched[0];
  if (!declared) throw new Error(`未声明该端点与模型的能力：${endpoint} / ${model}`);

  return {
    reasoningOff: declared.reasoningOff,
    ...(declared.toolChoice ? { toolChoice: declared.toolChoice } : {}),
  };
}
