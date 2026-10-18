import { launchEnv } from './sandbox/launch-env'; // 必须第一个导入：先于 dotenv 记录启动环境
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { findSecretEnvNames, sandboxMode } from './sandbox/sandbox';
import { PipelineService } from './pipeline/pipeline.service';
import { createPreviewHandlers, previewConfig } from './preview/preview-proxy';
import { corsOrigins } from './security/cors';

/**
 * 同用户的进程能读到本进程「启动时」的环境变量快照，OS 级沙箱管不住这条通道。
 * 所以密钥不能放在启动环境里（应由 .env 在运行时加载）；启动环境里有就提醒。
 */
function warnLeakyStartupEnv(): void {
  const names = findSecretEnvNames(launchEnv);
  if (names.length === 0 || sandboxMode() === 'off') return;
  new Logger('Sandbox').warn(
    `启动环境含 ${names.length} 个疑似密钥变量（${names.join(', ')}）：沙箱内运行的 LLM 生成代码可通过系统接口读到这些值。` +
      '请改用干净环境启动（pnpm --filter api start:clean），密钥放 .env 在运行时加载。',
  );
}

async function bootstrap() {
  warnLeakyStartupEnv();
  const app = await NestFactory.create(AppModule);
  // 预览反向代理必须挂在所有路由与守卫之前：它按 Host（<docId>.<PREVIEW_BASE_DOMAIN>）分流，其余请求原样放行
  const preview = previewConfig();
  if (preview) {
    const handlers = createPreviewHandlers(preview, (id) => app.get(PipelineService).get(id));
    app.use(handlers.middleware);
    app.getHttpServer().on('upgrade', handlers.upgrade);
    new Logger('Preview').log(`预览反向代理已启用：${preview.scheme}://<docId>.${preview.baseDomain}/`);
  }
  app.enableCors({ origin: corsOrigins() });
  // Next.js dev 占用 3000，API 用 3001；Next 通过 rewrites 把 /api/* 代理过来
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
