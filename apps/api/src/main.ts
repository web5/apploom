import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Next.js dev 占用 3000，API 用 3001；Next 通过 rewrites 把 /api/* 代理过来
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
