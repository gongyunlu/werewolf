import { randomUUID } from 'node:crypto';
import type { ExperienceSnapshot } from '@werewolf/shared';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { knowledgeText } from '../knowledge/text';
import {
  experienceDocument,
  knowledgeDocument,
  originalRetrievalQuery,
  retrievalQuery,
} from './retrieval';
import {
  fuseCandidates,
  rankKeywords,
  selectReferences,
  tokenizeChinese,
  type ReferenceJudgment,
  type RetrievalCandidate,
} from './retrieval-ranking';
import { result } from './testing';

const experience: ExperienceSnapshot = {
  ...result.experiences[0]!,
  id: 'experience',
  agentId: 'agent',
  generationId: 'generation',
  version: 1,
  sourceGameId: 'old',
  sourcePlayerId: 'p1',
  boardId: '12p_wolf_king',
  role: 'guard',
};
function candidate(id: string, body = id): RetrievalCandidate {
  return { ...experienceDocument({ ...experience, id, body }), fusionScore: 1 };
}
function judgment(
  row: RetrievalCandidate,
  patch: Partial<ReferenceJudgment> = {},
): ReferenceJudgment {
  return {
    key: row.key,
    relevance: 3,
    applicable: true,
    reason: '符合当时已知条件',
    duplicateOf: null,
    ...patch,
  };
}

describe('混合检索排序与筛选', () => {
  it('长公开历史不会挤掉本人查验、药品和昨夜守护，主观判断独立标注', () => {
    const context = {
      actor: { playerId: 'p1', seatNo: 1, role: '守卫' },
      day: 3,
      task: '选择守护目标',
      skill: ['禁连守'],
      options: ['2号', '空守'],
      visible: [
        {
          title: '你手里的牌',
          lines: [
            '你昨夜守的是 3 号，今夜不能再守他。',
            '你验过 2 号，是好人。',
            '药：解药已经用掉，毒药还在。',
          ],
        },
        {
          title: '公开发言',
          lines: Array.from({ length: 100 }, (_, i) => `${i} 号声称自己是预言家。`.repeat(50)),
        },
        { title: '局面', lines: ['场上还活着：1号、2号、3号。'] },
      ],
    };
    const query = retrievalQuery(context, '12p_wolf_king');
    expect(query).toContain('你昨夜守的是 3 号');
    expect(query).toContain('你验过 2 号');
    expect(query).toContain('解药已经用掉');
    expect(query).toContain('合法选项：2号；空守');
    expect(query).toContain('身份主张不是系统事实');
    expect(query.length).toBeLessThanOrEqual(6400);
    expect(originalRetrievalQuery(context, '12p_wolf_king')).not.toContain('你昨夜守的是');
  });

  it('中文分词保留领域词，BM25能从完整语料召回向量未命中的条目', () => {
    expect(tokenizeChinese('白狼王退水时注意屠边与禁连守')).toEqual(
      expect.arrayContaining(['白狼王', '退水', '屠边', '禁连守']),
    );
    const documents = [
      candidate('guard', '守卫需要遵守禁连守，昨夜已守护的玩家今夜不能重复保护'),
      candidate('speech', '平民投票需要核对公开发言'),
    ];
    const lexical = rankKeywords('今夜守卫禁连守', documents);
    expect(lexical[0]!.document.key).toBe('experience/guard/1');
    const fused = fuseCandidates([{ document: documents[1]!, score: 0.9 }], lexical);
    expect(fused.find((row) => row.key === 'experience/guard/1')).toMatchObject({ keywordRank: 1 });
    expect(rankKeywords('不存在的英文 zxq', documents)).toEqual([]);
    expect(rankKeywords('守卫', [])).toEqual([]);
  });

  it('RRF不会把向量相似度与词法分数直接相加，双路只生成一个候选', () => {
    const a = candidate('a');
    const b = candidate('b');
    const fused = fuseCandidates(
      [
        { document: a, score: 0.9 },
        { document: b, score: 0.8 },
      ],
      [
        { document: b, score: 100 },
        { document: a, score: 1 },
      ],
    );
    expect(fused).toHaveLength(2);
    expect(fused[0]!.fusionScore).toBeCloseTo(fused[1]!.fusionScore);
    expect(fused.find((row) => row.key === b.key)).toMatchObject({
      similarity: 0.8,
      keywordScore: 100,
      vectorRank: 2,
      keywordRank: 1,
    });
  });

  it('显式门槛3与适用性独立检查，允许没有材料；降低至2才选入部分相关材料', () => {
    const rows = [candidate('wrong'), candidate('weak')];
    const selected = selectReferences(
      rows,
      [judgment(rows[0]!, { applicable: false }), judgment(rows[1]!, { relevance: 2 })],
      3,
    );
    expect(selected.experiences).toEqual([]);
    expect(selected.decisions.map((row) => row.rejection)).toEqual(['inapplicable', 'irrelevant']);
    expect(
      selectReferences(
        rows,
        [judgment(rows[0]!, { applicable: false }), judgment(rows[1]!, { relevance: 2 })],
        2,
      ).experiences,
    ).toHaveLength(1);
  });

  it('默认门槛2选入适用的部分相关材料，主题相近的1分材料仍排除', () => {
    const rows = [candidate('partial'), candidate('topic')];
    const selected = selectReferences(rows, [
      judgment(rows[0]!, { relevance: 2 }),
      judgment(rows[1]!, { relevance: 1 }),
    ]);
    expect(selected.experiences.map((row) => row.id)).toEqual(['partial']);
    expect(selected.decisions.find((row) => row.key === rows[1]!.key)!.rejection).toBe(
      'irrelevant',
    );
  });

  it('跨库相同条件和策略去重，语义重复关系按实际排序保留一项', () => {
    const a = candidate('a', '不要连续两夜守护同一目标');
    const snapshot = {
      id: randomUUID(),
      versionId: randomUUID(),
      version: 1,
      content: {
        ...INITIAL_KNOWLEDGE[0]!.content,
        body: '不要连续两夜守护同一目标',
        conditions: experience.conditions,
      },
    };
    const b: RetrievalCandidate = { ...knowledgeDocument(snapshot), fusionScore: 0.5 };
    const selected = selectReferences([a, b], [judgment(a), judgment(b)]);
    expect(selected.experiences).toHaveLength(1);
    expect(selected.knowledge).toEqual([]);
    const c = candidate('c', '昨晚守过的人今晚应换开');
    expect(
      selectReferences([a, c], [judgment(a, { duplicateOf: c.key }), judgment(c)]).experiences,
    ).toHaveLength(1);
  });

  it('缺项和重复编号拒绝，超过输入预算的候选不会挤掉后面的短条目', () => {
    const huge = candidate('huge', '长'.repeat(4000));
    const short = candidate('short');
    expect(() => selectReferences([huge, short], [judgment(short)])).toThrow('覆盖');
    const selected = selectReferences([huge, short], [judgment(huge), judgment(short)]);
    expect(selected.experiences.map((row) => row.id)).toEqual(['short']);
    expect(selected.decisions.find((row) => row.key === huge.key)!.rejection).toBe('budget');
  });

  it('知识检索正文不包含网页地址和采集日期，经验排除条件进入重排', () => {
    const content = INITIAL_KNOWLEDGE[0]!.content;
    expect(knowledgeText(content)).toContain(content.conditions);
    expect(knowledgeText(content)).not.toContain(content.sources[0]!.url);
    expect(knowledgeText(content)).not.toContain(content.sources[0]!.checkedOn);
    expect(experienceDocument(experience).text).toContain(experience.exclusions);
  });
});
