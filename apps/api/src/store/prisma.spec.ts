import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { DuplicateAgentNameError } from './agents';
import { prismaAgents, prismaAsked } from './prisma';
import { ModelRecoveryError } from '../llm/observation';

describe('数据库唯一约束错误', () => {
  it.each([
    ['name', { target: ['name'] }],
    ['id', { target: ['id'] }],
    ['name', { driverAdapterError: { cause: { constraint: { index: 'agents_name_key' } } } }],
    ['id', { driverAdapterError: { cause: { constraint: { index: 'agents_pkey' } } } }],
  ])('只把 %s 中的名字冲突转换成重名错误', async (target, meta) => {
    const failure = new Prisma.PrismaClientKnownRequestError('唯一约束冲突', {
      code: 'P2002',
      clientVersion: '7',
      meta,
    });
    const client = {
      agent: { create: jest.fn().mockRejectedValue(failure) },
    } as unknown as PrismaClient;
    const result = prismaAgents(client).create({
      name: '同名',
      modelName: 'm',
      baseUrl: null,
      apiKeyCiphertext: null,
      apiKeyHint: null,
      tag: null,
      notes: null,
    });
    if (target === 'name') await expect(result).rejects.toBeInstanceOf(DuplicateAgentNameError);
    else await expect(result).rejects.toBe(failure);
  });
});

describe('恢复时追加模型调用', () => {
  it('数据库中的原调用未能恢复时，拒绝插入新调用并保留原编号', async () => {
    const askedPrompt = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ callId: '原调用', status: 'started', attempts: [] }]),
      create: jest.fn(),
    };
    const asked = prismaAsked({ askedPrompt } as unknown as PrismaClient);
    await expect(
      asked.append('g', {
        actionKey: '当前行动',
        model: 'm',
        system: '',
        prompt: '',
        observation: {
          callId: '新调用',
          executionId: '新执行',
          taskId: '原生任务',
          step: 'generate',
          formatAttempt: 1,
          endpointKey: '端点',
        },
      }),
    ).rejects.toEqual(new ModelRecoveryError('原调用'));
    expect(askedPrompt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          gameId: 'g',
          actionKey: '当前行动',
          summaryKey: null,
          step: 'generate',
        }),
      }),
    );
    expect(askedPrompt.create).not.toHaveBeenCalled();
  });
});
