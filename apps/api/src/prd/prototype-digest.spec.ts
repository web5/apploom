import { digestPrototype, prototypeForCodegen, prototypeForDesign, renderPrototypeForCodegen, trimPrototypeForCodegen } from './prototype-digest';

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>极简计数器</title><style>
:root{--bg:#f5f7fa;--primary:#2563eb;--radius:14px;}
body{margin:0;font-family:sans-serif;}
.card{padding:28px;box-shadow:0 6px 24px rgba(15,23,42,.06);}
</style></head><body>
<!-- 导航 -->
<nav><span class="brand">计数器</span><button class="active" onclick="show('counter')">计数</button><button onclick="show('about')">关于</button></nav>
<section id="counter" class="page active"><div class="card" style="color:red"><div id="value">0</div>
<button onclick="inc()">+1</button><button onclick="dec()">-1</button><button onclick="reset()">重置</button></div></section>
<section id="about" class="page"><h2>关于</h2></section>
<script>
let count = 0;
function show(id){ document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.id===id)); }
function inc(){ count++; render(); }
const dec = () => { count--; render(); };
const reset = function(){ count = 0; render(); };
function render(){ document.getElementById('value').textContent = count; }
</script></body></html>`;

const proto = {
  appName: '极简计数器',
  designStyle: '卡片式',
  html,
  pages: [{ id: 'counter', title: '计数' }, { id: 'about', title: '关于' }],
  flows: [{ name: '计数', description: '点击加一' }],
};

describe('prototype digest', () => {
  it('保留元信息、设计令牌、结构标记与交互函数名', () => {
    const d = digestPrototype(proto);
    expect(d).toMatchObject({ appName: '极简计数器', pages: proto.pages, flows: proto.flows });
    expect(d.designTokens).toContain('--primary:#2563eb');
    expect(d.interactionFunctions).toEqual(expect.arrayContaining(['show', 'inc', 'dec', 'reset', 'render']));
    expect(d.markup).toContain('<section id="counter" class="page active">');
    expect(d.markup).toContain('onclick="inc()"');
  });

  it('去掉样式、脚本、注释、head 与内联 style', () => {
    const { markup } = digestPrototype(proto);
    expect(markup).not.toMatch(/<style|<script|<head|<!--|DOCTYPE|box-shadow|style="/i);
    expect(markup).not.toContain('document.querySelectorAll');
  });

  it('明显小于原始 HTML，并在 note 中说明省略', () => {
    const d = digestPrototype(proto);
    expect(JSON.stringify(d).length).toBeLessThan(JSON.stringify(proto).length);
    expect(d.note).toContain(`共 ${html.length} 字符`);
  });

  it('超长结构被截断并标注', () => {
    const big = { ...proto, html: `<body>${'<div class="row">x</div>'.repeat(500)}</body>` };
    const d = digestPrototype(big);
    expect(d.markup.length).toBeLessThan(4100);
    expect(d.markup).toContain('结构已截断');
    expect(d.note).toContain('已截断');
  });

  it('design 入参去掉 html，其余字段不变', () => {
    const d = prototypeForDesign(proto) as Record<string, unknown>;
    expect(d.html).toBeUndefined();
    expect(d).toEqual({ appName: proto.appName, designStyle: proto.designStyle, pages: proto.pages, flows: proto.flows });
  });

  it('codegen 渲染：结构以原样 HTML 代码块给出，不被转义成 \\"', () => {
    const text = renderPrototypeForCodegen(proto);
    expect(text).toContain('```html\n<html lang="zh-CN">');
    expect(text).toContain('onclick="inc()"');
    expect(text).not.toContain('\\"counter\\"');
    expect(text).toContain('"designTokens"');
    expect(text.length).toBeLessThan(JSON.stringify(proto, null, 2).length);
  });

  it('输入不是预期形状时原样透传（不丢信息）', () => {
    expect(renderPrototypeForCodegen({ foo: 1 })).toBe(JSON.stringify({ foo: 1 }, null, 2));
    expect(prototypeForDesign(undefined)).toBeUndefined();
    expect(prototypeForCodegen({ foo: 1 })).toEqual({ foo: 1 });
    expect(prototypeForCodegen(null)).toBeNull();
  });
});

import { estimateTokens } from '@apploom/llm';
import { CODEGEN_SPEC } from '../agent/agent-specs';

describe('trimPrototypeForCodegen：按预算降级（L0–L3）', () => {
  /** 构造一个结构很大的原型：很多页面区块 + 很长的页面清单 / 流程 */
  const big = (sections: number, pages = 3) => {
    const body = Array.from({ length: sections }, (_, i) => `<section id="p${i}" class="page"><h2>页面${i}</h2><div class="card"><button onclick="act${i}()">操作${i}</button><p>说明文字说明文字说明文字</p></div></section>`).join('\n');
    return {
      appName: '大应用',
      designStyle: '卡片式',
      html: `<!DOCTYPE html><html><head><style>:root{--primary:#2563eb;--radius:12px;}</style></head><body>${body}<script>${Array.from({ length: sections }, (_, i) => `function act${i}(){}`).join('\n')}</script></body></html>`,
      pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i}`, title: `页面${i}` })),
      flows: [{ name: '主流程', description: '依次操作' }],
    };
  };

  it('L0：没有预算 / 预算足够 → 与降级功能出现之前逐字节一致（评测验证过的行为不能变）', () => {
    for (const p of [proto, big(40)]) {
      const old = renderPrototypeForCodegen(p);
      expect(trimPrototypeForCodegen(p, undefined)).toMatchObject({ text: old, level: 0, trimmed: false, overBudget: false });
      expect(trimPrototypeForCodegen(p, 1_000_000)).toMatchObject({ text: old, level: 0, trimmed: false });
      expect(trimPrototypeForCodegen(p, 1_000_000).tokens).toBe(estimateTokens(old));
    }
  });

  it('默认的 6000 预算下，典型原型仍是 L0，且 prompt 文本与加入预算之前逐字节一致（评测验证过的行为不能变）', () => {
    for (const p of [proto, big(60), big(5)]) {
      const r = trimPrototypeForCodegen(p, 6000);
      expect(r.level).toBe(0);
      expect(r.text).toBe(renderPrototypeForCodegen(p)); // markup 本身已有 4000 字符上限，所以不会超 6000 token
    }
  });

  it('codegen 阶段真正用来拼 prompt 的渲染（含图里声明的预算）与旧渲染逐字节一致', () => {
    for (const p of [proto, big(60)]) {
      const user = CODEGEN_SPEC.buildUser({ design: { d: 1 }, prototype: p });
      expect(user).toContain(renderPrototypeForCodegen(p));
      expect(user).not.toContain('已按 token 预算');
    }
  });

  it('非预期形状（没有 html 字符串）：原样透传，永不降级、不抛错', () => {
    for (const odd of [null, undefined, 'x', 42, { html: 1 }, {}, []]) {
      const r = trimPrototypeForCodegen(odd, 10);
      expect(r.level).toBe(0);
      expect(r.text).toBe(String(renderPrototypeForCodegen(odd)));
    }
  });

  it('L1：略超预算 → 只缩短页面结构，其余信息完整，且落在预算内，并显式声明被截断', () => {
    const p = big(60);
    const l0 = trimPrototypeForCodegen(p);
    const budget = l0.tokens - 300; // 略低于 L0
    const r = trimPrototypeForCodegen(p, budget);
    expect(r.level).toBe(1);
    expect(r.trimmed).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(budget);
    expect(r.text).toContain('按 token 预算截断');
    expect(r.text).toContain('--primary:#2563eb'); // 设计令牌保留
    expect(r.text).toContain('act0'); // 交互函数名保留
    expect(r.text).toContain('"id": "p0"'); // 页面清单保留
    expect(r.text).toContain('<section id="p0"'); // 页面结构仍有开头部分
    expect(r.text.length).toBeLessThan(l0.text.length);
  });

  it('L2：预算只够元信息 → 去掉页面结构，显式声明整体省略，且落在预算内', () => {
    const p = big(60);
    // 用二分找到恰好进入 L2 的预算
    let lo = 1;
    let hi = trimPrototypeForCodegen(p).tokens;
    let level2: ReturnType<typeof trimPrototypeForCodegen> | undefined;
    for (let b = hi; b >= lo; b -= 20) {
      const r = trimPrototypeForCodegen(p, b);
      if (r.level === 2) { level2 = r; break; }
    }
    expect(level2).toBeDefined();
    expect(level2!.text).toContain('整体省略');
    expect(level2!.text).not.toContain('<section');
    expect(level2!.text).toContain('--primary:#2563eb');
    expect(level2!.tokens).toBeLessThanOrEqual(level2!.budget!);
  });

  it('L3：预算极小 → 只留应用名 / 风格 / 页面清单，并明说细节已省略；仍放不下则标记 overBudget 而不是继续瞎截', () => {
    const p = big(60, 3);
    const r = trimPrototypeForCodegen(p, 120);
    expect(r.level).toBe(3);
    expect(r.text).toContain('已按 token 预算省略');
    expect(r.text).toContain('依据设计文档与页面清单生成');
    expect(r.text).not.toContain('designTokens');
    expect(r.text).not.toContain('<section');
    const tiny = trimPrototypeForCodegen(big(60, 80), 20); // 页面清单本身就很大
    expect(tiny.level).toBe(3);
    expect(tiny.overBudget).toBe(true);
  });

  it('单调：预算越小降级越多，信息只减不增，等级只升不降', () => {
    const p = big(60);
    const start = trimPrototypeForCodegen(p).tokens;
    let prevLevel = 0;
    let prevLen = Infinity;
    for (let b = start + 100; b >= 50; b -= 40) {
      const r = trimPrototypeForCodegen(p, b);
      expect(r.level).toBeGreaterThanOrEqual(prevLevel);
      expect(r.text.length).toBeLessThanOrEqual(prevLen);
      prevLevel = r.level;
      prevLen = r.text.length;
    }
    expect(prevLevel).toBe(3);
  });

  it('每一档降级都显式声明省略（绝不悄悄截断）', () => {
    const p = big(60);
    const start = trimPrototypeForCodegen(p).tokens;
    for (let b = start - 100; b >= 50; b -= 60) {
      const r = trimPrototypeForCodegen(p, b);
      if (r.trimmed) expect(r.text).toMatch(/预算(截断|整体省略|省略)/);
    }
  });
});
