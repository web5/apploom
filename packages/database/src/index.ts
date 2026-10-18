import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

declare const process: { env: Record<string, string | undefined> };

/**
 * 创建 PrismaClient，连接串显式取自进程环境变量 DATABASE_URL。
 * 刻意不导出模块级单例：Prisma 构造时会把 packages/database/.env 里的变量灌进 process.env，
 * 导入即构造会让「是否配置了 DATABASE_URL」这类判断随导入顺序变化。
 */
export function createPrismaClient(url: string | undefined = process.env.DATABASE_URL): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}
