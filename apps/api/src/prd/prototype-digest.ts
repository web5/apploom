/**
 * 原型产物的「按需裁剪」：下游阶段只拿到它真正需要的部分，完整 HTML 不再整段进 prompt。
 *
 *  design  只需要页面清单与流程（pageTree 与之对齐）→ 去掉 html
 *  codegen 需要布局结构 + 视觉基调 + 交互点 → 精简版（设计令牌 / 结构标记 / 交互函数名）
 *
 * 纯确定性字符串处理，不调用模型；输入不是预期形状时原样透传，保证不会因裁剪而丢掉信息。
 */

import { estimateTokens } from '@apploom/llm';

const MARKUP_LIMIT = 4000;
const FUNCTION_NAME_LIMIT = 20;

interface PrototypeLike {
  html: string;
  [key: string]: unknown;
}

export interface PrototypeDigest {
  appName?: unknown;
  designStyle?: unknown;
  pages?: unknown;
  flows?: unknown;
  /** :root 中的 CSS 变量（配色 / 圆角等视觉基调） */
  designTokens: string;
  /** 去掉 <head>/<style>/<script>/内联样式后的页面结构，一个标签一行 */
  markup: string;
  /** 脚本里的函数名（交互入口），不含实现 */
  interactionFunctions: string[];
  note: string;
}

function isPrototypeLike(p: unknown): p is PrototypeLike {
  return !!p && typeof p === 'object' && typeof (p as { html?: unknown }).html === 'string';
}

function extractDesignTokens(html: string): string {
  const root = html.match(/:root\s*\{([^}]*)\}/i);
  return root ? root[1].replace(/\s+/g, ' ').trim() : '';
}

function extractFunctionNames(html: string): string[] {
  const names = new Set<string>();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  for (const m of scripts.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of scripts.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) names.add(m[1]);
  return [...names].slice(0, FUNCTION_NAME_LIMIT);
}

function extractMarkup(html: string): { markup: string; truncated: boolean } {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\sstyle="[^"]*"/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/>\s*</g, '>\n<')
    .trim();
  return body.length > MARKUP_LIMIT
    ? { markup: `${body.slice(0, MARKUP_LIMIT)}\n…（结构已截断）`, truncated: true }
    : { markup: body, truncated: false };
}

export function digestPrototype(p: PrototypeLike): PrototypeDigest {
  const { markup, truncated } = extractMarkup(p.html);
  return {
    appName: p.appName,
    designStyle: p.designStyle,
    pages: p.pages,
    flows: p.flows,
    designTokens: extractDesignTokens(p.html),
    markup,
    interactionFunctions: extractFunctionNames(p.html),
    note: `原型完整 HTML 共 ${p.html.length} 字符，此处仅保留视觉基调（designTokens）、页面结构（markup${truncated ? '，已截断' : ''}）与交互入口函数名；样式细节与脚本实现已省略，请据此实现真实 UI 与交互。`,
  };
}

/** design 阶段入参：去掉 html，只留页面清单与流程等元信息 */
export function prototypeForDesign(p: unknown): unknown {
  if (!isPrototypeLike(p)) return p;
  const { html: _html, ...rest } = p;
  return rest;
}

/** codegen 阶段入参：精简版原型 */
export function prototypeForCodegen(p: unknown): unknown {
  return isPrototypeLike(p) ? digestPrototype(p) : p;
}

/**
 * 渲染成 prompt 文本：元信息用 JSON，页面结构用原样 HTML 代码块
 * （放进 JSON 字符串会把每个引号转义成 \"，既费 token 又难读）。非预期形状时退回完整 JSON。
 * 这是降级阶梯的 L0：行为与加入预算之前逐字节一致。
 */
export function renderPrototypeForCodegen(p: unknown): string {
  if (!isPrototypeLike(p)) return JSON.stringify(p, null, 2);
  const { markup, ...meta } = digestPrototype(p);
  return `${JSON.stringify(meta, null, 2)}\n\n页面结构（markup，已去掉样式与脚本）：\n\`\`\`html\n${markup}\n\`\`\``;
}

/** 降级等级：0 = 原样（不裁剪）；1 = 缩短页面结构；2 = 去掉页面结构；3 = 只留页面清单与风格 */
export type TrimLevel = 0 | 1 | 2 | 3;

export interface TrimResult {
  /** 最终进 prompt 的文本 */
  text: string;
  level: TrimLevel;
  /** text 的估算 token 数 */
  tokens: number;
  /** 这条边的预算；未声明预算为 undefined */
  budget?: number;
  /** level > 0 */
  trimmed: boolean;
  /** 降到最低一档仍超预算（原型元信息本身就很大） */
  overBudget: boolean;
}

/** 一档内至少要留下这么多字符的页面结构才有意义，否则直接进入下一档 */
const MIN_MARKUP_CHARS = 400;

/**
 * 按预算降级渲染原型（prototype → codegen 这条边）。降级是确定性的，且每一档都在 prompt 里**显式声明**省略了什么——
 * 悄悄截断会让模型不知道自己缺信息，生成质量不可控。
 *
 *  L0 渲染结果在预算内 → 原样
 *  L1 超预算 → 保留设计令牌 / 函数名 / 页面清单，只缩短页面结构（markup）到刚好放得下
 *  L2 仍放不下 → 去掉页面结构，只留设计令牌 / 函数名 / 页面清单 / 流程
 *  L3 仍放不下 → 只留应用名 / 风格 / 页面清单，并明说「原型细节已按预算省略，请依据设计文档与页面清单生成」
 * 未声明预算（budget 为 undefined）等同不限，恒为 L0。
 */
export function trimPrototypeForCodegen(p: unknown, budget?: number): TrimResult {
  // JSON.stringify(undefined) 返回 undefined 而不是字符串；String() 与它被拼进模板字符串时的结果一致，保持 prompt 不变
  const l0 = String(renderPrototypeForCodegen(p));
  const done = (text: string, level: TrimLevel, overBudget = false): TrimResult => ({
    text,
    level,
    tokens: estimateTokens(text),
    budget,
    trimmed: level > 0,
    overBudget,
  });
  if (budget === undefined || !isPrototypeLike(p) || estimateTokens(l0) <= budget) return done(l0, 0);

  const d = digestPrototype(p);
  const { markup, note: _note, ...meta } = d;

  // L1：只缩短页面结构
  const bare = (note: string) => JSON.stringify({ ...meta, note }, null, 2);
  const l1Head = `${bare('页面结构（markup）已按 token 预算截断，仅保留开头部分；设计令牌、页面清单、流程与交互函数名完整保留，请据此实现真实 UI 与交互，被截掉的部分请依据设计文档补全。')}\n\n页面结构（markup，已去掉样式与脚本，已按预算截断）：\n\`\`\`html\n`;
  const tail = '\n…（结构已按预算截断）\n```';
  const room = (budget - estimateTokens(l1Head + tail)) * 3; // estimateTokens 约 3 字符 / token
  if (room >= MIN_MARKUP_CHARS) {
    const l1 = l1Head + markup.slice(0, Math.floor(room)) + tail;
    if (estimateTokens(l1) <= budget) return done(l1, 1);
  }

  // L2：去掉页面结构
  const l2 = bare('页面结构（markup）已按 token 预算整体省略；设计令牌、页面清单、流程与交互函数名完整保留，请据此并结合设计文档实现真实 UI 与交互。');
  if (estimateTokens(l2) <= budget) return done(l2, 2);

  // L3：只留页面清单与风格
  const l3 = JSON.stringify(
    {
      appName: d.appName,
      designStyle: d.designStyle,
      pages: d.pages,
      note: '原型的结构、样式细节与交互已按 token 预算省略，仅保留应用名、风格与页面清单；请依据设计文档与页面清单生成真实 UI 与交互。',
    },
    null,
    2,
  );
  return done(l3, 3, estimateTokens(l3) > budget);
}
