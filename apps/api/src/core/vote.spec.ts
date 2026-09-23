import { collectVotes, tallyVotes, type VoteCast, type VoteRound } from './vote';

function roundOf(overrides: Partial<VoteRound> = {}): VoteRound {
  return {
    voters: ['p1', 'p2', 'p3'],
    candidates: ['p1', 'p2', 'p3'],
    weightedVoterId: null,
    ...overrides,
  };
}

function castsOf(...entries: [string, string | null][]): VoteCast[] {
  return entries.map(([voterId, targetId]) => ({ voterId, targetId }));
}

describe('计票', () => {
  it('唯一最高票当选，并给出得票数', () => {
    const outcome = tallyVotes(roundOf(), castsOf(['p1', 'p2'], ['p2', 'p2'], ['p3', 'p1']));

    expect(outcome).toEqual({ kind: 'elected', winnerId: 'p2', voteCount: 2 });
  });

  it('允许投自己', () => {
    const outcome = tallyVotes(roundOf(), castsOf(['p1', 'p1'], ['p2', 'p1'], ['p3', 'p1']));

    expect(outcome).toEqual({ kind: 'elected', winnerId: 'p1', voteCount: 3 });
  });

  it('并列最高票一律是平票', () => {
    const outcome = tallyVotes(roundOf(), castsOf(['p1', 'p2'], ['p2', 'p1'], ['p3', null]));

    expect(outcome).toEqual({ kind: 'tie', tiedIds: ['p2', 'p1'] });
  });

  it('弃票既不记给谁，也不影响别人的票数', () => {
    const outcome = tallyVotes(roundOf(), castsOf(['p1', 'p2'], ['p2', null], ['p3', null]));

    expect(outcome).toEqual({ kind: 'elected', winnerId: 'p2', voteCount: 1 });
  });

  it('全部弃票时无人当选', () => {
    const outcome = tallyVotes(roundOf(), castsOf(['p1', null], ['p2', null], ['p3', null]));

    expect(outcome).toEqual({ kind: 'none' });
  });

  it('候选收窄时计票口径不变', () => {
    const outcome = tallyVotes(
      roundOf({ candidates: ['p2'] }),
      castsOf(['p1', 'p2'], ['p2', 'p2'], ['p3', 'p2']),
    );

    expect(outcome).toEqual({ kind: 'elected', winnerId: 'p2', voteCount: 3 });
  });

  it('加权票按 1.5 计', () => {
    const voters = ['p1', 'p2', 'p3', 'p4'];
    const casts = castsOf(['p1', 'p2'], ['p2', 'p1'], ['p3', 'p2'], ['p4', 'p1']);

    // 没有警长时 p1 与 p2 各得 2 票，是平票。
    expect(tallyVotes(roundOf({ voters }), casts)).toEqual({ kind: 'tie', tiedIds: ['p2', 'p1'] });
    // p4 是警长，这一票按 1.5 计，p1 以 2.5 票胜出。
    expect(tallyVotes(roundOf({ voters, weightedVoterId: 'p4' }), casts)).toEqual({
      kind: 'elected',
      winnerId: 'p1',
      voteCount: 2.5,
    });
  });

  it('警长弃票时这一轮照常计票', () => {
    const outcome = tallyVotes(
      roundOf({ weightedVoterId: 'p3' }),
      castsOf(['p1', 'p2'], ['p2', 'p2'], ['p3', null]),
    );

    expect(outcome).toEqual({ kind: 'elected', winnerId: 'p2', voteCount: 2 });
  });

  it('票没收齐直接抛错，不拿现有票凑一个结果', () => {
    expect(() => tallyVotes(roundOf(), castsOf(['p1', 'p2']))).toThrow('投票未收齐');
    expect(() =>
      tallyVotes(roundOf(), castsOf(['p1', 'p2'], ['p2', 'p1'], ['p3', 'p2'], ['p1', 'p2'])),
    ).toThrow('投票未收齐');
  });

  it('同一个人投两票就抛错', () => {
    // 票数对得上，但 p1 投了两次、p2 一次没投——不查投票者就会把 p1 算成两票。
    expect(() => tallyVotes(roundOf(), castsOf(['p1', 'p2'], ['p1', 'p2'], ['p3', 'p1']))).toThrow(
      '同一名投票者投了两票',
    );
  });

  it('名单外的人投票就抛错', () => {
    // PK 台上的平票者、已经出局的警长都属这一类：他们本来就不该出现在这一轮里。
    expect(() => tallyVotes(roundOf(), castsOf(['p1', 'p2'], ['p2', 'p2'], ['p9', 'p1']))).toThrow(
      '投票者不在本轮名单内',
    );
  });

  it('投给候选之外的人就抛错', () => {
    expect(() =>
      tallyVotes(
        roundOf({ candidates: ['p1', 'p2'] }),
        castsOf(['p1', 'p2'], ['p2', 'p1'], ['p3', 'p3']),
      ),
    ).toThrow('不在候选之内');
  });
});

describe('收齐一轮投票', () => {
  it('一人失败后仍等其他行动收尾，避免失败返回后继续写入', async () => {
    let release!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    const settled = jest.fn();
    const result = collectVotes(roundOf(), async (id) => {
      if (id === 'p1') throw new Error('行动失败');
      return id === 'p2' ? slow : 'p1';
    }).catch(settled);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    release('p1');
    await result;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: '行动失败' }));
  });

  it('每名投票者问一次，落点按投票者对齐', async () => {
    const asked: string[] = [];
    const casts = await collectVotes(roundOf(), async (voterId) => {
      asked.push(voterId);
      return voterId === 'p2' ? null : 'p1';
    });

    expect(asked.toSorted()).toEqual(['p1', 'p2', 'p3']);
    expect(casts).toEqual(castsOf(['p1', 'p1'], ['p2', null], ['p3', 'p1']));
  });

  it('有人没答上来就整轮失败，不给失败者补一张弃票', async () => {
    await expect(
      collectVotes(roundOf(), async (voterId) => {
        if (voterId === 'p2') throw new Error('行动超时');
        return 'p1';
      }),
    ).rejects.toThrow('行动超时');
  });
});
