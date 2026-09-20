import { PromptContractError, renderTemplate, type PromptTemplate } from './prompt-template';

function template(text: string): PromptTemplate {
  return { name: 'test/one', text, version: null, source: 'local' };
}

describe('模板渲染', () => {
  it('少给变量当场抛，不把占位符原样留在正文里', () => {
    expect(() => renderTemplate(template('A {{x}} B'), {})).toThrow(PromptContractError);
  });

  it('独占一行的空变量连那一行一起去掉，不留空行', () => {
    expect(renderTemplate(template('A\n\n{{mid}}\n\nB'), { mid: '' })).toBe('A\n\nB');
  });

  it('变量值里的空行原样保留，渲染不改调用方递进来的文本', () => {
    const draft = '第一段\n\n\n\n第二段';
    const rendered = renderTemplate(template('草稿：\n{{draft}}\n\n完'), { draft });

    expect(rendered).toContain(draft);
  });
});
