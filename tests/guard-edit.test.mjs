import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, transition, saveState } from '../core/orchestrator/state.mjs';
import { matchesPattern, matchesAny } from '../core/orchestrator/ownership.mjs';

const HOOK = fileURLToPath(new URL('../core/orchestrator/hooks/guard-edit.mjs', import.meta.url));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function setup({ withState = true, withConfig = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'af-edit-')));
  const main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t'); git(main, 'config', 'user.name', 't');
  if (withConfig) {
    writeFileSync(join(main, 'project.config.json'), JSON.stringify({
      framework_version: '0.2.0', project: { name: 't', base_branch: 'main' }, commands: {},
      git: { worktree_dir: '../wt' },
      ownership: { shared_files: ['src/app/app.routes.ts', 'package.json'] },
      security: { deny_read: ['.env*', '**/*.pem'] },
    }));
  }
  writeFileSync(join(main, '.gitignore'), 'state/\nlogs/\n');
  writeFileSync(join(main, 'src', 'a.ts'), '1');
  git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  const wt = (id) => join(base, 'wt', id);
  for (const id of ['TASK-001', 'TASK-002', 'TASK-003']) git(main, 'worktree', 'add', '-q', wt(id), '-b', `task/${id}`);

  if (withState) {
    const state = createState({ execId: 'E1', tasks: [
      { id: 'TASK-001', owned_files: ['src/course/**', 'src/app/app.routes.ts'] },
      { id: 'TASK-002', owned_files: ['src/user/**'] },          // vẫn pending
      { id: 'TASK-003', owned_files: ['src/**'] },               // glob rộng
    ] });
    transition(state, 'TASK-001', 'in_progress');
    transition(state, 'TASK-003', 'in_progress');
    saveState(main, state);
  }
  return { base, main, wt };
}

const run = (cwd, tool, tool_input, env = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input, cwd }),
  encoding: 'utf8',
  env: { ...process.env, AGENT_TASK_ID: '', AGENT_EXEC_ID: '', ...env },
});
const S = setup();

test('glob matcher: **, *, ?, {a,b}, đường dẫn thuần', () => {
  assert.equal(matchesPattern('src/course/a/b.ts', 'src/course/**'), true);
  assert.equal(matchesPattern('src/courses/a.ts', 'src/course/**'), false);
  assert.equal(matchesPattern('src/x.ts', 'src/**/x.ts'), true);          // ** khớp 0 cấp
  assert.equal(matchesPattern('src/a/b/x.ts', 'src/**/x.ts'), true);
  assert.equal(matchesPattern('src/a/b.ts', 'src/*.ts'), false);          // * không qua dấu /
  assert.equal(matchesPattern('src/b.ts', 'src/*.ts'), true);
  assert.equal(matchesPattern('a.pem', '**/*.pem'), true);
  assert.equal(matchesPattern('x/y/a.pem', '**/*.pem'), true);
  assert.equal(matchesPattern('.env.local', '.env*'), true);
  assert.equal(matchesPattern('src/a.spec.ts', 'src/*.{spec,test}.ts'), true);
  assert.equal(matchesPattern('src/user/u.ts', 'src/user'), true);        // thư mục thuần
  assert.equal(matchesPattern('src/users/u.ts', 'src/user'), false);
  assert.equal(matchesAny('a.txt', []), false);
});

test('Coder sửa file thuộc owned_files: cho qua (tuyệt đối và tương đối)', () => {
  assert.equal(run(S.wt('TASK-001'), 'Write', { file_path: join(S.wt('TASK-001'), 'src/course/a.ts') }).status, 0);
  assert.equal(run(S.wt('TASK-001'), 'Edit', { file_path: 'src/course/sub/b.ts' }).status, 0);
  assert.equal(run(S.wt('TASK-001'), 'MultiEdit', { file_path: 'src/course/c.ts' }).status, 0);
  assert.equal(run(S.wt('TASK-001'), 'NotebookEdit', { notebook_path: 'src/course/n.ipynb' }).status, 0);
});

test('Coder sửa file ngoài owned_files: chặn, nêu rõ lý do', () => {
  const r = run(S.wt('TASK-001'), 'Write', { file_path: 'src/user/x.ts' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /không thuộc owned_files của TASK-001/);
  assert.equal(run(S.wt('TASK-001'), 'Write', { file_path: 'src/course/../user/x.ts' }).status, 2); // .. bị resolve
});

test('file dùng chung phải được liệt kê tường minh', () => {
  assert.equal(run(S.wt('TASK-001'), 'Edit', { file_path: 'src/app/app.routes.ts' }).status, 0);   // liệt kê tường minh
  const r = run(S.wt('TASK-003'), 'Edit', { file_path: 'src/app/app.routes.ts' });                 // chỉ có src/**
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dùng chung/);
  assert.equal(run(S.wt('TASK-003'), 'Edit', { file_path: 'src/foo.ts' }).status, 0);              // glob rộng đủ cho file thường
});

test('không được sửa ngoài worktree của chính Task', () => {
  assert.equal(run(S.wt('TASK-001'), 'Write', { file_path: join(S.wt('TASK-002'), 'src/user/x.ts') }).status, 2);
  assert.equal(run(S.wt('TASK-001'), 'Write', { file_path: '../TASK-002/src/user/x.ts' }).status, 2);
  assert.equal(run(S.wt('TASK-001'), 'Write', { file_path: join(S.main, 'src/course/a.ts') }).status, 2);   // checkout chính
  assert.equal(run(S.wt('TASK-001'), 'Write', { file_path: join(S.base, 'other.txt') }).status, 2);
});

test('không chạy trốn bằng symlink', (t) => {
  const outside = join(S.base, 'outside'); mkdirSync(outside);
  mkdirSync(join(S.wt('TASK-001'), 'src/course'), { recursive: true });
  try { symlinkSync(outside, join(S.wt('TASK-001'), 'src/course/link')); } catch { t.skip('không tạo được symlink'); return; }
  const r = run(S.wt('TASK-001'), 'Write', { file_path: 'src/course/link/evil.txt' });
  assert.equal(r.status, 2);
  assert.equal(existsSync(join(outside, 'evil.txt')), false);
});

test('file của khung và file nhạy cảm không bao giờ sửa được', () => {
  for (const p of ['.claude/settings.json', '.claude/hooks/x.mjs', 'orchestrator/cli.mjs', 'project.config.json', 'state/E1.json', 'logs/x', '.git/config']) {
    assert.equal(run(S.wt('TASK-003'), 'Write', { file_path: p }).status, 2, p);   // TASK-003 có glob src/** nhưng vẫn không đụng khung
  }
  for (const p of ['.env', '.env.local', 'src/key.pem', 'a/b/c.pem']) {
    assert.equal(run(S.wt('TASK-003'), 'Write', { file_path: p }).status, 2, p);
  }
});

test('Task không ở in_progress thì không được sửa gì', () => {
  const r = run(S.wt('TASK-002'), 'Write', { file_path: 'src/user/x.ts' });        // TASK-002 còn pending
  assert.equal(r.status, 2);
  assert.match(r.stderr, /in_progress/);
});

test('checkout chính: chỉ bảo vệ state/ và logs/', () => {
  assert.equal(run(S.main, 'Write', { file_path: 'src/new.ts' }).status, 0);
  assert.equal(run(S.main, 'Write', { file_path: '.claude/agents/x.md' }).status, 0);      // phiên phát triển bình thường
  assert.equal(run(S.main, 'Write', { file_path: join(S.wt('TASK-001'), 'src/x.ts') }).status, 0); // Orchestrator xử lý conflict trong worktree
  assert.equal(run(S.main, 'Write', { file_path: 'state/E1.json' }).status, 2);
  assert.equal(run(S.main, 'Edit', { file_path: 'logs/E1/hooks.jsonl' }).status, 2);
});

test('AGENT_TASK_ID chọn actor khi chạy riêng từng Task', () => {
  const r = run(S.main, 'Write', { file_path: join(S.wt('TASK-001'), 'src/user/x.ts') }, { AGENT_TASK_ID: 'TASK-001' });
  assert.equal(r.status, 2);   // actor TASK-001, file không thuộc owned_files
});

test('công cụ khác (Read, Bash) đi qua; đầu vào hỏng bị chặn (fail-closed)', () => {
  assert.equal(run(S.wt('TASK-001'), 'Read', { file_path: 'src/user/x.ts' }).status, 0);
  assert.equal(run(S.wt('TASK-001'), 'Bash', { command: 'ls' }).status, 0);
  for (const bad of ['', 'không phải json', '{}']) {
    const r = spawnSync(process.execPath, [HOOK], { input: bad, encoding: 'utf8' });
    assert.equal(r.status, 2, JSON.stringify(bad));
  }
  assert.equal(run(S.wt('TASK-001'), 'Write', {}).status, 2);                  // thiếu file_path
  assert.equal(run(join(S.base, 'khong-ton-tai'), 'Write', { file_path: 'a' }).status, 2); // cwd không phải repo
});

test('mỗi lần chặn được ghi vào audit log', () => {
  run(S.wt('TASK-001'), 'Write', { file_path: 'src/user/audit.ts' }, { AGENT_EXEC_ID: 'E1' });
  const lines = readFileSync(join(S.main, 'logs', 'E1', 'hooks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const denied = lines.filter((e) => e.event === 'guard_denied' && e.hook === 'guard-edit');
  assert.ok(denied.length >= 1);
  assert.equal(denied.at(-1).task_id, 'TASK-001');
  assert.match(denied.at(-1).target, /audit\.ts/);
});

test('state mất hoặc config mất: chặn (fail-closed), có thông báo rõ', () => {
  const noState = setup({ withState: false });
  const r1 = run(noState.wt('TASK-001'), 'Write', { file_path: 'src/a.ts' });
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /in_progress/);

  const noConfig = setup({ withConfig: false });
  const r2 = run(noConfig.wt('TASK-001'), 'Write', { file_path: 'src/a.ts' });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /project\.config\.json/);
});
