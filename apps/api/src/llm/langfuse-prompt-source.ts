import { LangfuseClient } from '@langfuse/client';
import type { PromptSource, PromptTemplate } from './prompt-template';

/** 平台接入信息。凭据由调用方从环境里取好传进来，这个模块不碰环境变量。 */
export interface LangfusePromptConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

/**
 * 显式版本优先，未指定时仍按原有方式取 production。
 *
 * 不传 SDK 的 fallback 选项：传了它会在请求失败时塞一份回退正文回来而不抛错，
 * 那份东西不是平台上的模板，混进来就成了拿旧正文冒充线上的。不传就没这条路。
 */
export function langfusePromptSource(config: LangfusePromptConfig): PromptSource {
  const client = new LangfuseClient(config);

  return {
    async load(name: string, version?: number): Promise<PromptTemplate> {
      const prompt = await client.prompt.get(name, {
        ...(version === undefined ? { label: 'production' } : { version }),
        type: 'text',
        cacheTtlSeconds: version === undefined ? 60 : 0,
      });

      return { name, text: prompt.prompt, version: prompt.version, source: 'platform' };
    },
  };
}
