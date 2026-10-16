import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { saveArtifact } from './artifact';

describe('saveArtifact', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apploom-art-'));
  beforeEach(() => (process.env.APPLOOM_ARTIFACT_DIR = root));
  afterAll(() => delete process.env.APPLOOM_ARTIFACT_DIR);

  it('写入 {root}/{docId}/{name} 并返回路径', async () => {
    const file = await saveArtifact('doc-1', 'prototype.html', '<html>中文</html>');
    expect(file).toBe(path.join(root, 'doc-1', 'prototype.html'));
    expect(readFileSync(file, 'utf-8')).toBe('<html>中文</html>');
  });

  it.each([
    ['../evil', 'a.html'],
    ['doc', '../a.html'],
    ['doc', 'a/b.html'],
    ['doc', '.hidden'],
    ['', 'a.html'],
  ])('拒绝路径穿越: %s / %s', async (docId, name) => {
    await expect(saveArtifact(docId, name, 'x')).rejects.toThrow('非法的产物路径');
    expect(existsSync(path.join(root, 'evil'))).toBe(false);
  });
});
