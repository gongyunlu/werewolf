import { loadSkill } from './skill-loader';

describe('技能正文加载', () => {
  it('取到 front-matter 之后的那段正文，front-matter 本身不混在里面', () => {
    const skill = loadSkill('roles/werewolf');

    expect(skill.id).toBe('roles/werewolf');
    expect(skill.description).not.toBe('');
    expect(skill.content).not.toContain('description:');
    expect(skill.content.startsWith('---')).toBe(false);
  });

  it('取两次是同一份，正文只读一次盘', () => {
    // 返回同一个对象才算命中缓存：重新读盘会造出一份内容相同的新对象，toEqual 看出来，toBe 看得出来。
    expect(loadSkill('roles/seer')).toBe(loadSkill('roles/seer'));
  });

  it('id 拼错时当场抛，不等到读文件', () => {
    expect(() => loadSkill('werewolf')).toThrow('不合形状');
    // 想从 id 里穿出去的写法，在形状这一关就被挡下了，走不到拼路径。
    expect(() => loadSkill('../roles/werewolf')).toThrow('不合形状');
    expect(() => loadSkill('roles/Werewolf')).toThrow('不合形状');
  });

  it('文件不在就当场抛，不拿一份空正文顶上', () => {
    // 少写一份正文是配置漏了，不是模型该将就的事：宁可开跑前炸掉。
    expect(() => loadSkill('roles/nobody')).toThrow(/ENOENT/);
  });
});
