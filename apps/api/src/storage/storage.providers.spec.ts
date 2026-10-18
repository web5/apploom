import { PipelineStore } from '../pipeline/pipeline.store';
import { storageProviders, storeBackend } from './storage.providers';
import { TraceStore } from '../trace/trace.store';

describe('存储后端选择', () => {
  it('STORE_BACKEND 显式指定优先；未指定时有 DATABASE_URL 才用 Postgres', () => {
    expect(storeBackend({})).toBe('redis');
    expect(storeBackend({ DATABASE_URL: 'postgresql://x' })).toBe('postgres');
    expect(storeBackend({ DATABASE_URL: 'postgresql://x', STORE_BACKEND: 'redis' })).toBe('redis');
    expect(storeBackend({ STORE_BACKEND: 'Postgres' })).toBe('postgres');
    expect(() => storeBackend({ STORE_BACKEND: 'mysql' })).toThrow(/postgres 或 redis/);
  });

  it('两种后端都提供 PipelineStore 与 TraceStore 令牌', () => {
    const tokens = (ps: ReturnType<typeof storageProviders>) => ps.map((p) => (p as { provide: unknown }).provide);
    expect(tokens(storageProviders('redis'))).toEqual(expect.arrayContaining([PipelineStore, TraceStore]));
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://x@localhost/x';
    try {
      expect(tokens(storageProviders('postgres'))).toEqual(expect.arrayContaining([PipelineStore, TraceStore]));
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });

  it('选了 postgres 却没有 DATABASE_URL：启动即报错，而不是悄悄退回 Redis', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => storageProviders('postgres')).toThrow(/DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
