/** 结构化输出的提交方式：原生 JSON Schema、强制工具调用、或只在提示词里要求输出 JSON。 */
export type StructuredOutputProtocol = 'jsonSchema' | 'functionCalling' | 'jsonMode';

/**
 * 一个模型接入点的能力。
 * 只记「问法要不要变」的差异：同一套问法就能问出来的模型，不必在这儿多写一笔。
 * 具体哪个模型是哪一档由接入时声明，不在这份类型里枚举。
 */
export interface ModelCapability {
  /** 结构化输出走哪条路提交。 */
  protocol: StructuredOutputProtocol;
  /** 是否容忍模型把整个 JSON 包在代码围栏里。 */
  allowCodeFence: boolean;
  /** 是否下发参数关掉供应商自己的思维链。 */
  disableReasoning: boolean;
}
