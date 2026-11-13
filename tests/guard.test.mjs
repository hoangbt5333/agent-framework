import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { evaluateBash, tokenize } from '../core/orchestrator/hooks/guard-policy.mjs';
import { redact, buildEntry, appendOnce } from '../core/orchestrator/hooks/hook-log.mjs';

const cwd = join(tmpdir(), 'wt', 'TASK-001');
const ev = (cmd) => evaluateBash(cmd, { cwd });

test('tokenize: nháy và escape', () => {
  assert.deepEqual(tokenize(`git commit -m "feat: a b" 'c d'`), ['git', 'commit', '-m', 'feat: a b', 'c d']);
  assert.deepEqual(tokenize('\\git push'), ['git', 'push']);
  assert.deepEqual(tokenize('echo ""'), ['echo', '']);
});

test('cho phép lệnh làm việc bình thường', () => {
  for (const c of [
    'git status', 'git commit -m "feat: add api"', 'git merge --no-ff task/TASK-001',
    'git worktree add ../wt/TASK-002 -b task/TASK-002 integration/E1', 'git -C ../wt/T log --oneline',
    'git branch --list', 'git reset --soft HEAD~1', 'npm test -- --watch=false', 'ng build 2>&1 | tail -5',
    'rm -rf node_modules', 'rm dist/a.js', 'rm -rf dist/*', 'ls -la && cat README.md',
  ]) assert.equal(ev(c).allow, true, c);
});

test('chặn git push dưới mọi hình thức', () => {
  for (const c of [
    'git push', 'git push origin main', 'git push -f', 'git -C /x push', 'git --no-pager push',
    'cd x && git push', 'echo hi; git push -f', 'git status | git push', 'true || git push',
    'bash -c "git push"', "sh -c 'echo a && git push'", 'eval "git push"', 'echo $(git push)', 'echo `git push`',
    'env GIT_TERMINAL_PROMPT=0 git push', 'GIT_X=1 git push', 'timeout 5 git push', '/usr/bin/git push', '\\git push',
    'xargs git push', 'bash -c "bash -c \'git push\'"',
  ]) assert.equal(ev(c).allow, false, c);
});

test('chặn lệnh git và quyền nguy hiểm khác', () => {
  for (const c of [
    'git reset --hard', 'git reset --hard HEAD~1', 'git clean -fd', 'git clean -f', 'git clean --force',
    'git branch -D task/x', 'git branch -d x', 'git branch --delete x', 'sudo ls', 'doas rm x',
  ]) assert.equal(ev(c).allow, false, c);
});

test('chặn rm ngoài phạm vi hoặc không kiểm chứng được', () => {
  for (const c of [
    'rm -rf /', 'rm -rf ..', 'rm -rf ../other', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf "$DIR"', 'rm -rf .', 'rm -rf ./',
    'rm -rf .*', 'rm -rf /*', 'rm -rf src/../..', "sh -c 'rm -rf /'", 'rm -rf dist ../x',
    'rm -rf .git', 'rm -rf .claude/hooks', 'rm -rf orchestrator', 'rm state/E1.json', 'rm -rf logs', 'rm project.config.json',
  ]) assert.equal(ev(c).allow, false, c);
});

const HOOK = new URL('../core/orchestrator/hooks/guard-bash.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOG = new URL('../core/orchestrator/hooks/log-event.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (script, input, env = {}) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', env: { ...process.env, ...env } });
const bashInput = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

test('guard-bash.mjs: exit 2 khi chặn, 0 khi cho qua, stderr có lý do', () => {
  const blocked = run(HOOK, bashInput('git push origin main'));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BỊ CHẶN/);
  assert.equal(run(HOOK, bashInput('git status')).status, 0);
  assert.equal(run(HOOK, JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } })).status, 0); // không phải Bash
});

test('guard-bash.mjs: FAIL-CLOSED với đầu vào hỏng', () => {
  for (const bad of ['', 'not json', '{}', JSON.stringify({ tool_name: 'Bash', tool_input: {} })]) {
    const r = run(HOOK, bad);
    assert.equal(r.status, 2, `input: ${JSON.stringify(bad)}`);
  }
});

test('redact che secret', () => {
  assert.doesNotMatch(redact('curl -H "Authorization: Bearer abc123xyz" --token=SUPERSECRET'), /abc123xyz|SUPERSECRET/);
  assert.doesNotMatch(redact('export KEY=sk-abcdefghijklmnop'), /abcdefghijklmnop/);
});

test('log-event.mjs: ghi JSONL, idempotent theo tool_use_id, fail-open', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-log-'));
  const env = { CLAUDE_PROJECT_DIR: root, AGENT_EXEC_ID: 'E1', AGENT_TASK_ID: '' };
  const ev1 = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'tu_1', session_id: 's1', cwd: join(root, 'wt', 'TASK-007'), tool_input: { file_path: 'src/a.ts' } });
  assert.equal(run(LOG, ev1, env).status, 0);
  assert.equal(run(LOG, ev1, env).status, 0);                    // chạy lại cùng sự kiện
  const lines = readFileSync(join(root, 'logs', 'E1', 'hooks.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.task_id, 'TASK-007');
  assert.equal(e.target, 'src/a.ts');

  const root2 = mkdtempSync(join(tmpdir(), 'af-log2-'));
  assert.equal(run(LOG, 'rác không phải JSON', { CLAUDE_PROJECT_DIR: root2 }).status, 0); // fail-open
  assert.equal(existsSync(join(root2, 'logs')), false);
});

test('buildEntry: che secret trong command; appendOnce không trùng', () => {
  const entry = buildEntry({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'deploy --api-key=hunter2hunter2' } });
  assert.doesNotMatch(entry.target, /hunter2/);
  const file = join(mkdtempSync(join(tmpdir(), 'af-log3-')), 'h.jsonl');
  assert.equal(appendOnce(file, entry), true);
  assert.equal(appendOnce(file, entry), false);
});

test('settings.fragment.json hợp lệ và trỏ tới script có thật', () => {
  const frag = JSON.parse(readFileSync(new URL('../core/.claude/settings.fragment.json', import.meta.url), 'utf8'));
  const commands = Object.values(frag.hooks).flat().flatMap((m) => m.hooks.map((h) => h.command));
  assert.ok(commands.length >= 3);
  for (const c of commands) {
    const rel = c.match(/orchestrator\/hooks\/[\w-]+\.mjs/)?.[0];
    assert.ok(rel && existsSync(new URL(`../core/${rel}`, import.meta.url)), c);
  }
});
