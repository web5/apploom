/**
 * 模型输出 → 结构化文档：抽取 JSON、本地修复、Zod 校验、失败归类。全是纯函数，不碰网络。
 */
import type { ErrorClass } from '@apploom/llm';
import type { ZodType } from 'zod';

/** 从模型输出里抽取 JSON（兼容 markdown 代码块 / 前后多余文字） */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** 检测 JSON 是否被截断（拿不到 finish_reason 时的兜底猜测） */
export function detectTruncation(raw: string, parsedError: string): string | null {
  // JSON.parse 报 "Unterminated string" 或 "Unexpected end of JSON input" 通常是截断
  if (/Unterminated string|Unexpected end of JSON|Unexpected token/.test(parsedError)) {
    const tail = raw.slice(-200);
    return `LLM 输出疑似被 max_tokens 截断（raw 长度 ${raw.length} 字符）。错误：${parsedError}。尾部 200 字符：${JSON.stringify(tail)}`;
  }
  return null;
}

export interface ParseFailure {
  raw: string;
  error: string;
  errorClass?: ErrorClass;
}

/** 模型输出解析失败 → 失败结果：finish_reason=length 是确凿的截断（truncated），其余沿用报错特征猜测（invalid_output） */
export function parseFailure(raw: string, finishReason: string | undefined, msg: string): ParseFailure {
  if (finishReason === 'length') {
    return {
      raw,
      error: `LLM 输出被 max_tokens 截断（finish_reason=length，已输出 ${raw.length} 字符${raw.trim() ? '' : '，正文为空，推理可能耗尽了额度'}）。解析错误：${msg}`,
      errorClass: 'truncated',
    };
  }
  // 服务端明确报了非 length 的结束原因（如 stop）= 没被截断，别按报错特征乱猜；拿不到 finish_reason 时才沿用猜测
  return { raw, error: (finishReason ? null : detectTruncation(raw, msg)) ?? msg };
}

/**
 * 修复 LLM 输出里常见的「非法反斜杠转义」导致的 JSON 解析失败。
 * 根因：模型在 HTML 字符串里写出了 `\!` `\.` `\(` 等非法转义（JSON 合法转义只有
 * `\" \\ \/ \b \f \n \r \t \uXXXX`）。把「反斜杠 + 非合法转义字符」修正为「双反斜杠 + 原字符」，
 * 既保留合法转义，又修复非法转义。修复的是模型自己生成的内容，修复后仍是 LLM 产出。
 * 注意：用负向后顾 (?<!\\) 避免把合法 `\\` 转义的第二根反斜杠也误修。
 * 原本就能解析 JSON（只是不符合 schema）时返回 null——那不是转义问题。
 */
export function tryRepairJson(raw: string): string | null {
  const json = extractJson(raw);
  try {
    JSON.parse(json);
    return null;
  } catch {
    /* 解析失败才有修复的必要 */
  }
  // 关键正则：匹配「前面不是反斜杠、且后面跟一个非法转义字符」的反斜杠，把该 \ 转义为 \\
  const fixed = json.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, '\\\\');
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}

export type Parsed<T> = { ok: true; doc: T; raw: string; repaired: boolean } | { ok: false; error: string };

/**
 * 解析并按 schema 校验。先直接解析；JSON 本身解析失败时再尝试本地修复非法转义。
 * 失败时返回的是「第一次」失败的原因（本地修复也失败时不被修复尝试的报错覆盖）；
 * raw 在修复成功时是修复后的 JSON 文本。
 */
export function parseOutput<T>(raw: string, schema: ZodType<T>): Parsed<T> {
  let firstError: string;
  try {
    return { ok: true, doc: schema.parse(JSON.parse(extractJson(raw))), raw, repaired: false };
  } catch (e) {
    firstError = (e as Error).message;
  }
  const fixed = tryRepairJson(raw);
  if (fixed) {
    try {
      return { ok: true, doc: schema.parse(JSON.parse(fixed)), raw: fixed, repaired: true };
    } catch {
      /* 修复后仍不合 schema：按首次失败原因报 */
    }
  }
  return { ok: false, error: firstError };
}
