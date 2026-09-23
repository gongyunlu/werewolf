import type { StageAnchor } from '../core/loop';

/**
 * 阶段锚点的落库口子。
 *
 * 落的是「进这一格时的完整局面 + 这一格的输入」。恢复取回最后一份，直接拿这份局面重进这一格，
 * 实例序号不推进，提问的键与断的那一次重合，答过的按记录复用，一个模型都不用问。
 * 它前面的那几格一律不重放——把它们再跑一遍不是恢复。
 */
export interface StepStore {
  /** 落一份锚点。同一格落第二遍不再写，先落那份留着。 */
  append(gameId: string, anchor: StageAnchor): Promise<void>;
  /** 这一局最后落的那一份；一份都没有就是 null。 */
  last(gameId: string): Promise<StageAnchor | null>;
  /**
   * 这几局各自最后落的那一份，按对局 id 取。一份都没有的那局不在表里。
   * 列表页要一屏算好几局的存活人数与天数：挨个 last 就是一屏一次的循环查库。
   */
  latest(gameIds: readonly string[]): Promise<Map<string, StageAnchor>>;
}
