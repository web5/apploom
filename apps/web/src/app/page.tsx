import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-10 p-8 bg-[#f7f8fa] text-[#1a1a2e] font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col items-center gap-3 text-center">
        <div className="flex items-center gap-2.5 text-3xl font-bold">
          <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-[#3b82f6] text-white text-lg">AL</span>
          AppLoom
        </div>
        <p className="max-w-md text-[#6b7280] text-sm leading-7">
          weave your idea into an app.
          <br />
          一句话 → 多 Agent 流水线 → 需求拆解 / 方案设计 / 代码生成 / 发布上线
        </p>
      </main>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl w-full">
        <Link
          href="/studio"
          className="group rounded-xl border border-[#e5e7eb] bg-white p-5 hover:border-[#3b82f6] hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-2 text-[#3b82f6] font-semibold text-sm mb-1.5">
            <span>🚀</span> 生产端 · Studio
          </div>
          <div className="text-[#1a1a2e] text-sm font-medium mb-1">流水线工作台</div>
          <div className="text-[#9ca3af] text-xs leading-5">
            真实研发作业：需求 → 方案 → 代码 → 部署，逐阶段推进与确认
          </div>
        </Link>

        <Link
          href="/admin/debug"
          className="group rounded-xl border border-[#e5e7eb] bg-white p-5 hover:border-[#8b5cf6] hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-2 text-[#8b5cf6] font-semibold text-sm mb-1.5">
            <span>🛠️</span> 管理端 · Admin
          </div>
          <div className="text-[#1a1a2e] text-sm font-medium mb-1">提示词调试工作台</div>
          <div className="text-[#9ca3af] text-xs leading-5">
            调试 Agent 的 Prompt / JSON Schema：MCP / 记忆 / Skills 配置（后续）
          </div>
        </Link>
      </div>
    </div>
  );
}
