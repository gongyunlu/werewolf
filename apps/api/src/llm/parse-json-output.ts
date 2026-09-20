/**
 * 解析模型给的 JSON。只剥掉包住整个输出的代码围栏，不抽片段、不补括号、不改字段。
 * 只有这一种容错：再往下容就是替模型编答案，编出来的东西没人看得出来是编的。
 */
export function parseJsonOutput(content: string, allowCodeFence = false): unknown {
  const fenced = allowCodeFence
    ? /^```(?:json)?[\t ]*\r?\n([\s\S]*)\r?\n```$/i.exec(content.trim())
    : null;
  return JSON.parse(fenced ? fenced[1] : content);
}
