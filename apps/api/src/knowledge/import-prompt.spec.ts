import { IMPORT_PROMPTS } from '../prompts/catalog';
import { snapshotPromptSource, type PromptSource } from '../prompts/template';
import { importPrompts, importRequest } from './import-prompt';
import { importFixture, page } from './import-testing';

const offline: PromptSource = {
  async load() {
    throw new Error('平台离线');
  },
};

it('知识整理请求保留完整文本、选中段落和模板来源', async () => {
  const f = await importFixture(undefined, {
    ...page,
    paragraphs: [...page.paragraphs, { id: 'P2', text: '未选中的段落' }],
  });
  const row = (await f.stores.knowledgeImports.find(f.id))!;
  row.state.organization!.input.rules = [{ id: '12p_wolf_king', text: '固定板子规则' }];
  const { tool, ...request } = importRequest(row);
  expect(request).toMatchSnapshot();
  expect(tool.name).toBe('submit');
  expect(request.prompt).not.toContain('未选中的段落');
});

it('普通源失败时回退本地，固定快照缺失时抛错', async () => {
  expect(await importPrompts(offline)).toMatchObject([
    { name: IMPORT_PROMPTS.system, version: null, source: 'local' },
    { name: IMPORT_PROMPTS.user, version: null, source: 'local' },
  ]);
  await expect(importPrompts(snapshotPromptSource([]))).rejects.toThrow('固定快照没有');
});

it('成功加载的模板缺少契约变量时不回退', async () => {
  const broken: PromptSource = {
    async load(name) {
      return { name, text: '删除了全部变量', source: 'platform', version: 7 };
    },
  };
  await expect(importPrompts(broken)).rejects.toThrow('缺少必需变量');
});

it('远端版本保留来源，新增未知变量在真实渲染时报错', async () => {
  const f = await importFixture();
  const row = (await f.stores.knowledgeImports.find(f.id))!;
  const local = snapshotPromptSource(await importPrompts(offline));
  const platform: PromptSource = {
    async load(name) {
      return { ...(await local.load(name)), source: 'platform', version: 7 };
    },
  };
  row.state.organization!.input.prompts = await importPrompts(platform);
  expect(importRequest(row).prompts).toEqual(
    Object.values(IMPORT_PROMPTS).map((name) => ({ name, source: 'platform', version: 7 })),
  );
  row.state.organization!.input.prompts[0]!.text += '\n{{unknown}}';
  expect(() => importRequest(row)).toThrow('缺少变量: unknown');
});
