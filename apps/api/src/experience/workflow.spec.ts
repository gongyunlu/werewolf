import { ExperienceResultSchema } from '@werewolf/shared';
import { ModelCallError } from '../llm/model-port';
import { scriptedModel, responseOf } from '../testing/model';
import { reviewFixture, fakeReviewPlatform } from '../review/testing';
import { runReview } from '../review/workflow';
import * as reviewWorkflow from '../review/workflow';
import { experienceSource, prepareExperience, runExperience } from './workflow';
import { fixture, result, access, promptSource, controlledPort } from './testing';
describe('个人经验生成与恢复', () => {
  it('从已完成复盘取本人原始行动和赛后材料，保留可知时点', async () => {
    const f = await fixture();
    await reviewFixture(f.gameId, f.stores);
    const { platform } = fakeReviewPlatform();
    const report = await runReview(f.stores, f.gameId, platform);
    const read = jest.spyOn(reviewWorkflow, 'readReview').mockResolvedValue(report);
    try {
      const input = await prepareExperience(f.stores, f.row, promptSource);
      expect(input.seat.agentId).toBe(f.agent.id);
      expect(input.review).toEqual(
        report!.players.find((player) => player.playerId === 'p1')!.result,
      );
      expect(
        JSON.stringify(input.sources.filter((source) => source.perspective === 'at_action')),
      ).toContain('当时的摘要');
      expect(
        JSON.stringify(input.sources.filter((source) => source.perspective === 'post_game')),
      ).toContain('未看过的原文');
      expect(JSON.stringify(input.sources)).not.toContain('质疑者私有评价');
    } finally {
      read.mockRestore();
    }
  });

  it('冻结原始证据、提示词、归属；重复提交不再调用或插入', async () => {
    const f = await fixture();
    const model = scriptedModel([JSON.stringify(result)]);
    await runExperience(f.stores, f.row.id, {
      port: model,
      access,
      promptSource,
      prepare: f.prepare,
    });
    await runExperience(f.stores, f.row.id, { port: model, access, promptSource });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.prompt).toContain('原始发言中的时序');
    expect(model.calls[0]!.system).toContain('没有旁观记录');
    expect(model.calls[0]!.prompts?.map((item) => item.name)).toEqual([
      'experience/extract-system',
      'experience/extract-user',
    ]);
    expect(await f.stores.experiences.list(f.agent.id)).toEqual([
      expect.objectContaining({
        agentId: f.agent.id,
        sourceGameId: f.gameId,
        sourcePlayerId: 'p1',
        version: 1,
        enabled: true,
        sourceIds: ['source-1'],
      }),
    ]);
    expect((await f.stores.experiences.findGeneration(f.row.id))!.state.status).toBe('completed');
  });

  it('升级前已保存的完整来源 ID 答复仍可恢复，不重新提炼', async () => {
    const f = await fixture();
    const old = {
      ...result,
      experiences: [{ ...result.experiences[0]!, sourceIds: ['source-1'] }],
    };
    const callId = '原调用';
    await f.stores.asked.append(f.gameId, {
      model: access.model,
      system: '旧模板',
      prompt: '旧题面',
      actionKey: null,
      observation: {
        callId,
        executionId: f.row.id,
        step: 'experience',
        formatAttempt: 1,
        endpointKey: '离线',
      },
    });
    await f.stores.experiences.save(f.row, {
      ...f.row.state,
      status: 'failed',
      input: f.input,
      attempts: [
        {
          callId,
          status: 'responded',
          response: {
            content: '',
            reasoning: null,
            toolCall: { name: 'submit', arguments: JSON.stringify({ value: old }) },
          },
        },
      ],
    });
    const model = scriptedModel([]);
    await runExperience(f.stores, f.row.id, { port: model, access, promptSource });
    expect(model.calls).toHaveLength(0);
    expect((await f.stores.experiences.list(f.agent.id))[0]!.sourceIds).toEqual(['source-1']);
  });

  it('校验失败后又遇到请求失败，续跑仍保留引用诊断', async () => {
    const f = await fixture();
    const invalid = {
      ...result,
      experiences: [{ ...result.experiences[0]!, sourceIds: ['旧局/assessment/行动一'] }],
    };
    const model = scriptedModel([
      JSON.stringify(invalid),
      new ModelCallError('transient', '请求失败'),
      JSON.stringify(result),
    ]);
    const runtime = { port: model, access, promptSource, prepare: f.prepare };
    await expect(runExperience(f.stores, f.row.id, runtime)).rejects.toThrow('可续跑');
    await runExperience(f.stores, f.row.id, runtime);
    expect(model.calls[2]!.prompt).toContain('只能选择 E1 至 E1');
    expect((await f.stores.experiences.list(f.agent.id))[0]!.sourceIds).toEqual(['source-1']);
  });

  it('零条结果也是完成，恢复不重新提炼', async () => {
    const f = await fixture();
    const model = scriptedModel([
      JSON.stringify({ experiences: [], reason: '没有新的可保存经验' }),
    ]);
    await runExperience(f.stores, f.row.id, {
      port: model,
      access,
      promptSource,
      prepare: f.prepare,
    });
    await runExperience(f.stores, f.row.id);
    expect(await f.stores.experiences.list(f.agent.id)).toHaveLength(0);
    expect(model.calls).toHaveLength(1);
  });

  it('产物事务失败后复用原答复，停用后的重复请求不重新启用', async () => {
    const f = await fixture();
    const complete = f.stores.experiences.complete.bind(f.stores.experiences);
    f.stores.experiences.complete = jest
      .fn()
      .mockRejectedValueOnce(new Error('保存中断'))
      .mockImplementation(complete);
    const model = scriptedModel([JSON.stringify(result)]);
    await expect(
      runExperience(f.stores, f.row.id, { port: model, access, promptSource, prepare: f.prepare }),
    ).rejects.toThrow('保存中断');
    await runExperience(f.stores, f.row.id, { port: model, access, promptSource });
    const item = (await f.stores.experiences.list(f.agent.id))[0]!;
    await f.stores.experiences.toggle(f.agent.id, item.id, false);
    await runExperience(f.stores, f.row.id);
    expect(model.calls).toHaveLength(1);
    expect((await f.stores.experiences.list(f.agent.id))[0]!.enabled).toBe(false);
  });

  it('调用收尾失败后从已保存的原答复续跑', async () => {
    const f = await fixture();
    const append = f.stores.asked.append.bind(f.stores.asked);
    f.stores.asked.append = async (...args) => {
      const recording = (await append(...args))!;
      return {
        ...recording,
        finish: async () => {
          throw new Error('收尾写入失败');
        },
      };
    };
    const model = scriptedModel([JSON.stringify(result)]);
    await expect(
      runExperience(f.stores, f.row.id, { port: model, access, promptSource, prepare: f.prepare }),
    ).rejects.toThrow();
    await runExperience(f.stores, f.row.id, { port: model, access, promptSource });
    expect(model.calls).toHaveLength(1);
    expect(await f.stores.experiences.list(f.agent.id)).toHaveLength(1);
  });

  it('收到完整答复后传输用量落库失败，续跑也不会重新调用', async () => {
    const f = await fixture();
    const append = f.stores.asked.append.bind(f.stores.asked);
    f.stores.asked.append = async (...args) => {
      const recording = (await append(...args))!;
      return {
        ...recording,
        finishAttempt: async () => {
          throw new Error('用量写入失败');
        },
      };
    };
    const model = controlledPort(JSON.stringify(result));
    const generate = jest.spyOn(model, 'generate');
    const runtime = { port: model, access, promptSource, prepare: f.prepare };
    await expect(runExperience(f.stores, f.row.id, runtime)).rejects.toThrow('观测写入失败');
    await runExperience(f.stores, f.row.id, runtime);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await f.stores.experiences.list(f.agent.id)).toHaveLength(1);
  });

  it('非法来源可控重问，已知网络失败可以续跑', async () => {
    const f = await fixture();
    const invalid = {
      ...result,
      experiences: [{ ...result.experiences[0], sourceIds: ['不存在'] }],
    };
    const model = scriptedModel([
      new ModelCallError('transient', '请求失败'),
      JSON.stringify(invalid),
      JSON.stringify(result),
    ]);
    await expect(
      runExperience(f.stores, f.row.id, { port: model, access, promptSource, prepare: f.prepare }),
    ).rejects.toThrow('可续跑');
    await runExperience(f.stores, f.row.id, { port: model, access, promptSource });
    expect(model.calls).toHaveLength(3);
    expect(model.calls[2]!.prompt).toContain('sourceIds 必须来自给定原始证据');
    expect(await f.stores.experiences.list(f.agent.id)).toHaveLength(1);
  });

  it('请求后答复保存前中断，不盲目重复调用', async () => {
    const f = await fixture();
    const save = f.stores.experiences.save.bind(f.stores.experiences);
    f.stores.experiences.save = async (row, next) => {
      if (next.attempts.at(-1)?.status === 'responded') throw new Error('答复落库中断');
      return save(row, next);
    };
    const model = scriptedModel([JSON.stringify(result)]);
    await expect(
      runExperience(f.stores, f.row.id, { port: model, access, promptSource, prepare: f.prepare }),
    ).rejects.toThrow();
    await expect(
      runExperience(f.stores, f.row.id, { port: model, access, promptSource }),
    ).rejects.toThrow('结果未知');
    expect(model.calls).toHaveLength(1);
  });

  it('两个并发执行只允许一个请求认领成功', async () => {
    const f = await fixture();
    const model = scriptedModel([JSON.stringify(result)]);
    await Promise.allSettled(
      [1, 2].map(() =>
        runExperience(f.stores, f.row.id, {
          port: model,
          access,
          promptSource,
          prepare: f.prepare,
        }),
      ),
    );
    expect(model.calls).toHaveLength(1);
    expect(await f.stores.experiences.list(f.agent.id)).toHaveLength(1);
  });

  it('请求仍在进行时的重复 worker 不改写原认领，也不会重复调用', async () => {
    const f = await fixture();
    let arrived!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = jest.fn(async (request) => {
      arrived();
      await waiting;
      return responseOf(request, JSON.stringify(result));
    });
    const runtime = { port: { generate }, access, promptSource, prepare: f.prepare };
    const original = runExperience(f.stores, f.row.id, runtime);
    await dispatched;
    await expect(runExperience(f.stores, f.row.id, runtime)).rejects.toThrow('结果未知');
    release();
    await original;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await f.stores.experiences.list(f.agent.id)).toHaveLength(1);
  });

  it('没有持久绑定的历史玩家，即使有完成复盘也不能按名称或座位认领', async () => {
    const f = await reviewFixture();
    const { platform } = fakeReviewPlatform();
    await runReview(f.stores, 'g', platform);
    expect((await experienceSource(f.stores, 'g', 'p1')).reason).toContain('没有绑定');
  });

  it('未结束的对局不可生成，结构允许零条且限制长度', async () => {
    const f = await fixture();
    await expect(experienceSource(f.stores, f.gameId, 'p1')).rejects.toThrow('已结束');
    expect(ExperienceResultSchema.safeParse({ experiences: [], reason: '' }).success).toBe(true);
    expect(
      ExperienceResultSchema.safeParse({
        ...result,
        experiences: [{ ...result.experiences[0], body: '长'.repeat(601) }],
      }).success,
    ).toBe(false);
  });
});
