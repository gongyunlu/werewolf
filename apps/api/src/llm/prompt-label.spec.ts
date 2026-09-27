import { applyPromptLabel, previewPromptLabel, validateProjectPrompt } from './prompt-label';
import { LOCAL_TURN_PROMPTS, TURN_PROMPT_NAMES } from '../turn/prompt';
import { EXPERIENCE_PROMPTS, LOCAL_EXPERIENCE_PROMPTS } from '../experience/prompt';

const selection = { name: 'turn/generate-system', label: 'production', version: 2 };

function platform() {
  const rows = new Map(
    [1, 2].map((version) => [
      version,
      {
        name: selection.name,
        type: 'text',
        prompt: `{{seatNo}}号 {{role}}，版本 ${version}`,
        version,
        labels: version === 1 ? ['production', 'keep-first'] : ['latest', 'staging', 'keep-second'],
      },
    ]),
  );
  const get = jest.fn(async (_name: string, query: { version?: number; label?: string }) => {
    const row =
      query.version !== undefined
        ? rows.get(query.version)
        : [...rows.values()].find((item) => item.labels.includes(query.label!));
    if (!row) throw { statusCode: 404 };
    return structuredClone(row);
  });
  const update = jest.fn(async (_name: string, version: number, body: { newLabels: string[] }) => {
    for (const row of rows.values())
      row.labels = row.labels.filter((label) => !body.newLabels.includes(label));
    rows.get(version)!.labels.push(...body.newLabels);
    return structuredClone(rows.get(version)!);
  });
  return { rows, get, update, api: { prompts: { get }, promptVersion: { update } } as never };
}

it('预览返回当前和目标正文，不移动标签、不走缓存', async () => {
  const p = platform();
  const preview = await previewPromptLabel(p.api, selection);
  expect(preview.current?.version).toBe(1);
  expect(preview.target.text).toContain('版本 2');
  expect(p.update).not.toHaveBeenCalled();
  expect(p.get).toHaveBeenCalledWith(selection.name, { version: 2 }, { maxRetries: 0 });
  expect(p.get).toHaveBeenCalledWith(selection.name, { label: 'production' }, { maxRetries: 0 });
});

it('移动单个标签并读回，回退复用旧版本，其他标签保留', async () => {
  const p = platform();
  const preview = await previewPromptLabel(p.api, selection);
  expect(await applyPromptLabel(p.api, preview, 1)).toEqual({
    changed: true,
    beforeVersion: 1,
    afterVersion: 2,
  });
  expect(p.update).toHaveBeenCalledWith(
    selection.name,
    2,
    { newLabels: ['production'] },
    { maxRetries: 0 },
  );
  expect(p.rows.get(1)!.labels).toEqual(['keep-first']);
  expect(p.rows.get(2)!.labels).toEqual(['latest', 'staging', 'keep-second', 'production']);
  const rollback = await previewPromptLabel(p.api, { ...selection, version: 1 });
  expect(await applyPromptLabel(p.api, rollback, 2)).toEqual({
    changed: true,
    beforeVersion: 2,
    afterVersion: 1,
  });
  expect(p.rows.size).toBe(2);
});

it('已在目标版本时不重复写，缺失标签可显式从 none 建立', async () => {
  const p = platform();
  const current = await previewPromptLabel(p.api, { ...selection, version: 1 });
  expect((await applyPromptLabel(p.api, current, 1)).changed).toBe(false);
  expect(p.update).not.toHaveBeenCalled();
  const missing = await previewPromptLabel(p.api, { ...selection, label: 'canary' });
  expect(missing.current).toBeNull();
  expect(await applyPromptLabel(p.api, missing, null)).toEqual({
    changed: true,
    beforeVersion: null,
    afterVersion: 2,
  });
});

it('当前版本与调用者预期不一致时停止，不覆盖其他发布', async () => {
  const p = platform();
  const preview = await previewPromptLabel(p.api, selection);
  await expect(applyPromptLabel(p.api, preview, 2)).rejects.toThrow('--expected');
  expect(p.update).not.toHaveBeenCalled();
});

it('目标正文在预览后变化时停止', async () => {
  const p = platform();
  const preview = await previewPromptLabel(p.api, selection);
  p.rows.get(2)!.prompt = '变化后的正文';
  await expect(applyPromptLabel(p.api, preview, 1)).rejects.toThrow('正文在预览后发生变化');
  expect(p.update).not.toHaveBeenCalled();
});

it('权限错误和目标版本缺失不会被当作标签缺失', async () => {
  const p = platform();
  await expect(previewPromptLabel(p.api, { ...selection, version: 99 })).rejects.toMatchObject({
    statusCode: 404,
  });
  p.get.mockRejectedValue({ statusCode: 403 });
  await expect(previewPromptLabel(p.api, selection)).rejects.toMatchObject({ statusCode: 403 });
  expect(p.update).not.toHaveBeenCalled();
});

it('写入异常不自动重试或回退，读回不一致不报告成功', async () => {
  const p = platform();
  const preview = await previewPromptLabel(p.api, selection);
  p.update.mockRejectedValueOnce(new Error('连接中断'));
  await expect(applyPromptLabel(p.api, preview, 1)).rejects.toThrow('连接中断');
  expect(p.update).toHaveBeenCalledTimes(1);
  p.update.mockImplementation(async () => structuredClone(p.rows.get(2)!));
  await expect(applyPromptLabel(p.api, preview, 1)).rejects.toThrow('读回不一致');
  expect(p.update).toHaveBeenCalledTimes(2);
});

it('拒绝维护 latest、非法版本和非文本模板', async () => {
  const p = platform();
  await expect(previewPromptLabel(p.api, { ...selection, label: 'latest' })).rejects.toThrow(
    'latest',
  );
  await expect(previewPromptLabel(p.api, { ...selection, version: 0 })).rejects.toThrow();
  expect(p.get).not.toHaveBeenCalled();
  p.rows.get(2)!.type = 'chat';
  await expect(previewPromptLabel(p.api, selection)).rejects.toThrow('文本模板');
});

it.each([...Object.values(TURN_PROMPT_NAMES), ...Object.values(EXPERIENCE_PROMPTS)])(
  '沿用真实渲染契约检查 %s',
  async (name) => {
    const source = name.startsWith('turn/') ? LOCAL_TURN_PROMPTS : LOCAL_EXPERIENCE_PROMPTS;
    await expect(validateProjectPrompt(await source.load(name))).resolves.toBeUndefined();
  },
);

it('缺少必需变量、未知变量与不支持的模板均失败', async () => {
  const source = await LOCAL_TURN_PROMPTS.load('turn/generate-system');
  await expect(validateProjectPrompt({ ...source, text: '只有 {{seatNo}}' })).rejects.toThrow(
    '必需变量',
  );
  await expect(
    validateProjectPrompt({ ...source, text: `${source.text} {{future}}` }),
  ).rejects.toThrow('缺少变量');
  const experience = await LOCAL_EXPERIENCE_PROMPTS.load(EXPERIENCE_PROMPTS.user);
  await expect(
    validateProjectPrompt({ ...experience, text: `${experience.text} {{future}}` }),
  ).rejects.toThrow('缺少变量');
  await expect(validateProjectPrompt({ ...source, name: 'other/prompt' })).rejects.toThrow(
    '仅支持',
  );
});
