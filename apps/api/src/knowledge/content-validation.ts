import { BadRequestException } from '@nestjs/common';
import type { KnowledgeContent } from '@werewolf/shared';
import { ALL_BOARDS, type BoardId } from '../boards/boards';
import type { GameStores } from '../store/stores';

export function validateKnowledgeContent(content: KnowledgeContent) {
  for (const boardId of content.boardIds) {
    const board = ALL_BOARDS[boardId as BoardId];
    if (!board || content.roles.some((role) => !(role in board.roles)))
      throw new BadRequestException('板子不存在或不包含所选角色，请分别整理适用范围');
  }
}

export async function validateKnowledgeSources(stores: GameStores, content: KnowledgeContent) {
  const ids = [...new Set(content.sources.flatMap((s) => (s.captureId ? [s.captureId] : [])))];
  const rows = new Map(
    await Promise.all(ids.map(async (id) => [id, await stores.knowledgeImports.find(id)] as const)),
  );
  for (const source of content.sources) {
    if (!source.captureId) {
      if (source.paragraphIds || source.sourceId)
        throw new BadRequestException('来源或段落引用缺少采集快照');
      continue;
    }
    const capture = rows.get(source.captureId);
    const snapshot = capture?.state.snapshot;
    if (
      !snapshot ||
      (source.sourceId !== undefined && source.sourceId !== capture?.sourceId) ||
      source.url !== snapshot.url ||
      !source.paragraphIds?.length ||
      source.paragraphIds.some((id) => !snapshot.paragraphs.some((p) => p.id === id))
    )
      throw new BadRequestException('来源链接或段落与采集快照不一致');
  }
}
