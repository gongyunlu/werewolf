import type { PrismaClient } from '../generated/prisma/client';
import { prismaStores } from '../store/prisma';
import { loadPromptAction } from './prompt-action';

jest.mock('../store/prisma', () => ({ prismaStores: jest.fn() }));

function fixture() {
  const snapshot = { context: { visible: ['当时信息'] }, schema: null };
  const action = { gameId: 'g', status: 'done', outcome: { snapshot } };
  const findAction = jest.fn(async () => action);
  const findGame = jest.fn(async () => ({ gameId: 'g' }));
  jest
    .mocked(prismaStores)
    .mockReturnValue({ games: { find: findGame }, actions: { find: findAction } } as never);
  const findFirst = jest.fn(async () => ({ tool: null, callId: 'c', traceId: 't', spanId: 's' }));
  const db = { askedPrompt: { findFirst } } as unknown as PrismaClient;
  return { snapshot, action, findAction, findGame, findFirst, db };
}

it('读取本局原行动快照和首个生成调用，来源绑定到该调用', async () => {
  const f = fixture();
  const result = await loadPromptAction(f.db, 'g', 'a');
  expect(result.snapshot).toBe(f.snapshot);
  expect(result.source).toEqual({
    gameId: 'g',
    actionKey: 'a',
    callId: 'c',
    traceId: 't',
    observationId: 's',
  });
  expect(f.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { gameId: 'g', actionKey: 'a', step: 'generate', formatAttempt: 1 },
      orderBy: { id: 'asc' },
    }),
  );
});

it.each(['其他对局', '尚未完成'])('%s的行动不能保存或复用为样本', async (reason) => {
  const f = fixture();
  if (reason === '其他对局') f.action.gameId = 'other';
  else f.action.status = 'running';
  await expect(loadPromptAction(f.db, 'g', 'a')).rejects.toThrow('本局已完成的行动');
  expect(f.findFirst).not.toHaveBeenCalled();
});
