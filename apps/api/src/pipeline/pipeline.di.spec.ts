/**
 * DI 装配测试：用 Nest 容器真实解析 PipelineService 的依赖。
 * 单测都是手工 new，绕过了容器；而接口类型在运行时会被擦成 Object，缺少 @Inject 令牌时 tsc 与单测都不会报错，
 * 只有应用启动才会炸（Nest can't resolve dependencies）。这里把它前移到测试里。
 */
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })) }));

import { Test } from '@nestjs/testing';
import { LlmService } from '../prd/llm.service';
import { LocalDeployService } from '../deploy/local-deploy.service';
import { CodegenGateService } from '../gate/codegen-gate';
import { TraceStore } from '../trace/trace.store';
import { PipelineBus } from './pipeline.bus';
import { PipelineService } from './pipeline.service';
import { PipelineStore } from './pipeline.store';

describe('PipelineService 的依赖注入', () => {
  it('容器能解析全部依赖，且注入的总线就是 PipelineBus 令牌对应的实例', async () => {
    const bus = new PipelineBus();
    const mod = await Test.createTestingModule({
      providers: [
        PipelineService,
        { provide: PipelineBus, useValue: bus },
        { provide: PipelineStore, useValue: {} },
        { provide: LlmService, useValue: {} },
        { provide: LocalDeployService, useValue: {} },
        { provide: CodegenGateService, useValue: {} },
        { provide: TraceStore, useValue: {} },
      ],
    }).compile();

    const svc = mod.get(PipelineService);
    expect((svc as unknown as { bus: unknown }).bus).toBe(bus);

    // 换总线实现只需替换令牌的提供者，消费方不用改
    const alt = new PipelineBus();
    const mod2 = await Test.createTestingModule({
      providers: [
        PipelineService,
        { provide: PipelineBus, useValue: alt },
        { provide: PipelineStore, useValue: {} },
        { provide: LlmService, useValue: {} },
        { provide: LocalDeployService, useValue: {} },
        { provide: CodegenGateService, useValue: {} },
        { provide: TraceStore, useValue: {} },
      ],
    }).compile();
    expect((mod2.get(PipelineService) as unknown as { bus: unknown }).bus).toBe(alt);
  });
});
