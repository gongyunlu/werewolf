import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { applyPromptLabel, previewPromptLabel, validateProjectPrompt } from '../llm/prompt-label';

async function main() {
  const { values } = parseArgs({
    options: {
      prompt: { type: 'string' },
      version: { type: 'string' },
      label: { type: 'string' },
      expected: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values.prompt || !values.version || !values.label || (values.apply && !values.expected))
    throw new Error(
      '用法：prompt:label --prompt <名称> --version <版本> --label <标签> [--apply --expected <当前版本|none>]',
    );
  const expected =
    values.expected === 'none'
      ? null
      : values.expected === undefined
        ? undefined
        : z.number().int().positive().parse(Number(values.expected));
  loadEnvFiles();
  const env = loadEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) throw new Error('未配置 Langfuse');
  const client = new LangfuseClient({
    baseUrl: env.LANGFUSE_HOST,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  });
  const preview = await previewPromptLabel(client.api, {
    name: values.prompt,
    version: Number(values.version),
    label: values.label,
  });
  await validateProjectPrompt(preview.target);
  const directory = resolve(__dirname, '../../../../docs/prompt-labels', randomUUID());
  await mkdir(directory, { recursive: true });
  const save = (file: string, data: unknown) =>
    writeFile(resolve(directory, file), JSON.stringify(data, null, 2), 'utf8');
  await save('preview.json', preview);
  Logger.log(
    JSON.stringify({
      prompt: preview.name,
      label: preview.label,
      currentVersion: preview.current?.version ?? null,
      targetVersion: preview.target.version,
      directory,
    }),
  );
  if (!values.apply) {
    Logger.log('预览完成，未移动标签。加 --apply --expected <当前版本|none> 执行。');
    return;
  }
  try {
    const result = await applyPromptLabel(client.api, preview, expected!);
    await save('result.json', {
      status: 'verified',
      ...result,
      verifiedAt: new Date().toISOString(),
    });
    Logger.log(JSON.stringify(result));
  } catch (error) {
    await save('result.json', { status: 'not_verified', checkedAt: new Date().toISOString() });
    throw error;
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '标签操作失败，请核查平台当前状态');
  process.exitCode = 1;
});
