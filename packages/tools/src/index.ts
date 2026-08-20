/**
 * @apploom/tools —— AppLoom Agent 基础能力层
 *
 * 参考 DeepSeek Harness 设计：类型化工具契约（Definition/Provider/Consumer）、
 * 沙箱三档分级、追加式调用日志、审批预留接口。
 *
 * 用法：
 *   const tools = createDefaultRegistry();
 *   const r = await tools.execute('write_file', { path: 'src/a.ts', content: '...' }, {
 *     workspace: '/tmp/apploom-deploy/xxx',
 *     sandbox: 'workspace-write',
 *     onLog: (l) => console.log(l),
 *   });
 */
export * from './types';
export * from './sandbox';
export * from './session-log';
export * from './registry';
export * from './tools/read-file';
export * from './tools/list-dir';
export * from './tools/write-file';
export * from './tools/shell';
