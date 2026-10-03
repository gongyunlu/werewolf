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
  it('插入别人私密行动不改变本人可见编号，受众不同则各自连续编号', async () => {
    const plain = ledger(memoryEvents(), GAME, [], ALL);
    const store = memoryEvents();
    const hidden = ledger(store, GAME, [], ALL);
    for (const process of [plain, hidden])
      await process.add('open', 1, '女巫请睁眼。', ALL, EVENT_KINDS.SYSTEM);
    await hidden.add('choice', 1, '你选择不用药。', ['p2'], EVENT_KINDS.SYSTEM);
    for (const process of [plain, hidden])
      await process.add('close', 1, '女巫请闭眼。', ALL, EVENT_KINDS.SYSTEM);

    expect(hidden.factsFor('p1')).toEqual(plain.factsFor('p1'));
    expect(hidden.factsFor('p1')[0].lines).toEqual([
      '【第 1 天】',
      '[#1] 女巫请睁眼。',
      '[#2] 女巫请闭眼。',
    ]);
    expect(hidden.factsFor('p2').flatMap((block) => block.lines)).toEqual(
      expect.arrayContaining(['[#2] 你选择不用药。', '[#3] 女巫请闭眼。']),
    );
    const resumed = ledger(store, GAME, await store.list(GAME), ALL);
    expect(resumed.factsFor('p1', 1)).toEqual(plain.factsFor('p1', 1));
  });

  it('跨类别保留事件先后，摘要不使用生成时的序号冒充原发言时点', async () => {
    const store = memoryEvents();
    const process = ledger(store, GAME, [], ALL);
    await process.add(speechKey('p1', 0), 1, '1号归票2号。', ALL, EVENT_KINDS.PUBLIC_SPEECH);
    await process.add('ballot', 1, '1号、3号投2号。', ALL, EVENT_KINDS.BALLOT);
    await process.add('exile', 1, '2号被放逐。', ALL, EVENT_KINDS.SYSTEM);
    await process.add('badge', 1, '2号撕掉警徽。', ALL, EVENT_KINDS.SHERIFF);

    expect(process.factsFor('p1').flatMap((block) => block.lines)).toEqual(
      expect.arrayContaining([
        '[#1] 1号归票2号。',
        '[#2] 1号、3号投2号。',
        '[#3] 2号被放逐。',
        '[#4] 2号撕掉警徽。',
      ]),
    );
    await process.add('night', 3, '第3夜开始。', ALL, EVENT_KINDS.SYSTEM);
    const task = process.pendingSummaries()[0];
    await process.addSummary(task, '1号曾归票2号。');
    const resumed = ledger(store, GAME, await store.list(GAME), ALL);
    expect(resumed.factsFor('p1').find((block) => block.title === '公开发言')?.lines).toEqual([
      '【第 1 天】',
      '1号曾归票2号。',
    ]);
    expect(resumed.factsFor('p1', 3).flatMap((block) => block.lines)).not.toContain(
      '[#4] 2号撕掉警徽。',
    );
  });

  it.each([EVENT_KINDS.SYSTEM, EVENT_KINDS.OTHER])(
    '%s 相同原文按事件受众区分公私，跨天恢复仍服从原受众和提问水位',
    async (kind) => {
      const store = memoryEvents();
      const process = ledger(store, GAME, [], ALL);
      const publicTitle = kind === EVENT_KINDS.SYSTEM ? '法官播报' : '其它';
      const privateTitle = kind === EVENT_KINDS.SYSTEM ? '法官私密告知' : '其它私密记录';
      const text = '狼队今晚选择袭击5号。';
      await process.add('private-1', 1, text, ['p1'], kind);
      const privateMark = process.lastSeq();

      // 此前只有私密记录，不能把当前最大受众误当作全员。
      expect(process.factsFor('p1')).toEqual([
        { title: privateTitle, lines: ['【第 1 天】', `[#1] ${text}`] },
      ]);
      expect(process.factsFor('p2')).toEqual([]);

      await process.add('public', 1, text, ALL.toReversed(), kind);
      await process.add('private-2', 2, text, ['p2'], kind);
      const beforeFuture = process.lastSeq();
      const p1BeforeFuture = process.factsFor('p1');
      const p2BeforeFuture = process.factsFor('p2');
      await process.add('future', 3, '次日记录。', ALL, kind);
      const resumed = ledger(store, GAME, await store.list(GAME), ALL);

      expect(p1BeforeFuture).toEqual([
        { title: publicTitle, lines: ['【第 1 天】', `[#2] ${text}`] },
        { title: privateTitle, lines: ['【第 1 天】', `[#1] ${text}`] },
      ]);
      expect(p2BeforeFuture).toEqual([
        { title: publicTitle, lines: ['【第 1 天】', `[#1] ${text}`] },
        { title: privateTitle, lines: ['【第 2 天】', `[#2] ${text}`] },
      ]);
      expect(resumed.factsFor('p1', beforeFuture)).toEqual(p1BeforeFuture);
      expect(resumed.factsFor('p2', beforeFuture)).toEqual(p2BeforeFuture);
      expect(resumed.factsFor('p2', privateMark)).toEqual([]);
      expect(resumed.factsFor('p1', privateMark)).toEqual([
        { title: privateTitle, lines: ['【第 1 天】', `[#1] ${text}`] },
      ]);
    },
  );

  it('法官播报进入玩家上下文，恢复后仍按受众和提问水位隔离', async () => {
    const store = memoryEvents();
    const process = ledger(store, GAME, [], ALL);
    await sayAs(process, EVENT_KINDS.SYSTEM, 'death', 1, '昨晚 4 号倒牌。');
    await sayAs(process, EVENT_KINDS.SYSTEM, 'blast', 1, '3 号自爆出局。');
    await sayAs(process, EVENT_KINDS.SYSTEM, 'take', 1, '3 号发动技能，带走了 2 号。');
    await process.add('check', 1, '你查验了 6 号，是狼人。', ['p2'], EVENT_KINDS.SYSTEM);
    await process.add('wolf', 1, '狼队刀了 4 号。', ['p2'], EVENT_KINDS.WOLF_SPEECH);
    await sayAs(process, EVENT_KINDS.SYSTEM, 'future', 2, '昨晚平安夜。');

    const resumed = ledger(store, GAME, await store.list(GAME), ALL);
    expect(resumed.factsFor(VIEWER, 5)).toEqual([
      {
        title: '法官播报',
        lines: [
          '【第 1 天】',
          '[#1] 昨晚 4 号倒牌。',
          '[#2] 3 号自爆出局。',
          '[#3] 3 号发动技能，带走了 2 号。',
        ],
      },
    ]);
    expect(resumed.factsFor(VIEWER, 1)[0].lines).toEqual(['【第 1 天】', '[#1] 昨晚 4 号倒牌。']);
    expect(resumed.factsFor('p2', 5).flatMap((block) => block.lines)).toContain(
      '[#4] 你查验了 6 号，是狼人。',
    );
  });

  it('没记过就是空的', () => {
    expect(ledger(memoryEvents(), GAME, [], ALL).factsFor(VIEWER)).toEqual([]);
  });

  it('按类别分块，块的先后定死，与记的先后无关', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

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
    const process = ledger(memoryEvents(), GAME, [], ALL);

    await say(process, 'a', 1, '1 号发言：我先过。');
    await say(process, 'b', 1, '2 号发言：我再看一轮。');
    await say(process, 'c', 2, '3 号发言：过。');

    expect(process.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '[#1] 1 号发言：我先过。',
          '[#2] 2 号发言：我再看一轮。',
          '【第 2 天】',
          '[#3] 3 号发言：过。',
        ],
      },
    ]);
  });

  it('受众里没有他的条目整条抽掉，别人照样看得到；抽空的块不留', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

    await say(process, 'a', 1, '1 号发言：我先过。');
    await process.add('b', 1, '狼队商量刀 3 号。', ['p2'], EVENT_KINDS.WOLF_SPEECH);
    await say(process, 'c', 2, '3 号发言：过。');

    expect(process.factsFor('p1')).toEqual([
      {
        title: '公开发言',
        lines: ['【第 1 天】', '[#1] 1 号发言：我先过。', '【第 2 天】', '[#2] 3 号发言：过。'],
      },
    ]);
    expect(process.factsFor('p2')).toEqual([
      {
        title: '公开发言',
        lines: ['【第 1 天】', '[#1] 1 号发言：我先过。', '【第 2 天】', '[#3] 3 号发言：过。'],
      },
      { title: '狼队商议', lines: ['【第 1 天】', '[#2] 狼队商量刀 3 号。'] },
    ]);
  });

  it('某一天没有他看得到的条目时，那一行的天号分隔也不留', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

    await process.add('a', 1, '狼队商量刀 3 号。', ['p2'], EVENT_KINDS.WOLF_SPEECH);
    await say(process, 'b', 2, '3 号发言：过。');

    expect(process.factsFor('p1')).toEqual([
      { title: '公开发言', lines: ['【第 2 天】', '[#1] 3 号发言：过。'] },
    ]);
  });

  it('落库的那份带着序号、键、天数、类别和受众，按记的顺序排', async () => {
    const store = memoryEvents();
    const process = ledger(store, GAME, [], ALL);

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
    const first = ledger(store, GAME, [], ALL);
    await say(first, 'a', 1, '1 号发言：我先过。');
    await say(first, 'b', 1, '2 号发言：我再看一轮。');

    // 断了再起：库里那两条先铺回来，然后从阶段开头重走，前两问原样再记一遍。
    const resumed = ledger(store, GAME, await store.list(GAME), ALL);
    await say(resumed, 'a', 1, '1 号发言：我先过。');
    await say(resumed, 'b', 1, '2 号发言：我再看一轮。');

    expect(resumed.factsFor(VIEWER)).toEqual(first.factsFor(VIEWER));

    await say(resumed, 'c', 2, '3 号发言：过。');

    expect(resumed.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '[#1] 1 号发言：我先过。',
          '[#2] 2 号发言：我再看一轮。',
          '【第 2 天】',
          '[#3] 3 号发言：过。',
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
    const first = ledger(store, GAME, [], ALL);
    await say(first, 'a', 1, '1 号发言：我先过。');
    await say(first, 'b', 2, '2 号发言：我再看一轮。');

    const resumed = ledger(store, GAME, await store.list(GAME), ALL);

    expect(resumed.factsFor(VIEWER)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '[#1] 1 号发言：我先过。',
          '【第 2 天】',
          '[#2] 2 号发言：我再看一轮。',
        ],
      },
    ]);
  });

  it('同一趟里同一个键记两遍是自己人出的错，当场抛', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

    await say(process, 'a', 1, '1 号发言：我先过。');

    await expect(say(process, 'a', 1, '1 号发言：我先过。')).rejects.toThrow('这一局已经记过 a');
  });

  it('交出去的是复印件，之后记的不往回渗', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);
    await say(process, 'a', 1, '1 号发言：我先过。');

    const before = process.factsFor(VIEWER);
    await say(process, 'b', 1, '2 号发言：我再看一轮。');

    expect(before).toEqual([
      { title: '公开发言', lines: ['【第 1 天】', '[#1] 1 号发言：我先过。'] },
    ]);
  });

  it('按记号取回当时那份：记号之后的都不算', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);
    await say(process, 'a', 1, '1 号发言：我先过。');

    // 提问那一刻记下记号，那一刻看到的就这一条。
    const mark = process.lastSeq();
    await say(process, 'b', 2, '2 号发言：我再看一轮。');

    expect(mark).toBe(1);
    expect(process.factsFor(VIEWER, mark)).toEqual([
      { title: '公开发言', lines: ['【第 1 天】', '[#1] 1 号发言：我先过。'] },
    ]);
    // 一条都还没记时记号是 0，取出来是空的。
    expect(ledger(memoryEvents(), GAME, [], ALL).lastSeq()).toBe(0);
    expect(process.factsFor(VIEWER, 0)).toEqual([]);
    expect(process.factsFor(VIEWER, process.lastSeq())).toEqual(process.factsFor(VIEWER));
  });

  it('断了再起：库里那份整份铺回来，按当时那个记号照样取回那一份', async () => {
    const store = memoryEvents();
    const first = ledger(store, GAME, [], ALL);
    await say(first, 'a', 1, '1 号发言：我先过。');

    const mark = first.lastSeq();
    const atAsk = first.factsFor(VIEWER, mark);
    await say(first, 'b', 1, '2 号发言：我再看一轮。');

    const resumed = ledger(store, GAME, await store.list(GAME), ALL);

    expect(resumed.factsFor(VIEWER)).toContainEqual({
      title: '公开发言',
      lines: ['【第 1 天】', '[#1] 1 号发言：我先过。', '[#2] 2 号发言：我再看一轮。'],
    });
    // 那一问之后记的那条已经在铺回来的那份里了，照整份复算就会多出一条。
    expect(resumed.factsFor(VIEWER, mark)).toEqual(atAsk);
  });
});

describe('滑动窗口与折叠摘要', () => {
  it('窗口外的发言折成摘要顶上，窗口里的照旧逐字给', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

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
          '[#3] p1 号发言：第 2 天的打算。',
          '【第 3 天】',
          '[#4] p2 号发言：第 3 天的打算。',
        ],
      },
    ]);
    // 折过的不再列：水位不因为摘要那张写回过去的天号往后退。
    expect(process.pendingSummaries()).toEqual([]);
  });

  it('公开与狼队各折各的，一天一条，各自落回自己那一块', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

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
          '[#3] p1 号发言：第 3 天的打算。',
        ],
      },
      { title: '狼队商议', lines: ['【第 1 天】', '狼队商议那天压成的这一行。'] },
    ]);
  });

  it('不带说话人的那几类不折，窗口外也逐字留着', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

    await sayAs(process, EVENT_KINDS.BALLOT, 'b1', 1, '放逐投票：1 号投给 2 号；2 号票最多。');
    await sayAs(process, EVENT_KINDS.SHERIFF, 's1', 1, '1 号上警。');
    await saidBy(process, 'p1', 0, 3);

    // 水位第 3 天，第 1 天在窗口外：发言那条要折（还没折，所以看不见），票型与警徽照旧。
    expect(process.factsFor(VIEWER)).toEqual([
      { title: '上警与警徽', lines: ['【第 1 天】', '[#2] 1 号上警。'] },
      { title: '票型', lines: ['【第 1 天】', '[#1] 放逐投票：1 号投给 2 号；2 号票最多。'] },
      { title: '公开发言', lines: ['【第 3 天】', '[#3] p1 号发言：第 3 天的打算。'] },
    ]);
  });

  it('记号取在摘要落库之前：摘要照给，它折的那一天不至于两样都没有', async () => {
    const process = ledger(memoryEvents(), GAME, [], ALL);

    await saidBy(process, 'p1', 0, 1);
    await saidBy(process, 'p1', 1, 3);

    // 那一刻的位置：第 1 天的原文与第 3 天那条都在记号之内，摘要还没落库。
    const mark = process.lastSeq();
    await process.addSummary(process.pendingSummaries()[0], '1 号发言摘要：先过。');

    expect(process.factsFor(VIEWER, mark)).toEqual([
      {
        title: '公开发言',
        lines: [
          '【第 1 天】',
          '1 号发言摘要：先过。',
          '【第 3 天】',
          '[#2] p1 号发言：第 3 天的打算。',
        ],
      },
    ]);
  });

  it('按记号取回的那一刻那份，与当初问出去时看到的是同一份', async () => {
    const store = memoryEvents();
    const process = ledger(store, GAME, [], ALL);

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
          '[#3] p1 号发言：第 2 天的打算。',
          '【第 3 天】',
          '[#4] p1 号发言：第 3 天的打算。',
        ],
      },
    ]);
    // 第一次问没有记号，取的是此刻这份；此刻就是那一刻，两份得一模一样。
    expect(process.factsFor(VIEWER)).toEqual(atAsk);

    // 答完记下这一条。断了再起：库里整份铺回来，同一个记号取出来还得是当初那一份。
    await saidBy(process, 'p2', 3, 3);
    const resumed = ledger(store, GAME, await store.list(GAME), ALL);

    expect(resumed.factsFor(VIEWER, mark)).toEqual(atAsk);
  });
});
