import test from 'node:test';
import assert from 'node:assert/strict';
import { patternsOverlap, planCheck, dependsOn } from '../core/orchestrator/ownership.mjs';
import { createState, readyTasks, transition } from '../core/orchestrator/state.mjs';

test('patternsOverlap: file, thư mục, glob', () => {
  assert.equal(patternsOverlap('src/a.ts', 'src/a.ts'), true);
  assert.equal(patternsOverlap('src/a.ts', 'src/b.ts'), false);
  assert.equal(patternsOverlap('src/course/**', 'src/course/a.ts'), true);
  assert.equal(patternsOverlap('src/course/**', 'src/courses/a.ts'), false); // course != courses
  assert.equal(patternsOverlap('src/course', 'src/course/a.ts'), true);       // đường dẫn thuần coi như thư mục
  assert.equal(patternsOverlap('src/course/**', 'src/course/sub/**'), true);
  assert.equal(patternsOverlap('src/user/**', 'src/course/**'), false);
  assert.equal(patternsOverlap('./src\\a.ts', 'src/a.ts'), true);              // chuẩn hóa đường dẫn
  assert.equal(patternsOverlap('**/*.spec.ts', 'src/a.ts'), true);             // bảo thủ: glob gốc khớp mọi thứ
});

test('planCheck: báo lỗi khi Task song song trùng file, bỏ qua khi đã tuần tự', () => {
  const parallel = [
    { id: 'A', owned_files: ['src/user/**'] },
    { id: 'B', owned_files: ['src/user/user.service.ts'] },
    { id: 'C', owned_files: ['src/course/**'] },
  ];
  const r = planCheck(parallel, { sharedFiles: ['src/user/user.service.ts'] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /A và B/);
  assert.match(r.errors[0], /file dùng chung/);

  const serial = parallel.map((t) => (t.id === 'B' ? { ...t, depends_on: ['A'] } : t));
  assert.deepEqual(planCheck(serial).errors, []);

  // phụ thuộc gián tiếp cũng tính
  const chain = [
    { id: 'A', owned_files: ['x/**'] }, { id: 'M', depends_on: ['A'], owned_files: ['m/**'] },
    { id: 'B', depends_on: ['M'], owned_files: ['x/f.ts'] },
  ];
  assert.equal(dependsOn(chain, 'B', 'A'), true);
  assert.deepEqual(planCheck(chain).errors, []);
});

test('planCheck: cảnh báo Task thiếu owned_files', () => {
  assert.match(planCheck([{ id: 'A' }]).warnings[0], /A: chưa khai báo owned_files/);
});

test('readyTasks: không giao Task trùng file với Task đang giữ file', () => {
  const s = createState({ execId: 'E', tasks: [
    { id: 'A', owned_files: ['src/user/**'] },
    { id: 'B', owned_files: ['src/user/x.ts'] },   // trùng A (cố tình, không có depends_on)
    { id: 'C', owned_files: ['src/course/**'] },
  ] });
  assert.deepEqual(readyTasks(s, 3).map((t) => t.id), ['A', 'C']);   // B bị loại ngay trong cùng lượt
  transition(s, 'A', 'in_progress');
  assert.deepEqual(readyTasks(s, 3).map((t) => t.id), ['C']);        // A đang giữ file
  transition(s, 'A', 'ready_for_review');
  assert.deepEqual(readyTasks(s, 3).map((t) => t.id), ['C']);        // chờ review vẫn giữ file
  transition(s, 'A', 'completed');
  assert.deepEqual(readyTasks(s, 3).map((t) => t.id), ['B', 'C']);   // completed thì nhả file
});
