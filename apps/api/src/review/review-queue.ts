import { REVIEW_VERSION } from './contracts';

// 队列随评价版本隔离，旧任务不能由新提示词接着执行。
export const REVIEW_QUEUE = `reviews-${REVIEW_VERSION}`;
export interface ReviewJob {
  gameId: string;
  retryFailed?: boolean;
  /** 上一次观察到的完成数，用于判断这一轮有没有推进。 */
  progress?: number;
  /** 连续没有推进的等待轮次。 */
  waits?: number;
}
