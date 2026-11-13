import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../core/orchestrator/schema-lite.mjs';
import { loadConfig, ConfigError } from '../core/orchestrator/config.mjs';

const angular = readFileSync(new URL('../profiles/angular.json', import.meta.url), 'utf8');
const tmpProject = (obj) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-cfg-'));
  writeFileSync(join(dir, 'project.config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  return dir;
};

test('schema-lite: kiểu, required, trường lạ', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer', minimum: 1 } } };
  assert.deepEqual(validate({ a: 2 }, schema), []);
  assert.equal(validate({}, schema).length, 1);
  assert.equal(validate({ a: 0 }, schema).length, 1);
  assert.equal(validate({ a: 1, b: 2 }, schema).length, 1);
  assert.equal(validate({ a: 'x' }, schema).length, 1);
});

test('profile angular hợp lệ và được áp mặc định', () => {
  const cfg = loadConfig(tmpProject(angular));
  assert.equal(cfg.limits.max_review_rounds, 2);
  assert.equal(cfg.commands.build.required, true);
});

test('thiếu section tùy chọn thì dùng mặc định', () => {
  const cfg = loadConfig(tmpProject({ framework_version: '0.1.0', project: { name: 'x', base_branch: 'main' }, commands: {} }));
  assert.equal(cfg.limits.max_parallel, 3);
});

test('sai chính tả trường bị từ chối', () => {
  const bad = JSON.parse(angular);
  bad.limits.max_atempts = 3;
  assert.throws(() => loadConfig(tmpProject(bad)), (e) => e instanceof ConfigError && /max_atempts/.test(e.message));
});

test('thiếu file / JSON hỏng bị từ chối', () => {
  assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), 'af-empty-'))), ConfigError);
  assert.throws(() => loadConfig(tmpProject('{oops')), ConfigError);
});
