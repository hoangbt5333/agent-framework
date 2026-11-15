import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, transition, saveState, loadState, readyTasks, detectDeadlock } from '../core/orchestrator/state.mjs';
import { recordReview, recoverTask, recoverExecution } from '../core/orchestrator/recover.mjs';
import { runGate } from '../core/orchestrator/validate.mjs';
import { REPORT_FILE, REVIEW_FILE } from '../core/orchestrator/report.mjs';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const CLI = dir('../core/orchestrator/cli.mjs');
const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' })
    .replace(/\r/g, '')
    .trim();

function setupRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'af-recov-')));
  const main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'test@test.local');
  git(main, 'config', 'user.name', 'Tester');

  writeFileSync(
    join(main, 'project.config.json'),
    JSON.stringify({
      framework_version: '0.4.0',
      project: { name: 'test-recovery', base_branch: 'main' },
      commands: {
        build: { cmd: 'node -e "process.exit(0)"', required: true, timeout_s: 30 },
      },
      git: {
        task_branch_prefix: 'task/',
        integration_branch_prefix: 'integration/',
        worktree_dir: '../wt',
        merge_strategy: 'squash',
      },
      limits: { max_parallel: 3, max_attempts: 3, max_review_rounds: 2, agent_timeout_min: 60 },
      ownership: { shared_files: ['package.json'] },
      security: { deny_read: ['.env*'] },
    })
  );

  writeFileSync(join(main, '.gitignore'), `state/\nlogs/\n${REPORT_FILE}\n${REVIEW_FILE}\n`);
  writeFileSync(join(main, 'src', 'app.ts'), 'export const app = 1;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'initial commit');

  git(main, 'branch', 'integration/EXEC-001');

  const wt = (id) => join(base, 'wt', id);
  for (const id of ['TASK-001', 'TASK-002']) {
    git(main, 'worktree', 'add', '-q', wt(id), '-b', `task/${id}`, 'integration/EXEC-001');
  }

  const state = createState({
    execId: 'EXEC-001',
    tasks: [
      {
        id: 'TASK-001',
        title: 'Feature 1',
        owned_files: ['src/feature1/**'],
        acceptance_criteria: ['f1 works'],
      },
      {
        id: 'TASK-002',
        title: 'Feature 2',
        owned_files: ['src/feature2/**'],
        acceptance_criteria: ['f2 works'],
      },
    ],
  });
  saveState(main, state);

  return { base, main, wt };
}

test('recordReview: APPROVED ghi nhận đánh giá thành công', () => {
  const { main, wt } = setupRepo();
  const state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-001', 'ready_for_review', { agent: 'coder' });
  saveState(main, state);

  const res = recordReview({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
    verdict: 'APPROVED',
    reviewer: 'human-or-agent',
    findings: [],
  });

  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'APPROVED');

  const reviewPath = join(main, 'logs', 'EXEC-001', 'TASK-001', 'review.json');
  const reviewData = JSON.parse(readFileSync(reviewPath, 'utf8'));
  assert.equal(reviewData.verdict, 'APPROVED');
  assert.equal(reviewData.reviewer, 'human-or-agent');
});

test('recordReview: CHANGES_REQUESTED tăng review_rounds và chuyển blocked khi vượt giới hạn', () => {
  const { main } = setupRepo();
  let state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-001', 'ready_for_review', { agent: 'coder' });
  saveState(main, state);

  // Vòng 1: Yêu cầu sửa đổi -> chuyển về in_progress, chưa blocked
  const res1 = recordReview({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
    verdict: 'CHANGES_REQUESTED',
    findings: ['Thiếu unit test edge case'],
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.status, 'in_progress');
  assert.equal(res1.review_rounds, 1);
  assert.equal(res1.needs_human, false);

  state = loadState(main, 'EXEC-001');
  assert.equal(state.tasks[0].status, 'in_progress');
  assert.equal(state.tasks[0].review_rounds, 1);

  // Coder nộp lại
  transition(state, 'TASK-001', 'ready_for_review', { agent: 'coder' });
  saveState(main, state);

  // Vòng 2: Lại bị từ chối -> Đạt max_review_rounds (2) -> chuyển sang blocked (needs_human = true)
  const res2 = recordReview({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
    verdict: 'CHANGES_REQUESTED',
    findings: ['Vẫn chưa xử lý xong edge case'],
  });

  assert.equal(res2.ok, true);
  assert.equal(res2.status, 'blocked');
  assert.equal(res2.review_rounds, 2);
  assert.equal(res2.needs_human, true);

  state = loadState(main, 'EXEC-001');
  assert.equal(state.tasks[0].status, 'blocked');
});

test('recoverTask: Coder dở dang có uncommitted changes -> giữ nguyên in_progress', async () => {
  const { main, wt } = setupRepo();
  const state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  saveState(main, state);

  // Coder tạo file dở dang
  const fPath = join(wt('TASK-001'), 'src', 'feature1', 'work.ts');
  mkdirSync(join(fPath, '..'), { recursive: true });
  writeFileSync(fPath, '// uncommitted work in progress\n');

  const res = await recoverTask({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'in_progress');
  assert.equal(res.action, 'resume_in_progress');
  assert.equal(res.dirty_files.length, 1);

  const updatedState = loadState(main, 'EXEC-001');
  assert.equal(updatedState.tasks[0].status, 'in_progress');
});

test('recoverTask: Coder dừng không tạo commit nào -> reset về pending và tăng attempts', async () => {
  const { main } = setupRepo();
  const state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  saveState(main, state);

  const res = await recoverTask({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'pending');
  assert.equal(res.action, 'reset_to_pending');
  // attempts ban đầu = 1 khi transition in_progress, tăng thêm 1 khi reset = 2
  assert.equal(res.attempts, 2);

  const updatedState = loadState(main, 'EXEC-001');
  assert.equal(updatedState.tasks[0].status, 'pending');
  assert.equal(updatedState.tasks[0].attempts, 2);
});

test('recoverTask: Coder đã commit và có evidence hợp lệ -> khôi phục ready_for_review', async () => {
  const { main, wt } = setupRepo();
  const wtPath = wt('TASK-001');

  // Commit code
  const fPath = join(wtPath, 'src', 'feature1', 'f1.ts');
  mkdirSync(join(fPath, '..'), { recursive: true });
  writeFileSync(fPath, '// feature done\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', 'feat(TASK-001): finish');
  const head = git(wtPath, 'rev-parse', 'HEAD');

  // Chuyển in_progress
  const state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  saveState(main, state);

  // Sinh evidence
  const config = JSON.parse(readFileSync(join(main, 'project.config.json'), 'utf8'));
  await runGate({
    config,
    taskId: 'TASK-001',
    execId: 'EXEC-001',
    worktree: wtPath,
    root: main,
    base: 'integration/EXEC-001',
  });

  // Phục hồi
  const res = await recoverTask({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'ready_for_review');
  assert.equal(res.action, 'promoted_to_ready_for_review');

  const updatedState = loadState(main, 'EXEC-001');
  assert.equal(updatedState.tasks[0].status, 'ready_for_review');
});

test('recoverTask: Coder đã commit nhưng chưa chạy gate -> tự động chạy gate và promote', async () => {
  const { main, wt } = setupRepo();
  const wtPath = wt('TASK-001');

  // Commit code nhưng KHÔNG chạy gate trước
  const fPath = join(wtPath, 'src', 'feature1', 'f1.ts');
  mkdirSync(join(fPath, '..'), { recursive: true });
  writeFileSync(fPath, '// feature done\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', 'feat(TASK-001): finish');

  // Chuyển in_progress
  const state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  saveState(main, state);

  // Phục hồi: recoverTask sẽ tự chạy runGate
  const res = await recoverTask({
    root: main,
    execId: 'EXEC-001',
    taskId: 'TASK-001',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'ready_for_review');
  assert.equal(res.action, 'validated_and_promoted');

  const updatedState = loadState(main, 'EXEC-001');
  assert.equal(updatedState.tasks[0].status, 'ready_for_review');
});

test('Circuit breaker: 3 lỗi liên tiếp ngắt điều phối và phát hiện deadlock', () => {
  const { main } = setupRepo();
  const state = loadState(main, 'EXEC-001');

  assert.equal(state.circuit_breaker_tripped, false);
  assert.equal(state.consecutive_failures, 0);

  // Lần 1
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-001', 'failed', { agent: 'coder', note: 'fail 1' });
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.circuit_breaker_tripped, false);

  // Lần 2 (reset task 1 to pending, then in_progress, then failed)
  transition(state, 'TASK-001', 'pending');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-001', 'failed', { agent: 'coder', note: 'fail 2' });
  assert.equal(state.consecutive_failures, 2);
  assert.equal(state.circuit_breaker_tripped, false);

  // Lần 3
  transition(state, 'TASK-002', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-002', 'failed', { agent: 'coder', note: 'fail 3' });
  assert.equal(state.consecutive_failures, 3);
  assert.equal(state.circuit_breaker_tripped, true);

  // Khi ngắt: readyTasks không giao việc nữa
  const ready = readyTasks(state, 3);
  assert.deepEqual(ready, []);

  // detectDeadlock báo circuit breaker
  const dl = detectDeadlock(state);
  assert.equal(dl.deadlock, true);
  assert.equal(dl.circuit_breaker, true);
});

test('CLI: recover và review-record tích hợp trơn tru', () => {
  const { main, wt } = setupRepo();
  const state = loadState(main, 'EXEC-001');
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-001', 'ready_for_review', { agent: 'coder' });
  saveState(main, state);

  // 1. review-record via CLI
  const r1 = spawnSync(
    'node',
    [
      CLI,
      'review-record',
      'TASK-001',
      '--exec',
      'EXEC-001',
      '--root',
      main,
      '--verdict',
      'CHANGES_REQUESTED',
      '--findings',
      JSON.stringify(['Cần tối ưu code']),
    ],
    { encoding: 'utf8' }
  );
  assert.equal(r1.status, 0, r1.stderr);
  const out1 = JSON.parse(r1.stdout);
  assert.equal(out1.verdict, 'CHANGES_REQUESTED');
  assert.equal(out1.status, 'in_progress');

  // 2. recover via CLI
  const r2 = spawnSync(
    'node',
    [CLI, 'recover', 'TASK-001', '--exec', 'EXEC-001', '--root', main],
    { encoding: 'utf8' }
  );
  assert.equal(r2.status, 0, r2.stderr);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.action, 'reset_to_pending');
});
