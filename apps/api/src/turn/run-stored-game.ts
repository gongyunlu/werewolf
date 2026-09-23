import { GAME_STATUSES } from '@werewolf/shared';
import type { GameStores } from '../store/stores';
import { runModelGame, type ModelGameInput, type ModelGameResult } from './run-model-game';

/**
 * 跑一局留得住的对局要的东西。
 * 跑法跟 runModelGame 一样，只是进度从库里接着跑。
 */
export interface StoredGameInput extends Omit<ModelGameInput, 'resume' | 'stores'> {
  /** 存档写哪儿。这一跑的意义就是断了还能接着跑，所以不给一份默认的内存存储。 */
  stores: GameStores;
}

/**
 * 跑一局对局，进度落在库里。
 *
 * 一局的身份就是对局 id：库里已经有的那一局接着它最后一份锚点往下跑。
 *
 * 已经有了胜方的那一局不用再跑：档案里记着它分出了什么胜负。
 * 接着跑时传进来的板子必须还是开局那块，对不上当场抛——技能正文是按传进来的板子现取的。
 *
 * @param input 建局快照、模型端口、提示词源与那几份存档
 * @returns 终局局面与胜方，以及这一跑每次行动的产物
 */
export async function runStoredGame(input: StoredGameInput): Promise<ModelGameResult> {
  const { gameId } = input.setup;
  const { stores, ...rest } = input;

  const stored = await stores.games.find(gameId);
  if (stored?.winner) throw new Error(`这一局已经分出胜负：${stored.winner}`);

  if (!stored) {
    // 跑到这儿才立档的是命令行那条路：界面上排的那份阵容不经过这儿，档案里是空的。
    await stores.games.open({ gameId, boardId: input.setup.boardId, roster: [] });
  } else if (stored.boardId !== input.setup.boardId) {
    // 接着跑的板子只能是开局那块：局面从存档里来，技能正文却是按这次传进来的板子现取的。
    throw new Error(`这一局是用 ${stored.boardId} 开的，接不上 ${input.setup.boardId}`);
  }

  // 走到这儿就是真开始跑了。进度从「排队中」挪到「运行中」——列表上还挂着排队中的局，
  // 看的人会以为它没轮上，其实它正在烧钱。
  await stores.games.setStatus(gameId, GAME_STATUSES.RUNNING);

  try {
    const settled = await runModelGame({
      ...rest,
      // 从最后一份锚点接着跑：锚点落在提问之前，落在哪一格就重进哪一格，答过的按记录复用。
      resume: stored ? ((await stores.steps.last(gameId)) ?? undefined) : undefined,
      stores,
    });
    await stores.games.finish(gameId, settled.winner, settled.state);
    return settled;
  } catch (error) {
    // 一局跑十几个来回，中途断在哪儿都有可能。不标记的话它会一直挂在「运行中」，
    // 而那个进程早就没了。
    await stores.games.setStatus(gameId, GAME_STATUSES.FAILED);
    throw error;
  }
}
