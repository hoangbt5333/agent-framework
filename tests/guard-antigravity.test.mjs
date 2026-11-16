import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, transition, saveState } from '../core/orchestrator/state.mjs';
import { loadConfig } from '../core/orchestrator/config.mjs';
import { runGate } from '../core/orchestrator/validate.mjs';
import { REPORT_FILE } from '../core/orchestrator/report.mjs';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const BASH = dir('../core/orchestrator/hooks/guard-bash.mjs');
const EDIT = dir('../core/orchestrator/hooks/guard-edit.mjs');
const HANDOFF = dir('../core/orchestrator/hooks/guard-handoff.mjs');
const LOG = dir('../core/orchestrator/hooks/log-event.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const runHook = (script, input, env = {}) => {
  const res = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {}
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
};

test('guard-bash [Antigravity]: chặn lệnh nguy hiểm qua JSON decision deny', () => {
  const input = {
    conversationId: 'conv-123',
    workspacePaths: [process.cwd()],
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'git push origin main' },
    },
  };
  const r = runHook(BASH, input);
  assert.equal(r.status, 0); // Antigravity yêu cầu exit 0
  assert.equal(r.json?.decision, 'deny');
  assert.match(r.json?.reason, /BỊ CHẶN/);
});

test('guard-bash [Antigravity]: cho qua lệnh hợp lệ qua JSON decision allow', () => {
  const input = {
    conversationId: 'conv-123',
    workspacePaths: [process.cwd()],
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'git status' },
    },
  };
  const r = runHook(BASH, input);
  assert.equal(r.status, 0);
  assert.equal(r.json?.decision, 'allow');
});

test('guard-edit & guard-handoff [Antigravity]: tuân thủ worktree và handoff', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'af-agy-')));
  const main = join(base, 'main');
  mkdirSync(join(main, 'src', 'course'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t'); git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'project.config.json'), JSON.stringify({
    framework_version: '0.4.0', project: { name: 't', base_branch: 'main' },
    commands: { build: { cmd: 'node -e "process.exit(0)"', required: true, timeout_s: 20 } },
    git: { worktree_dir: '../wt' },
    ownership: { shared_files: ['package.json'] },
    security: { deny_read: ['.env*'] },
  }));
  writeFileSync(join(main, '.gitignore'), `state/\nlogs/\n${REPORT_FILE}\n`);
  writeFileSync(join(main, 'src', 'course', 'a.ts'), '1');
  git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  git(main, 'branch', 'integration/E1');

  const wtDir = join(base, 'wt', 'TASK-001');
  git(main, 'worktree', 'add', '-q', wtDir, '-b', 'task/TASK-001', 'integration/E1');
  const state = createState({
    execId: 'E1',
    tasks: [{ id: 'TASK-001', title: 'Course API', owned_files: ['src/course/**'], acceptance_criteria: ['ok'] }],
  });
  transition(state, 'TASK-001', 'in_progress');
  saveState(main, state);

  // 1. guard-edit cho phép sửa file thuộc owned_files trong worktree
  const editAllowed = runHook(EDIT, {
    conversationId: 'c1',
    workspacePaths: [main],
    cwd: wtDir,
    toolCall: {
      name: 'write_file',
      args: { Path: join(wtDir, 'src', 'course', 'a.ts'), Content: '2' },
    },
  }, { AGENT_EXEC_ID: 'E1' });
  assert.equal(editAllowed.status, 0);
  assert.equal(editAllowed.json?.decision, 'allow');

  // 2. guard-edit chặn sửa file ngoài owned_files
  const editDenied = runHook(EDIT, {
    conversationId: 'c1',
    workspacePaths: [main],
    cwd: wtDir,
    toolCall: {
      name: 'edit_file',
      args: { Path: join(wtDir, 'src', 'other.ts'), Target: 'a', Replacement: 'b' },
    },
  }, { AGENT_EXEC_ID: 'E1' });
  assert.equal(editDenied.status, 0);
  assert.equal(editDenied.json?.decision, 'deny');
  assert.match(editDenied.json?.reason, /không thuộc owned_files/);

  // 3. guard-handoff yêu cầu tiếp tục nếu chưa có .task-report.json
  const stopBlocked = runHook(HANDOFF, {
    conversationId: 'c1',
    workspacePaths: [main],
    cwd: wtDir,
    terminationReason: 'NO_TOOL_CALL',
  }, { AGENT_EXEC_ID: 'E1' });
  assert.equal(stopBlocked.status, 0);
  assert.equal(stopBlocked.json?.decision, 'continue');
  assert.match(stopBlocked.json?.reason, /Chưa có báo cáo bàn giao/);

  // 4. Coder commit + validate + tạo báo cáo hợp lệ -> guard-handoff cho dừng
  writeFileSync(join(wtDir, 'src', 'course', 'a.ts'), 'x');
  git(wtDir, 'add', '-A'); git(wtDir, 'commit', '-q', '-m', 'feat: course a');
  const head = git(wtDir, 'rev-parse', 'HEAD');
  const config = loadConfig(main);
  await runGate({ config, taskId: 'TASK-001', execId: 'E1', worktree: wtDir, root: main, base: 'integration/E1' });

  const report = {
    task_id: 'TASK-001', agent: 'coder', result: 'READY_FOR_REVIEW', summary: 'done', branch: 'task/TASK-001',
    commits: [head.slice(0, 7)], files_changed: ['src/course/a.ts'], checks: { build: 'pass' },
    evidence: [], open_issues: [], needs_human: false,
  };
  writeFileSync(join(wtDir, REPORT_FILE), JSON.stringify(report));

  const stopAllowed = runHook(HANDOFF, {
    conversationId: 'c1',
    workspacePaths: [main],
    cwd: wtDir,
    terminationReason: 'NO_TOOL_CALL',
  }, { AGENT_EXEC_ID: 'E1' });
  assert.equal(stopAllowed.status, 0);
  assert.deepEqual(stopAllowed.json, {}); // Cho dừng
});

test('log-event [Antigravity]: ghi log đúng định dạng và che secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-log-agy-'));
  const input = {
    conversationId: 'c1',
    workspacePaths: [root],
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'npm test --token=SECRET_KEY_12345' },
    },
    stepIdx: 5,
  };
  const r = runHook(LOG, input, { AGENT_EXEC_ID: 'E1' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});

  const logPath = join(root, 'logs', 'E1', 'hooks.jsonl');
  const content = readFileSync(logPath, 'utf8');
  assert.match(content, /run_command/);
  assert.doesNotMatch(content, /SECRET_KEY_12345/);
});
