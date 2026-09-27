import type { PrismaClient } from '../generated/prisma/client';
import type { ModelTool } from '../llm/model-port';
import { prismaStores } from '../store/prisma';
import type { TurnOutcome } from '../turn/graph';

export async function loadPromptAction(db: PrismaClient, gameId: string, actionKey: string) {
  const stores = prismaStores(db);
  const [game, action] = await Promise.all([
    stores.games.find(gameId),
    stores.actions.find(actionKey),
  ]);
  if (!game) throw new Error('没有这局对局');
  if (!action || action.gameId !== game.gameId || action.status !== 'done')
    throw new Error('需要本局已完成的行动');
  const { snapshot } = action.outcome as TurnOutcome;
  const asked = await db.askedPrompt.findFirst({
    where: { gameId, actionKey, step: 'generate', formatAttempt: 1 },
    orderBy: { id: 'asc' },
    select: { tool: true, callId: true, traceId: true, spanId: true },
  });
  if (!asked) throw new Error('原行动没有生成调用记录');
  return {
    game,
    snapshot,
    tool: asked.tool === null ? undefined : (asked.tool as unknown as ModelTool),
    source: {
      gameId,
      actionKey,
      callId: asked.callId ?? undefined,
      traceId: asked.traceId ?? undefined,
      observationId: asked.spanId ?? undefined,
    },
  };
}
