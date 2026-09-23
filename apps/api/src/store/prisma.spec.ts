import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { DuplicateAgentNameError } from './agents';
import { prismaAgents } from './prisma';

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
