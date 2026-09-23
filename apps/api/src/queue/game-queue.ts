/** 跑对局的队列。一局一个任务，同一局重复入队由 jobId 挡掉。 */
export const GAME_QUEUE = 'games';

/**
 * 一个排队任务就是「把这一局跑起来」。
 * 只放 id 不放板子：板子记在档案里，两处都写迟早会对不上。
 */
export interface GameJob {
  gameId: string;
}
