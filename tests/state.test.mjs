import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createState, validateDag, transition, readyTasks, detectDeadlock,
  saveState, loadState, updateState, StateError, statePath,
} from '../core/orchestrator/state.mjs';

const dag = () => [
  { id: 'T1', depends_on: [] },
  { id: 'T2', depends_on: [] },
  { id: 'T3', depends_on: ['T1', 'T2'] },
  { id: 'T4', depends_on: ['T3'] },
];
const mk = (tasks = dag()) => createState({ execId: 'E1', tasks, maxAttempts: 2 });

test('DAG: phát hiện chu trình, dependency thiếu, trùng id', () => {
  assert.match(validateDag([{ id: 'A', depends_on: ['B'] }, { id: 'B', depends_on: ['A'] }]).errors[0], /chu trình/);
  assert.match(validateDag([{ id: 'A', depends_on: ['X'] }]).errors[0], /không tồn tại/);
  assert.match(validateDag([{ id: 'A' }, { id: 'A' }]).errors[0], /Trùng id/);
  assert.deepEqual(validateDag(dag()).order.slice(-2), ['T3', 'T4']);
  assert.throws(() => mk([{ id: 'A', depends_on: ['A'] }]), StateError);
});

test('chỉ Task đủ dependency mới sẵn sàng, tôn trọng max_parallel', () => {
  const s = mk();
  assert.deepEqual(readyTasks(s, 3).map((t) => t.id), ['T1', 'T2']);
  assert.deepEqual(readyTasks(s, 1).map((t) => t.id), ['T1']);
  transition(s, 'T1', 'in_progress');
  assert.deepEqual(readyTasks(s, 1).map((t) => t.id), []); // hết chỗ
  assert.deepEqual(readyTasks(s, 2).map((t) => t.id), ['T2']);
});

test('không giao Task khi dependency chưa completed', () => {
  const s = mk();
  assert.throws(() => transition(s, 'T3', 'in_progress'), /dependency chưa completed/);
});

test('chuyển trạng thái không hợp lệ bị chặn; READY_FOR_REVIEW khác COMPLETED', () => {
  const s = mk();
  assert.throws(() => transition(s, 'T1', 'completed'), /không được chuyển/);
  transition(s, 'T1', 'in_progress', { agent: 'coder-a' });
  assert.throws(() => transition(s, 'T1', 'completed'), /không được chuyển/); // phải qua review
  transition(s, 'T1', 'ready_for_review');
  transition(s, 'T1', 'completed');
  assert.equal(s.tasks[0].status, 'completed');
  assert.equal(s.history.length, 3);
});

test('hết max_attempts thì không giao lại', () => {
  const s = mk();
  for (let i = 0; i < 2; i++) { transition(s, 'T1', 'in_progress'); transition(s, 'T1', 'pending'); } // phục hồi
  assert.equal(s.tasks[0].attempts, 2);
  assert.throws(() => transition(s, 'T1', 'in_progress'), /hết 2 lần thử/);
});

test('phát hiện deadlock khi dependency failed', () => {
  const s = mk();
  transition(s, 'T1', 'in_progress'); transition(s, 'T1', 'failed');
  transition(s, 'T2', 'in_progress'); transition(s, 'T2', 'ready_for_review'); transition(s, 'T2', 'completed');
  const d = detectDeadlock(s);
  assert.equal(d.deadlock, true);
  assert.match(d.stuck.find((x) => x.id === 'T3').reason, /T1\(failed\)/);
  assert.equal(detectDeadlock(mk()).deadlock, false);
});

test('state ghi ra file, đọc lại được, không để lại file tạm', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-state-'));
  saveState(root, mk());
  updateState(root, 'E1', (s) => transition(s, 'T1', 'in_progress', { agent: 'coder-a' }));
  const back = loadState(root, 'E1');
  assert.equal(back.tasks[0].status, 'in_progress');
  assert.equal(back.tasks[0].assigned_to, 'coder-a');
  assert.deepEqual(readdirSync(join(root, 'state')), ['E1.json']);
  assert.throws(() => loadState(root, 'NOPE'), StateError);
  assert.ok(statePath(root, 'E1').endsWith('E1.json'));
});
