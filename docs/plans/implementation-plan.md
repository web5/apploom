# AI 研发平台实施计划
   
   > **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
   
   **Goal:** 构建一个 AI 研发平台，用户输入一句话或文档，AI 自动完成需求拆解→技术方案→代码生成→发布上线全流程，并支持生成产品的自我修改能力。
   
   **Architecture:** 前后端分离架构。前端 React + Next.js，后端 Node.js + NestJS，核心是 AI Pipeline 编排引擎（4 个 Agent 串联），数据层 PostgreSQL + Redis，部署层 Docker + K8s。
   
   **Tech Stack:** React 18 / Next.js 14 / TypeScript / Tailwind CSS / NestJS / Prisma / PostgreSQL / Redis / Docker / Kubernetes / OpenAI API / Claude API
  
  ---
  
  ## 总体阶段规划
  
  | 阶段 | 名称 | 目标 | 核心交付 |
  |------|------|------|---------|
  | Phase 0 | 基础设施 | 搭建项目骨架和开发环境 | Monorepo、数据库、CI/CD |
  | Phase 1 | MVP 核心流程 | 跑通"一句话→简单 Web 应用上线" | 单 Agent 精简流程、基础工作区 |
  | Phase 2 | 多 Agent 流水线 | 拆分为 4 个 Agent，完整 Pipeline | PRD 生成、方案设计、多端代码、部署 |
  | Phase 3 | 平台功能 | 用户系统、模板市场、计费 | 完整商业化闭环 |
  | Phase 4 | 产品自修改 | 内嵌 AI Runtime SDK | 产品内 AI 助手、增量修改、版本回滚 |
  
  ---
  
  ## Phase 0: 基础设施（搭建项目骨架）
  
  ### Task 0.1: 初始化 Monorepo 项目结构
  
  **Files:**
  - Create: `package.json` (root)
  - Create: `pnpm-workspace.yaml`
  - Create: `apps/web/package.json`
  - Create: `apps/api/package.json`
  - Create: `packages/shared/package.json`
  - Create: `packages/database/package.json`
  - Create: `.gitignore`
  - Create: `.eslintrc.js`
  - Create: `tsconfig.base.json`
  
  **Step 1: 初始化 Monorepo**
  
  ```bash
  mkdir ai-dev-platform && cd ai-dev-platform
  pnpm init
  ```
  
  `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - 'apps/*'
    - 'packages/*'
  ```
  
  **Step 2: 创建前端应用**
  
  ```bash
  pnpm create next-app apps/web --typescript --tailwind --app --src-dir
  ```
  
  **Step 3: 创建后端应用**
  
  ```bash
  mkdir -p apps/api/src
  cd apps/api && pnpm init
  pnpm add @nestjs/core @nestjs/common @nestjs/platform-express reflect-metadata rxjs
  pnpm add -D @nestjs/cli typescript @types/node ts-node
  ```
  
  **Step 4: 创建共享包**
  
  ```bash
  mkdir -p packages/shared/src packages/database/src
  ```
  
  `packages/shared/src/index.ts`:
  ```typescript
  export * from './types';
  export * from './constants';
  ```
  
  **Step 5: 初始化 Git**
  
  ```bash
  git init
  git add .
  git commit -m "chore: initialize monorepo structure"
  ```
  
  ---
  
  ### Task 0.2: 配置数据库与 ORM
  
  **Files:**
  - Create: `packages/database/prisma/schema.prisma`
  - Create: `packages/database/src/index.ts`
  - Create: `packages/database/package.json`
  - Create: `docker-compose.dev.yml`
  
  **Step 1: 编写 docker-compose 启动 PostgreSQL + Redis**
 
 `docker-compose.dev.yml`:
 ```yaml
 version: '3.8'
 services:
   postgres:
     image: postgres:16-alpine
     environment:
       POSTGRES_USER: aidp
       POSTGRES_PASSWORD: aidp_dev
       POSTGRES_DB: ai_dev_platform
     ports:
       - '5432:5432'
     volumes:
       - pgdata:/var/lib/postgresql/data
   redis:
     image: redis:7-alpine
     ports:
       - '6379:6379'
 volumes:
   pgdata:
 ```
 
 **Step 2: 定义初始 Prisma Schema**
 
 `packages/database/prisma/schema.prisma`:
 ```prisma
 generator client {
   provider = "prisma-client-js"
 }
 
 datasource db {
   provider = "postgresql"
   url      = env("DATABASE_URL")
 }
 
 model User {
   id        String   @id @default(uuid())
   email     String   @unique
   phone     String?  @unique
   name      String?
   avatar    String?
   plan      Plan     @default(FREE)
   credits   Int      @default(500)
   createdAt DateTime @default(now())
   updatedAt DateTime @updatedAt
   projects  Project[]
 }
 
 enum Plan {
   FREE
   PRO
   TEAM
   ENTERPRISE
 }
 
 model Project {
   id          String         @id @default(uuid())
   name        String
   description String?
   status      ProjectStatus  @default(DRAFT)
   platform    String[]
   pipelineMode PipelineMode  @default(STEP_BY_STEP)
   ownerId     String
   owner       User           @relation(fields: [ownerId], references: [id])
   versions    ProjectVersion[]
   createdAt   DateTime       @default(now())
   updatedAt   DateTime       @updatedAt
 }
 
 enum ProjectStatus {
   DRAFT
   IN_PROGRESS
   READY_TO_PUBLISH
   PUBLISHED
   ARCHIVED
 }
 
 enum PipelineMode {
   AUTO
   STEP_BY_STEP
 }
 
 model ProjectVersion {
   id        String   @id @default(uuid())
   projectId String
   project   Project  @relation(fields: [projectId], references: [id])
   version   String
   snapshot  Json
   createdAt DateTime @default(now())
 }
 ```
 
 **Step 3: 生成 Prisma Client**
 
 ```bash
 cd packages/database
 pnpm add @prisma/client
 pnpm add -D prisma
 npx prisma generate
 npx prisma migrate dev --name init
 ```
 
 **Step 4: 导出数据库客户端**
 
 `packages/database/src/index.ts`:
 ```typescript
 import { PrismaClient } from '@prisma/client';
 export const prisma = new PrismaClient();
 export * from '@prisma/client';
 ```
 
 **Step 5: Commit**
 
 ```bash
 git add .
 git commit -m "chore: setup database with Prisma and PostgreSQL"
 ```
 
 ---
 
 ### Task 0.3: 搭建后端 API 骨架
 
 **Files:**
 - Create: `apps/api/src/main.ts`
 - Create: `apps/api/src/app.module.ts`
 - Create: `apps/api/src/modules/auth/auth.module.ts`
 - Create: `apps/api/src/modules/auth/auth.controller.ts`
 - Create: `apps/api/src/modules/auth/auth.service.ts`
 - Create: `apps/api/src/modules/projects/projects.module.ts`
 - Create: `apps/api/src/modules/projects/projects.controller.ts`
 - Create: `apps/api/src/modules/projects/projects.service.ts`
 
 **Step 1: 创建 NestJS 应用入口**
 
 `apps/api/src/main.ts`:
 ```typescript
 import { NestFactory } from '@nestjs/core';
 import { AppModule } from './app.module';
 
 async function bootstrap() {
   const app = await NestFactory.create(AppModule);
   app.enableCors();
   app.listen(3001);
 }
 bootstrap();
 ```
 
 `apps/api/src/app.module.ts`:
 ```typescript
 import { Module } from '@nestjs/common';
 import { AuthModule } from './modules/auth/auth.module';
 import { ProjectsModule } from './modules/projects/projects.module';
 
 @Module({
   imports: [AuthModule, ProjectsModule],
 })
 export class AppModule {}
 ```
 
 **Step 2: 实现 Auth 模块（JWT 认证）**
 
 ```bash
 cd apps/api
 pnpm add @nestjs/jwt @nestjs/passport passport passport-jwt bcrypt
 pnpm add -D @types/passport-jwt @types/bcrypt
 ```
 
 `apps/api/src/modules/auth/auth.service.ts`:
 ```typescript
 import { Injectable } from '@nestjs/common';
 import { JwtService } from '@nestjs/jwt';
 import * as bcrypt from 'bcrypt';
 import { prisma } from '@ai-dev-platform/database';
 
 @Injectable()
 export class AuthService {
   constructor(private jwtService: JwtService) {}
 
   async register(email: string, password: string) {
     const hashed = await bcrypt.hash(password, 10);
     const user = await prisma.user.create({
       data: { email, name: email.split('@')[0] },
     });
     const token = this.jwtService.sign({ sub: user.id, email: user.email });
     return { user, token };
   }
 
   async login(email: string, password: string) {
     // TODO: implement login with password verification
     const user = await prisma.user.findUnique({ where: { email } });
     if (!user) throw new Error('User not found');
     const token = this.jwtService.sign({ sub: user.id, email: user.email });
     return { user, token };
   }
 
   async validateToken(token: string) {
     return this.jwtService.verify(token);
   }
 }
 ```
 
 **Step 3: 实现 Projects 模块（CRUD）**
 
 `apps/api/src/modules/projects/projects.service.ts`:
 ```typescript
 import { Injectable } from '@nestjs/common';
 import { prisma } from '@ai-dev-platform/database';
 
 @Injectable()
 export class ProjectsService {
   async findAll(userId: string) {
     return prisma.project.findMany({
       where: { ownerId: userId },
       include: { versions: { take: 1, orderBy: { createdAt: 'desc' } } },
       orderBy: { updatedAt: 'desc' },
     });
   }
 
   async create(userId: string, data: { name: string; description?: string; platform?: string[] }) {
     return prisma.project.create({
       data: {
         ...data,
         ownerId: userId,
         platform: data.platform || ['WEB'],
       },
     });
   }
 
   async findById(id: string) {
     return prisma.project.findUnique({
       where: { id },
       include: { versions: { orderBy: { createdAt: 'desc' } } },
     });
   }
 
   async update(id: string, data: Partial<{ name: string; description: string; status: string }>) {
     return prisma.project.update({ where: { id }, data });
   }
 
   async delete(id: string) {
     return prisma.project.delete({ where: { id } });
   }
 }
 ```
 
 **Step 4: 启动验证**
 
 ```bash
 cd apps/api && pnpm start
 # 访问 http://localhost:3001 确认 API 启动
 ```
 
 **Step 5: Commit**
 
 ```bash
 git add .
 git commit -m "feat: setup NestJS API with auth and projects modules"
 ```
 
 ---
 
 ### Task 0.4: 搭建前端基础布局
 
 **Files:**
 - Create: `apps/web/src/app/layout.tsx`
 - Create: `apps/web/src/app/(landing)/page.tsx`
 - Create: `apps/web/src/app/(app)/layout.tsx`
 - Create: `apps/web/src/app/(app)/dashboard/page.tsx`
 - Create: `apps/web/src/components/Topbar.tsx`
 - Create: `apps/web/src/components/Sidebar.tsx`
 - Create: `apps/web/src/lib/api.ts`
 
 **Step 1: 配置路由分组**
 
 Next.js App Router 使用路由分组：
 - `(landing)` - 落地页，无导航栏
 - `(app)` - 应用页面，带顶部导航栏
 
 **Step 2: 实现顶部导航栏组件**
 
 `apps/web/src/components/Topbar.tsx`:
 ```tsx
 'use client';
 import Link from 'next/link';
 import { usePathname } from 'next/navigation';
 
 const navItems = [
   { href: '/dashboard', label: '工作台' },
   { href: '/marketplace', label: '模板市场' },
   { href: '/publish', label: '发布管理' },
   { href: '/settings', label: '设置' },
 ];
 
 export function Topbar() {
   const pathname = usePathname();
   return (
     <header className="h-14 border-b flex items-center justify-between px-6 sticky top-0 bg-white z-50">
       <div className="flex items-center gap-8">
         <Link href="/dashboard" className="font-bold flex items-center gap-2">
           <span className="w-7 h-7 bg-blue-500 text-white rounded-md flex items-center justify-center text-sm">AI</span>
           AI Dev Studio
         </Link>
         <nav className="flex gap-1">
           {navItems.map(item => (
             <Link
               key={item.href}
               href={item.href}
               className={`px-3 py-1.5 rounded-lg text-sm ${pathname === item.href ? 'text-blue-600 bg-blue-50 font-medium' : 'text-gray-600'}`}
             >
               {item.label}
             </Link>
           ))}
         </nav>
       </div>
     </header>
   );
 }
 ```
 
 **Step 3: 实现 API 客户端**
 
 `apps/web/src/lib/api.ts`:
 ```typescript
 const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
 
 export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
   const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
   const res = await fetch(`${API_BASE}${path}`, {
     ...options,
     headers: {
       'Content-Type': 'application/json',
       ...(token ? { Authorization: `Bearer ${token}` } : {}),
       ...options?.headers,
     },
   });
   if (!res.ok) throw new Error(`API Error: ${res.status}`);
   return res.json();
 }
 ```
 
 **Step 4: 验证前端启动**
 
 ```bash
 cd apps/web && pnpm dev
 # 访问 http://localhost:3000
 ```
 
 **Step 5: Commit**
 
 ```bash
 git add .
 git commit -m "feat: setup frontend layout with topbar and routing"
 ```
 
 ---
 
 ## Phase 1: MVP 核心流程（跑通一句话→上线）
 
 > **目标**：用最简化的单 Agent 流程跑通完整链路——用户输入一句话，AI 生成一个简单 Web 应用并部署上线。
 
 ### Task 1.1: 实现 AI Pipeline 引擎骨架
 
 **Files:**
 - Create: `apps/api/src/modules/pipeline/pipeline.module.ts`
 - Create: `apps/api/src/modules/pipeline/pipeline.service.ts`
 - Create: `apps/api/src/modules/pipeline/pipeline.controller.ts`
 - Create: `apps/api/src/modules/pipeline/agents/base-agent.ts`
 - Create: `apps/api/src/modules/pipeline/agents/requirement-agent.ts`
 - Create: `apps/api/src/modules/pipeline/agents/codegen-agent.ts`
 - Create: `apps/api/src/modules/pipeline/agents/deploy-agent.ts`
 - Create: `packages/shared/src/types/pipeline.ts`
 
 **Step 1: 定义 Pipeline 类型**
 
 `packages/shared/src/types/pipeline.ts`:
 ```typescript
 export type PipelineStage = 'REQUIREMENT' | 'DESIGN' | 'CODEGEN' | 'DEPLOY';
 export type StageStatus = 'PENDING' | 'RUNNING' | 'WAITING_CONFIRM' | 'COMPLETED' | 'FAILED';
 
 export interface PipelineContext {
   projectId: string;
   userInput: string;
   currentStage: PipelineStage;
   stageStatus: Record<PipelineStage, StageStatus>;
   outputs: Record<PipelineStage, any>;
 }
 
 export interface AgentResult {
   success: boolean;
   output: any;
   error?: string;
 }
 ```
 
 **Step 2: 实现 Base Agent 抽象类**
 
 `apps/api/src/modules/pipeline/agents/base-agent.ts`:
 ```typescript
 import { PipelineContext, AgentResult } from '@ai-dev-platform/shared';
 
 export abstract class BaseAgent {
   abstract readonly stage: string;
 
   abstract execute(context: PipelineContext): Promise<AgentResult>;
 
   protected async callAI(prompt: string, systemPrompt?: string): Promise<string> {
     // 统一的 AI 模型调用入口
     const response = await fetch('https://api.openai.com/v1/chat/completions', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
       },
       body: JSON.stringify({
         model: 'gpt-4',
         messages: [
           ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
           { role: 'user', content: prompt },
         ],
         temperature: 0.7,
       }),
     });
     const data = await response.json();
     return data.choices[0].message.content;
   }
 }
 ```
 
 **Step 3: 实现 Requirement Agent（需求分析）**
 
 `apps/api/src/modules/pipeline/agents/requirement-agent.ts`:
 ```typescript
 import { BaseAgent } from './base-agent';
 import { PipelineContext, AgentResult } from '@ai-dev-platform/shared';
 
 const SYSTEM_PROMPT = `你是一个产品经理。用户会给你一句话描述，你需要：
 1. 分析核心需求
 2. 生成产品概述
 3. 列出功能列表（分 P0/P1/P2 优先级）
 4. 列出需要的页面
 5. 列出核心数据实体
 输出 JSON 格式的 PRD 文档。`;
 
 export class RequirementAgent extends BaseAgent {
   readonly stage = 'REQUIREMENT';
 
   async execute(context: PipelineContext): Promise<AgentResult> {
     try {
       const result = await this.callAI(context.userInput, SYSTEM_PROMPT);
       const prd = JSON.parse(result);
       return { success: true, output: prd };
     } catch (error) {
       return { success: false, output: null, error: error.message };
     }
   }
 }
 ```
 
 **Step 4: 实现 CodeGen Agent（代码生成 - MVP 版）**
 
 `apps/api/src/modules/pipeline/agents/codegen-agent.ts`:
 ```typescript
 import { BaseAgent } from './base-agent';
 import { PipelineContext, AgentResult } from '@ai-dev-platform/shared';
 
 const SYSTEM_PROMPT = `你是一个全栈工程师。根据 PRD 生成一个可运行的 Next.js 项目代码。
 要求：
 - 使用 React + TypeScript + Tailwind CSS
 - 包含所有页面的完整代码
 - 输出 JSON 格式：{ "files": [{ "path": "src/app/page.tsx", "content": "..." }] }
 - 代码必须完整可运行`;
 
 export class CodeGenAgent extends BaseAgent {
   readonly stage = 'CODEGEN';
 
   async execute(context: PipelineContext): Promise<AgentResult> {
     const prd = context.outputs.REQUIREMENT;
     const prompt = `根据以下 PRD 生成完整的 Next.js 项目代码：\n${JSON.stringify(prd, null, 2)}`;
     try {
       const result = await this.callAI(prompt, SYSTEM_PROMPT);
       const files = JSON.parse(result);
       return { success: true, output: files };
     } catch (error) {
       return { success: false, output: null, error: error.message };
     }
   }
 }
 ```
 
 **Step 5: 实现 Deploy Agent（部署 - MVP 版）**
 
 `apps/api/src/modules/pipeline/agents/deploy-agent.ts`:
 ```typescript
 import { BaseAgent } from './base-agent';
 import { PipelineContext, AgentResult } from '@ai-dev-platform/shared';
 import * as fs from 'fs/promises';
 import * as path from 'path';
 
 export class DeployAgent extends BaseAgent {
   readonly stage = 'DEPLOY';
 
   async execute(context: PipelineContext): Promise<AgentResult> {
     const files = context.outputs.CODEGEN?.files;
     if (!files || !Array.isArray(files)) {
       return { success: false, output: null, error: 'No files to deploy' };
     }
 
     // MVP: 写入文件到临时目录，调用构建脚本
     const deployDir = path.join('/tmp/deploys', context.projectId);
     await fs.mkdir(deployDir, { recursive: true });
 
     for (const file of files) {
       const filePath = path.join(deployDir, file.path);
       await fs.mkdir(path.dirname(filePath), { recursive: true });
       await fs.writeFile(filePath, file.content);
     }
 
     // TODO: 调用 Docker 构建和部署
     const url = `https://${context.projectId}.aidp.cloud`;
     return { success: true, output: { url, deployDir } };
   }
 }
 ```
 
 **Step 6: 实现 Pipeline 编排服务**
 
 `apps/api/src/modules/pipeline/pipeline.service.ts`:
 ```typescript
 import { Injectable } from '@nestjs/common';
 import { RequirementAgent } from './agents/requirement-agent';
 import { CodeGenAgent } from './agents/codegen-agent';
 import { DeployAgent } from './agents/deploy-agent';
 import { prisma } from '@ai-dev-platform/database';
 
 @Injectable()
 export class PipelineService {
   private agents = {
     REQUIREMENT: new RequirementAgent(),
     CODEGEN: new CodeGenAgent(),
     DEPLOY: new DeployAgent(),
   };
 
   async runPipeline(projectId: string, userInput: string) {
     const project = await prisma.project.findUnique({ where: { id: projectId } });
     if (!project) throw new Error('Project not found');
 
     const context = {
       projectId,
       userInput,
       currentStage: 'REQUIREMENT' as const,
       stageStatus: { REQUIREMENT: 'PENDING', DESIGN: 'PENDING', CODEGEN: 'PENDING', DEPLOY: 'PENDING' },
       outputs: {},
     };
 
     // MVP: 顺序执行，无人工确认
     for (const [stage, agent] of Object.entries(this.agents)) {
       context.currentStage = stage as any;
       context.stageStatus[stage] = 'RUNNING';
       const result = await agent.execute(context);
       if (!result.success) {
         context.stageStatus[stage] = 'FAILED';
         throw new Error(`Pipeline failed at ${stage}: ${result.error}`);
       }
       context.outputs[stage] = result.output;
       context.stageStatus[stage] = 'COMPLETED';
     }
 
     // 保存版本快照
     await prisma.projectVersion.create({
       data: {
         projectId,
         version: 'v1.0',
         snapshot: context.outputs,
       },
     });
 
     await prisma.project.update({
       where: { id: projectId },
       data: { status: 'PUBLISHED' },
     });
 
     return context.outputs.DEPLOY;
   }
 }
 ```
 
 **Step 7: Commit**
 
 ```bash
 git add .
 git commit -m "feat: implement AI pipeline engine with 3 agents (MVP)"
 ```
 
 ---
 
 ### Task 1.2: 实现项目工作区前端（三栏布局）
 
 **Files:**
 - Create: `apps/web/src/app/(app)/projects/[id]/page.tsx`
 - Create: `apps/web/src/components/workspace/WorkspaceLayout.tsx`
 - Create: `apps/web/src/components/workspace/ChatPanel.tsx`
 - Create: `apps/web/src/components/workspace/PipelineBoard.tsx`
 - Create: `apps/web/src/components/workspace/PreviewPanel.tsx`
 - Create: `apps/web/src/hooks/usePipeline.ts`
 
 **Step 1: 实现三栏布局容器**
 
 `apps/web/src/components/workspace/WorkspaceLayout.tsx`:
 ```tsx
 'use client';
 import { useState } from 'react';
 import { ChatPanel } from './ChatPanel';
 import { PipelineBoard } from './PipelineBoard';
 import { PreviewPanel } from './PreviewPanel';
 
 export function WorkspaceLayout({ projectId }: { projectId: string }) {
   const [leftWidth, setLeftWidth] = useState(280);
   const [rightWidth, setRightWidth] = useState(360);
   const [activeStage, setActiveStage] = useState('REQUIREMENT');
 
   return (
     <div className="flex h-[calc(100vh-3.5rem)]">
       <div style={{ width: leftWidth }} className="border-r flex-shrink-0">
         <ChatPanel projectId={projectId} />
       </div>
       <div className="flex-1 overflow-auto">
         <PipelineBoard projectId={projectId} activeStage={activeStage} onSelectStage={setActiveStage} />
       </div>
       <div style={{ width: rightWidth }} className="border-l flex-shrink-0">
         <PreviewPanel projectId={projectId} activeStage={activeStage} />
       </div>
     </div>
   );
 }
 ```
 
 **Step 2: 实现对话面板**
 
 `apps/web/src/components/workspace/ChatPanel.tsx`:
 ```tsx
 'use client';
 import { useState } from 'react';
 import { apiFetch } from '@/lib/api';
 
 export function ChatPanel({ projectId }: { projectId: string }) {
   const [messages, setMessages] = useState<{ role: 'user' | 'ai'; content: string }[]>([]);
   const [input, setInput] = useState('');
 
   const send = async () => {
     if (!input.trim()) return;
     const userMsg = { role: 'user' as const, content: input };
     setMessages(prev => [...prev, userMsg]);
     setInput('');
     // 触发 Pipeline
     try {
       const result = await apiFetch(`/pipeline/run`, {
         method: 'POST',
         body: JSON.stringify({ projectId, userInput: input }),
       });
       setMessages(prev => [...prev, { role: 'ai', content: '已生成！查看右侧预览。' }]);
     } catch (e) {
       setMessages(prev => [...prev, { role: 'ai', content: '出错了，请重试。' }]);
     }
   };
 
   return (
     <div className="flex flex-col h-full">
       <div className="flex-1 overflow-auto p-4 space-y-3">
         {messages.map((msg, i) => (
           <div key={i} className={`p-3 rounded-xl text-sm max-w-[90%] ${
             msg.role === 'user' ? 'bg-blue-500 text-white ml-auto' : 'bg-gray-100'
           }`}>
             {msg.content}
           </div>
         ))}
       </div>
       <div className="p-3 border-t flex gap-2">
         <input
           value={input}
           onChange={e => setInput(e.target.value)}
           onKeyDown={e => e.key === 'Enter' && send()}
           placeholder="描述你的产品想法…"
           className="flex-1 border rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
         />
         <button onClick={send} className="bg-blue-500 text-white px-4 rounded-lg text-sm">发送</button>
       </div>
     </div>
   );
 }
 ```
 
 **Step 3: 实现流水线看板**
 
 `apps/web/src/components/workspace/PipelineBoard.tsx`:
 ```tsx
 'use client';
 
 const STAGES = [
   { id: 'REQUIREMENT', label: '需求拆解', icon: '📋' },
   { id: 'DESIGN', label: '方案设计', icon: '🏗' },
   { id: 'CODEGEN', label: '代码生成', icon: '💻' },
   { id: 'DEPLOY', label: '发布上线', icon: '🚀' },
 ];
 
 export function PipelineBoard({ projectId, activeStage, onSelectStage }: {
   projectId: string;
   activeStage: string;
   onSelectStage: (stage: string) => void;
 }) {
   return (
     <div className="p-6">
       <div className="flex items-center gap-4 mb-6">
         {STAGES.map((stage, i) => (
           <div key={stage.id} className="flex items-center gap-4">
             <div
               onClick={() => onSelectStage(stage.id)}
               className={`cursor-pointer flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition ${
                 activeStage === stage.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
               }`}
             >
               <div className="text-2xl">{stage.icon}</div>
               <div className="text-sm font-medium">{stage.label}</div>
               <div className="text-xs text-gray-400">等待中</div>
             </div>
             {i < STAGES.length - 1 && <div className="w-8 h-0.5 bg-gray-200" />}
           </div>
         ))}
       </div>
     </div>
   );
 }
 ```
 
 **Step 4: 实现预览面板**
 
 `apps/web/src/components/workspace/PreviewPanel.tsx`:
 ```tsx
 'use client';
 import { useState, useEffect } from 'react';
 import { apiFetch } from '@/lib/api';
 
 export function PreviewPanel({ projectId, activeStage }: { projectId: string; activeStage: string }) {
   const [tab, setTab] = useState<'prd' | 'code' | 'preview'>('prd');
   const [data, setData] = useState<any>(null);
 
   useEffect(() => {
     // 根据当前 stage 加载预览数据
     apiFetch(`/projects/${projectId}/output/${activeStage}`).then(setData).catch(() => setData(null));
   }, [projectId, activeStage]);
 
   return (
     <div className="flex flex-col h-full">
       <div className="flex border-b">
         {[
           { id: 'prd', label: 'PRD' },
           { id: 'code', label: '代码' },
           { id: 'preview', label: '预览' },
         ].map(t => (
           <button
             key={t.id}
             onClick={() => setTab(t.id as any)}
             className={`px-4 py-2 text-sm ${tab === t.id ? 'border-b-2 border-blue-500 text-blue-600 font-medium' : 'text-gray-500'}`}
           >
             {t.label}
           </button>
         ))}
       </div>
       <div className="flex-1 overflow-auto p-4">
         {tab === 'prd' && <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>}
         {tab === 'code' && <pre className="text-xs font-mono">{JSON.stringify(data, null, 2)}</pre>}
         {tab === 'preview' && data?.url && <iframe src={data.url} className="w-full h-full border-0" />}
       </div>
     </div>
   );
 }
 ```
 
 **Step 5: 组装项目工作区页面**
 
 `apps/web/src/app/(app)/projects/[id]/page.tsx`:
 ```tsx
 import { WorkspaceLayout } from '@/components/workspace/WorkspaceLayout';
 
 export default function ProjectPage({ params }: { params: { id: string } }) {
   return <WorkspaceLayout projectId={params.id} />;
 }
 ```
 
 **Step 6: Commit**
 
 ```bash
 git add .
 git commit -m "feat: implement workspace with three-column layout"
 ```
 
 ---
 
 ### Task 1.3: 实现工作台首页（项目列表 + 创建入口）
 
 **Files:**
 - Create: `apps/web/src/app/(app)/dashboard/page.tsx`
 - Create: `apps/web/src/components/dashboard/CreateBar.tsx`
 - Create: `apps/web/src/components/dashboard/ProjectCard.tsx`
 - Create: `apps/web/src/hooks/useProjects.ts`
 
 **Step 1: 实现创建入口**
 
 `apps/web/src/components/dashboard/CreateBar.tsx`:
 ```tsx
 'use client';
 import { useState } from 'react';
 import { useRouter } from 'next/navigation';
 import { apiFetch } from '@/lib/api';
 
 export function CreateBar() {
   const [input, setInput] = useState('');
   const [loading, setLoading] = useState(false);
   const router = useRouter();
 
   const create = async () => {
     if (!input.trim()) return;
     setLoading(true);
     try {
       const project = await apiFetch<{ id: string }>('/projects', {
         method: 'POST',
         body: JSON.stringify({ name: input.slice(0, 20), description: input, platform: ['WEB'] }),
       });
       router.push(`/projects/${project.id}`);
     } finally {
       setLoading(false);
     }
   };
 
   return (
     <div className="flex gap-3 mb-8">
       <div className="flex-1 flex items-center gap-2 border rounded-xl px-4 h-13">
         <span className="text-gray-400">💬</span>
         <input
           value={input}
           onChange={e => setInput(e.target.value)}
           onKeyDown={e => e.key === 'Enter' && create()}
           placeholder="输入一句话描述你的产品想法…"
           className="flex-1 h-12 outline-none text-sm"
           disabled={loading}
         />
       </div>
       <button onClick={create} disabled={loading} className="bg-blue-500 text-white px-6 rounded-xl text-sm font-medium disabled:opacity-50">
         {loading ? '创建中…' : '创建项目'}
       </button>
     </div>
   );
 }
 ```
 
 **Step 2: 实现项目卡片**
 
 `apps/web/src/components/dashboard/ProjectCard.tsx`:
 ```tsx
 import Link from 'next/link';
 
 const statusColors: Record<string, string> = {
   DRAFT: 'bg-gray-100 text-gray-600',
   IN_PROGRESS: 'bg-blue-50 text-blue-600',
   PUBLISHED: 'bg-green-50 text-green-600',
 };
 
 export function ProjectCard({ project }: { project: any }) {
   return (
     <Link href={`/projects/${project.id}`} className="block border rounded-xl p-4 hover:border-blue-300 transition">
       <div className="flex items-start justify-between mb-3">
         <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center text-lg">📦</div>
         <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[project.status] || statusColors.DRAFT}`}>
           {project.status}
         </span>
       </div>
       <h3 className="font-medium text-sm mb-1">{project.name}</h3>
       <p className="text-xs text-gray-500 line-clamp-2">{project.description}</p>
       <div className="text-xs text-gray-400 mt-3">
         {new Date(project.updatedAt).toLocaleDateString()}
       </div>
     </Link>
   );
 }
 ```
 
 **Step 3: 组装工作台页面**
 
 `apps/web/src/app/(app)/dashboard/page.tsx`:
 ```tsx
 'use client';
 import { useEffect, useState } from 'react';
 import { CreateBar } from '@/components/dashboard/CreateBar';
 import { ProjectCard } from '@/components/dashboard/ProjectCard';
 import { apiFetch } from '@/lib/api';
 
 export default function DashboardPage() {
   const [projects, setProjects] = useState([]);
 
   useEffect(() => {
    apiFetch('/projects').then(setProjects).catch(() => {});
  }, []);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <CreateBar />
      <div className="grid grid-cols-3 gap-4">
        {projects.map(p => <ProjectCard key={p.id} project={p} />)}
      </div>
    </div>
  );
}
```

**Step 4: Commit**

```bash
git add .
git commit -m "feat: implement dashboard with project list and create bar"
```

---

### Task 1.4: 实现简化部署（Docker 容器化）

**Files:**
- Create: `apps/api/src/modules/deploy/deploy.module.ts`
- Create: `apps/api/src/modules/deploy/deploy.service.ts`
- Create: `apps/api/src/modules/deploy/templates/Dockerfile.template`
- Create: `apps/api/src/modules/deploy/templates/nginx.conf.template`

**Step 1: 实现部署服务**

`apps/api/src/modules/deploy/deploy.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class DeployService {
  async deploy(projectId: string, files: { path: string; content: string }[]): Promise<string> {
    const deployDir = path.join(process.env.DEPLOY_DIR || '/tmp/deploys', projectId);
    await fs.mkdir(deployDir, { recursive: true });

    // 写入代码文件
    for (const file of files) {
      const filePath = path.join(deployDir, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content);
    }

    // 写入 Dockerfile
    const dockerfile = `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]`;
    await fs.writeFile(path.join(deployDir, 'Dockerfile'), dockerfile);

    // 构建并运行 Docker 容器
    const containerName = `aidp-${projectId}`;
    const port = await this.allocatePort(projectId);

    try {
      await execAsync(`docker rm -f ${containerName} 2>/dev/null || true`);
      await execAsync(`docker build -t ${containerName} ${deployDir}`);
      await execAsync(`docker run -d --name ${containerName} -p ${port}:3000 ${containerName}`);
    } catch (error) {
      throw new Error(`Deploy failed: ${error.message}`);
    }

    return `http://localhost:${port}`;
  }

  private async allocatePort(projectId: string): Promise<number> {
    // 简单的端口分配：基于 projectId hash
    const hash = projectId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return 10000 + (hash % 50000);
  }

  async stop(projectId: string) {
    const containerName = `aidp-${projectId}`;
    await execAsync(`docker rm -f ${containerName} 2>/dev/null || true`);
  }
}
```

**Step 2: 更新 Pipeline 中的 Deploy Agent 使用 DeployService**

在 `deploy-agent.ts` 中注入并调用 `DeployService.deploy()`。

**Step 3: 验证完整流程**

```bash
# 1. 启动数据库
docker-compose -f docker-compose.dev.yml up -d

# 2. 启动 API
cd apps/api && pnpm start

# 3. 启动前端
cd apps/web && pnpm dev

# 4. 在前端输入"做一个待办事项应用"，验证完整流程
```

**Step 4: Commit**

```bash
git add .
git commit -m "feat: implement Docker-based deployment service"
```

---

### Task 1.5: MVP 集成测试与修复

**Step 1: 端到端测试**

手动走查完整流程：
1. 访问 `http://localhost:3000`
2. 输入"做一个待办事项应用"
3. 确认项目创建成功，跳转到工作区
4. 确认对话面板可输入
5. 确认 Pipeline 各阶段执行
6. 确认右侧预览面板展示产出
7. 确认最终部署 URL 可访问

**Step 2: 修复发现的问题**

记录并修复集成中发现的问题。

**Step 3: Commit**

```bash
git add .
git commit -m "fix: resolve integration issues from MVP testing"
```

---

## Phase 2: 多 Agent 流水线（完整 Pipeline）

> **目标**：将 MVP 的 3 个 Agent 扩展为完整的 4 个，加入架构设计 Agent，支持逐步确认模式，实现多端代码生成。

### Task 2.1: 实现架构设计 Agent

**Files:**
- Create: `apps/api/src/modules/pipeline/agents/design-agent.ts`
- Modify: `apps/api/src/modules/pipeline/pipeline.service.ts` (插入 DesignAgent 到 REQUIREMENT 和 CODEGEN 之间)

**关键实现**：
- 输入：确认后的 PRD
- AI Prompt 设计：技术选型、页面结构树、数据模型(ER)、API 列表、低保真原型图描述
- 产出：结构化技术方案 JSON
- 支持「人工确认」暂停点

---

### Task 2.2: 实现逐步确认模式

**Files:**
- Modify: `apps/api/src/modules/pipeline/pipeline.service.ts`
- Create: `apps/api/src/modules/pipeline/pipeline-state.ts`
- Modify: `apps/web/src/components/workspace/PipelineBoard.tsx`

**关键实现**：
- Pipeline 状态持久化到数据库
- 每个阶段完成后暂停，等待用户确认
- 前端轮询或 WebSocket 推送状态更新
- 用户点击「确认」继续下一阶段，或「重新生成」重跑当前阶段

---

### Task 2.3: 实现多端代码生成

**Files:**
- Create: `apps/api/src/modules/pipeline/codegen/web-codegen.ts`
- Create: `apps/api/src/modules/pipeline/codegen/miniprogram-codegen.ts`
- Create: `apps/api/src/modules/pipeline/codegen/app-codegen.ts`
- Modify: `apps/api/src/modules/pipeline/agents/codegen-agent.ts`

**关键实现**：
- Web：React + Next.js + Tailwind CSS
- 小程序：Taro 3 (React 语法)
- App：React Native + Expo
- 共享数据模型定义和 API 客户端代码
- 代码生成使用 CodeLlama / DeepSeek-Coder 辅助

---

### Task 2.4: 实现对话式修改

**Files:**
- Create: `apps/api/src/modules/pipeline/chat-handler.ts`
- Modify: `apps/web/src/components/workspace/ChatPanel.tsx`

**关键实现**：
- 用户在对话面板输入修改需求
- AI 判断影响范围（需求层/方案层/代码层）
- 增量重新生成受影响部分
- 保存版本快照，支持回退

---

### Task 2.5: 实现代码编辑器

**Files:**
- Create: `apps/web/src/components/workspace/CodeEditor.tsx`
- Add dependency: `@monaco-editor/react`

**关键实现**：
- 集成 Monaco Editor
- 展示生成的代码文件树
- 支持在线编辑代码
- 编辑后可重新预览

---

## Phase 3: 平台功能（商业化闭环）

> **目标**：实现用户系统、模板市场、计费体系、发布管理，形成完整商业产品。

### Task 3.1: 用户认证系统

**Files:**
- Create: `apps/api/src/modules/auth/strategies/jwt.strategy.ts`
- Create: `apps/api/src/modules/auth/strategies/wechat.strategy.ts`
- Create: `apps/api/src/modules/auth/guards/jwt-auth.guard.ts`
- Create: `apps/web/src/app/(auth)/login/page.tsx`
- Create: `apps/web/src/app/(auth)/register/page.tsx`

**关键实现**：
- JWT 认证（邮箱+密码）
- 微信扫码登录
- 手机号+验证码登录
- 前端登录/注册页面
- 路由守卫：未登录跳转登录页

---

### Task 3.2: 模板市场

**Files:**
- Create: `apps/api/src/modules/templates/templates.module.ts`
- Create: `apps/api/src/modules/templates/templates.service.ts`
- Create: `apps/api/src/modules/templates/templates.controller.ts`
- Modify: `packages/database/prisma/schema.prisma` (新增 Template 模型)
- Create: `apps/web/src/app/(app)/marketplace/page.tsx`

**关键实现**：
- 模板 CRUD（管理员创建）
- 分类筛选（行业/功能/平台）
- 使用模板创建项目
- 模板评分和使用统计

---

### Task 3.3: 计费系统

**Files:**
- Create: `apps/api/src/modules/billing/billing.module.ts`
- Create: `apps/api/src/modules/billing/billing.service.ts`
- Create: `apps/api/src/modules/billing/credits.service.ts`
- Modify: `packages/database/prisma/schema.prisma` (新增 Subscription, CreditTransaction 模型)
- Create: `apps/web/src/app/(app)/settings/billing/page.tsx`

**关键实现**：
- 四档套餐管理（FREE/PRO/TEAM/ENTERPRISE）
- 算力点数消耗与扣减
- 支付集成（微信支付/支付宝）
- 用量统计与告警

---

### Task 3.4: 发布管理

**Files:**
- Create: `apps/api/src/modules/publish/publish.module.ts`
- Create: `apps/api/src/modules/publish/publish.service.ts`
- Modify: `packages/database/prisma/schema.prisma` (新增 Deployment 模型)
- Create: `apps/web/src/app/(app)/publish/page.tsx`

**关键实现**：
- 已发布应用列表
- 部署配置（域名、环境变量）
- 代码导出到 GitHub/GitLab
- 发布历史与回滚
- 访问统计

---

### Task 3.5: 团队协作

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (新增 Team, TeamMember 模型)
- Create: `apps/api/src/modules/teams/teams.module.ts`
- Create: `apps/api/src/modules/teams/teams.service.ts`

**关键实现**：
- 创建团队
- 邀请成员
- 权限管理（管理员/编辑者/查看者）
- 项目共享

---

## Phase 4: 产品自修改（AI Runtime SDK）

> **目标**：让平台生成的产品内嵌 AI 助手，用户直接在产品里说"改什么"，AI 自动修改并发布。

### Task 4.1: AI Runtime SDK

**Files:**
- Create: `packages/ai-runtime-sdk/package.json`
- Create: `packages/ai-runtime-sdk/src/index.ts`
- Create: `packages/ai-runtime-sdk/src/assistant.ts`
- Create: `packages/ai-runtime-sdk/src/api-client.ts`
- Create: `packages/ai-runtime-sdk/src/types.ts`

**关键实现**：
- SDK 核心类：AIAssistant
- 初始化：接收 projectId 和 API key
- 修改请求：发送到平台后端 AI 引擎
- Cmd+K 指令栏 UI 组件
- 浮动 AI 助手面板 UI 组件

---

### Task 4.2: 增量修改引擎

**Files:**
- Create: `apps/api/src/modules/pipeline/incremental/incremental-engine.ts`
- Create: `apps/api/src/modules/pipeline/incremental/impact-analyzer.ts`
- Create: `apps/api/src/modules/pipeline/incremental/diff-generator.ts`

**关键实现**：
- 影响范围分析：AI 解析修改请求，判断影响的代码模块
- 增量代码生成：只重新生成受影响部分，保留未变动代码
- Diff 生成：对比修改前后代码差异
- 安全验证：构建检查，失败则不发布

---

### Task 4.3: 产品内嵌助手 UI

**Files:**
- Create: `packages/ai-runtime-sdk/src/ui/CommandBar.tsx`
- Create: `packages/ai-runtime-sdk/src/ui/AssistantPanel.tsx`
- Create: `packages/ai-runtime-sdk/src/ui/DiffViewer.tsx`
- Create: `packages/ai-runtime-sdk/src/ui/VersionHistory.tsx`

**关键实现**：
- Cmd+K 快捷键唤出指令栏
- 助手面板：对话交互 + 影响分析卡片 + Diff 对比 + 确认发布
- 版本历史面板：查看历史版本、一键回滚
- 能力分级提示：轻量/中等/重大修改

---

### Task 4.4: 代码注入器

**Files:**
- Create: `apps/api/src/modules/pipeline/injector/injector.ts`

**关键实现**：
- 在 CodeGen Agent 生成代码时自动注入 AI Runtime SDK
- 注入 SDK 初始化代码到产品入口文件
- 注入 Cmd+K 快捷键监听
- 注入助手面板组件
- 配置产品与平台的连接凭证

---

### Task 4.5: 版本管理与回滚

**Files:**
- Create: `apps/api/src/modules/pipeline/version-manager.ts`
- Modify: `packages/database/prisma/schema.prisma` (扩展 ProjectVersion 模型)

**关键实现**：
- 每次修改自动保存代码快照
- 版本树：线性版本历史
- 一键回滚到任意历史版本
- 回滚时增量重新部署

---

## 里程碑与验收标准

| 里程碑 | 阶段 | 验收标准 | 预估时间 |
|--------|------|---------|---------|
| M0: 基础设施就绪 | Phase 0 | Monorepo 可运行，数据库连通，API 和前端可启动 | 1 周 |
| M1: MVP 跑通 | Phase 1 | 输入一句话→生成简单 Web 应用→部署可访问 | 2 周 |
| M2: 完整 Pipeline | Phase 2 | 4 个 Agent 串联，逐步确认，多端生成，对话修改 | 3 周 |
| M3: 商业化闭环 | Phase 3 | 用户注册→创建项目→发布→计费→团队协作 | 3 周 |
| M4: 产品自修改 | Phase 4 | 生成的产品内嵌 AI，可直接在产品里修改并发布 | 2 周 |

---

## 技术决策记录

### ADR-001: Monorepo vs Polyrepo
**决策**：使用 Monorepo（pnpm workspace）
**理由**：前后端和共享类型需要在同一仓库中协调，Monorepo 便于代码共享和统一 CI/CD。

### ADR-002: NestJS vs FastAPI
**决策**：后端使用 NestJS（Node.js）
**理由**：与前端同语言（TypeScript），类型可共享，NestJS 的模块化设计适合 Pipeline 的多 Agent 架构。

### ADR-003: Docker vs Serverless 部署
**决策**：MVP 阶段使用 Docker，后续迁移到 Kubernetes
**理由**：Docker 简单直接，适合 MVP 快速验证。K8s 在多租户隔离和弹性伸缩上有优势，在 Phase 3 迁移。

### ADR-004: AI 模型选择
**决策**：主用 GPT-4，代码生成辅助 CodeLlama/DeepSeek-Coder
**理由**：GPT-4 在需求理解和方案设计上表现最佳，代码生成场景可用更经济的专用模型。

### ADR-005: 代码注入方式
**决策**：CodeGen Agent 在生成代码时自动注入 AI Runtime SDK
**理由**：对用户透明，无需手动配置。SDK 作为 npm 依赖注入，通过环境变量配置连接凭证。

---

## 安全体系设计（跨阶段贯穿）

> 安全性是 AI 研发平台的生命线。AI 生成的代码、平台承载的业务、部署运行的工程，三个层面都需要系统性防护。

### 一、代码安全：AI 生成的代码本身是否安全

**核心风险**：AI 生成的代码可能包含注入漏洞、XSS、硬编码密钥、危险依赖、路径遍历等。

#### 1.1 安全审查 Agent（Pipeline 第 5 环节）

**Files:**
- Create: `apps/api/src/modules/pipeline/agents/security-agent.ts`
- Create: `apps/api/src/modules/pipeline/security/scanner.ts`
- Create: `apps/api/src/modules/pipeline/security/rules.ts`

**实现方案**：

在代码生成（CodeGen Agent）完成后、部署前，自动插入安全审查环节：

```
CodeGen Agent 产出代码
      │
      ▼
Security Agent 安全审查
  ├── SAST 静态分析（集成 Semgrep / ESLint security 插件）
  ├── 依赖漏洞扫描（npm audit / Snyk API）
  ├── OWASP Top 10 检测
  │   · SQL 注入（拼接 SQL 语句）
  │   · XSS（未转义的 dangerouslySetInnerHTML）
  │   · CSRF（缺失 token 验证）
  │   · 路径遍历（../ 路径拼接）
  │   · 不安全的反序列化
  ├── 敏感信息检测
  │   · 硬编码密钥/Token（正则 + entropy 分析）
  │   · 数据库连接串明文
  │   · API Key 明文
  └── 代码质量检查
      · 未处理的 Promise rejection
      · 不安全的 eval() / Function() 调用
      · 危险的 child_process 调用
```

`apps/api/src/modules/pipeline/agents/security-agent.ts`:
```typescript
import { BaseAgent } from './base-agent';
import { PipelineContext, AgentResult } from '@ai-dev-platform/shared';
import { Scanner } from '../security/scanner';

const SECURITY_SYSTEM_PROMPT = `你是安全审查专家。检查以下代码是否存在安全漏洞：
1. SQL 注入、XSS、CSRF
2. 硬编码的密钥、Token、密码
3. 不安全的依赖（已知 CVE）
4. 路径遍历、命令注入
5. 不安全的反序列化
6. 敏感信息泄露

输出 JSON: { "passed": bool, "issues": [{ "severity": "HIGH|MEDIUM|LOW", "file": "...", "line": N, "description": "...", "fix": "..." }] }`;

export class SecurityAgent extends BaseAgent {
  readonly stage = 'SECURITY';

  async execute(context: PipelineContext): Promise<AgentResult> {
    const codegenOutput = context.outputs.CODEGEN;
    const scanner = new Scanner();

    // 1. 静态分析扫描
    const sastResults = await scanner.runSAST(codegenOutput.files);

    // 2. 依赖漏洞扫描
    const depResults = await scanner.scanDependencies(codegenOutput.files);

    // 3. AI 语义安全审查
    const aiReview = await this.callAI(
      `审查以下代码的安全性：\n${JSON.stringify(codegenOutput.files, null, 2)}`,
      SECURITY_SYSTEM_PROMPT
    );

    // 4. 敏感信息检测
    const secretResults = scanner.detectSecrets(codegenOutput.files);

    // 5. 汇总结果
    const allIssues = [
      ...sastResults,
      ...depResults,
      ...JSON.parse(aiReview).issues,
      ...secretResults,
    ];

    const highSeverityCount = allIssues.filter(i => i.severity === 'HIGH').length;

    // HIGH 级别问题阻断部署
    if (highSeverityCount > 0) {
      return {
        success: false,
        output: { issues: allIssues, blocked: true },
        error: `发现 ${highSeverityCount} 个高危安全问题，已阻断部署`,
      };
    }

    return { success: true, output: { issues: allIssues, blocked: false } };
  }
}
```

#### 1.2 代码沙箱预览

生成的代码在独立沙箱容器中预览运行，限制：
- 文件系统：仅项目目录可读写，禁止访问宿主文件系统
- 网络：仅允许 HTTP/HTTPS 出站，限制内网访问
- 系统调用：禁用 fork/exec/ptrace 等
- 执行权限：非 root 用户运行

#### 1.3 代码签名与完整性

- 代码生成后计算 SHA-256 hash
- 部署时校验 hash，防止中间篡改
- 版本快照绑定 hash，回滚时重新校验

---

### 二、业务安全：平台自身的业务逻辑和数据安全

**核心风险**：多租户数据泄露、越权访问、算力滥用、模板市场注入恶意代码。

#### 2.1 多租户数据隔离

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (添加 RLS 策略)
- Create: `apps/api/src/common/interceptors/tenant.interceptor.ts`
- Create: `apps/api/src/common/guards/resource.guard.ts`

**数据库层面 - PostgreSQL Row Level Security (RLS)**:

```sql
-- 启用 RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- 策略：用户只能看到自己的项目
CREATE POLICY tenant_isolation ON projects
  FOR ALL
  USING (owner_id = current_setting('app.current_user_id')::uuid);

-- 每次请求时设置当前用户 ID
SET app.current_user_id = '<user_uuid>';
```

**应用层面 - 租户上下文拦截器**:

```typescript
// apps/api/src/common/interceptors/tenant.interceptor.ts
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.sub;

    if (userId) {
      // 在数据库连接上设置当前用户上下文
      return from(prisma.$executeRaw`SET app.current_user_id = ${userId}`).pipe(
        switchMap(() => next.handle()),
      );
    }
    return next.handle();
  }
}
```

**资源级权限校验**:

```typescript
// apps/api/src/common/guards/resource.guard.ts
@Injectable()
export class ResourceGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const projectId = request.params.projectId || request.params.id;
    const userId = request.user?.sub;

    if (!projectId || !userId) return true; // 非资源路由放行

    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
    });

    if (!project) {
      throw new ForbiddenException('无权访问此资源');
    }
    return true;
  }
}
```

#### 2.2 算力配额与防滥用

**Files:**
- Create: `apps/api/src/modules/billing/rate-limiter.service.ts`
- Create: `apps/api/src/modules/billing/quota.service.ts`
- Create: `apps/api/src/common/guards/quota.guard.ts`

**措施**:

| 维度 | 限制 | 实现 |
|------|------|------|
| 每日生成次数 | 免费版 10 次/天，专业版 100 次/天 | Redis 计数器 |
| 单次生成 Token 消耗上限 | 50,000 tokens/次 | API 层截断 |
| 并发 Pipeline 数 | 每用户最多 1 个并发 | Redis 分布式锁 |
| 请求频率 | 60 次/分钟 | 令牌桶限流 |
| 异常行为检测 | 5 分钟内超过 20 次生成 → 暂停 15 分钟 | 滑动窗口检测 |

```typescript
// apps/api/src/modules/billing/rate-limiter.service.ts
@Injectable()
export class RateLimiterService {
  constructor(private redis: Redis) {}

  async checkQuota(userId: string, action: string): Promise<{ allowed: boolean; remaining: number }> {
    const key = `quota:${userId}:${action}:${this.getDateKey()}`;
    const limit = this.getLimit(action, userId);
    const current = await this.redis.incr(key);
    if (current === 1) await this.redis.expire(key, 86400);
    return { allowed: current <= limit, remaining: Math.max(0, limit - current) };
  }

  async checkAnomaly(userId: string): Promise<boolean> {
    const key = `anomaly:${userId}:${Math.floor(Date.now() / 300000)}`; // 5分钟窗口
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 300);
    return count > 20; // 5分钟内超过20次视为异常
  }
}
```

#### 2.3 模板市场安全

**核心风险**：恶意用户上传包含后门代码的模板。

**措施**:
1. 模板提交前自动经过 Security Agent 审查
2. 模板代码不允许包含 `eval()`、`child_process`、`fs.writeFile` 等危险 API
3. 模板代码经过人工审核后才能上架
4. 模板运行在沙箱中，限制权限

#### 2.4 数据安全

| 措施 | 实现方式 |
|------|---------|
| 敏感数据加密存储 | 用户密码 bcrypt，API Key AES-256 加密 |
| 数据传输加密 | 全站 HTTPS，API 请求签名 |
| 敏感信息脱敏 | 日志中手机号/邮箱自动脱敏 |
| 审计日志 | 所有敏感操作记录：谁、何时、做了什么 |
| 数据备份 | 每日自动备份，保留 30 天 |

---

### 三、工程安全：部署运行时的安全隔离

**核心风险**：生成的应用之间互相影响、容器逃逸、资源耗尽、恶意代码影响宿主机。

#### 3.1 容器隔离架构

```
┌──────────────────────────────────────────────┐
│                  宿主机                       │
│                                              │
│  ┌─────────────┐  ┌─────────────┐           │
│  │ App 容器 A   │  │ App 容器 B   │  ...      │
│  │             │  │             │           │
│  │ USER nobody │  │ USER nobody │           │
│  │ CPU: 1 core │  │ CPU: 1 core │           │
│  │ MEM: 512MB  │  │ MEM: 512MB  │           │
│  │ NET: 仅出站  │  │ NET: 仅出站  │           │
│  │ FS: 只读root │  │ FS: 只读root │           │
│  └──────┬──────┘  └──────┬──────┘           │
│         │                │                   │
│    ┌────┴────────────────┴────┐              │
│    │   Docker 自定义网络       │              │
│    │   (容器间不可互通)        │              │
│    └────────────┬─────────────┘              │
│                 │                            │
│  ┌──────────────┴──────────────┐             │
│  │      反向代理 (Nginx)        │             │
│  │  · 按域名路由到不同容器       │             │
│  │  · 请求大小限制 (10MB)       │             │
│  │  · 超时限制 (30s)           │             │
│  └─────────────────────────────┘             │
└──────────────────────────────────────────────┘
```

#### 3.2 容器安全配置

**Files:**
- Create: `apps/api/src/modules/deploy/security/container-security.ts`
- Modify: `apps/api/src/modules/deploy/deploy.service.ts`

```typescript
// apps/api/src/modules/deploy/security/container-security.ts
export const CONTAINER_SECURITY_CONFIG = {
  // 用户：非 root 运行
  user: 'nobody',

  // 资源限制
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 100,

  // 文件系统：rootfs 只读，仅 /tmp 可写
  readonlyRootfs: true,
  tmpfs: [{ target: '/tmp', size: 64 * 1024 * 1024 }],

  // 网络限制
  networkMode: 'bridge', // 使用自定义网络，容器间隔离
  capDrop: ['ALL'], // 移除所有 Linux capabilities
  capAdd: [], // 不添加任何额外权限
  securityOpts: ['no-new-privileges'], // 禁止提权

  // 环境变量隔离
  envWhitelist: ['NODE_ENV', 'PORT', 'DATABASE_URL'], // 仅注入白名单变量

  // 超时自动回收
  maxLifetime: 3600, // 容器最长存活 1 小时（可续期）
};
```

#### 3.3 镜像安全

| 措施 | 工具 | 时机 |
|------|------|------|
| 基础镜像扫描 | Trivy | 构建时 |
| 依赖漏洞扫描 | Snyk / npm audit | 构建时 |
| 镜像签名 | Cosign | 构建后 |
| 最小化镜像 | Alpine / Distroless | 基础镜像选择 |

#### 3.4 运行时监控

**Files:**
- Create: `apps/api/src/modules/monitor/runtime-monitor.service.ts`
- Create: `apps/api/src/modules/monitor/anomaly-detector.service.ts`

| 监控项 | 告警阈值 | 处理动作 |
|--------|---------|---------|
| CPU 使用率 | > 90% 持续 60s | 重启容器 |
| 内存使用率 | > 95% | 重启容器 |
| 异常网络流量 | > 100MB/分钟 | 断网 + 告警 |
| 异常文件写入 | 写入非 /tmp 目录 | 阻断 + 告警 |
| 异常进程 | fork bomb 检测 | 终止容器 |
| 容器逃逸检测 | 特权提升行为 | 立即隔离 + 告警 |

---

### 安全实施时间线

| 阶段 | 安全任务 | 优先级 |
|------|---------|--------|
| Phase 0 | 数据库 RLS、JWT 认证、API 限流 | P0 |
| Phase 1 | 容器隔离配置（非root/只读/资源限制）、基础 SAST 扫描 | P0 |
| Phase 2 | 安全审查 Agent、敏感信息检测、代码沙箱预览 | P0 |
| Phase 3 | 算力配额系统、模板市场安全审查、审计日志、镜像扫描 | P1 |
| Phase 4 | 产品自修改的安全边界（修改范围限制、权限隔离） | P1 |

### 安全 ADR

#### ADR-006: 安全审查作为 Pipeline 强制环节
**决策**：Security Agent 作为 Pipeline 的强制环节，不可跳过
**理由**：AI 生成的代码质量不可控，必须有自动化安全门禁。HIGH 级别问题阻断部署，MEDIUM/LOW 级别警告但允许通过。

#### ADR-007: 容器隔离方案
**决策**：MVP 用 Docker + security 配置，Phase 3 迁移到 gVisor/Kata Containers
**理由**：Docker 原生安全配置够用于 MVP。gVisor 提供更强的内核级隔离，适合多租户生产环境。

#### ADR-008: 多租户隔离方案
**决策**：PostgreSQL RLS + 应用层拦截器双重隔离
**理由**：数据库层 RLS 是最后一道防线，应用层拦截器提供更灵活的权限控制。双层防护确保即使应用层有 bug，数据库层仍能防止越权。
