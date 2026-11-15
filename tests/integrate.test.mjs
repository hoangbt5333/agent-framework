import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, transition, saveState, loadState } from '../core/orchestrator/state.mjs';
import { runGate } from '../core/orchestrator/validate.mjs';
import { integrateTask, IntegrateError } from '../core/orchestrator/integrate.mjs';
import { REPORT_FILE } from '../core/orchestrator/report.mjs';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const CLI = dir('../core/orchestrator/cli.mjs');
const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' })
    .replace(/\r/g, '')
    .trim();

function setupRepo({ buildFails = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'af-integ-')));
  const main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'test@test.local');
  git(main, 'config', 'user.name', 'Tester');

  const buildCmd = buildFails
    ? 'node -e "console.error(\'build failed intentionally\'); process.exit(1)"'
    : 'node -e "process.exit(0)"';

  writeFileSync(
    join(main, 'project.config.json'),
    JSON.stringify({
      framework_version: '0.4.0',
      project: { name: 'test-app', base_branch: 'main' },
      commands: {
        build: { cmd: buildCmd, required: true, timeout_s: 30 },
      },
      git: {
        task_branch_prefix: 'task/',
        integration_branch_prefix: 'integration/',
        worktree_dir: '../wt',
        merge_strategy: 'squash',
      },
      limits: { max_parallel: 3, max_attempts: 3 },
      ownership: { shared_files: ['package.json'] },
      security: { deny_read: ['.env*'] },
    })
  );

  writeFileSync(join(main, '.gitignore'), `state/\nlogs/\n${REPORT_FILE}\n`);
  writeFileSync(join(main, 'src', 'app.ts'), 'export const app = 1;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'initial commit');

  // Nhánh tích hợp
  git(main, 'branch', 'integration/EXEC-001');

  // Worktree cho TASK-001 và TASK-002
  const wt = (id) => join(base, 'wt', id);
  for (const id of ['TASK-001', 'TASK-002']) {
    git(main, 'worktree', 'add', '-q', wt(id), '-b', `task/${id}`, 'integration/EXEC-001');
  }

  // Khởi tạo state
  const state = createState({
    execId: 'EXEC-001',
    tasks: [
      {
        id: 'TASK-001',
        title: 'Feature 1',
        owned_files: ['src/feature1/**'],
        acceptance_criteria: ['unit test pass'],
      },
      {
        id: 'TASK-002',
        title: 'Feature 2',
        owned_files: ['src/feature2/**'],
        acceptance_criteria: ['unit test pass'],
      },
    ],
  });
  saveState(main, state);

  return { base, main, wt };
}

async function prepareTaskHandoff({ main, wtPath, taskId, execId = 'EXEC-001', file = 'src/feature1/f1.ts' }) {
  // 1. Tạo code và commit
  const fullPath = join(wtPath, file);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, '// feature implementation\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', `feat(${taskId}): implementation`);
  const head = git(wtPath, 'rev-parse', 'HEAD');

  // 2. Chuyển Task sang in_progress
  const state = loadState(main, execId);
  const task = state.tasks.find((t) => t.id === taskId);
  if (task.status === 'pending') {
    transition(state, taskId, 'in_progress', { agent: 'coder' });
    saveState(main, state);
  }

  // 3. Chạy validation để sinh bằng chứng
  const config = JSON.parse(readFileSync(join(main, 'project.config.json'), 'utf8'));
  config.commands = { build: { cmd: 'node -e "process.exit(0)"', required: true } };
  const valResult = await runGate({
    config,
    taskId,
    execId,
    worktree: wtPath,
    root: main,
    base: 'integration/EXEC-001',
  });
  assert.equal(valResult.status, 'READY_FOR_REVIEW');

  // 4. Ghi báo cáo bàn giao .task-report.json
  const report = {
    task_id: taskId,
    agent: 'coder',
    result: 'READY_FOR_REVIEW',
    summary: 'Done feature implementation',
    branch: `task/${taskId}`,
    commits: [head],
    files_changed: [file],
    checks: { build: 'pass' },
    evidence: [`logs/${execId}/${taskId}/${head.slice(0, 7)}/result.json`],
    open_issues: [],
    needs_human: false,
  };
  writeFileSync(join(wtPath, REPORT_FILE), JSON.stringify(report, null, 2));

  // 5. Đổi trạng thái state sang ready_for_review
  const s2 = loadState(main, execId);
  transition(s2, taskId, 'ready_for_review');
  saveState(main, s2);

  return { head, report };
}

test('integrateTask: từ chối khi Task chưa ở ready_for_review', async () => {
  const { main } = setupRepo();
  await assert.rejects(
    async () => integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' }),
    (err) => err instanceof IntegrateError && err.message.includes('ready_for_review')
  );
});

test('integrateTask: từ chối khi thiếu báo cáo bàn giao', async () => {
  const { main, wt } = setupRepo();
  const s = loadState(main, 'EXEC-001');
  transition(s, 'TASK-001', 'in_progress');
  transition(s, 'TASK-001', 'ready_for_review');
  saveState(main, s);

  await assert.rejects(
    async () => integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' }),
    (err) => err instanceof IntegrateError && err.message.includes(REPORT_FILE)
  );
});

test('integrateTask: merge sạch vào integration branch và Integration Gate xanh -> completed', async () => {
  const { main, wt } = setupRepo();
  await prepareTaskHandoff({ main, wtPath: wt('TASK-001'), taskId: 'TASK-001' });

  const result = await integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.integration_branch, 'integration/EXEC-001');
  assert.ok(result.merge_commit);

  // Kiểm tra state đã chuyển sang completed
  const state = loadState(main, 'EXEC-001');
  assert.equal(state.tasks.find((t) => t.id === 'TASK-001').status, 'completed');

  // Kiểm tra file đã có trên nhánh integration/EXEC-001
  const currentBranch = git(main, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert.equal(currentBranch, 'integration/EXEC-001');
  const fileContent = readFileSync(join(main, 'src/feature1/f1.ts'), 'utf8');
  assert.match(fileContent, /feature implementation/);
});

test('integrateTask: idempotent khi chạy lại trên Task đã hoàn thành', async () => {
  const { main, wt } = setupRepo();
  await prepareTaskHandoff({ main, wtPath: wt('TASK-001'), taskId: 'TASK-001' });

  const first = await integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' });
  assert.equal(first.ok, true);

  const headCommit = git(main, 'rev-parse', 'HEAD');

  // Chạy lần hai
  const second = await integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' });
  assert.equal(second.ok, true);
  assert.equal(second.already_integrated, true);
  assert.equal(second.status, 'completed');

  // Không sinh commit mới
  assert.equal(git(main, 'rev-parse', 'HEAD'), headCommit);
});

test('integrateTask: xung đột merge (conflict) -> abort, chuyển in_progress yêu cầu rebase', async () => {
  const { main, wt } = setupRepo();
  // TASK-001 sửa file f1.ts trên worktree của mình
  await prepareTaskHandoff({
    main,
    wtPath: wt('TASK-001'),
    taskId: 'TASK-001',
    file: 'src/feature1/f1.ts',
  });

  // Trong khi đó, trên nhánh integration/EXEC-001, có commit thay đổi cùng dòng trong f1.ts
  git(main, 'checkout', 'integration/EXEC-001');
  mkdirSync(join(main, 'src/feature1'), { recursive: true });
  writeFileSync(join(main, 'src/feature1/f1.ts'), '// conflicting line on integration branch\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-m', 'conflicting change on integration');

  // Chuyển lại về main để test chuyển nhánh
  git(main, 'checkout', 'main');

  // Tích hợp TASK-001 -> phát hiện xung đột!
  const res = await integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' });
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.equal(res.status, 'in_progress');
  assert.match(res.error, /Xung đột merge/);

  // State của TASK-001 chuyển về in_progress
  const state = loadState(main, 'EXEC-001');
  assert.equal(state.tasks.find((t) => t.id === 'TASK-001').status, 'in_progress');

  // Nhánh integration sạch, không dính trạng thái MERGING
  assert.equal(git(main, 'status', '--porcelain'), '');
});

test('integrateTask: Integration Gate đỏ -> tự động rollback về commit trước', async () => {
  const { main, wt } = setupRepo();
  await prepareTaskHandoff({ main, wtPath: wt('TASK-001'), taskId: 'TASK-001' });

  // Cố ý làm hỏng command build trong project.config.json
  const cfgPath = join(main, 'project.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.commands.build = {
    cmd: 'node -e "console.error(\'gate failure\'); process.exit(1)"',
    required: true,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // Commit thay đổi cấu hình vào integration/EXEC-001
  git(main, 'checkout', 'integration/EXEC-001');
  git(main, 'add', '-A');
  git(main, 'commit', '-m', 'set failing build');
  const commitBefore = git(main, 'rev-parse', 'HEAD');

  // Thực hiện integrate -> merge thật sẽ xong nhưng gate đỏ => rollback!
  const res = await integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' });
  assert.equal(res.ok, false);
  assert.equal(res.gate_failed, true);
  assert.match(res.error, /rollback/);

  // Đã rollback về đúng commit trước khi merge
  assert.equal(git(main, 'rev-parse', 'HEAD'), commitBefore);

  // State chuyển về in_progress
  const state = loadState(main, 'EXEC-001');
  assert.equal(state.tasks.find((t) => t.id === 'TASK-001').status, 'in_progress');
});

test('integrateTask: từ chối khi Reviewer CHANGES_REQUESTED', async () => {
  const { main, wt } = setupRepo();
  await prepareTaskHandoff({ main, wtPath: wt('TASK-001'), taskId: 'TASK-001' });

  // Đặt file review có CHANGES_REQUESTED
  writeFileSync(
    join(wt('TASK-001'), '.task-review.json'),
    JSON.stringify({
      task_id: 'TASK-001',
      verdict: 'CHANGES_REQUESTED',
      findings: ['Thiếu unit test edge case'],
    })
  );

  await assert.rejects(
    async () => integrateTask({ root: main, execId: 'EXEC-001', taskId: 'TASK-001' }),
    (err) => err instanceof IntegrateError && err.message.includes('CHANGES_REQUESTED')
  );
});

test('cli.mjs integrate: gọi qua CLI hoạt động đúng', async () => {
  const { main, wt } = setupRepo();
  await prepareTaskHandoff({ main, wtPath: wt('TASK-001'), taskId: 'TASK-001' });

  const r = spawnSync(process.execPath, [CLI, 'integrate', 'TASK-001', '--exec', 'EXEC-001', '--root', main], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed');
});
