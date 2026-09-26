import { setupExperiencePrompts } from './setup-prompts';

function platform() {
  const stored = new Map<string, { name: string; type: string; prompt: string; version: number }>();
  const get = jest.fn(async (name: string) => {
    const row = stored.get(name);
    if (!row) throw { statusCode: 404 };
    return row;
  });
  const create = jest.fn(async (value) => {
    const row = { ...value, version: 1 };
    stored.set(value.name, row);
    return row;
  });
  return { stored, get, create, api: { get, create } as never };
}

it('创建缺失的 production 模板，读回版本；再次执行复用，保留平台正文', async () => {
  const p = platform();
  expect((await setupExperiencePrompts(p.api)).map((item) => item.version)).toEqual([1, 1]);
  expect(p.create).toHaveBeenCalledTimes(2);
  expect(p.create.mock.calls[0]![0].labels).toEqual(['production']);
  p.stored.get('experience/extract-system')!.prompt = '用户在平台维护的正文';
  expect((await setupExperiencePrompts(p.api))[0]!.text).toBe('用户在平台维护的正文');
  expect(p.create).toHaveBeenCalledTimes(2);
});

it('部分失败后只补缺失模板，不重复创建已成功的版本', async () => {
  const p = platform();
  const create = p.create.getMockImplementation()!;
  p.create.mockImplementationOnce(create).mockRejectedValueOnce(new Error('平台暂时失败'));
  await expect(setupExperiencePrompts(p.api)).rejects.toThrow('平台暂时失败');
  await setupExperiencePrompts(p.api);
  expect(
    p.create.mock.calls.filter(([item]) => item.name === 'experience/extract-system'),
  ).toHaveLength(1);
  expect(p.stored.size).toBe(2);
});

it('权限错误不当作模板缺失，不产生写入', async () => {
  const p = platform();
  p.get.mockRejectedValue({ statusCode: 401 });
  await expect(setupExperiencePrompts(p.api)).rejects.toMatchObject({ statusCode: 401 });
  expect(p.create).not.toHaveBeenCalled();
});

it('已有其他标签的模板不自动发布或覆盖', async () => {
  const p = platform();
  p.get.mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValueOnce({
    name: 'experience/extract-system',
    type: 'text',
    prompt: '已有正文',
    version: 2,
  });
  await expect(setupExperiencePrompts(p.api)).rejects.toThrow('未指定 production');
  expect(p.create).not.toHaveBeenCalled();
});
