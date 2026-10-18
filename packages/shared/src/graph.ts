/**
 * 流水线拓扑的单一事实源：有哪些阶段、顺序、每个阶段消费哪些上游。
 *
 * 阶段 id 的联合类型、顺序数组、展示名、上游依赖、级联范围全部从 STAGE_GRAPH 推导，
 * 加一个阶段只需要在这里加一项（再补它的 Zod schema、system prompt、前端视图）。
 *
 * 刻意不含 Zod schema：前端会引用本文件（取阶段顺序和展示名），不能因此把 zod 和 prompt 打进浏览器包。
 * 出参契约见 contracts.ts 的 STAGE_SCHEMAS。
 */

/** 外部入口：用户的一句话需求。只允许首个阶段使用 */
export const INPUT = '@input' as const;

/** 上游产物进入下游 prompt 的方式（现状：full 原样注入；trim 由对应的裁剪函数处理，见 note） */
export type InputStrategy = 'full' | 'fields' | 'trim';

export interface StageInput {
  from: string;
  strategy: InputStrategy;
  /** strategy 为 fields / trim 时保留哪些部分 */
  select?: readonly string[];
  /** 这条边允许占用的 token 预算（预留给按预算裁剪，现在尚未启用） */
  maxTokens?: number;
  note?: string;
}

export interface StageNode {
  id: string;
  /** 展示名 */
  label: string;
  agent: string;
  /** 越靠下游越要确定性 */
  temperature: number;
  /** 本阶段消费的上游。数组顺序即注入 prompt 的顺序 */
  inputs: readonly StageInput[];
  /** 逐步确认模式下，本阶段完成后是否要等人确认再继续（最后一个阶段后无需确认） */
  needsConfirmation: boolean;
}

export const STAGE_GRAPH = [
  {
    id: 'requirement',
    label: '需求拆解',
    agent: 'requirement-analyst',
    temperature: 0.7,
    inputs: [{ from: INPUT, strategy: 'full' }],
    needsConfirmation: true,
  },
  {
    id: 'prototype',
    label: '产品原型',
    agent: 'prototype-designer',
    temperature: 0.6,
    inputs: [{ from: 'requirement', strategy: 'full' }],
    needsConfirmation: true,
  },
  {
    id: 'design',
    label: '方案设计',
    agent: 'architect',
    temperature: 0.5,
    inputs: [
      { from: 'requirement', strategy: 'full' },
      { from: 'prototype', strategy: 'trim', note: '去掉 html 正文，只留页面清单与交互（prototypeForDesign）' },
    ],
    needsConfirmation: true,
  },
  {
    id: 'codegen',
    label: '代码生成',
    agent: 'codegen',
    temperature: 0.3,
    inputs: [
      { from: 'design', strategy: 'full' },
      { from: 'prototype', strategy: 'trim', maxTokens: 6000, note: '跨级边：原型是视觉契约；精简为设计令牌 + 结构 markup + 函数名，超出预算时按 L1–L3 逐级降级（trimPrototypeForCodegen）' },
    ],
    needsConfirmation: true,
  },
  {
    id: 'deploy',
    label: '部署发布',
    agent: 'deployer',
    temperature: 0.3,
    inputs: [{ from: 'codegen', strategy: 'full' }],
    needsConfirmation: false,
  },
] as const satisfies readonly StageNode[];

export type StageId = (typeof STAGE_GRAPH)[number]['id'];

// ───────────────────────── 静态校验 ─────────────────────────

/** 返回问题列表（空 = 图合法）。接受任意 StageNode[]，便于测试各种坏图 */
export function validateStageGraph(graph: readonly StageNode[]): string[] {
  const errors: string[] = [];
  const ids = graph.map((n) => n.id);
  const indexOf = new Map<string, number>();
  ids.forEach((id, i) => {
    if (indexOf.has(id)) errors.push(`阶段 id 重复: ${id}`);
    else indexOf.set(id, i);
  });
  if (graph.length === 0) return ['阶段图为空'];

  graph.forEach((node, i) => {
    if (!node.label.trim()) errors.push(`${node.id}: label 为空`);
    if (node.temperature < 0 || node.temperature > 2) errors.push(`${node.id}: temperature 超出 [0, 2]`);
    if (node.inputs.length === 0) errors.push(`${node.id}: 没有任何入边（孤立节点）`);
    const seen = new Set<string>();
    for (const input of node.inputs) {
      if (seen.has(input.from)) errors.push(`${node.id}: 重复消费同一上游 ${input.from}`);
      seen.add(input.from);
      if (input.maxTokens !== undefined && !(input.maxTokens > 0)) errors.push(`${node.id}: ${input.from} 边的 maxTokens 必须为正`);
      if (input.from === INPUT) {
        if (i !== 0) errors.push(`${node.id}: ${INPUT} 只能出现在首个阶段（单外部入口）`);
        continue;
      }
      const j = indexOf.get(input.from);
      if (j === undefined) errors.push(`${node.id}: 上游 ${input.from} 不存在`);
      else if (j >= i) errors.push(`${node.id}: 上游 ${input.from} 不在它之前（${j >= i && j === i ? '自环' : '前向引用'}）`);
    }
  });

  if (!graph[0].inputs.some((x) => x.from === INPUT)) errors.push(`首个阶段 ${graph[0].id} 必须消费 ${INPUT}`);

  // 环检测（Kahn）：上面已拒绝前向引用，这里独立再验一次，防止校验规则日后被放宽
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const n of graph) for (const x of n.inputs) if (indexOf.has(x.from)) indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    visited++;
    for (const n of graph) {
      if (n.inputs.some((x) => x.from === cur)) {
        indeg.set(n.id, (indeg.get(n.id) ?? 0) - 1);
        if (indeg.get(n.id) === 0) queue.push(n.id);
      }
    }
  }
  if (visited < ids.length) errors.push('阶段图存在环');
  return errors;
}

export function assertValidStageGraph(graph: readonly StageNode[]): void {
  const errors = validateStageGraph(graph);
  if (errors.length) throw new Error(`STAGE_GRAPH 不合法:\n- ${errors.join('\n- ')}`);
}

// 导入即校验：非法的图根本无法被任何模块使用（对应「启动时校验，失败拒绝启动」）
assertValidStageGraph(STAGE_GRAPH);

// ───────────────────────── 推导出的视图 ─────────────────────────

const NODES: readonly StageNode[] = STAGE_GRAPH;

/** 阶段顺序 */
export const STAGE_IDS: readonly StageId[] = STAGE_GRAPH.map((n) => n.id);

export const STAGE_LABEL = Object.fromEntries(STAGE_GRAPH.map((n) => [n.id, n.label])) as Record<StageId, string>;

export function stageNode(id: StageId): StageNode {
  return NODES.find((n) => n.id === id)!;
}

/** 某条入边的 token 预算；没有声明预算的边返回 undefined（不限） */
export function edgeBudget(stage: StageId, from: string): number | undefined {
  return stageNode(stage).inputs.find((x) => x.from === from)?.maxTokens;
}

/** 某阶段直接消费的上游阶段（不含 @input），按注入顺序 */
export function upstreamOf(id: StageId): StageId[] {
  return stageNode(id)
    .inputs.map((x) => x.from)
    .filter((f): f is StageId => f !== INPUT);
}

/** 主链上的下一个阶段；最后一个返回 null */
export function nextStageOf(id: StageId): StageId | null {
  const i = STAGE_IDS.indexOf(id);
  return i >= 0 && i < STAGE_IDS.length - 1 ? STAGE_IDS[i + 1] : null;
}

/** 某阶段变化后，所有（直接或间接）依赖它的阶段，按阶段顺序 */
export function downstreamOf(id: StageId): StageId[] {
  const affected = new Set<StageId>([id]);
  for (const node of NODES) {
    if (node.inputs.some((x) => affected.has(x.from as StageId))) affected.add(node.id as StageId);
  }
  affected.delete(id);
  return STAGE_IDS.filter((s) => affected.has(s));
}
