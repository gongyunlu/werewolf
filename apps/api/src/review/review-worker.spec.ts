import { DelayedError, type Job } from 'bullmq';
import type { GameStores } from '../store/stores';
import { ReviewFailedError, ReviewPendingError } from './platform';
import type { ReviewJob } from './review-queue';
import { ReviewWorker } from './review-worker';
import { readReviewState, runReview } from './workflow';

jest.mock('./workflow', () => ({ runReview: jest.fn(), readReviewState: jest.fn() }));

const run = jest.mocked(runReview);
const state = jest.mocked(readReviewState);
beforeEach(() => {
  jest.clearAllMocks();
  state.mockResolvedValue({ receipts: [] } as never);
});

function fixture() {
  const stores = {} as GameStores;
  const job = {
    data: { gameId: 'g' } as ReviewJob,
    updateData: jest.fn(async (data: ReviewJob) => {
      job.data = data;
    }),
    moveToDelayed: jest.fn(async () => {}),
  };
  const worker = new ReviewWorker(stores);
  return { stores, job, process: () => worker.process(job as unknown as Job<ReviewJob>, 'lock') };
}

it('超过本轮等待时间后延迟续读，后续轮询不自动重试模型', async () => {
  const { stores, job, process } = fixture();
  run.mockRejectedValueOnce(new ReviewPendingError()).mockResolvedValueOnce(null);
  await expect(process()).rejects.toBeInstanceOf(DelayedError);
  expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock');
  expect(job.data).toMatchObject({ retryFailed: false, waits: 1 });
  expect(run).toHaveBeenNthCalledWith(1, stores, 'g', undefined, true);
  await process();
  expect(run).toHaveBeenNthCalledWith(2, stores, 'g', undefined, false);
  expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
});

it('判定失败给下一轮下发重投权限，成功后收回', async () => {
  const { job, process } = fixture();
  run.mockRejectedValueOnce(new ReviewFailedError());
  await expect(process()).rejects.toBeInstanceOf(DelayedError);
  expect(job.data).toMatchObject({ retryFailed: true, waits: 1 });
  await process();
  expect(job.data).toMatchObject({ retryFailed: false, waits: 0 });
});

it('连续多轮没有单元完成就停下等人工，有完成则重新计时', async () => {
  const { job, process } = fixture();
  run.mockRejectedValue(new ReviewPendingError());
  for (let round = 1; round <= 5; round++) {
    await expect(process()).rejects.toBeInstanceOf(DelayedError);
    expect(job.data.waits).toBe(round);
  }
  await expect(process()).rejects.toThrow('没有结果');

  const moved = fixture();
  run.mockRejectedValue(new ReviewPendingError());
  await expect(moved.process()).rejects.toBeInstanceOf(DelayedError);
  expect(moved.job.data.waits).toBe(1);
  state.mockResolvedValue({ receipts: [{}, {}] } as never);
  await expect(moved.process()).rejects.toBeInstanceOf(DelayedError);
  expect(moved.job.data.waits).toBe(1);
});

it('原生失败或读取异常继续报错，不通过延迟队列掩盖失败', async () => {
  const { job, process } = fixture();
  run.mockRejectedValueOnce(new Error('原生评价失败'));
  await expect(process()).rejects.toThrow('原生评价失败');
  expect(job.moveToDelayed).not.toHaveBeenCalled();
});
