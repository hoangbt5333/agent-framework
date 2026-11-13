import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGate } from '../core/orchestrator/validate.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const node = (code) => `node -e "${code}"`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'af-repo-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), '1');
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'init');
  sh(dir, 'checkout', '-q', '-b', 'task/T1');
  writeFileSync(join(dir, 'b.txt'), '2');
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'work');
  return dir;
}
const cfg = (commands) => ({ commands });
const ok = { cmd: node('process.exit(0)'), required: true, timeout_s: 20 };

test('tất cả xanh -> READY_FOR_REVIEW, evidence gắn commit', async () => {
  const dir = repo(); const root = mkdtempSync(join(tmpdir(), 'af-root-'));
  const r = await runGate({ config: cfg({ build: ok, lint: ok, unit_test: ok }), taskId: 'T1', execId: 'E1', worktree: dir, root, base: 'main' });
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.equal(r.commit, sh(dir, 'rev-parse', 'HEAD'));
  assert.ok(existsSync(join(root, 'logs', 'E1', 'T1', r.commit.slice(0, 7), 'result.json')));
});

test('lint lỗi -> FAIL do code, ghi stderr', async () => {
  const dir = repo(); const root = mkdtempSync(join(tmpdir(), 'af-root-'));
  const bad = { cmd: node('console.error(\\"loi lint\\"); process.exit(1)'), required: true, timeout_s: 20 };
  const r = await runGate({ config: cfg({ build: ok, lint: bad }), taskId: 'T1', execId: 'E1', worktree: dir, root });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.failure_kind, 'code');
  assert.equal(r.checks.find((c) => c.name === 'lint').exit_code, 1);
});

test('file chưa commit -> FAIL', async () => {
  const dir = repo(); const root = mkdtempSync(join(tmpdir(), 'af-root-'));
  writeFileSync(join(dir, 'dirty.txt'), 'x');
  const r = await runGate({ config: cfg({ build: ok }), taskId: 'T1', execId: 'E1', worktree: dir, root });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.checks.find((c) => c.name === 'git_clean').passed, false);
});

test('không có commit mới so với base -> FAIL', async () => {
  const dir = repo(); const root = mkdtempSync(join(tmpdir(), 'af-root-'));
  const r = await runGate({ config: cfg({ build: ok }), taskId: 'T1', execId: 'E1', worktree: dir, root, base: 'task/T1' });
  assert.equal(r.status, 'FAIL');
});

test('timeout -> FAIL loại environment, không treo', async () => {
  const dir = repo(); const root = mkdtempSync(join(tmpdir(), 'af-root-'));
  const slow = { cmd: node('setTimeout(()=>{}, 30000)'), required: true, timeout_s: 1 };
  const t0 = Date.now();
  const r = await runGate({ config: cfg({ unit_test: slow }), taskId: 'T1', execId: 'E1', worktree: dir, root });
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.failure_kind, 'environment');
});

test('lệnh không tồn tại -> environment; kiểm tra không bắt buộc không chặn', async () => {
  const dir = repo(); const root = mkdtempSync(join(tmpdir(), 'af-root-'));
  const r1 = await runGate({ config: cfg({ build: { cmd: 'khong-co-lenh-nay-xyz', required: true, timeout_s: 10 } }), taskId: 'T1', execId: 'E1', worktree: dir, root });
  assert.equal(r1.failure_kind, 'environment');
  const soft = { cmd: node('process.exit(1)'), required: false, timeout_s: 10 };
  const r2 = await runGate({ config: cfg({ build: ok, lint: soft }), taskId: 'T1', execId: 'E1', worktree: dir, root });
  assert.equal(r2.status, 'READY_FOR_REVIEW');
});

test('cổng rỗng bị từ chối', async () => {
  const dir = repo();
  await assert.rejects(runGate({ config: cfg({ e2e: { cmd: 'x' } }), taskId: 'T1', execId: 'E1', worktree: dir, root: dir }), /cổng rỗng/);
});
