import { GAME_STATUSES, type AgentSummary, type GameSummary } from '@werewolf/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame, fetchAgents, fetchBoards, fetchGames, runGame } from '@/lib/api-client';
import { ApiError } from '@/lib/http';
import { GamesPage } from './GamesPage';

vi.mock('@/lib/api-client', () => ({
  createGame: vi.fn(),
  fetchAgents: vi.fn(),
  fetchBoards: vi.fn(),
  fetchGames: vi.fn(),
  runGame: vi.fn(),
}));

const BOARDS = [
  { id: '12p_wolf_king', name: '标准 12 人局 · 预女猎守狼王', playerCount: 12, hasSheriff: true },
  { id: '6p_white_wolf', name: '6 人局 · 预守白狼王', playerCount: 6, hasSheriff: true },
];

/** 一桌人：名字按序号排，够 12 人那块板子用。 */
const AGENTS: AgentSummary[] = Array.from({ length: 12 }, (_, index) => ({
  id: `a${index + 1}`,
  name: `选手${index + 1}`,
  modelName: `model-${index + 1}`,
  baseUrl: null,
  apiKeyHint: null,
  tag: index < 6 ? '甲队' : '乙队',
  isActive: true,
  notes: null,
}));

function game(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    gameId: 'g-1',
    boardId: '6p_white_wolf',
    status: GAME_STATUSES.RUNNING,
    winner: null,
    createdAt: '2026-09-22T10:00:00.000Z',
    aliveCount: 5,
    day: 2,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<GamesPage />} />
        <Route path="/games/:gameId" element={<p>观战页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 勾上第几号选手：勾选框的名字是「名字 + 型号」，按名字认。 */
async function pick(index: number) {
  await userEvent.click(screen.getByRole('checkbox', { name: `选手${index}model-${index}` }));
}

/** 常走的那几步：板子与名单都取回来，开局面板打开。 */
async function openDialog() {
  vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
  vi.mocked(fetchGames).mockResolvedValue({ games: [] });
  vi.mocked(fetchAgents).mockResolvedValue({ agents: AGENTS });

  renderPage();

  const button = await screen.findByRole('button', { name: '开一局' });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);

  return screen.findByRole('button', { name: '开局' });
}

describe('GamesPage', () => {
  it.each([false, true])(
    '慢请求结束之前不启动下一轮，卸载后停止轮询；板子请求失败：%s',
    async (boardFailed) => {
      vi.useFakeTimers();
      let release!: (value: { games: GameSummary[] }) => void;
      if (boardFailed) vi.mocked(fetchBoards).mockRejectedValue(new Error('板子读取失败'));
      else vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
      vi.mocked(fetchGames).mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const view = renderPage();
      try {
        await act(() => vi.advanceTimersByTimeAsync(20000));
        expect(fetchGames).toHaveBeenCalledTimes(1);
        await act(async () => {
          release({ games: [game()] });
        });
        expect(
          screen.getByText(boardFailed ? '板子读取失败' : '第 2 天 · 存活 5 人'),
        ).toBeInTheDocument();
        await act(() => vi.advanceTimersByTimeAsync(5000));
        expect(fetchGames).toHaveBeenCalledTimes(2);
        view.unmount();
        await act(async () => {
          release({ games: [] });
        });
        await act(() => vi.advanceTimersByTimeAsync(20000));
        expect(fetchGames).toHaveBeenCalledTimes(2);
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    },
  );

  afterEach(() => {
    vi.mocked(fetchBoards).mockReset();
    vi.mocked(fetchGames).mockReset();
    vi.mocked(fetchAgents).mockReset();
    vi.mocked(createGame).mockReset();
    vi.mocked(runGame).mockReset();
  });

  it('板子名从 /boards 现读，对局那几项按中文显示', async () => {
    vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
    vi.mocked(fetchGames).mockResolvedValue({
      games: [game({ status: GAME_STATUSES.FINISHED, winner: 'werewolf' })],
    });

    renderPage();

    expect(await screen.findByText('6 人局 · 预守白狼王')).toBeInTheDocument();
    expect(screen.getByText('已结束')).toBeInTheDocument();
    expect(screen.getByText('胜方：狼人')).toBeInTheDocument();
    expect(screen.getByText('第 2 天 · 存活 5 人')).toBeInTheDocument();
    expect(screen.getByText('观战')).toBeInTheDocument();
  });

  it('还没发牌的局没有天数与存活人数，别写成一局零人', async () => {
    vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
    vi.mocked(fetchGames).mockResolvedValue({
      games: [game({ status: GAME_STATUSES.QUEUED, aliveCount: null, day: null })],
    });

    renderPage();

    expect(await screen.findByText('还没发牌')).toBeInTheDocument();
  });

  it('一局都没有时说一声', async () => {
    vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
    vi.mocked(fetchGames).mockResolvedValue({ games: [] });

    renderPage();

    expect(await screen.findByText('还没有对局。')).toBeInTheDocument();
  });

  it('勾选只统计人数，不提前分配座次；人数不齐不能开局', async () => {
    const submit = await openDialog();

    // 先勾三个，看看凑不满这块板子时是什么样子
    for (const index of [3, 1, 2]) {
      await pick(index);
      expect(screen.getByRole('checkbox', { name: `选手${index}model-${index}` })).toBeChecked();
    }

    expect(screen.getByText('需要 12 个，已选 3 个')).toBeInTheDocument();
    expect(screen.queryByText(/^座位：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ 号$/)).not.toBeInTheDocument();
    expect(screen.getByText(/开局时随机分配座次和角色/)).toBeInTheDocument();
    expect(submit).toBeDisabled();

    for (let index = 4; index <= 12; index += 1) {
      await pick(index);
    }

    expect(screen.getByText('需要 12 个，已选 12 个')).toBeInTheDocument();
    expect(submit).toBeEnabled();
    await pick(3);
    expect(screen.getByRole('checkbox', { name: '选手3model-3' })).not.toBeChecked();
    expect(screen.getByText('需要 12 个，已选 11 个')).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it('开局只提交板子与所选参赛者，由后端分配，建好就进观战页', async () => {
    vi.mocked(createGame).mockResolvedValue({ gameId: 'g-new' });
    const submit = await openDialog();

    for (const index of [3, 1, 2]) {
      await pick(index);
    }
    for (let index = 4; index <= 12; index += 1) {
      await pick(index);
    }

    await userEvent.click(submit);

    expect(createGame).toHaveBeenCalledWith('12p_wolf_king', [
      'a3',
      'a1',
      'a2',
      'a4',
      'a5',
      'a6',
      'a7',
      'a8',
      'a9',
      'a10',
      'a11',
      'a12',
    ]);
    expect(await screen.findByText('观战页')).toBeInTheDocument();
  });

  it('开不起来就把后端那句话摆出来', async () => {
    vi.mocked(createGame).mockRejectedValue(new Error('没有这块板子：x'));
    const submit = await openDialog();

    for (let index = 1; index <= 12; index += 1) {
      await pick(index);
    }

    await userEvent.click(submit);

    expect(await screen.findByText('没有这块板子：x')).toBeInTheDocument();
  });

  it('没分出胜负的那局能续跑，排上队就进观战页', async () => {
    vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
    vi.mocked(fetchGames).mockResolvedValue({ games: [game({ status: GAME_STATUSES.FAILED })] });
    vi.mocked(runGame).mockResolvedValue({ gameId: 'g-1' });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '续跑' }));

    expect(runGame).toHaveBeenCalledWith('g-1');
    expect(await screen.findByText('观战页')).toBeInTheDocument();
  });

  it('已经分出胜负的那局不给续跑', async () => {
    vi.mocked(fetchBoards).mockResolvedValue({ boards: BOARDS });
    vi.mocked(fetchGames).mockResolvedValue({
      games: [game({ status: GAME_STATUSES.FINISHED, winner: 'good' })],
    });

    renderPage();

    expect(await screen.findByText('观战')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '续跑' })).toBeNull();
  });

  it('轮询自己顶掉的那次不算错，后端起来了红字也自己撤掉', async () => {
    vi.useFakeTimers();

    try {
      vi.mocked(fetchBoards)
        .mockRejectedValueOnce(new Error('连不上'))
        .mockRejectedValueOnce(new ApiError('canceled', { code: 'CANCELED' }))
        .mockResolvedValue({ boards: BOARDS });
      vi.mocked(fetchGames).mockResolvedValue({ games: [] });

      renderPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('连不上')).toBeInTheDocument();

      // 第二轮是「被下一轮顶掉」的那种失败：原来那句留着，不该换成 canceled
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText('连不上')).toBeInTheDocument();
      expect(screen.queryByText('canceled')).toBeNull();

      // 第三轮拿到数据：上一轮的红字得跟着撤掉
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.queryByText('连不上')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
