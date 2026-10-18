/**
 * 测试用适配层：流水线现在通过 llm.run(stage, inputs, ctx) 调 Agent；
 * 老测试按阶段桩 generateXxx，这里把 run 转发过去，并把返回形状（prd / prototype / …）还原成统一的 doc。
 * 这样断言的仍是「某阶段拿到了什么上游、什么反馈」，不用关心内部是 generateXxx 还是 run。
 */
import type { StageId } from '@apploom/shared';

type Stub = jest.Mock;
type Stubs = Partial<Record<'generatePrd' | 'generatePrototype' | 'generateDesign' | 'generateCodegen' | 'generateDeploy', Stub>>;

const KEY: Record<StageId, [keyof Stubs, string]> = {
  requirement: ['generatePrd', 'prd'],
  prototype: ['generatePrototype', 'prototype'],
  design: ['generateDesign', 'design'],
  codegen: ['generateCodegen', 'codegen'],
  deploy: ['generateDeploy', 'deploy'],
};

export function withRun<T extends Stubs>(stubs: T): T & { run: Stub } {
  const run = jest.fn(async (stage: StageId, inputs: Record<string, unknown>, ctx: { onToken: unknown; onLog: unknown; repair: unknown }) => {
    const [name, docKey] = KEY[stage];
    const fn = stubs[name];
    if (!fn) throw new Error(`测试没有为阶段 ${stage} 提供桩 ${name}`);
    // 老桩的参数形状：(上游…, onToken, repair, onLog)
    const args: unknown[] =
      stage === 'requirement' ? [inputs['@input']]
      : stage === 'prototype' ? [inputs.requirement]
      : stage === 'design' ? [inputs.requirement, inputs.prototype]
      : stage === 'codegen' ? [inputs.design, inputs.prototype]
      : [inputs.codegen];
    const r = await fn(...args, ctx.onToken, ctx.repair, ctx.onLog);
    const { [docKey]: doc, ...rest } = r as Record<string, unknown>;
    return { ...rest, doc };
  });
  return Object.assign(stubs, { run }) as T & { run: Stub };
}
