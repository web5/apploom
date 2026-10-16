/**
 * 原型预览的沙箱设置。原型 HTML 由 LLM 生成，必须当作不可信内容：
 * 不给 allow-same-origin —— 否则 srcDoc 里的脚本与 Studio 同源，能读 Studio 的存储、带凭证调用 /api，沙箱形同虚设。
 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-modals';

/**
 * 没有 allow-same-origin 时，访问 localStorage / sessionStorage 会抛 SecurityError，
 * 用到存储的原型（如待办清单）会整段脚本中断。注入内存版存储垫片，让它们照常运行（刷新后不保留，预览本就不需要持久化）。
 */
const STORAGE_SHIM =
  '<script>(function(){function mem(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},' +
  'setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},' +
  'get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("x")}catch(e){' +
  'try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}})})();</script>';

/** 在 <head>（没有则 <html>，再没有则文档开头）之后注入垫片，不破坏 DOCTYPE 与标准模式 */
export function buildPreviewHtml(html: string): string {
  for (const tag of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i]) {
    if (tag.test(html)) return html.replace(tag, (m) => m + STORAGE_SHIM);
  }
  return STORAGE_SHIM + html;
}
