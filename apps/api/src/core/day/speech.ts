import type { ActionProvider, SpeechTurn } from '../actions';
import type { PlayerState } from '../state';

/** 一段发言。数组按实际发生的顺序排列，顺序本身就是结果的一部分。 */
export interface Speech {
  turn: SpeechTurn;
  playerId: string;
  seatNo: number;
  content: string;
}

/**
 * 按给定座位号顺序依次请人发言，返回的数组就是实际发言顺序。
 *
 * 顺序由调用方算好（警上按单顺双逆、白天按警长指定、PK 按相反顺序），这里只负责
 * 走完它——不排序、不跳过、不补人。逐个 await 是发言本身的要求：前一人的发言是
 * 后一人的输入，不能并发去问。
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
