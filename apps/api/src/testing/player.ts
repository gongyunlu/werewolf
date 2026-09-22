import type { ModelRequest } from '../llm/model-port';
import { answeringModel, responseOf, type RecordingModel } from './model';

/** 从提示词里读回来的两句：他坐几号，这次能选哪些座位。 */
function briefOf(request: ModelRequest): { seatNo: number; seats: number[] } {
  const seatNo = request.system.match(/坐 (\d+) 号/)?.[1];
  if (seatNo === undefined) throw new Error(`提示词里没写他坐几号：${request.system}`);

  return {
    seatNo: Number(seatNo),
    seats: [...request.prompt.matchAll(/^- (\d+) 号$/gm)].map((match) => Number(match[1])),
  };
}

/**
 * 这次要交的形状：给了工具的那几问，工具参数就是形状；没给工具的那一问是发言。
 * 认整份提示词不行：事实与候选里的字样都可能跟某个形状撞上，撞上了就会把每一问都当成那一问答。
 */
function shapeOf(request: ModelRequest): string {
  return request.tool ? JSON.stringify(request.tool.parameters, null, 2) : '';
}

/**
 * 假玩家的作答口径。它除了提示词什么也没有，于是只能按提示词里的线索认这一问在问什么。
 * 认不出的形状不兜底：宁可当场炸，也不要它默默交一个形状合法的废话，把整局跑成一场假胜利。
 */
export function playerAnswer(request: ModelRequest): string {
  const shape = shapeOf(request);

  // 质疑是唯一交 accept 的那一问，一律通过，整局走不到修订。
  // 它这一问的身份不在提示词里，得排在取身份之前。
  if (shape.includes('"accept"')) return JSON.stringify({ accept: true, issues: '' });

  // 折摘要那一问不是玩家的回合：题面里没有「坐几号」，交的是每人一条。
  // 座位号从题面里读——那一份就是台账里那几行发言，每行以「N 号发言：」开头，
  // 读出来的人跟被折的发言一个不多一个不少。
  if (shape.includes('"items"')) {
    const seatNos = [
      ...new Set([...request.prompt.matchAll(/^\s*(\d+) 号/gm)].map((match) => Number(match[1]))),
    ];

    return JSON.stringify({
      items: seatNos.map((seatNo) => ({ seatNo, gist: `${seatNo} 号今天说的要点` })),
    });
  }

  const { seatNo, seats } = briefOf(request);

  // 女巫与警徽那一问每支都带 kind；能不用药、能撕掉就选那一支，不必再挑座位。
  if (shape.includes('"const": "none"')) return JSON.stringify({ kind: 'none' });
  if (shape.includes('"const": "tear"')) return JSON.stringify({ kind: 'tear' });

  // 上警、退水、自爆是同一个形状，只有这次要做什么分得开。
  // 前三号上警、其余不上，退水与自爆都不做：留出警下的人才有票投，警徽那一串流程也才走得到。
  if (shape.includes('"type": "boolean"')) {
    return JSON.stringify(request.prompt.includes('决定是否上警竞选警长。') && seatNo <= 3);
  }

  if (shape.includes('"left"')) return JSON.stringify('left');
  if (shape.includes('"type": "number"')) return JSON.stringify(seats[0] ?? null);

  // 没有形状的那一问就是发言。
  return `我坐 ${seatNo} 号，先听前面的。`;
}

/** 照作答口径回答的假玩家。 */
export function answeringPlayer(): RecordingModel {
  return answeringModel(playerAnswer);
}

/** 答到第 stopAfter 次就断的假玩家：断的那一次连答案都没吐出来，跟真端点断在半路一个位置。 */
export function breakingPlayer(stopAfter: number): RecordingModel {
  const calls: ModelRequest[] = [];
  let asked = 0;

  return {
    calls,
    async generate(request) {
      calls.push(request);
      asked += 1;
      if (asked > stopAfter) throw new Error('这一跑断在这儿');
      return responseOf(request, playerAnswer(request));
    },
  };
}
