import { EVENT_KINDS, type EventKind } from '../store/events';
import { memoryEvents } from '../store/memory';
import { ledger, type Ledger } from './ledger';

const GAME = 'g1';
/** 用例里的读者；这一局发了两张牌。 */
const VIEWER = 'p1';
/** 公开事实的受众：在场的人都看得到。 */
const ALL = ['p1', 'p2'];

/** 记一条公开发言。用例里绝大多数都是这种。 */
function say(process: Ledger, key: string, day: number, text: string): Promise<void> {
  return process.add(key, day, text, ALL, EVENT_KINDS.PUBLIC_SPEECH);
}

/** 记一条别的类别的公开事实。 */
function sayAs(
  process: Ledger,
  kind: EventKind,
  key: string,
  day: number,
  text: string,
): Promise<void> {
  return process.add(key, day, text, ALL, kind);
}

/** 发言那条事实的键就是那次提问的行动键，说话人写在键里。折摘要得回键上取人。 */
function speechKey(actorId: string, ordinal: number): string {
  return JSON.stringify([GAME, 'day-1', 'speech', actorId, ordinal]);
}

/** 记一条公开发言，带上说话的人。 */
function saidBy(process: Ledger, actorId: string, ordinal: number, day: number): Promise<void> {
  return process.add(
    speechKey(actorId, ordinal),
    day,
    `${actorId} 号发言：第 ${day} 天的打算。`,
    ALL,
    EVENT_KINDS.PUBLIC_SPEECH,
  );
}

describe('过程台账', () => {
  it('没记过就是空的', () => {
    expect(ledger(memoryEvents(), GAME, []).factsFor(VIEWER)).toEqual([]);
  });

  it('按类别分块，块的先后定死，与记的先后无关', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    // 故意按打乱的顺序记：块序跟着类别走，不跟着谁先发生走。
    await say(process, 'a', 1, '2 号发言：我先过。');
    await sayAs(process, EVENT_KINDS.BALLOT, 'b', 1, '放逐投票：1 号投给 2 号；2 号票最多。');
    await sayAs(process, EVENT_KINDS.WOLF_SPEECH, 'c', 1, '狼队商量刀 3 号。');
    await sayAs(process, EVENT_KINDS.SHERIFF, 'd', 1, '1 号上警。');
    await sayAs(process, EVENT_KINDS.OTHER, 'e', 1, '3 号出局。');

    expect(process.factsFor(VIEWER).map((block) => block.title)).toEqual([
      '上警与警徽',
      '票型',
      '公开发言',
      '狼队商议',
      '其它',
    ]);
  });

  it('块内按记的顺序排，换天插一行分隔', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await say(process, 'a', 1, '1 号发言：我先过。');
    await say(process, 'b', 1, '2 号发言：我再看一轮。');
    await say(process, 'c', 2, '3 号发言：过。');

    expect(process.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '1 号发言：我先过。',
          '2 号发言：我再看一轮。',
          '【第 2 天】',
          '3 号发言：过。',
        ],
      },
    ]);
  });

  it('受众里没有他的条目整条抽掉，别人照样看得到；抽空的块不留', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await say(process, 'a', 1, '1 号发言：我先过。');
    await process.add('b', 1, '狼队商量刀 3 号。', ['p2'], EVENT_KINDS.WOLF_SPEECH);
    await say(process, 'c', 2, '3 号发言：过。');

    expect(process.factsFor('p1')).toEqual([
      {
        title: '公开发言',
        lines: ['【第 1 天】', '1 号发言：我先过。', '【第 2 天】', '3 号发言：过。'],
      },
    ]);
    expect(process.factsFor('p2')).toEqual([
      {
        title: '公开发言',
        lines: ['【第 1 天】', '1 号发言：我先过。', '【第 2 天】', '3 号发言：过。'],
      },
      { title: '狼队商议', lines: ['【第 1 天】', '狼队商量刀 3 号。'] },
    ]);
  });

  it('某一天没有他看得到的条目时，那一行的天号分隔也不留', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await process.add('a', 1, '狼队商量刀 3 号。', ['p2'], EVENT_KINDS.WOLF_SPEECH);
    await say(process, 'b', 2, '3 号发言：过。');

    expect(process.factsFor('p1')).toEqual([
      { title: '公开发言', lines: ['【第 2 天】', '3 号发言：过。'] },
    ]);
  });

  it('落库的那份带着序号、键、天数、类别和受众，按记的顺序排', async () => {
    const store = memoryEvents();
    const process = ledger(store, GAME, []);

    await sayAs(process, EVENT_KINDS.SHERIFF, 'a', 1, '1 号上警。');
    await process.add('b', 2, '狼队商量刀 3 号。', ['p2'], EVENT_KINDS.WOLF_SPEECH);

    expect(await store.list(GAME)).toEqual([
      { seq: 1, eventKey: 'a', day: 1, text: '1 号上警。', kind: 'sheriff', audience: ALL },
      {
        seq: 2,
        eventKey: 'b',
        day: 2,
        text: '狼队商量刀 3 号。',
        kind: 'wolf_speech',
        audience: ['p2'],
      },
    ]);
  });

  it('断点续跑：库里那几条铺回来，重放走过的路不会再添一条', async () => {
    const store = memoryEvents();
    const first = ledger(store, GAME, []);
    await say(first, 'a', 1, '1 号发言：我先过。');
    await say(first, 'b', 1, '2 号发言：我再看一轮。');

    // 断了再起：库里那两条先铺回来，然后从阶段开头重走，前两问原样再记一遍。
    const resumed = ledger(store, GAME, await store.list(GAME));
    await say(resumed, 'a', 1, '1 号发言：我先过。');
    await say(resumed, 'b', 1, '2 号发言：我再看一轮。');

    expect(resumed.factsFor(VIEWER)).toEqual(first.factsFor(VIEWER));

    await say(resumed, 'c', 2, '3 号发言：过。');

    expect(resumed.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '1 号发言：我先过。',
          '2 号发言：我再看一轮。',
          '【第 2 天】',
          '3 号发言：过。',
        ],
      },
    ]);
    // 重放的那两条不再落库，序号也不重排：续着往下接。
    expect(await store.list(GAME)).toEqual([
      {
        seq: 1,
        eventKey: 'a',
        day: 1,
        text: '1 号发言：我先过。',
        kind: 'public_speech',
        audience: ALL,
      },
      {
        seq: 2,
        eventKey: 'b',
        day: 1,
        text: '2 号发言：我再看一轮。',
        kind: 'public_speech',
        audience: ALL,
      },
      {
        seq: 3,
        eventKey: 'c',
        day: 2,
        text: '3 号发言：过。',
        kind: 'public_speech',
        audience: ALL,
      },
    ]);
  });

  it('库里那几条铺回来时，天数分隔照原样重建', async () => {
    const store = memoryEvents();
    const first = ledger(store, GAME, []);
    await say(first, 'a', 1, '1 号发言：我先过。');
    await say(first, 'b', 2, '2 号发言：我再看一轮。');

    const resumed = ledger(store, GAME, await store.list(GAME));

    expect(resumed.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: ['【第 1 天】', '1 号发言：我先过。', '【第 2 天】', '2 号发言：我再看一轮。'],
      },
    ]);
  });

  it('同一趟里同一个键记两遍是自己人出的错，当场抛', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await say(process, 'a', 1, '1 号发言：我先过。');

    await expect(say(process, 'a', 1, '1 号发言：我先过。')).rejects.toThrow('这一局已经记过 a');
  });

  it('交出去的是复印件，之后记的不往回渗', async () => {
    const process = ledger(memoryEvents(), GAME, []);
    await say(process, 'a', 1, '1 号发言：我先过。');

    const before = process.factsFor(VIEWER);
    await say(process, 'b', 1, '2 号发言：我再看一轮。');

    expect(before).toEqual([{ title: '公开发言', lines: ['【第 1 天】', '1 号发言：我先过。'] }]);
  });

  it('按记号取回当时那份：记号之后的都不算', async () => {
    const process = ledger(memoryEvents(), GAME, []);
    await say(process, 'a', 1, '1 号发言：我先过。');

    // 提问那一刻记下记号，那一刻看到的就这一条。
    const mark = process.lastSeq();
    await say(process, 'b', 2, '2 号发言：我再看一轮。');

    expect(mark).toBe(1);
    expect(process.factsFor(VIEWER, mark)).toEqual([
      { title: '公开发言', lines: ['【第 1 天】', '1 号发言：我先过。'] },
    ]);
    // 一条都还没记时记号是 0，取出来是空的。
    expect(ledger(memoryEvents(), GAME, []).lastSeq()).toBe(0);
    expect(process.factsFor(VIEWER, 0)).toEqual([]);
    expect(process.factsFor(VIEWER, process.lastSeq())).toEqual(process.factsFor(VIEWER));
  });

  it('断了再起：库里那份整份铺回来，按当时那个记号照样取回那一份', async () => {
    const store = memoryEvents();
    const first = ledger(store, GAME, []);
    await say(first, 'a', 1, '1 号发言：我先过。');

    const mark = first.lastSeq();
    const atAsk = first.factsFor(VIEWER, mark);
    await say(first, 'b', 1, '2 号发言：我再看一轮。');

    const resumed = ledger(store, GAME, await store.list(GAME));

    expect(resumed.factsFor(VIEWER)).toContainEqual({
      title: '公开发言',
      lines: ['【第 1 天】', '1 号发言：我先过。', '2 号发言：我再看一轮。'],
    });
    // 那一问之后记的那条已经在铺回来的那份里了，照整份复算就会多出一条。
    expect(resumed.factsFor(VIEWER, mark)).toEqual(atAsk);
  });
});

describe('滑动窗口与折叠摘要', () => {
  it('窗口外的发言折成摘要顶上，窗口里的照旧逐字给', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await saidBy(process, 'p1', 0, 1);
    await saidBy(process, 'p2', 0, 1);
    await saidBy(process, 'p1', 1, 2);
    await saidBy(process, 'p2', 1, 3);

    // 水位在第 3 天、窗口两天：该折的是第 1 天，第 2 天往后还逐字留着。
    expect(process.pendingSummaries()).toEqual([
      {
        key: 'summary:1:public_summary',
        day: 1,
        kind: EVENT_KINDS.PUBLIC_SUMMARY,
        audience: ALL,
        speeches: [
          { actorId: 'p1', lines: ['p1 号发言：第 1 天的打算。'] },
          { actorId: 'p2', lines: ['p2 号发言：第 1 天的打算。'] },
        ],
      },
    ]);

    await process.addSummary(
      process.pendingSummaries()[0],
      '1 号发言摘要：先过。\n2 号发言摘要：再看一轮。',
    );

    // 摘要落回第 1 天、排在它替掉的那几行上，那一整天的原文不再出现。
    expect(process.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '1 号发言摘要：先过。',
          '2 号发言摘要：再看一轮。',
          '【第 2 天】',
          'p1 号发言：第 2 天的打算。',
          '【第 3 天】',
          'p2 号发言：第 3 天的打算。',
        ],
      },
    ]);
    // 折过的不再列：水位不因为摘要那张写回过去的天号往后退。
    expect(process.pendingSummaries()).toEqual([]);
  });

  it('公开与狼队各折各的，一天一条，各自落回自己那一块', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await saidBy(process, 'p1', 0, 1);
    await process.add(
      speechKey('p1', 1),
      1,
      'p1 号商议发言：刀 2 号。',
      ALL,
      EVENT_KINDS.WOLF_SPEECH,
    );
    await saidBy(process, 'p1', 2, 3);

    const tasks = process.pendingSummaries();
    expect(tasks.map((task) => task.key)).toEqual([
      'summary:1:public_summary',
      'summary:1:wolf_summary',
    ]);

    await process.addSummary(tasks[0], '公开发言那天压成的这一行。');
    await process.addSummary(tasks[1], '狼队商议那天压成的这一行。');

    expect(process.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '公开发言那天压成的这一行。',
          '【第 3 天】',
          'p1 号发言：第 3 天的打算。',
        ],
      },
      { title: '狼队商议', lines: ['【第 1 天】', '狼队商议那天压成的这一行。'] },
    ]);
  });

  it('不带说话人的那几类不折，窗口外也逐字留着', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await sayAs(process, EVENT_KINDS.BALLOT, 'b1', 1, '放逐投票：1 号投给 2 号；2 号票最多。');
    await sayAs(process, EVENT_KINDS.SHERIFF, 's1', 1, '1 号上警。');
    await saidBy(process, 'p1', 0, 3);

    // 水位第 3 天，第 1 天在窗口外：发言那条要折（还没折，所以看不见），票型与警徽照旧。
    expect(process.factsFor(VIEWER)).toEqual([
      { title: '上警与警徽', lines: ['【第 1 天】', '1 号上警。'] },
      { title: '票型', lines: ['【第 1 天】', '放逐投票：1 号投给 2 号；2 号票最多。'] },
      { title: '公开发言', lines: ['【第 3 天】', 'p1 号发言：第 3 天的打算。'] },
    ]);
  });

  it('记号取在摘要落库之前：摘要照给，它折的那一天不至于两样都没有', async () => {
    const process = ledger(memoryEvents(), GAME, []);

    await saidBy(process, 'p1', 0, 1);
    await saidBy(process, 'p1', 1, 3);

    // 那一刻的位置：第 1 天的原文与第 3 天那条都在记号之内，摘要还没落库。
    const mark = process.lastSeq();
    await process.addSummary(process.pendingSummaries()[0], '1 号发言摘要：先过。');

    expect(process.factsFor(VIEWER, mark)).toEqual([
      {
        title: '公开发言',
        lines: ['【第 1 天】', '1 号发言摘要：先过。', '【第 3 天】', 'p1 号发言：第 3 天的打算。'],
      },
    ]);
  });

  it('按记号取回的那一刻那份，与当初问出去时看到的是同一份', async () => {
    const store = memoryEvents();
    const process = ledger(store, GAME, []);

    await saidBy(process, 'p1', 0, 1);
    await saidBy(process, 'p2', 0, 1);
    await saidBy(process, 'p1', 1, 2);
    await saidBy(process, 'p1', 2, 3);

    // 问出去那一刻：摘要先折好落库，记号在那之后取，于是题面里给的是摘要。
    await process.addSummary(process.pendingSummaries()[0], '1 号发言摘要：先过。');
    const mark = process.lastSeq();
    const atAsk = process.factsFor(VIEWER, mark);

    expect(atAsk).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '1 号发言摘要：先过。',
          '【第 2 天】',
          'p1 号发言：第 2 天的打算。',
          '【第 3 天】',
          'p1 号发言：第 3 天的打算。',
        ],
      },
    ]);
    // 第一次问没有记号，取的是此刻这份；此刻就是那一刻，两份得一模一样。
    expect(process.factsFor(VIEWER)).toEqual(atAsk);

    // 答完记下这一条。断了再起：库里整份铺回来，同一个记号取出来还得是当初那一份。
    await saidBy(process, 'p2', 3, 3);
    const resumed = ledger(store, GAME, await store.list(GAME));

    expect(resumed.factsFor(VIEWER, mark)).toEqual(atAsk);
  });
});
