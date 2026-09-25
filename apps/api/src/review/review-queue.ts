import { REVIEW_VERSION } from './contracts';

// 队列随评价版本隔离，旧任务不能由新提示词接着执行。
export const REVIEW_QUEUE = `reviews-${REVIEW_VERSION}`;
export interface ReviewJob {
  gameId: string;
}
