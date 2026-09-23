/** 等本轮所有行动收尾再抛错，失败返回后不能留下继续写存档的任务。 */
export async function settleActions<T>(actions: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(actions);
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
