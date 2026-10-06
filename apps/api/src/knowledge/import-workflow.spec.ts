import { randomUUID } from 'node:crypto';
import { KnowledgeContentSchema } from '@werewolf/shared';
import { controlledPort, vectorRuntime, failNextAttemptObservation } from '../experience/testing';
import { ModelCallError } from '../llm/model-port';
import { knowledgeEmbeddingKey } from './text';
import { memoryStores } from '../store/memory';
import { page, proposed, importFixture } from './import-testing';
import {
  captureKnowledgePage,
  organizeKnowledgePage,
  prepareOrganization,
} from './import-workflow';
import { prepareKnowledgeIndex, indexKnowledge } from './indexing';

describe('网页采集、整理与确认', () => {
  it('整理前记录写入失败可以恢复，未派发不算结果未知', async () => {
    const f = await importFixture();
    jest.spyOn(f.stores.asked, 'append').mockRejectedValueOnce(new Error('模拟题面写入失败'));
    await expect(organizeKnowledgePage(f.stores, f.id, f.runtime)).rejects.toThrow();
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
    expect((await f.stores.knowledgeImports.find(f.id))!.state.organization).toMatchObject({
      status: 'failed',
      attempts: [{ status: 'failed' }],
    });
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
  });

  it('整理答复收到后观测写入失败不产出候选，恢复补记后复用答复', async () => {
    const f = await importFixture();
    failNextAttemptObservation(f.stores);
    await expect(organizeKnowledgePage(f.stores, f.id, f.runtime)).rejects.toThrow(
      '模型观测写入失败',
    );
    const failed = (await f.stores.knowledgeImports.find(f.id))!;
    expect(failed.state.organization!.status).toBe('failed');
    expect(failed.state.candidates).toHaveLength(0);
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    expect((await f.stores.knowledgeImports.find(f.id))!.state.organization!.status).toBe('ready');
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect((await f.stores.asked.captureCalls(f.id)).calls).toMatchObject([
      { status: 'accepted', attempts: [{ status: 'succeeded', usage: { total_tokens: 15 } }] },
    ]);
  });

  it('请求链接的跳转目标改变后仍按来源身份关联更新，替换本来源但保留其他来源', async () => {
    const f = await importFixture();
    const first = (await f.stores.knowledgeImports.find(f.id))!;
    await f.stores.knowledgeImports.save(first, {
      ...first.state,
      snapshot: { ...page, url: 'https://example.org/redirect-a' },
    });
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    const candidate = (await f.stores.knowledgeImports.find(f.id))!.state.candidates[0]!;
    const otherSource = {
      title: '另一来源',
      url: 'https://other.example/guide',
      publisher: 'other.example',
      author: '',
      locator: '第一节',
      publishedOn: null,
      checkedOn: '2026-09-28',
    };
    await f.stores.knowledgeImports.confirm(
      f.id,
      candidate.id,
      { ...candidate.content, sources: [...candidate.content.sources, otherSource] },
      0,
    );
    const [next] = await f.stores.knowledgeImports.open(randomUUID(), [page.url]);
    await captureKnowledgePage(f.stores, next!.id, async () => ({
      ...page,
      url: 'https://example.org/redirect-b',
      hash: 'redirected',
    }));
    const row = (await f.stores.knowledgeImports.find(next!.id))!;
    await prepareOrganization(
      f.stores,
      row,
      { ...f.selection, revision: row.revision, targetIds: [candidate.itemId] },
      f.runtime,
    );
    await organizeKnowledgePage(f.stores, row.id, {
      ...f.runtime,
      port: controlledPort(JSON.stringify(proposed(candidate.itemId))),
    });
    const sources = (await f.stores.knowledgeImports.find(row.id))!.state.candidates[0]!.content
      .sources;
    expect(sources).toHaveLength(2);
    expect(sources[1]).toEqual(otherSource);
    expect(sources[0]).toMatchObject({
      sourceId: first.sourceId,
      captureId: row.id,
      url: 'https://example.org/redirect-b',
    });
  });
  it('重复批次复用身份，抓取失败可重试，内容未变不自动调用模型', async () => {
    const stores = memoryStores();
    const batch = randomUUID();
    const rows = await stores.knowledgeImports.open(batch, [page.url]);
    expect(await stores.knowledgeImports.open(batch, [page.url])).toEqual(rows);
    await expect(
      stores.knowledgeImports.open(batch, ['https://example.org/other']),
    ).rejects.toThrow('其他链接');
    await expect(
      captureKnowledgePage(stores, rows[0]!.id, async () => {
        throw new Error('网页超时');
      }),
    ).rejects.toThrow('超时');
    expect((await stores.knowledgeImports.find(rows[0]!.id))!.state.status).toBe('failed');
    await captureKnowledgePage(stores, rows[0]!.id, async () => page);
    const [next] = await stores.knowledgeImports.open(randomUUID(), [page.url]);
    await captureKnowledgePage(stores, next!.id, async () => page);
    const unchanged = (await stores.knowledgeImports.find(next!.id))!;
    expect(unchanged.state).toMatchObject({
      status: 'unchanged',
      previousId: rows[0]!.id,
      organization: null,
    });
    expect(await stores.knowledge.list()).toEqual([]);
  });
  it('AI 草稿仅在人工确认后入库；并发确认一次保存，来源固定且索引、启用分别触发', async () => {
    const f = await importFixture();
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    expect(await f.stores.knowledge.list()).toHaveLength(0);
    const candidate = (await f.stores.knowledgeImports.find(f.id))!.state.candidates[0]!;
    const content = KnowledgeContentSchema.parse({
      ...candidate.content,
      title: '人工核对后的标题',
    });
    await Promise.all([
      f.stores.knowledgeImports.confirm(f.id, candidate.id, content, 0),
      f.stores.knowledgeImports.confirm(f.id, candidate.id, content, 0),
    ]);
    const items = await f.stores.knowledge.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.activeVersionId).toBeNull();
    expect(items[0]!.versions[0]!.content.sources[0]).toMatchObject({
      captureId: f.id,
      paragraphIds: ['P1'],
      url: page.url,
    });
    expect(items[0]!.revision).toBe(1);
    const runtime = vectorRuntime();
    await prepareKnowledgeIndex(f.stores, items[0]!.versions[0]!, runtime);
    await indexKnowledge(f.stores, items[0]!.versions[0]!.versionId, runtime);
    await f.stores.knowledge.activate(
      items[0]!.id,
      1,
      items[0]!.versions[0]!.versionId,
      knowledgeEmbeddingKey(runtime),
    );
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect((await f.stores.asked.captureCalls(f.id)).calls).toHaveLength(1);
  });
  it('候选写入失败后复用答复；重复 worker 不重发；未知请求停住，明确失败可继续', async () => {
    const f = await importFixture();
    const save = f.stores.knowledgeImports.save.bind(f.stores.knowledgeImports);
    jest.spyOn(f.stores.knowledgeImports, 'save').mockImplementation(async (row, state) => {
      if (state.organization?.status === 'ready') throw new Error('模拟候选保存失败');
      return save(row, state);
    });
    await expect(organizeKnowledgePage(f.stores, f.id, f.runtime)).rejects.toThrow('保存失败');
    jest.mocked(f.stores.knowledgeImports.save).mockImplementation(save);
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    const concurrent = await importFixture();
    const outcomes = await Promise.allSettled([
      organizeKnowledgePage(concurrent.stores, concurrent.id, concurrent.runtime),
      organizeKnowledgePage(concurrent.stores, concurrent.id, concurrent.runtime),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.runtime.port.generate).toHaveBeenCalledTimes(1);
    const unknown = await importFixture();
    jest.mocked(unknown.runtime.port.generate).mockRejectedValue(new Error('未知传输结果'));
    await expect(
      organizeKnowledgePage(unknown.stores, unknown.id, unknown.runtime),
    ).rejects.toThrow('未知');
    const row = (await unknown.stores.knowledgeImports.find(unknown.id))!;
    expect(row.state.organization!.status).toBe('unknown');
    await expect(
      prepareOrganization(
        unknown.stores,
        row,
        { ...unknown.selection, revision: row.revision },
        unknown.runtime,
      ),
    ).rejects.toThrow('不能重发');
    const failed = await importFixture();
    jest
      .mocked(failed.runtime.port.generate)
      .mockRejectedValueOnce(new ModelCallError('fatal', '明确拒绝'));
    await expect(organizeKnowledgePage(failed.stores, failed.id, failed.runtime)).rejects.toThrow(
      '明确拒绝',
    );
    await organizeKnowledgePage(failed.stores, failed.id, failed.runtime);
    expect(failed.runtime.port.generate).toHaveBeenCalledTimes(2);
  });
  it('更新只创建草稿，旧启用版本及来源保留；并发人工编辑产生冲突', async () => {
    const f = await importFixture();
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    const c = (await f.stores.knowledgeImports.find(f.id))!.state.candidates[0]!;
    await f.stores.knowledgeImports.confirm(f.id, c.id, c.content, 0);
    let item = (await f.stores.knowledge.find(c.itemId))!;
    const vector = vectorRuntime();
    await prepareKnowledgeIndex(f.stores, item.versions[0]!, vector);
    await indexKnowledge(f.stores, item.versions[0]!.versionId, vector);
    await f.stores.knowledge.activate(
      item.id,
      item.revision,
      item.versions[0]!.versionId,
      knowledgeEmbeddingKey(vector),
    );
    item = (await f.stores.knowledge.find(item.id))!;
    const old = structuredClone(item.versions[0]);
    const [next] = await f.stores.knowledgeImports.open(randomUUID(), [page.url]);
    await captureKnowledgePage(f.stores, next!.id, async () => ({
      ...page,
      hash: 'changed',
      paragraphs: [{ id: 'P1', text: '更新的守护观点' }],
    }));
    const row = (await f.stores.knowledgeImports.find(next!.id))!;
    await prepareOrganization(
      f.stores,
      row,
      { ...f.selection, revision: row.revision, targetIds: [item.id] },
      f.runtime,
    );
    const update = {
      ...f.runtime,
      port: controlledPort(JSON.stringify(proposed(item.id, '更新后的守护参考观点'))),
    };
    await organizeKnowledgePage(f.stores, next!.id, update);
    const candidate = (await f.stores.knowledgeImports.find(next!.id))!.state.candidates[0]!;
    await f.stores.knowledge.saveDraft(item.id, item.revision, {
      ...old!.content,
      body: '其他人的人工编辑',
    });
    await expect(
      f.stores.knowledgeImports.confirm(
        next!.id,
        candidate.id,
        candidate.content,
        candidate.expectedRevision,
      ),
    ).rejects.toThrow('已被修改');
    const latest = (await f.stores.knowledge.find(item.id))!;
    expect(latest.activeVersionId).toBe(old!.versionId);
    expect(latest.versions[0]).toEqual(old);
    expect((await f.stores.knowledgeImports.find(f.id))!.state.snapshot).toEqual(page);
  });
  it('不适用文章可返回零条；伪造段落和未选择的板子被拒绝', async () => {
    for (const output of [
      { proposals: [], reason: '此网页属于未实现的觉醒板型' },
      { ...proposed(), proposals: [{ ...proposed().proposals[0], paragraphIds: ['P999'] }] },
      {
        ...proposed(),
        proposals: [
          {
            ...proposed().proposals[0],
            content: { ...proposed().proposals[0]!.content, boardIds: ['6p_white_wolf'] },
          },
        ],
      },
    ]) {
      const f = await importFixture();
      const runtime = { ...f.runtime, port: controlledPort(JSON.stringify(output)) };
      if (!output.proposals.length) {
        await organizeKnowledgePage(f.stores, f.id, runtime);
        expect((await f.stores.knowledgeImports.find(f.id))!.state.candidates).toEqual([]);
      } else await expect(organizeKnowledgePage(f.stores, f.id, runtime)).rejects.toThrow();
      expect(await f.stores.knowledge.list()).toEqual([]);
    }
  });
});
