import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../src/storage.js';

test('JSON 存储原子写入并过滤 token 与正文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-org-')); const path = join(dir, 'data.json');
  const store = createJsonStore(path);
  await store.save({ scannedAt: 'now', token: 'ghp_secret', items: [{ fullName: 'a/b', body: 'README text' }] });
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('ghp_secret'), false); assert.equal(raw.includes('README text'), false);
  assert.equal((await store.load()).items[0].fullName, 'a/b');
  await rm(dir, { recursive: true, force: true });
});

test('JSON 存储过滤 Issue/PR 正文并支持可恢复备份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-org-')); const path = join(dir, 'data.json'); const backup = join(dir, 'backup.json');
  const store = createJsonStore(path);
  await store.save({ audit: [{ issueBody: 'private issue', pull_request_content: 'private pr', project: 'a/b' }], metadata: { clientSecret: 'top-secret' } });
  await store.backup(backup);
  const raw = await readFile(backup, 'utf8');
  assert.equal(raw.includes('private issue'), false); assert.equal(raw.includes('private pr'), false); assert.equal(raw.includes('top-secret'), false);
  assert.equal(JSON.parse(raw).audit[0].project, 'a/b');
  await rm(dir, { recursive: true, force: true });
});
