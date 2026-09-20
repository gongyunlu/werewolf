/**
 * 稳定序列化：对象键排序，数组顺序保留。
 * 哈希要能复算，而数据库 JSONB 不保留键序，直接 stringify 出来的串会飘。
 * 键序按码点比，不用 localeCompare：那个的结果跟着运行环境的 locale 走，
 * 换台机器就可能排出另一个顺序，哈希也就对不上了。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}
