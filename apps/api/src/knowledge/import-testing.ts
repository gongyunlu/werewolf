import { randomUUID } from 'node:crypto';
import { access, controlledPort, promptSource } from '../experience/testing';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { INITIAL_KNOWLEDGE } from './initial-content';
import { captureKnowledgePage, prepareOrganization } from './import-workflow';

export const page = {
  url: 'https://example.org/guide',
  title: '守卫攻略',
  publisher: 'example.org',
  author: '',
  publishedOn: null,
  fetchedAt: '2026-09-28T00:00:00.000Z',
  hash: 'first',
  paragraphs: [{ id: 'P1', text: '首夜是否空守应结合板子及女巫解药判断。' }],
};
export function proposed(
  targetId: string | null = null,
  body = '有女巫时考虑守救配合，避免把其他板型的假设当规则。',
) {
  const { sources: _sources, ...content } = INITIAL_KNOWLEDGE[0]!.content;
  return {
    proposals: [{ targetId, content: { ...content, body }, paragraphIds: ['P1'] }],
    reason: '提出一条供人工核对的建议',
  };
}
export async function importFixture(stores: GameStores = memoryStores(), snapshot = page) {
  const [row] = await stores.knowledgeImports.open(randomUUID(), [snapshot.url]);
  await captureKnowledgePage(stores, row!.id, async () => snapshot);
  const captured = (await stores.knowledgeImports.find(row!.id))!;
  const selection = {
    revision: captured.revision,
    boardIds: ['12p_wolf_king', '12p_white_wolf'],
    paragraphIds: ['P1'],
    targetIds: [] as string[],
  };
  const runtime = { access, promptSource, port: controlledPort(JSON.stringify(proposed())) };
  jest.spyOn(runtime.port, 'generate');
  await prepareOrganization(stores, captured, selection, runtime);
  return { stores, id: row!.id, runtime, selection };
}
