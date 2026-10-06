import { LOCAL_PROMPTS, loadPrompt, PROMPT_CATALOG, type RuntimePromptName } from './catalog';
import { PromptContractError, snapshotPromptSource, type PromptSource } from './template';

it('公共本地源直接提供全部十二条运行时模板', async () => {
  const names = Object.keys(PROMPT_CATALOG) as RuntimePromptName[];
  expect(names).toHaveLength(12);
  for (const name of names) {
    expect(await loadPrompt(LOCAL_PROMPTS, name)).toMatchObject({
      name,
      source: 'local',
      version: null,
      text: expect.any(String),
    });
  }
  await expect(LOCAL_PROMPTS.load('未注册模板')).rejects.toThrow('本地没有提示词');
});

it.each([new Error('平台离线'), new PromptContractError('源拒绝读取')])(
  '提示词源加载失败直接抛出：%s',
  async (error) => {
    const source: PromptSource = { load: jest.fn().mockRejectedValue(error) };
    await expect(loadPrompt(source, 'knowledge/organize-user')).rejects.toBe(error);
    expect(source.load).toHaveBeenCalledTimes(1);
  },
);

it('严格源的原始错误继续抛出，不取本地正文', async () => {
  const error = new Error('固定版本不可用');
  const source: PromptSource = { load: jest.fn().mockRejectedValue(error) };
  await expect(loadPrompt(source, 'experience/extract-user')).rejects.toBe(error);
  expect(source.load).toHaveBeenCalledTimes(1);
});

it('加载成功后的必需变量错误不进入回退', async () => {
  const source: PromptSource = {
    load: async (name) => ({ name, text: '{{rules}}', version: 3, source: 'platform' }),
  };
  await expect(loadPrompt(source, 'knowledge/organize-user')).rejects.toThrow(
    '缺少必需变量: targets, source',
  );
});

it('完整固定快照保留正文和版本，不受本地来源替换影响', async () => {
  const template = {
    ...(await LOCAL_PROMPTS.load('experience/extract-user')),
    text: '{{identity}}\n{{review}}\n{{evidence}}\n固定版本正文',
    version: 9,
    source: 'platform' as const,
  };
  expect(await loadPrompt(snapshotPromptSource([template]), 'experience/extract-user')).toEqual(
    template,
  );
});
