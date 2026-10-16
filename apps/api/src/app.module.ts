import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrdModule } from './prd/prd.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { SecurityGuard } from './security/security.guard';

@Module({
  imports: [PrdModule, PipelineModule],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: SecurityGuard }],
})
export class AppModule {}
