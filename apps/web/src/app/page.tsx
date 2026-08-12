import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 p-8 bg-[#f7f8fa] text-[#1a1a2e] font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col items-center gap-6 text-center">
        <div className="flex items-center gap-2 text-2xl font-bold">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-[#3b82f6] text-white">AI</span>
          AI Dev Studio
        </div>
        <p className="max-w-xl text-[#6b7280] text-sm leading-7">
          输入一句话，AI 自动完成需求拆解→方案设计→代码生成→发布上线。
          <br />
          当前阶段：W2 提示词调试闭环（需求分析 Agent）。
        </p>
        <Link
          href="/debug"
          className="rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white px-5 py-2.5 text-sm font-medium transition-colors"
        >
          进入调试工作台 →
        </Link>
      </main>
    </div>
  );
}
