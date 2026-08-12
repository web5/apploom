import { Module } from '@nestjs/common';
import { PrdController } from './prd.controller';
import { LlmService } from './llm.service';

@Module({
  controllers: [PrdController],
  providers: [LlmService],
})
export class PrdModule {}
