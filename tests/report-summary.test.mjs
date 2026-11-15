import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, transition, saveState } from '../core/orchestrator/state.mjs';
import {
  generateExecutionSummary,
  formatMarkdownReport,
  saveExecutionReport,
  logJiraSkipped,
} from '../core/orchestrator/report-summary.mjs';
import { logDenied, logHook } from '../core/orchestrator/hooks/hook-log.mjs';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const CLI = dir('../core/orchestrator/cli.mjs');

function setupTestEnv() {
  const root = mkdtempSync(join(tmpdir(), 'af-report-'));
  const execId = 'EXEC-REPORT-1';

  writeFileSync(
    join(root, 'project.config.json'),
    JSON.stringify({
      framework_version: '0.4.0',
      project: { name: 'test-report', base_branch: 'main' },
      commands: { build: { cmd: 'node -e "process.exit(0)"', required: true } },
      git: { task_branch_prefix: 'task/', integration_branch_prefix: 'integration/' },
      limits: { max_parallel: 3, max_attempts: 3 },
      ownership: { shared_files: [] },
      security: { deny_read: [] },
    })
  );

  // Khởi tạo state với nhiều Task ở các trạng thái khác nhau
  const state = createState({
    execId,
    tasks: [
      { id: 'TASK-001', title: 'Task Completed', owned_files: ['src/a.ts'] },
      { id: 'TASK-002', title: 'Task In Progress', owned_files: ['src/b.ts'] },
      { id: 'TASK-003', title: 'Task Blocked', owned_files: ['src/c.ts'] },
      { id: 'TASK-004', title: 'Task Failed', owned_files: ['src/d.ts'] },
      { id: 'TASK-005', title: 'Task Pending', owned_files: ['src/e.ts'] },
    ],
  });

  // TASK-001: hoàn thành
  transition(state, 'TASK-001', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-001', 'ready_for_review', { agent: 'coder' });
  transition(state, 'TASK-001', 'completed', { agent: 'orchestrator' });

  // TASK-002: đang in_progress
  transition(state, 'TASK-002', 'in_progress', { agent: 'coder' });

  // TASK-003: bị blocked do review
  transition(state, 'TASK-003', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-003', 'ready_for_review', { agent: 'coder' });
  state.tasks.find((t) => t.id === 'TASK-003').review_rounds = 2;
  transition(state, 'TASK-003', 'blocked', { agent: 'reviewer', failure_kind: 'review' });

  // TASK-004: failed do code
  transition(state, 'TASK-004', 'in_progress', { agent: 'coder' });
  transition(state, 'TASK-004', 'failed', { agent: 'orchestrator', failure_kind: 'code' });

  saveState(root, state);

  // Ghi nhật ký hook audit
  logDenied(root, execId, {
    hook: 'guard-edit',
    tool: 'Edit',
    target: 'secret/api_key=sk-ant-api03-verysecret1234567890.env',
    reason: 'File nhạy cảm',
    cwd: root,
    taskId: 'TASK-002',
  });

  logHook(root, execId, {
    event: 'tool_call',
    tool_name: 'Bash',
  });

  // Ghi nhật ký Jira skipped
  logJiraSkipped(root, execId, { ticketId: 'PROJ-101', reason: 'Jira MCP not configured' });

  return { root, execId, state };
}

test('generateExecutionSummary: tổng hợp đúng chỉ số tiến độ và trạng thái Task', () => {
  const { root, execId } = setupTestEnv();

  const summary = generateExecutionSummary({ root, execId });

  assert.equal(summary.exec_id, execId);
  assert.equal(summary.counts.total, 5);
  assert.equal(summary.counts.completed, 1);
  assert.equal(summary.counts.in_progress, 1);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.pending, 1);
  assert.equal(summary.completion_rate_pct, 20); // 1 / 5 = 20%
  assert.equal(summary.overall_status, 'NEEDS_HUMAN_ATTENTION');
  assert.equal(summary.manual_intervention.needs_human, true);
  assert.equal(summary.manual_intervention.blocked_count, 1);
});

test('generateExecutionSummary: đếm chính xác số vòng review và phân loại lỗi', () => {
  const { root, execId } = setupTestEnv();

  const summary = generateExecutionSummary({ root, execId });

  assert.equal(summary.quality_and_reviews.total_review_rounds, 2);
  assert.equal(summary.quality_and_reviews.failures_by_kind.code, 1);
  assert.equal(summary.quality_and_reviews.failures_by_kind.review, 1);
});

test('generateExecutionSummary: phân tích nhật ký hook, bảo mật che secret và Jira status', () => {
  const { root, execId } = setupTestEnv();

  const summary = generateExecutionSummary({ root, execId });

  // Audit events
  assert.equal(summary.audit_events.total_hook_events, 3);
  assert.equal(summary.audit_events.guard_denied_count, 1);

  // Secret phải bị che trong target của denial
  const denial = summary.audit_events.denials[0];
  assert.equal(denial.tool, 'Edit');
  assert.match(denial.target, /\[REDACTED\]/);
  assert.doesNotMatch(denial.target, /verysecret/);

  // Jira status
  assert.match(summary.jira_integration.status, /Bỏ qua.*fail-open/);
  assert.equal(summary.jira_integration.skipped_count, 1);

  // Token usage
  assert.equal(summary.token_usage, 'Nguồn dữ liệu không khả dụng từ CLI');
});

test('formatMarkdownReport: sinh báo cáo định dạng Markdown đầy đủ các phần', () => {
  const { root, execId } = setupTestEnv();

  const summary = generateExecutionSummary({ root, execId });
  const md = formatMarkdownReport(summary);

  assert.match(md, /# Báo cáo Tổng kết Phiên Thực thi: EXEC-REPORT-1/);
  assert.match(md, /## 1\. Tổng quan Tiến độ/);
  assert.match(md, /\| Hoàn thành \(`completed`\) \| 1 \|/);
  assert.match(md, /## 2\. Chi tiết từng Task/);
  assert.match(md, /`TASK-001`/);
  assert.match(md, /`TASK-003`/);
  assert.match(md, /## 3\. Chất lượng & Độ tin cậy/);
  assert.match(md, /Tổng số vòng Review:\*\* 2/);
  assert.match(md, /## 4\. Nhật ký Giám sát & An toàn/);
  assert.match(md, /\[REDACTED\]/);
  assert.match(md, /## 5\. Tích hợp Ngoại vi & Tài nguyên/);
  assert.match(md, /Jira MCP/);
  assert.match(md, /Nguồn dữ liệu không khả dụng từ CLI/);
});

test('saveExecutionReport: lưu báo cáo dạng Markdown và JSON vào logs/', () => {
  const { root, execId } = setupTestEnv();

  // Lưu Markdown
  const resMd = saveExecutionReport({ root, execId, format: 'markdown' });
  assert.equal(resMd.ok, true);
  assert.equal(existsSync(resMd.path), true);
  const mdContent = readFileSync(resMd.path, 'utf8');
  assert.match(mdContent, /# Báo cáo Tổng kết/);

  // Lưu JSON
  const resJson = saveExecutionReport({ root, execId, format: 'json' });
  assert.equal(resJson.ok, true);
  assert.equal(existsSync(resJson.path), true);
  const jsonContent = JSON.parse(readFileSync(resJson.path, 'utf8'));
  assert.equal(jsonContent.exec_id, execId);
  assert.equal(jsonContent.counts.total, 5);
});

test('CLI: node cli.mjs report hoạt động đúng với định dạng JSON và Markdown', () => {
  const { root, execId } = setupTestEnv();

  // 1. Chạy với format JSON
  const rJson = spawnSync(
    'node',
    [CLI, 'report', '--exec', execId, '--root', root, '--format', 'json'],
    { encoding: 'utf8' }
  );
  assert.equal(rJson.status, 0, rJson.stderr);
  const parsedJson = JSON.parse(rJson.stdout);
  assert.equal(parsedJson.exec_id, execId);
  assert.equal(parsedJson.counts.total, 5);

  // 2. Chạy với format Markdown
  const rMd = spawnSync(
    'node',
    [CLI, 'report', '--exec', execId, '--root', root, '--format', 'markdown'],
    { encoding: 'utf8' }
  );
  assert.equal(rMd.status, 0, rMd.stderr);
  assert.match(rMd.stdout, /# Báo cáo Tổng kết Phiên Thực thi/);
});
