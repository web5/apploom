import { digestPrototype, prototypeForCodegen, prototypeForDesign, renderPrototypeForCodegen } from './prototype-digest';

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
