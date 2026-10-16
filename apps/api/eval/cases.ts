/**
 * 评测用例集：固定的典型需求，用来在改动 harness / 提示词前后做对比。
 * 技术栈在需求里写死（降低模型自由发挥带来的方差），难度由易到难，且覆盖「有 package.json」与「纯静态」两条路径。
 * 新增用例只需在这里追加；已有用例的 id 不要改（基线按 id 对应）。
 */
import type { EvalCaseDef } from '../src/eval/metrics';

export const EVAL_CASES: EvalCaseDef[] = [
  {
    id: 'counter',
    title: '计数器（最简前端）',
    requirement: '做一个最简单的纯前端计数器页面（Vite + React + TypeScript），支持加一、减一和重置，不需要后端',
  },
  {
    id: 'todo',
    title: '待办清单（本地持久化）',
    requirement: '做一个纯前端待办清单应用（Vite + React + TypeScript）：可新增、勾选完成、删除任务，支持「全部/未完成/已完成」筛选，数据保存在浏览器 localStorage，不需要后端',
  },
  {
    id: 'bookmarks',
    title: '书签管理（搜索 + 标签）',
    requirement: '做一个纯前端书签管理应用（Vite + React + TypeScript）：可添加带标题、网址和标签的书签，支持按关键字搜索和按标签筛选，可删除，数据保存在 localStorage，不需要后端',
  },
  {
    id: 'landing',
    title: '静态落地页（无构建）',
    requirement: '做一个咖啡店的静态宣传单页，只用一个 index.html 加一个 style.css（原生 HTML/CSS，不使用任何框架和构建工具，不需要 package.json），包含店名横幅、菜单价目表和营业时间',
  },
];
