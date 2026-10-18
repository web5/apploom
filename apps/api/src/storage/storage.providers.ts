/**
 * 存储后端选择：STORE_BACKEND=postgres|redis；未设置时有 DATABASE_URL 就用 Postgres，否则退回 Redis（本地零配置可跑）。
 * 只换「流水线文档 + 执行记录」的存储，BullMQ 队列始终走 Redis。
 */
import { PrismaClient, createPrismaClient } from '@apploom/database';
import type { Provider } from '@nestjs/common';
import { PgPipelineStore } from '../pipeline/pipeline.pg-store';
import { RedisPipelineStore } from '../pipeline/pipeline.redis-store';
import { PipelineStore } from '../pipeline/pipeline.store';
import { PgTraceStore } from '../trace/trace.pg-store';
import { RedisTraceStore } from '../trace/trace.redis-store';
import { TraceStore } from '../trace/trace.store';

export type StoreBackend = 'postgres' | 'redis';

export function storeBackend(env: NodeJS.ProcessEnv = process.env): StoreBackend {
  const v = env.STORE_BACKEND?.toLowerCase();
  if (v === 'postgres' || v === 'redis') return v;
  if (v) throw new Error(`STORE_BACKEND 只能是 postgres 或 redis，收到 "${env.STORE_BACKEND}"`);
  return env.DATABASE_URL ? 'postgres' : 'redis';
}

export function storageProviders(backend: StoreBackend = storeBackend()): Provider[] {
  if (backend === 'redis') {
    return [
      { provide: PipelineStore, useClass: RedisPipelineStore },
      { provide: TraceStore, useClass: RedisTraceStore },
    ];
  }
  if (!process.env.DATABASE_URL) throw new Error('STORE_BACKEND=postgres 需要设置 DATABASE_URL');
  return [
    { provide: PrismaClient, useFactory: () => createPrismaClient() },
    { provide: PipelineStore, useFactory: (prisma: PrismaClient) => new PgPipelineStore(prisma), inject: [PrismaClient] },
    { provide: TraceStore, useFactory: (prisma: PrismaClient) => new PgTraceStore(prisma), inject: [PrismaClient] },
  ];
}
