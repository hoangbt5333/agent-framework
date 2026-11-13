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
import { validateReportShape, validateBriefShape, REPORT_FILE } from '../core/orchestrator/report.mjs';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const HANDOFF = dir('../core/orchestrator/hooks/guard-handoff.mjs');
const EDIT = dir('../core/orchestrator/hooks/guard-edit.mjs');
const CLI = dir('../core/orchestrator/cli.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// Repo chính + nhánh integration/E1 + 3 worktree rẽ từ integration/E1. TASK-001 và TASK-003 in_progress.
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'af-hand-')));
  const main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t'); git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'project.config.json'), JSON.stringify({
    framework_version: '0.3.0', project: { name: 't', base_branch: 'main' },
    commands: { build: { cmd: 'node -e "process.exit(0)"', required: true, timeout_s: 20 } },
    git: { worktree_dir: '../wt' },
    ownership: { shared_files: ['package.json'] },
    security: { deny_read: ['.env*'] },
  }));
  writeFileSync(join(main, '.gitignore'), `state/\nlogs/\n${REPORT_FILE}\n`);
  writeFileSync(join(main, 'src', 'a.ts'), '1');
  git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  git(main, 'branch', 'integration/E1');
  const wt = (id) => join(base, 'wt', id);
  for (const id of ['TASK-001', 'TASK-002', 'TASK-003']) git(main, 'worktree', 'add', '-q', wt(id), '-b', `task/${id}`, 'integration/E1');
  const state = createState({ execId: 'E1', tasks: [
    { id: 'TASK-001', title: 'Course API', description: 'CRUD course', owned_files: ['src/course/**'], acceptance_criteria: ['unit test pass'] },
    { id: 'TASK-002', owned_files: ['src/user/**'] },
    { id: 'TASK-003', owned_files: ['src/other/**'], acceptance_criteria: ['x'] },
  ] });
  transition(state, 'TASK-001', 'in_progress'); transition(state, 'TASK-003', 'in_progress');
  saveState(main, state);
  return { base, main, wt, config: loadConfig(main) };
}

const commit = (cwd, rel, text = 'x') => {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), text);
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', `add ${rel}`);
  return git(cwd, 'rev-parse', 'HEAD');
};
const validated = (S, id) => runGate({ config: S.config, taskId: id, execId: 'E1', worktree: S.wt(id), root: S.main, base: 'integration/E1' });
const goodReport = (S, id, head, over = {}) => ({
  task_id: id, agent: 'coder-a', result: 'READY_FOR_REVIEW', summary: 'xong', branch: `task/${id}`,
  commits: [head.slice(0, 7)], files_changed: ['src/course/a.ts'], checks: { build: 'pass' },
  evidence: [], open_issues: [], needs_human: false, ...over,
});
const writeReport = (S, id, report) => writeFileSync(join(S.wt(id), REPORT_FILE), typeof report === 'string' ? report : JSON.stringify(report));
const stop = (cwd, extra = {}, env = {}) => spawnSync(process.execPath, [HANDOFF], {
  input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: 'coder', stop_hook_active: false, cwd, ...extra }),
  encoding: 'utf8', env: { ...process.env, AGENT_TASK_ID: '', AGENT_EXEC_ID: '', ...env },
});
const events = (S) => readFileSync(join(S.main, 'logs', 'E1', 'hooks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('schema báo cáo: hợp lệ, trường lạ, commit sai định dạng, enum sai', () => {
  const ok = { task_id: 'T', agent: 'a', result: 'FAIL', summary: 's', branch: 'b', commits: ['abc1234'], files_changed: [], checks: { build: 'fail' }, evidence: [], open_issues: ['x'], needs_human: true };
  assert.deepEqual(validateReportShape(ok), []);
  assert.ok(validateReportShape({ ...ok, extra: 1 }).length);
  assert.ok(validateReportShape({ ...ok, commits: ['zzz'] }).length);
  assert.ok(validateReportShape({ ...ok, result: 'DONE' }).length);
  assert.ok(validateReportShape({ ...ok, checks: { build: 'ok' } }).length);
  const { summary, ...missing } = ok;
  assert.match(validateReportShape(missing)[0], /summary/);
});

test('không áp dụng: Agent không phải Coder, phiên chính, Task không in_progress, đầu vào hỏng', () => {
  const S = setup();
  assert.equal(stop(S.wt('TASK-001'), { agent_type: 'reviewer' }).status, 0);
  assert.equal(stop(S.main, { agent_type: undefined }).status, 0);
  assert.equal(stop(S.wt('TASK-002')).status, 0);                       // TASK-002 còn pending
  assert.equal(spawnSync(process.execPath, [HANDOFF], { input: 'rác', encoding: 'utf8' }).status, 0); // fail-open
});

test('chưa có báo cáo: chặn kết thúc và chỉ cách làm', () => {
  const S = setup();
  const r = stop(S.wt('TASK-001'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /1\. Chưa có báo cáo bàn giao/);
  assert.match(r.stderr, /brief TASK-001/);
});

test('bàn giao đầy đủ và đúng: cho kết thúc, ghi handoff_ok', async () => {
  const S = setup();
  const head = commit(S.wt('TASK-001'), 'src/course/a.ts');
  assert.equal((await validated(S, 'TASK-001')).status, 'READY_FOR_REVIEW');
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head));
  assert.equal(stop(S.wt('TASK-001')).status, 0);
  assert.equal(events(S).at(-1).event, 'handoff_ok');
  // báo cáo (đã .gitignore) không làm bẩn git khi validate lại
  assert.equal((await validated(S, 'TASK-001')).status, 'READY_FOR_REVIEW');
});

test('báo cáo sai schema hoặc không phải JSON: chặn, liệt kê lỗi', () => {
  const S = setup();
  writeReport(S, 'TASK-001', { task_id: 'TASK-001', result: 'DONE' });
  const r = stop(S.wt('TASK-001'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Sai schema báo cáo/);
  writeReport(S, 'TASK-001', '{hỏng');
  assert.match(stop(S.wt('TASK-001')).stderr, /không phải JSON hợp lệ/);
});

test('không tin lời khai: thiếu bằng chứng cho HEAD, commit chưa nêu, bằng chứng bị sửa, còn file chưa commit', async () => {
  const S = setup();
  const head = commit(S.wt('TASK-001'), 'src/course/a.ts');
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head));
  let r = stop(S.wt('TASK-001'));                                         // chưa chạy validate.mjs
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Chưa có bằng chứng validation cho commit/);
  assert.match(r.stderr, /validate\.mjs/);                                // có lệnh cụ thể để chạy

  await validated(S, 'TASK-001');
  const head2 = commit(S.wt('TASK-001'), 'src/course/b.ts');              // commit mới sau khi validate
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head, { files_changed: ['src/course/a.ts', 'src/course/b.ts'] }));
  r = stop(S.wt('TASK-001'));
  assert.match(r.stderr, /chưa gồm commit HEAD/);
  assert.match(r.stderr, new RegExp(`Chưa có bằng chứng validation cho commit ${head2.slice(0, 7)}`));

  await validated(S, 'TASK-001');                                         // tamper: sửa bằng chứng thành FAIL
  const evFile = join(S.main, 'logs', 'E1', 'TASK-001', head2.slice(0, 7), 'result.json');
  const ev = JSON.parse(readFileSync(evFile, 'utf8')); ev.status = 'FAIL'; ev.checks[2].passed = false;
  writeFileSync(evFile, JSON.stringify(ev));
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head2, { files_changed: ['src/course/a.ts', 'src/course/b.ts'] }));
  r = stop(S.wt('TASK-001'));
  assert.match(r.stderr, /không thể báo READY_FOR_REVIEW/);
  assert.match(r.stderr, /khai build=pass nhưng bằng chứng/);

  writeFileSync(join(S.wt('TASK-001'), 'src/course/dirty.ts'), 'x');     // file chưa commit
  assert.match(stop(S.wt('TASK-001')).stderr, /Còn thay đổi chưa commit/);
});

test('đối chiếu git diff: file ngoài owned_files (ghi qua Bash) và files_changed thiếu', async () => {
  const S = setup();
  commit(S.wt('TASK-001'), 'src/course/a.ts');
  const head = commit(S.wt('TASK-001'), 'src/user/leak.ts');              // ngoài phạm vi, qua mặt guard-edit
  await validated(S, 'TASK-001');
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head, { files_changed: ['src/course/a.ts'] }));
  const r = stop(S.wt('TASK-001'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /file ngoài phạm vi: src\/user\/leak\.ts/);
  assert.match(r.stderr, /"files_changed" thiếu file thực sự đã đổi: src\/user\/leak\.ts/);
});

test('result FAIL/BLOCKED: không cần validation nhưng phải có open_issues', () => {
  const S = setup();
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', 'abcdef0123', { result: 'BLOCKED', commits: [], files_changed: [], checks: {}, open_issues: [], needs_human: true }));
  assert.match(stop(S.wt('TASK-001')).stderr, /cần "open_issues"/);
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', 'abcdef0123', { result: 'BLOCKED', commits: [], files_changed: [], checks: {}, open_issues: ['thiếu contract API'], needs_human: true }));
  assert.equal(stop(S.wt('TASK-001')).status, 0);
});

test('stop_hook_active: nhắc một lần rồi cho dừng, vẫn ghi lại (không kẹt vô hạn)', () => {
  const S = setup();
  assert.equal(stop(S.wt('TASK-001')).status, 2);
  assert.equal(stop(S.wt('TASK-001'), { stop_hook_active: true }).status, 0);
  const last = events(S).at(-1);
  assert.equal(last.event, 'handoff_invalid');
  assert.equal(last.retry_exhausted, true);
});

test('chạy riêng từng Task bằng AGENT_TASK_ID (sự kiện Stop, không có agent_type)', () => {
  const S = setup();
  const r = stop(S.main, { hook_event_name: 'Stop', agent_type: undefined }, { AGENT_TASK_ID: 'TASK-001', AGENT_EXEC_ID: 'E1' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Chưa có báo cáo bàn giao/);
});

test('guard-edit cho Coder ghi .task-report.json dù không thuộc owned_files, nhưng không ghi được khi Task không in_progress', () => {
  const S = setup();
  const edit = (cwd, file_path) => spawnSync(process.execPath, [EDIT], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path }, cwd }), encoding: 'utf8',
    env: { ...process.env, AGENT_TASK_ID: '', AGENT_EXEC_ID: '' },
  }).status;
  assert.equal(edit(S.wt('TASK-001'), REPORT_FILE), 0);
  assert.equal(edit(S.wt('TASK-001'), 'src/user/x.ts'), 2);
  assert.equal(edit(S.wt('TASK-002'), REPORT_FILE), 2);                   // TASK-002 pending
});

test('cli brief: sinh Task Brief đúng schema; thiếu owned_files thì từ chối', () => {
  const S = setup();
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a, '--root', S.main], { encoding: 'utf8' });
  const r = cli('brief', 'TASK-001', '--exec', 'E1');
  assert.equal(r.status, 0, r.stderr);
  const brief = JSON.parse(r.stdout);
  assert.deepEqual(validateBriefShape(brief), []);
  assert.equal(brief.base_branch, 'integration/E1');
  assert.equal(brief.branch, 'task/TASK-001');
  assert.ok(brief.worktree.endsWith(join('wt', 'TASK-001')));
  assert.match(brief.validation_command, /validate\.mjs" TASK-001/);
  const bad = cli('brief', 'TASK-002', '--exec', 'E1');                   // TASK-002 không có acceptance_criteria
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /acceptance_criteria/);
});

test('cli report-check: kiểm tra độc lập của Orchestrator, không cần hook', async () => {
  const S = setup();
  const cli = () => spawnSync(process.execPath, [CLI, 'report-check', 'TASK-001', '--exec', 'E1', '--root', S.main], { encoding: 'utf8' });
  assert.equal(cli().status, 1);                                          // chưa có báo cáo
  const head = commit(S.wt('TASK-001'), 'src/course/a.ts');
  await validated(S, 'TASK-001');
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head));
  const ok = cli();
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head, { commits: ['1234567'] }));
  assert.equal(cli().status, 1);
});

test('validate và handoff không coi .task-report.json là thay đổi chưa commit, kể cả khi dự án quên .gitignore', async () => {
  const S = setup();
  const wt = S.wt('TASK-001');
  writeFileSync(join(wt, '.gitignore'), 'state/\nlogs/\n');                 // gỡ dòng ignore file báo cáo
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'bỏ ignore');
  const head = commit(wt, 'src/course/a.ts');
  writeReport(S, 'TASK-001', goodReport(S, 'TASK-001', head, { files_changed: ['.gitignore', 'src/course/a.ts'] }));
  assert.match(git(wt, 'status', '--porcelain'), /\?\? \.task-report\.json/);   // đang là file chưa theo dõi
  const r = await validated(S, 'TASK-001');
  assert.equal(r.checks.find((c) => c.name === 'git_clean').passed, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.doesNotMatch(stop(wt).stderr, /Còn thay đổi chưa commit/);        // (vẫn có thể bị chặn vì lý do khác, ví dụ .gitignore ngoài phạm vi)
});
