import { fingerprint, stableStringify } from './fingerprint';

describe('stableStringify', () => {
  it('对象 key 顺序不影响结果（含嵌套）', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(stableStringify({ a: { c: 'x', d: [1, 2] }, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('数组顺序有意义', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('与 JSON 一致地处理 undefined：对象里的 undefined 字段 = 不存在；数组里的 undefined = null', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify([1, undefined, 3])).toBe(stableStringify([1, null, 3]));
    expect(stableStringify({ a: undefined })).toBe('{}');
  });

  it('数字归一：-0 → 0；NaN / Infinity 与 JSON 一样变成 null', () => {
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify({ n: -0 })).toBe(stableStringify({ n: 0 }));
    expect(stableStringify([NaN, Infinity, -Infinity])).toBe('[null,null,null]');
    expect(stableStringify(1.5)).toBe('1.5');
  });

  it('字符串里的特殊字符被正确转义，不会与结构字符混淆', () => {
    expect(stableStringify({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
    expect(stableStringify(['a,b'])).not.toBe(stableStringify(['a', 'b']));
    expect(stableStringify({ a: '{"b":1}' })).not.toBe(stableStringify({ a: { b: 1 } }));
  });

  it('类型不同不混淆：数字 1 / 字符串 "1" / 布尔 true / null', () => {
    const outs = [1, '1', true, null, [], {}].map((v) => stableStringify(v));
    expect(new Set(outs).size).toBe(outs.length);
  });

  it('环引用直接抛错；同一对象在兄弟位置重复出现（非环）是允许的', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => stableStringify(a)).toThrow(/环引用/);
    const shared = { k: 1 };
    expect(() => stableStringify({ p: shared, q: shared, r: [shared, shared] })).not.toThrow();
  });
});

describe('fingerprint', () => {
  it('16 位十六进制，语义相同则相同、有任何变化则不同', () => {
    const doc = { files: [{ path: 'a.ts', content: 'x' }], runCommand: 'npm run dev', deps: ['react@^18'] };
    const fp = fingerprint(doc);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ deps: ['react@^18'], runCommand: 'npm run dev', files: [{ content: 'x', path: 'a.ts' }] })).toBe(fp);
    expect(fingerprint({ ...doc, runCommand: 'npm start' })).not.toBe(fp);
    expect(fingerprint({ ...doc, files: [{ path: 'a.ts', content: 'y' }] })).not.toBe(fp);
  });

  it('对真实形状的产物稳定：重复计算 1000 次结果一致', () => {
    const doc = { overview: '计数器', features: Array.from({ length: 20 }, (_, i) => ({ id: `F${i}`, name: `功能${i}`, priority: 'P0', desc: '😀 emoji / 中文 / "引号"' })) };
    const first = fingerprint(doc);
    for (let i = 0; i < 1000; i++) expect(fingerprint(structuredClone(doc))).toBe(first);
  });

  it('普通字符串（如用户需求原文）也能算指纹，改一个字就不同', () => {
    expect(fingerprint('做一个计数器')).toBe(fingerprint('做一个计数器'));
    expect(fingerprint('做一个计数器')).not.toBe(fingerprint('做一个计数器。'));
  });
});
