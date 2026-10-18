/**
 * 过期判定：一个阶段的产物是否仍然基于「当前」的上游。全是纯函数。
 *
 * 做法是比对指纹而不是靠「谁改过谁」的推断：阶段成功时记下它依据的每个上游的指纹（consumed），
 * 之后只要拿当前上游的指纹去比，就能知道它是否还有效——不管上游是被修复、被重试还是被别的什么改的。
 * 判定是惰性的：轮到某个阶段执行时才查，所以上游重新生成出完全相同的产物时，下游自然不必重跑。
 */
import { INPUT, stageNode, type StageId } from '@apploom/shared';
import { fingerprint } from './fingerprint';
import type { PipelineDoc } from './pipeline.types';

/**
 * 过期级联开关（STAGE_STALE_CASCADE=1 开启，默认关闭）。
 * 关闭：修复某阶段时，下游已有产物直接清空、等待重跑（原有行为）。
 * 开启：下游产物保留并标记 stale（可对照旧版本），轮到它时用指纹判断是否仍有效，有效则沿用、不重跑。
 */
export const staleCascadeEnabled = (): boolean => process.env.STAGE_STALE_CASCADE === '1';

/** 该阶段**现在**应当依据的上游指纹：首阶段取需求原文，其余取上游当前产出。上游还没有产出的键缺省 */
export function currentUpstreamFingerprints(doc: PipelineDoc, stage: StageId): Record<string, string> {
  const out: Record<string, string> = {};
  for (const edge of stageNode(stage).inputs) {
    if (edge.from === INPUT) {
      out[INPUT] = fingerprint(doc.requirement);
    } else {
      const upstream = doc.stages[edge.from as StageId];
      if (upstream?.result !== undefined) out[edge.from] = fingerprint(upstream.result);
    }
  }
  return out;
}

/**
 * 该阶段已有的产物是否仍然有效，可以直接沿用而不必重跑。必须同时满足：
 *  - 有产物，且记录了指纹与当时依据的上游（老数据没有这些字段 → 无法证明有效 → 当作无效，保守重跑）
 *  - 所有上游当前都是 done（上游自己还过期或没跑完，它的指纹不可信）
 *  - 每个上游当前的指纹都等于当时依据的那个
 */
export function isStageStillValid(doc: PipelineDoc, stage: StageId): boolean {
  const st = doc.stages[stage];
  if (st.result === undefined || !st.fingerprint || !st.consumed) return false;
  const current = currentUpstreamFingerprints(doc, stage);
  return stageNode(stage).inputs.every((edge) => {
    if (edge.from !== INPUT && doc.stages[edge.from as StageId]?.status !== 'done') return false;
    return current[edge.from] !== undefined && current[edge.from] === st.consumed![edge.from];
  });
}

/** 文档里目前哪些阶段的产物已经过期（有产物但不再有效，且不在执行中）。给调试 / 展示用 */
export function findOutdatedStages(doc: PipelineDoc): StageId[] {
  return (Object.keys(doc.stages) as StageId[]).filter((s) => {
    const st = doc.stages[s];
    return st.result !== undefined && (st.status === 'done' || st.status === 'stale') && !isStageStillValid(doc, s);
  });
}
