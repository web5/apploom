import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrdModule } from './prd/prd.module';
import { PipelineModule } from './pipeline/pipeline.module';

@Module({
  imports: [PrdModule, PipelineModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
