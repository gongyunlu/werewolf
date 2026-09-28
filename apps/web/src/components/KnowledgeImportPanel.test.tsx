import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { KnowledgeCapture, KnowledgeContent, KnowledgeItem } from '@werewolf/shared';
import * as api from '@/lib/knowledge-import-api';
import { fetchKnowledge } from '@/lib/knowledge-api';
import { KnowledgeImportPanel } from './KnowledgeImportPanel';

vi.mock('@/lib/knowledge-import-api', () => ({
  fetchCaptures: vi.fn(),
  fetchImportModel: vi.fn(),
  startCapture: vi.fn(),
  fetchCapture: vi.fn(),
  retryCapture: vi.fn(),
  organizeCapture: vi.fn(),
  confirmCandidate: vi.fn(),
  discardCandidate: vi.fn(),
  fetchCaptureCalls: vi.fn(),
  bulkKnowledgeAction: vi.fn(),
}));
vi.mock('@/lib/knowledge-api', () => ({ fetchKnowledge: vi.fn() }));
const content: KnowledgeContent = {
  kind: 'strategy',
  title: '守护前核对规则',
  body: '守护前结合板子与公开信息判断。',
  conditions: '准备守护时',
  adaptation: '只根据当前规则和证据判断',
  rulesBasis: '守护规则以本项目为准',
  boardIds: ['board'],
  roles: ['guard'],
  actionTypes: ['guard_protect'],
  firstDayOnly: false,
  minDay: 1,
  sources: [
    {
      title: '攻略',
      url: 'https://example.org',
      publisher: 'example.org',
      author: '',
      locator: 'P1',
      publishedOn: null,
      checkedOn: '2026-09-28',
      captureId: '00000000-0000-4000-8000-000000000001',
      paragraphIds: ['P1'],
    },
  ],
};
const capture: KnowledgeCapture = {
  id: content.sources[0]!.captureId!,
  sourceId: 'source',
  batchId: 'batch',
  url: 'https://example.org',
  revision: 2,
  createdAt: '2026-09-28T00:00:00Z',
  status: 'ready',
  failure: null,
  previousId: null,
  snapshot: {
    url: 'https://example.org',
    title: '网页攻略',
    publisher: 'example.org',
    author: '',
    publishedOn: null,
    fetchedAt: '2026-09-28T00:00:00Z',
    hash: 'hash',
    paragraphs: [{ id: 'P1', text: '原网页守护说明' }],
  },
  organization: null,
  candidates: [],
};
const board = { id: 'board', name: '测试板子', playerCount: 12, hasSheriff: true };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchCaptures).mockResolvedValue({ captures: [capture] });
  vi.mocked(api.fetchImportModel).mockResolvedValue({ model: '受控模型' });
});

it('重新采集后自动打开新任务，不留在旧正文；内容未变不会自动整理', async () => {
  const next = {
    ...capture,
    id: 'next-capture',
    previousId: capture.id,
    status: 'unchanged' as const,
  };
  vi.mocked(api.startCapture).mockImplementation(async () => {
    vi.mocked(api.fetchCaptures).mockResolvedValue({ captures: [next, capture] });
    return { captures: [next] };
  });
  render(
    <MemoryRouter>
      <KnowledgeImportPanel boards={[board]} items={[]} onKnowledgeChanged={async () => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '重新采集，检查更新' }));
  await screen.findByText('本次正文和元数据没有变化。没有自动整理或更新知识。');
  expect(api.organizeCapture).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: '打开正文快照' })).toHaveAttribute(
    'href',
    '/knowledge/sources/next-capture',
  );
});
it('采集、预览不会整理；明确选择板子和段落后才调用 AI', async () => {
  render(
    <MemoryRouter>
      <KnowledgeImportPanel boards={[board]} items={[]} onKnowledgeChanged={async () => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await screen.findByText(
    '整理型号：受控模型。每页最多 5 条候选，也可能没有适用内容。采集、预览和保存不调用模型。',
  );
  expect(api.organizeCapture).not.toHaveBeenCalled();
  expect(api.confirmCandidate).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'AI 生成草稿（调用模型）' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: '测试板子' }));
  await user.click(screen.getByText(/选择提供给 AI 的正文段落/));
  await user.click(screen.getByRole('checkbox', { name: 'P1 · 原网页守护说明' }));
  await user.click(screen.getByRole('button', { name: 'AI 生成草稿（调用模型）' }));
  expect(api.organizeCapture).toHaveBeenCalledExactlyOnceWith(capture.id, {
    revision: 2,
    boardIds: ['board'],
    paragraphIds: ['P1'],
    targetIds: [],
  });
});
it('批量确认保留成功项并逐项显示失败，普通保存不自动索引或启用', async () => {
  const c = {
    id: 'candidate-1',
    itemId: 'item-1',
    expectedRevision: 0,
    before: null,
    content,
    status: 'pending' as const,
    versionId: null,
  };
  const row = {
    ...capture,
    candidates: [c, { ...c, id: 'candidate-2', itemId: 'item-2' }],
    organization: {
      status: 'ready' as const,
      failure: null,
      model: '受控模型',
      boardIds: ['board'],
      paragraphIds: ['P1'],
      targetIds: [],
      reason: '已整理',
      calls: [],
    },
  };
  vi.mocked(api.fetchCaptures).mockResolvedValue({ captures: [row] });
  vi.mocked(api.confirmCandidate)
    .mockResolvedValueOnce(row)
    .mockRejectedValueOnce(new Error('知识已被修改，请重新核对'));
  render(
    <MemoryRouter>
      <KnowledgeImportPanel boards={[board]} items={[]} onKnowledgeChanged={async () => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await screen.findByText('人工确认候选');
  for (const choice of screen.getAllByRole('checkbox', { name: /已核对，选中保存/ }))
    await user.click(choice);
  await user.click(screen.getByRole('button', { name: '确认并保存选中草稿' }));
  await screen.findByText('知识已被修改，请重新核对');
  expect(screen.getByText('已保存草稿')).toBeInTheDocument();
  expect(api.confirmCandidate).toHaveBeenCalledTimes(2);
  expect(api.bulkKnowledgeAction).not.toHaveBeenCalled();
});
it('冲突后读取最新知识保留人工草稿，并使用重新核对的 revision；未知请求禁止重发', async () => {
  const c = {
    id: 'candidate',
    itemId: 'item',
    expectedRevision: 2,
    before: { ...content, body: '旧正文' },
    content,
    status: 'pending' as const,
    versionId: null,
  };
  const row = {
    ...capture,
    candidates: [c],
    organization: {
      status: 'unknown' as const,
      failure: '请求未知，不能重发',
      model: '受控模型',
      boardIds: ['board'],
      paragraphIds: ['P1'],
      targetIds: ['item'],
      reason: null,
      calls: [],
    },
  };
  vi.mocked(api.fetchCaptures).mockResolvedValue({ captures: [row] });
  vi.mocked(api.confirmCandidate)
    .mockRejectedValueOnce(new Error('并发编辑冲突'))
    .mockResolvedValue(row);
  vi.mocked(fetchKnowledge).mockResolvedValue({
    items: [
      {
        id: 'item',
        revision: 3,
        versions: [{ content: { ...content, body: '他人的最新正文' } }],
      } as KnowledgeItem,
    ],
  });
  render(
    <MemoryRouter>
      <KnowledgeImportPanel boards={[board]} items={[]} onKnowledgeChanged={async () => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '编辑并确认' }));
  const dialog = within(screen.getByRole('dialog'));
  await user.clear(dialog.getByLabelText('整理正文'));
  await user.type(dialog.getByLabelText('整理正文'), '人工修改的正文');
  await user.click(dialog.getByRole('button', { name: '确认并保存草稿' }));
  await screen.findByText('并发编辑冲突');
  await user.click(dialog.getByRole('button', { name: /读取最新知识重新核对/ }));
  await screen.findByText('原内容：他人的最新正文');
  expect(dialog.getByLabelText('整理正文')).toHaveValue('人工修改的正文');
  await user.click(dialog.getByRole('button', { name: '确认并保存草稿' }));
  await waitFor(() =>
    expect(api.confirmCandidate).toHaveBeenLastCalledWith(
      row.id,
      c.id,
      expect.objectContaining({ body: '人工修改的正文' }),
      3,
    ),
  );
  expect(screen.getByRole('button', { name: '继续整理（可能调用模型）' })).toBeDisabled();
});

it('已保存草稿被修改后展示实际版本并取消勾选，重新核对后才能索引', async () => {
  const candidate = {
    id: 'candidate',
    itemId: 'item',
    expectedRevision: 0,
    before: null,
    content,
    status: 'saved' as const,
    versionId: 'version',
  };
  const row = { ...capture, candidates: [candidate] };
  const item: KnowledgeItem = {
    id: candidate.itemId,
    revision: 1,
    activeVersionId: null,
    versions: [
      {
        id: candidate.itemId,
        versionId: candidate.versionId,
        version: 1,
        content,
        status: 'draft',
        failure: null,
        model: null,
        createdAt: capture.createdAt,
      },
    ],
  };
  vi.mocked(api.fetchCaptures).mockResolvedValue({ captures: [row] });
  vi.mocked(api.bulkKnowledgeAction).mockResolvedValue({
    results: [{ id: item.id, versionId: candidate.versionId, error: null }],
  });
  const panel = (items: KnowledgeItem[]) => (
    <MemoryRouter>
      <KnowledgeImportPanel boards={[board]} items={items} onKnowledgeChanged={async () => {}} />
    </MemoryRouter>
  );
  const { rerender } = render(panel([item]));
  const user = userEvent.setup();
  const choice = await screen.findByRole('checkbox', { name: /选中此保存版本以索引或启用/ });
  const index = screen.getByRole('button', { name: '选中版本建立索引（调用向量模型）' });
  await user.click(choice);
  expect(index).toBeEnabled();

  const updated: KnowledgeItem = {
    ...item,
    revision: 2,
    versions: [
      {
        ...item.versions[0]!,
        content: {
          ...content,
          body: '另一个窗口修改了守护策略。',
          sources: [{ ...content.sources[0]!, title: '重新核对的来源', paragraphIds: ['P2'] }],
        },
      },
    ],
  };
  rerender(panel([updated]));
  expect(screen.getByText(updated.versions[0]!.content.body)).toBeInTheDocument();
  expect(screen.queryByText(content.body)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '重新核对的来源' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '采集时正文' })).toHaveAttribute(
    'href',
    `/knowledge/sources/${capture.id}#P2`,
  );
  expect(choice).not.toBeChecked();
  expect(index).toBeDisabled();
  expect(screen.getByRole('button', { name: '启用选中版本' })).toBeDisabled();
  expect(api.bulkKnowledgeAction).not.toHaveBeenCalled();

  await user.click(choice);
  await user.click(index);
  await waitFor(() =>
    expect(api.bulkKnowledgeAction).toHaveBeenCalledExactlyOnceWith('index', [
      { id: item.id, versionId: candidate.versionId, revision: updated.revision },
    ]),
  );
  await screen.findByText('已受理索引，请查看版本状态');
  rerender(panel([{ ...updated, versions: [{ ...updated.versions[0]!, status: 'ready' }] }]));
  expect(choice).toBeChecked();
});
