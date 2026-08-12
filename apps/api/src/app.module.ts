import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrdModule } from './prd/prd.module';

@Module({
  imports: [PrdModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
