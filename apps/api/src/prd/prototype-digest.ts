/**
 * 原型产物的「按需裁剪」：下游阶段只拿到它真正需要的部分，完整 HTML 不再整段进 prompt。
 *
 *  design  只需要页面清单与流程（pageTree 与之对齐）→ 去掉 html
 *  codegen 需要布局结构 + 视觉基调 + 交互点 → 精简版（设计令牌 / 结构标记 / 交互函数名）
 *
 * 纯确定性字符串处理，不调用模型；输入不是预期形状时原样透传，保证不会因裁剪而丢掉信息。
 */

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
 */
export function renderPrototypeForCodegen(p: unknown): string {
  if (!isPrototypeLike(p)) return JSON.stringify(p, null, 2);
  const { markup, ...meta } = digestPrototype(p);
  return `${JSON.stringify(meta, null, 2)}\n\n页面结构（markup，已去掉样式与脚本）：\n\`\`\`html\n${markup}\n\`\`\``;
}
