/**
 * 进程启动时的环境变量快照。必须是 main.ts 里第一个被 import 的模块：
 * 之后 @apploom/llm 会在导入时用 dotenv 把 .env 读进 process.env，那部分是运行时加载的，
 * 不在系统保存的「启动环境」里（同用户进程只能读到启动环境），不应算作泄漏。
 */
export const launchEnv: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });
