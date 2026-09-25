import { LangfuseClient } from '@langfuse/client';
import { langfusePromptSource } from './langfuse-prompt-source';

jest.mock('@langfuse/client', () => ({ LangfuseClient: jest.fn() }));

it('默认仍在取用时读取 production，显式版本不带标签且不使用缓存', async () => {
  const get = jest.fn().mockResolvedValue({ prompt: '正文', version: 3 });
  jest
    .mocked(LangfuseClient)
    .mockImplementation(() => ({ prompt: { get } }) as unknown as LangfuseClient);
  const source = langfusePromptSource({
    baseUrl: 'http://localhost:3100',
    publicKey: 'test',
    secretKey: 'test',
  });
  expect(get).not.toHaveBeenCalled();
  await source.load('turn/generate-system');
  expect(get).toHaveBeenLastCalledWith('turn/generate-system', {
    label: 'production',
    type: 'text',
    cacheTtlSeconds: 60,
  });
  get.mockResolvedValueOnce({ prompt: '移动标签后的正文', version: 4 });
  expect((await source.load('turn/generate-system')).version).toBe(4);
  expect(await source.load('turn/generate-system', 3)).toEqual({
    name: 'turn/generate-system',
    text: '正文',
    version: 3,
    source: 'platform',
  });
  expect(get).toHaveBeenLastCalledWith('turn/generate-system', {
    version: 3,
    type: 'text',
    cacheTtlSeconds: 0,
  });
  get.mockRejectedValueOnce(new Error('版本不存在'));
  await expect(source.load('turn/generate-system', 99)).rejects.toThrow('版本不存在');
});
