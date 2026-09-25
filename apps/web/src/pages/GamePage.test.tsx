import { DEATH_CAUSES, GAME_STATUSES, type GameDetail } from '@werewolf/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGameDetail,
  fetchBoards,
  fetchActionSummaries,
  fetchActionDetail,
  fetchReview,
  fetchReviewPreview,
  startReview,
} from '@/lib/api-client';
import { reviewPreview, reviewResponse } from '@/test/review-fixture';
import { SceneRow } from '@/components/game-watch/SceneRow';
import { GamePage } from './GamePage';

vi.mock('@/lib/api-client', () => ({
  fetchGameDetail: vi.fn(),
  fetchBoards: vi.fn(),
  fetchActionSummaries: vi.fn(),
  fetchActionDetail: vi.fn(),
  fetchReview: vi.fn(),
  fetchReviewPreview: vi.fn(),
  startReview: vi.fn(),
}));

// 记一笔事实行被画了几次：正在写的那一段每秒来几十片，事实那一叠不该跟着重画。
vi.mock('@/components/game-watch/SceneRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/game-watch/SceneRow')>();

  return { SceneRow: vi.fn(actual.SceneRow) };
});

/** 记下页面挂上来的那一个收信口，用例直接往里塞消息，等于服务端推了一条。 */
const inbox: ((message: MessageEvent<string>) => void)[] = [];

/** 连接那边的状态，用例按需摆：错误得摆到页面上，不能只留在 hook 里。 */
let streamState: { connected: boolean; error: unknown } = { connected: true, error: null };

vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: (_url: string, onMessage: (message: MessageEvent<string>) => void) => {
    inbox.push(onMessage);

    return streamState;
  },
}));

function detail(overrides: Partial<GameDetail> = {}): GameDetail {
  return {
    gameId: 'g-1',
    boardId: '6p_white_wolf',
    status: GAME_STATUSES.RUNNING,
    winner: null,
    createdAt: '2026-09-22T10:00:00.000Z',
    aliveCount: 2,
    day: 1,
    players: [
      {
        id: 'p1',
        seatNo: 1,
        role: 'seer',
        faction: 'good',
        isAlive: true,
        deathDay: null,
        deathCause: null,
        isSheriff: true,
      },
      {
        id: 'p2',
        seatNo: 2,
        role: 'white_wolf',
        faction: 'werewolf',
        isAlive: false,
        deathDay: 1,
        deathCause: DEATH_CAUSES.NIGHT_KILL,
        isSheriff: false,
      },
    ],
    roster: [],
    ...overrides,
  };
}

/** 推一条事实进来：state 更新落在 React 外面，得括进 act 里。 */
function push(seq: number, text: string, audience: string[]) {
  act(() => {
    inbox.at(-1)!(
      new MessageEvent('message', {
        data: JSON.stringify({ seq, day: 1, kind: 'public_speech', text, audience }),
        lastEventId: String(seq),
      }),
    );
  });
}

/** 推一片正在生成的那一段。不带 id——带了会把断点顶掉，这是服务端那头的约定。 */
function pushWriting(
  callId: string,
  channel: 'reasoning' | 'content',
  text: string,
  step = 'generate',
) {
  act(() => {
    inbox.at(-1)!(
      new MessageEvent('preview', {
        data: JSON.stringify({
          actionKey: 'k1',
          day: 1,
          actorId: 'p1',
          seatNo: 1,
          actionType: 'speech',
          step,
          callId,
          channel,
          text,
        }),
      }),
    );
  });
}

function page(entry = '/games/g-1') {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/games/:gameId" element={<GamePage />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderPage() {
  return render(page());
}

describe('GamePage', () => {
  it('日终判断在上帝视角展示玩家、截止位置及变化，闭眼视角隐藏', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });
    vi.mocked(fetchActionSummaries).mockResolvedValue({
      actions: [
        {
          actionKey: '日终判断1',
          actionType: 'day_end_judgment',
          day: 1,
          seatNo: 1,
          role: '预言家',
          task: '整理个人判断',
          ledgerSeq: 18,
          hasReasoning: false,
          phase: 'dayEnd',
          eventSeq: null,
          decision: { assessment: '我开始怀疑2号的主张。', changes: '新票型使我改变了看法。' },
        },
      ],
      pending: [],
    });
    renderPage();
    expect(await screen.findByText('第 1 天 · 日终')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 号 · 日终个人判断/ })).toBeInTheDocument();
    expect(screen.getByText(/信息截至事件 #18/)).toHaveTextContent('私有判断，可能有误');
    expect(screen.getByText(/主要变化：新票型使我改变了看法/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));
    expect(screen.queryByText(/我开始怀疑2号的主张/)).toBeNull();
    expect(screen.queryByText(/信息截至事件 #18/)).toBeNull();
  });
  it('已结束页面通过入口打开复盘，地址中的复盘视图可在刷新后恢复', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ status: GAME_STATUSES.FINISHED, winner: 'good' }),
    });
    vi.mocked(fetchReviewPreview).mockResolvedValue(reviewPreview);
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse());
    const view = renderPage();
    await userEvent.click(await screen.findByRole('link', { name: '赛后复盘' }));
    expect(await screen.findByText('玩家当时视角')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '闭眼视角' })).toBeNull();
    view.unmount();
    render(page('/games/g-1?view=review'));
    expect(await screen.findByText('玩家当时视角')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: '返回对局记录' }));
    expect(screen.getByRole('tab', { name: '闭眼视角' })).toBeInTheDocument();
    expect(startReview).not.toHaveBeenCalled();
  });

  it.each([GAME_STATUSES.RUNNING, GAME_STATUSES.FAILED])(
    '%s 的对局不展示复盘入口，也不读取复盘',
    async (status) => {
      vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail({ status }) });
      vi.mocked(fetchReview).mockClear();
      render(page('/games/g-1?view=review'));
      await screen.findByText('预言家');
      expect(screen.queryByRole('link', { name: '赛后复盘' })).toBeNull();
      expect(fetchReview).not.toHaveBeenCalled();
    },
  );

  it('终局详情晚于并行摘要时，最终行动仍会显示并清掉未完成状态', async () => {
    vi.useFakeTimers();
    let finishDetail!: (value: { game: GameDetail }) => void;
    vi.mocked(fetchGameDetail).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDetail = resolve;
        }),
    );
    vi.mocked(fetchActionSummaries)
      .mockResolvedValueOnce({
        actions: [],
        pending: [
          { actionKey: 'last', actionType: 'vote', actorId: 'p1', ledgerSeq: 0, phase: 'vote' },
        ],
      })
      .mockResolvedValue({
        actions: [
          {
            actionKey: 'last',
            actionType: 'vote',
            seatNo: 1,
            role: '预言家',
            day: 1,
            task: '投票',
            decision: 2,
            ledgerSeq: 0,
            hasReasoning: true,
            phase: 'vote',
            eventSeq: null,
          },
        ],
        pending: [],
      });
    const view = renderPage();
    try {
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(async () => {
        finishDetail({ game: detail({ status: GAME_STATUSES.FINISHED, winner: 'good' }) });
      });
      const row = screen.getByRole('button', { name: /1 号 · 投票/ });
      expect(row).toHaveTextContent('已完成');
      expect(screen.queryByText('已中断')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(30000));
      expect(fetchActionSummaries).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('读到终局后再读取最终摘要，成功后才停止轮询', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ status: GAME_STATUSES.FINISHED }),
    });
    vi.mocked(fetchActionSummaries)
      .mockResolvedValueOnce({
        actions: [],
        pending: [
          { actionKey: 'last', actionType: 'vote', actorId: 'p1', ledgerSeq: 0, phase: 'vote' },
        ],
      })
      .mockRejectedValueOnce(new Error('最终摘要暂时不可用'));
    const view = renderPage();
    try {
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(fetchActionSummaries).toHaveBeenCalledTimes(2);
      expect(screen.getByText('最终摘要暂时不可用')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(fetchActionSummaries).toHaveBeenCalledTimes(4);
      expect(screen.queryByText('最终摘要暂时不可用')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(30000));
      expect(fetchActionSummaries).toHaveBeenCalledTimes(4);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('中断后仍低频轮询，其他页面恢复对局时更新状态和玩家', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchGameDetail)
      .mockResolvedValueOnce({ game: detail({ status: GAME_STATUSES.FAILED }) })
      .mockResolvedValue({
        game: detail({
          day: 2,
          players: detail().players.map((player) => ({
            ...player,
            isAlive: true,
            deathDay: null,
            deathCause: null,
          })),
        }),
      });
    const view = renderPage();
    try {
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole('button', { name: '恢复对局' })).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(10000));
      expect(fetchGameDetail).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('button', { name: '恢复对局' })).toBeNull();
      expect(screen.queryByText('第 1 天出局 · 夜里被杀')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(fetchGameDetail).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('详情请求超过轮询间隔仍只发一次，完成后才安排下一轮', async () => {
    vi.useFakeTimers();
    let release!: (value: { game: GameDetail }) => void;
    vi.mocked(fetchGameDetail).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(page());
    try {
      await act(() => vi.advanceTimersByTimeAsync(10000));
      expect(fetchGameDetail).toHaveBeenCalledTimes(1);
      await act(async () => {
        release({ game: detail() });
      });
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(fetchGameDetail).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => {
        release({ game: detail() });
      });
      await act(() => vi.advanceTimersByTimeAsync(10000));
      expect(fetchGameDetail).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    inbox.length = 0;
    vi.mocked(fetchBoards).mockResolvedValue({ boards: [] });
    vi.mocked(fetchActionSummaries).mockReset().mockResolvedValue({ actions: [], pending: [] });
    streamState = { connected: true, error: null };
    // jsdom 里没有滚动这回事，页面跟到底那一下得先给它一个实现。
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.mocked(fetchGameDetail).mockReset();
  });

  it('上帝视角那张牌桌：座位、角色、出局的天数与死因、警长', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();

    expect(await screen.findByText('预言家')).toBeInTheDocument();
    expect(screen.getByText('白狼王')).toBeInTheDocument();
    expect(screen.getByText('1 号')).toBeInTheDocument();
    expect(screen.getByText('第 1 天出局 · 夜里被杀')).toBeInTheDocument();
    expect(screen.getByLabelText('警长')).toBeInTheDocument();
  });

  it('座位按座次折半分到两边：左一半、右一半', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    expect(within(screen.getByLabelText('左侧座位')).getByText('1 号')).toBeInTheDocument();
    expect(within(screen.getByLabelText('右侧座位')).getByText('2 号')).toBeInTheDocument();
  });

  it('切到闭眼：只发给某几个人的那条不再露面，公开的照旧', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    push(1, '法官宣布天黑请闭眼', ['p1', 'p2']);
    push(2, '狼队商议：先刀 1 号', ['p2']);

    expect(await screen.findByText('狼队商议：先刀 1 号')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));

    expect(screen.queryByText('狼队商议：先刀 1 号')).toBeNull();
    expect(screen.getByText('法官宣布天黑请闭眼')).toBeInTheDocument();
  });

  it('事实按顺序显示，不显示内部受众名单', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    push(1, '1 号查验了 2 号', ['p1']);
    push(2, '狼队刀了 1 号', ['p2', 'p1']);

    expect(await screen.findByText('1 号查验了 2 号')).toBeInTheDocument();
    expect(screen.queryByText(/看得见的人/)).toBeNull();
  });

  it('同一条事实重发一遍不会排成两行', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    push(1, '1 号查验了 2 号', ['p1']);
    push(1, '1 号查验了 2 号', ['p1']);

    expect(await screen.findByText('1 号查验了 2 号')).toBeInTheDocument();
    expect(screen.getAllByText('1 号查验了 2 号')).toHaveLength(1);
  });

  it('分出胜负之后把胜方摆出来', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ status: GAME_STATUSES.FINISHED, winner: 'werewolf' }),
    });

    renderPage();

    expect(await screen.findByText('已结束 · 胜方 狼人')).toBeInTheDocument();
  });

  it('这一局读不到就把后端那句话摆出来', async () => {
    vi.mocked(fetchGameDetail).mockRejectedValue(new Error('没有这一局：g-1'));

    renderPage();

    expect(await screen.findByText('没有这一局：g-1')).toBeInTheDocument();
  });

  it('闭眼把最后一条挡住时，说的是挡住了而不是还没有事实', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    push(1, '狼队商议：先刀 1 号', ['p2']);
    await screen.findByText('狼队商议：先刀 1 号');

    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));

    expect(screen.getByText('闭眼视角下，这一局还没有公开的事实。')).toBeInTheDocument();
    expect(screen.queryByText('还没有事实。')).toBeNull();
  });

  it('还没发牌：两侧座位区不渲染，中栏摆一句', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ players: [], aliveCount: null, day: null }),
    });

    renderPage();

    expect(await screen.findByText('还没发牌。')).toBeInTheDocument();
    expect(screen.queryByLabelText('左侧座位')).toBeNull();
    expect(screen.queryByLabelText('右侧座位')).toBeNull();
  });

  it('法官播报保留昼夜分隔，闭眼视角看不到查验结果', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });
    renderPage();
    await screen.findByText('预言家');
    act(() => {
      for (const event of [
        {
          seq: 1,
          day: 1,
          kind: 'system',
          phase: 'night',
          text: '预言家请睁眼，选择要查验的玩家。',
          audience: ['p1', 'p2'],
        },
        {
          seq: 2,
          day: 1,
          kind: 'system',
          phase: 'night',
          text: '查验结果：2 号是狼人。',
          audience: ['p1'],
        },
        {
          seq: 3,
          day: 1,
          kind: 'system',
          phase: 'day',
          text: '天亮了，昨晚是平安夜。',
          audience: ['p1', 'p2'],
        },
      ])
        inbox.at(-1)!(new MessageEvent('message', { data: JSON.stringify(event) }));
    });
    expect(screen.getByText('第 1 天 · 夜晚')).toBeInTheDocument();
    expect(screen.getByText('第 1 天 · 白天')).toBeInTheDocument();
    expect(screen.getByText('查验结果：2 号是狼人。', { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));
    expect(screen.queryByText('查验结果：2 号是狼人。', { exact: false })).toBeNull();
    expect(screen.getByText('天亮了，昨晚是平安夜。', { exact: false })).toBeInTheDocument();
  });

  it('正在写的那一段边写边冒：思考先落，正文接在下面，两段各留各的', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    pushWriting('c1', 'reasoning', '3 号跳了预言家，');
    expect(await screen.findByText('3 号跳了预言家，')).toBeInTheDocument();
    expect(screen.getByText(/1 号 · 发言/)).toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();

    // 每片带的是这一路到目前的全文，收到整段换掉，不是往后接。
    pushWriting('c1', 'content', '我坐 3 号，');
    pushWriting('c1', 'content', '我坐 3 号，先听前面的。');

    expect(screen.getByText('我坐 3 号，先听前面的。')).toBeInTheDocument();
    expect(screen.queryByText('我坐 3 号，')).toBeNull();
    // 输出草稿时思考收起，仍能随时展开。
    expect(screen.queryByText('3 号跳了预言家，')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '思考过程' }));
    expect(screen.getByText('3 号跳了预言家，')).toBeInTheDocument();
  });

  it('换了 callId 就是重问的一趟：上一趟的字一个都不留', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    pushWriting('c1', 'content', '先投 7 号');
    await screen.findByText('先投 7 号');

    pushWriting('c2', 'reasoning', '候选里没有 7 号');

    // 两趟是两次回答，接在一起就是它没说过的话。
    expect(await screen.findByText('候选里没有 7 号')).toBeInTheDocument();
    expect(screen.queryByText('先投 7 号')).toBeNull();
  });

  it('无关事实不清掉正在输出的思考，完成后仍能展开历史', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });
    renderPage();
    await screen.findByText('预言家');
    pushWriting('c1', 'reasoning', '这段思考要保留');
    push(1, '法官公布票型', ['p1', 'p2']);
    expect(screen.getByText('这段思考要保留')).toBeInTheDocument();
    act(() =>
      inbox.at(-1)!(
        new MessageEvent('preview', {
          data: JSON.stringify({
            actionKey: 'k1',
            day: 1,
            seatNo: 1,
            actionType: 'speech',
            step: 'generate',
            callId: 'task1',
            channel: 'node',
            status: 'completed',
            text: '发言已完成',
          }),
        }),
      ),
    );
    expect(screen.queryByText('这段思考要保留')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '思考过程' }));
    expect(screen.getByText('这段思考要保留')).toBeInTheDocument();
  });

  it('刷新后可按需展开已完成行动的思考和节点，折叠再开不重复读取', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ status: GAME_STATUSES.FINISHED, winner: 'good' }),
    });
    vi.mocked(fetchActionSummaries).mockResolvedValue({
      actions: [
        {
          actionKey: 'a1',
          actionType: 'vote',
          seatNo: 1,
          role: '预言家',
          day: 1,
          task: '投票',
          decision: 2,
          ledgerSeq: 0,
          hasReasoning: true,
          phase: 'day',
          eventSeq: null,
        },
      ],
      pending: [],
    });
    vi.mocked(fetchActionDetail).mockResolvedValue({
      reasoning: '保存的思考',
      steps: [
        {
          id: 's1',
          name: 'generate',
          status: 'completed',
          content: '投 2 号',
          reasoning: '保存的思考',
        },
        {
          id: 's2',
          name: 'finalize',
          status: 'completed',
          content: '行动结果已确认',
          reasoning: null,
        },
      ],
    });
    renderPage();
    const trigger = await screen.findByRole('button', { name: /1 号 · 投票/ });
    expect(fetchActionDetail).not.toHaveBeenCalled();
    await userEvent.click(trigger);
    expect(await screen.findByText('确认结果')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '思考过程' }));
    expect(screen.getByText('保存的思考')).toBeInTheDocument();
    await userEvent.click(trigger);
    await userEvent.click(trigger);
    expect(fetchActionDetail).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));
    expect(screen.queryByRole('button', { name: /1 号 · 投票/ })).toBeNull();
  });

  it('正在写的字往外冒时，落下的事实一行都不重画', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    push(1, '法官宣布天黑请闭眼', ['p1', 'p2']);
    push(2, '狼队刀了 1 号', ['p1', 'p2']);
    await screen.findByText('狼队刀了 1 号');

    const rows = vi.mocked(SceneRow);
    expect(rows).toHaveBeenCalled();
    rows.mockClear();

    pushWriting('c1', 'reasoning', '3 号跳了预言家，');
    pushWriting('c1', 'content', '我坐 3 号，先听前面的。');
    await screen.findByText('我坐 3 号，先听前面的。');

    expect(rows).not.toHaveBeenCalled();
  });

  it('终局后的历史中断行动仍在原自爆窗口，刷新不把它追加到终局后', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ status: GAME_STATUSES.FINISHED, winner: 'good' }),
    });
    vi.mocked(fetchActionSummaries).mockResolvedValue({
      actions: [],
      pending: [
        {
          actionKey: 'old-blast',
          actionType: 'wolf_explode',
          actorId: 'p1',
          ledgerSeq: 1,
          phase: 'day',
        },
      ],
    });
    const assertOrder = async () => {
      await screen.findByRole('button', { name: /1 号 · 自爆判断/ });
      push(1, '进入自爆窗口', ['p1', 'p2']);
      push(2, '另一名狼人自爆出局', ['p1', 'p2']);
      push(3, '对局结束，好人阵营获胜', ['p1', 'p2']);
      const action = screen.getByRole('button', { name: /1 号 · 自爆判断/ });
      expect(action).toHaveTextContent('已中断');
      expect(
        screen.getByText('进入自爆窗口').compareDocumentPosition(action) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        action.compareDocumentPosition(screen.getByText('另一名狼人自爆出局')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getAllByRole('button', { name: /1 号 · 自爆判断/ })).toHaveLength(1);
    };
    const view = renderPage();
    await assertOrder();
    view.unmount();
    renderPage();
    await assertOrder();
  });

  it('中断后刷新也能展开未完成行动，并把未完成节点标为中断', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({
      game: detail({ status: GAME_STATUSES.FAILED }),
    });
    vi.mocked(fetchActionSummaries).mockResolvedValue({
      actions: [],
      pending: [
        {
          actionKey: 'pending1',
          ledgerSeq: 0,
          phase: 'vote',
          actionType: 'vote',
          actorId: 'p1',
        },
      ],
    });
    vi.mocked(fetchActionDetail).mockResolvedValue({
      reasoning: null,
      steps: [
        {
          id: 's1',
          name: 'generate',
          status: 'completed',
          content: '2',
          reasoning: '已经保存的生成思考',
        },
        { id: 's2', name: 'critique', status: 'running', content: '', reasoning: null },
      ],
    });
    renderPage();
    const trigger = await screen.findByRole('button', { name: /1 号 · 投票/ });
    expect(trigger).toHaveTextContent('已中断');
    await userEvent.click(trigger);
    expect(await screen.findByText('复核')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '思考过程' }));
    expect(screen.getByText('已经保存的生成思考')).toBeInTheDocument();
    expect(screen.queryByText(/^结果：/)).toBeNull();
  });

  it('闭眼视角下也在往外冒字，事实那几行照样不重画', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    push(1, '法官宣布天黑请闭眼', ['p1', 'p2']);
    await screen.findByText('法官宣布天黑请闭眼');
    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));

    const rows = vi.mocked(SceneRow);
    rows.mockClear();

    // 闭眼那一支每次都现 filter 一遍，这一层要是没定住，预览每来一片都会重画整个列表。
    pushWriting('c1', 'reasoning', '3 号跳了预言家，');

    expect(rows).not.toHaveBeenCalled();
  });

  it('闭眼视角下不摆这张卡片：预览里只有座位号，认不出这一问公不公开', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });

    renderPage();
    await screen.findByText('预言家');

    pushWriting('c1', 'reasoning', '3 号跳了预言家，');
    await screen.findByText('3 号跳了预言家，');

    await userEvent.click(screen.getByRole('tab', { name: '闭眼视角' }));

    expect(screen.queryByText('3 号跳了预言家，')).toBeNull();
  });

  it('流断了要说出来：一直写「连接中」看不出要不要刷新', async () => {
    vi.mocked(fetchGameDetail).mockResolvedValue({ game: detail() });
    streamState = { connected: false, error: new Error('事件流连接失败：500') };

    renderPage();

    expect(await screen.findByText('已断开：事件流连接失败：500')).toBeInTheDocument();
    expect(screen.queryByText('连接中')).toBeNull();
  });
});
