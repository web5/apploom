/**
 * 阶段产物落文件：体积大的产物（如原型完整 HTML）除存在 doc 中供前端预览外，
 * 另存为独立文件，便于审计、对比与后续让模型按需读取（tool-use）。
 *
 * 目录：APPLOOM_ARTIFACT_DIR（默认 /tmp/apploom-artifacts）/{docId}/{name}
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export function artifactRoot(): string {
  return process.env.APPLOOM_ARTIFACT_DIR || '/tmp/apploom-artifacts';
}

/** 写入产物文件并返回绝对路径；docId / name 只允许安全字符，防止路径穿越 */
export async function saveArtifact(docId: string, name: string, content: string): Promise<string> {
  if (!/^[\w-]+$/.test(docId) || !/^[\w.-]+$/.test(name) || name.startsWith('.')) {
    throw new Error(`非法的产物路径: ${docId}/${name}`);
  }
  const dir = path.join(artifactRoot(), docId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, content, 'utf-8');
  return file;
}
