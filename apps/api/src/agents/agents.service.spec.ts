import { BadRequestException } from '@nestjs/common';
import { memoryStores } from '../store/memory';
import { AgentsService } from './agents.service';

describe('参赛者重名处理', () => {
  it('并发创建同名参赛者只成功一次，不预查，冲突返回明确错误', async () => {
    const stores = memoryStores();
    const service = new AgentsService(stores);
    const lookup = jest.spyOn(stores.agents, 'findByName');
    const result = await Promise.allSettled([
      service.create({ name: '同名', modelName: 'm' }),
      service.create({ name: '同名', modelName: 'm' }),
    ]);
    expect(result.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const failed = result.find((one) => one.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(BadRequestException);
    expect(failed?.reason.message).toContain('同名');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('其他存储错误原样抛出', async () => {
    const stores = memoryStores();
    const failure = new Error('数据库断线');
    jest.spyOn(stores.agents, 'create').mockRejectedValue(failure);
    await expect(new AgentsService(stores).create({ name: '名字', modelName: 'm' })).rejects.toBe(
      failure,
    );
  });
});
