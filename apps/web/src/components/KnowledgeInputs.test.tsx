import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { it, expect } from 'vitest';
import { KnowledgeSnapshotSchema } from '@werewolf/shared';
import { KnowledgeInputs } from './KnowledgeInputs';

it('区分候选、实际发送和未发出输入，显示保存版本与原文来源', () => {
  const knowledge = KnowledgeSnapshotSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    versionId: '00000000-0000-4000-8000-000000000002',
    version: 2,
    content: {
      kind: 'strategy',
      title: '保存的策略版本',
      body: '当次实际整理正文',
      conditions: '仅首夜',
      adaptation: '仅供参考',
      rulesBasis: '当前规则',
      boardIds: ['12p_white_wolf'],
      roles: ['guard'],
      actionTypes: ['guard_protect'],
      firstDayOnly: true,
      sources: [
        {
          title: '来源标题',
          url: 'https://example.test/source',
          publisher: '发布者',
          author: '',
          locator: '第一节',
          publishedOn: '2020-01-01',
          checkedOn: '2026-09-26',
        },
      ],
    },
  });
  render(
    <MemoryRouter>
      <KnowledgeInputs
        detail={{
          reasoning: null,
          steps: [],
          knowledgeRetrieval: {
            actionType: 'guard_protect',
            day: 1,
            candidates: [{ id: knowledge.id, versionId: knowledge.versionId, similarity: 0.8 }],
            selected: [knowledge],
          },
          knowledgeInputs: [
            { callId: 'sent', step: 'generate', dispatched: true, knowledge: [knowledge] },
            { callId: 'prepared', step: 'critique', dispatched: false, knowledge: [knowledge] },
          ],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText(/知识检索候选 1 条/)).toBeVisible();
  expect(screen.getByText(/generate · 已实际发送/)).toBeVisible();
  expect(screen.getByText(/critique · 已准备，尚未确认发送/)).toBeVisible();
  expect(screen.getByText(/输入不代表明确采纳/)).toBeVisible();
  expect(screen.getAllByText('当次实际整理正文')).toHaveLength(3);
  expect(screen.getAllByRole('link', { name: '来源标题' })[0]).toHaveAttribute(
    'href',
    'https://example.test/source',
  );
  expect(screen.getAllByRole('link', { name: '查看知识及版本' })[0]).toHaveAttribute(
    'href',
    `/knowledge?id=${knowledge.id}&version=${knowledge.versionId}`,
  );
});
