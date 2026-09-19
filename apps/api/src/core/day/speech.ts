import type { ActionProvider, SpeechTurn } from '../actions';
import type { PlayerState } from '../state';

/** 一段发言。数组按实际发生顺序排，顺序也是结果的一部分。 */
export interface Speech {
  turn: SpeechTurn;
  playerId: string;
  seatNo: number;
  content: string;
}

/**
 * 按给定座位号顺序依次请人发言，顺序由调用方算好，这里只走完，不排序不跳过不补人。
 * 必须逐个 await：前一人的发言是后一人的输入，不能并发去问。
 */
export async function speakInOrder(
  turn: SpeechTurn,
  seatNos: readonly number[],
  players: readonly PlayerState[],
  actions: ActionProvider,
): Promise<Speech[]> {
  const playerBySeatNo = new Map(players.map((player) => [player.seatNo, player]));

  const speeches: Speech[] = [];
  for (const seatNo of seatNos) {
    const player = playerBySeatNo.get(seatNo);
    if (!player) throw new Error(`发言顺序里的座位号不在局内：${seatNo}`);
    speeches.push({
      turn,
      playerId: player.id,
      seatNo,
      content: await actions.speak(turn, player.id),
    });
  }

  return speeches;
}
