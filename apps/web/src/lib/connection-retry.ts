/** 连续五次失败后停止；四次重试分别等待 1、2、4、8 秒。 */
export function connectionRetryDelay(failures: number): number | null {
  return failures >= 5 ? null : 1000 * 2 ** (failures - 1);
}
