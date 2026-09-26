import { fixture, result, access, promptSource, controlledPort, vectorRuntime } from './testing';
import { runExperience } from './workflow';
import { indexExperience } from './indexing';
import { ModelCallError } from '../llm/model-port';

describe('经验索引恢复', () => {
  it('部分失败不重做提炼或成功的向量请求；重复索引无调用', async () => {
    const f = await fixture();
    const model = controlledPort(
      JSON.stringify({ ...result, experiences: [result.experiences[0], result.experiences[0]] }),
    );
    const generate = jest.spyOn(model, 'generate');
    await runExperience(f.stores, f.row.id, {
      port: model,
      access,
      promptSource,
      prepare: f.prepare,
    });
    const embedding = vectorRuntime();
    const original = jest.mocked(embedding.port.generate).getMockImplementation()!;
    jest
      .spyOn(embedding.port, 'generate')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new ModelCallError('transient', '模拟失败'));
    await expect(indexExperience(f.stores, f.row.id, embedding)).rejects.toThrow('模拟');
    expect((await f.stores.experiences.findGeneration(f.row.id))!.state.status).toBe('completed');
    await indexExperience(f.stores, f.row.id, embedding);
    await indexExperience(f.stores, f.row.id, embedding);
    expect(embedding.port.generate).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await f.stores.experiences.list(f.agent.id)).every((item) => item.indexed)).toBe(true);
  });

  it('未知请求不自动重发，维度错误可重试；零产物无需模型', async () => {
    const f = await fixture();
    await runExperience(f.stores, f.row.id, {
      port: controlledPort(JSON.stringify(result)),
      access,
      promptSource,
      prepare: f.prepare,
    });
    const invalid = vectorRuntime([1]);
    await expect(indexExperience(f.stores, f.row.id, invalid)).rejects.toThrow('维度');
    const embedding = vectorRuntime();
    jest.spyOn(embedding.port, 'generate').mockRejectedValueOnce(new Error('未知中断'));
    await expect(indexExperience(f.stores, f.row.id, embedding)).rejects.toThrow('未知');
    await expect(indexExperience(f.stores, f.row.id, embedding)).rejects.toThrow('结果未知');
    expect(embedding.port.generate).toHaveBeenCalledTimes(1);
    const empty = await fixture();
    await runExperience(empty.stores, empty.row.id, {
      port: controlledPort(JSON.stringify({ experiences: [], reason: '没有新经验' })),
      access,
      promptSource,
      prepare: empty.prepare,
    });
    await indexExperience(empty.stores, empty.row.id, embedding);
    expect(embedding.port.generate).toHaveBeenCalledTimes(1);
  });
});
