import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 一份技能正文。
 *
 * front-matter 只有两个字段：`name` 必须与它在仓库里的位置对得上（`roles/werewolf`
 * 那份写 `name: werewolf`），`description` 是给人看的用途说明。
 * 选哪一份不看 front-matter，看路径——目录结构就是条件，不另设一套条件字段。
 */
export interface Skill {
  /** 仓库内路径，如 roles/werewolf。取值域里的原样串，不另做一层映射。 */
  id: string;
  description: string;
  /** front-matter 之后的那段正文。 */
  content: string;
}

/** 正文放这儿。构建时整个目录会被拷进 dist，见 nest-cli.json 的 assets。 */
const ROOT = join(__dirname, 'v1');

/**
 * 形如 `roles/werewolf`：两段，各由小写字母、数字、下划线与连字符组成。
 * 字符收得这么紧，`..` 与绝对路径就拼不出来，路径不必再单独防一遍。
 */
const ID_SHAPE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

/** 读过一次就留着：正文是构建产物的一部分，进程活着的时候它不会变。 */
const cache = new Map<string, Skill>();

/**
 * 取一份技能正文。
 *
 * id 只由代码按取值域拼出来，不由外部输入带进来；形状照查一遍是为了拼错时
 * 当场说清是哪个 id，而不是等 readFileSync 抛一句看不出所以然的读文件失败。
 */
export function loadSkill(id: string): Skill {
  const cached = cache.get(id);
  if (cached) return cached;

  if (!ID_SHAPE.test(id)) throw new Error(`技能路径不合形状：${id}`);

  const skill = parseSkill(id, readFileSync(join(ROOT, id, 'SKILL.md'), 'utf8'));
  cache.set(id, skill);
  return skill;
}

/** 拆 front-matter 与正文，顺手核对名字与它所在的位置。 */
function parseSkill(id: string, raw: string): Skill {
  // 仓库里按 LF 存，检出到 Windows 会变成 CRLF；编辑器另存还可能带上 BOM，两样都先归一。
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const text = noBom.replace(/\r\n/g, '\n');
  const found = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!found) throw new Error(`技能缺 front-matter：${id}`);

  const fields = new Map<string, string>();
  for (const line of found[1].split('\n')) {
    if (line.trim() === '') continue;
    const at = line.indexOf(':');
    if (at < 0) throw new Error(`技能 front-matter 这一行不是键值对：${id} 的「${line}」`);
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const name = fields.get('name');
  if (name !== id.split('/')[1])
    throw new Error(`技能名与它所在的位置对不上：${id} 写的是 ${String(name)}`);
  const description = fields.get('description');
  if (!description) throw new Error(`技能没有 description：${id}`);

  return { id, description, content: found[2].trim() };
}
