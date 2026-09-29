import { cancellableModelPort } from './cancellable-model-port';
import { ModelCallError, type ModelAccess, type ModelPort } from './model-port';
import { retryingModelPort } from './retrying-model-port';

const access: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-test',
  capability: { reasoningOff: null },
};
const request = { system: '用例', prompt: '用例' };

it.each(['服务停止', '行动取消'])('%s时保留两级中止信号，尚未开始的请求不会发出', async (kind) => {
  const shutdown = new AbortController();
  const action = new AbortController();
  const generate = jest.fn<ReturnType<ModelPort['generate']>, Parameters<ModelPort['generate']>>();
  (kind === '服务停止' ? shutdown : action).abort();
  const port = cancellableModelPort({ generate }, shutdown.signal);
  await expect(port.generate(request, access, { signal: action.signal })).rejects.toMatchObject({
    code: 'deadline',
  });
  expect(generate).not.toHaveBeenCalled();
});

it('服务停止会打断模型重试等待，不再重发', async () => {
  const shutdown = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const generate = jest
    .fn<ReturnType<ModelPort['generate']>, Parameters<ModelPort['generate']>>()
    .mockImplementation(async () => {
      entered();
      throw new ModelCallError('transient', '临时故障');
    });
  const port = cancellableModelPort(
    retryingModelPort({ generate }, { backoffMs: 60000 }),
    shutdown.signal,
  );
  const failure = expect(port.generate(request, access)).rejects.toMatchObject({
    code: 'deadline',
  });
  await started;
  shutdown.abort();
  await failure;
  expect(generate).toHaveBeenCalledTimes(1);
});
