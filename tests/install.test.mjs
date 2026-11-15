import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFramework } from '../install.mjs';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const INSTALL_SCRIPT = dir('../install.mjs');

test('installFramework: --dry-run mô phỏng cài đặt mà không tạo hay sửa đổi file', () => {
  const target = join(tmpdir(), `af-inst-dry-${Date.now()}`);

  const res = installFramework({
    targetDir: target,
    profileName: 'angular',
    dryRun: true,
  });

  assert.equal(res.success, true);
  assert.equal(res.dry_run, true);
  assert.equal(res.profile, 'angular');
  // Thư mục không được tạo ra trên ổ đĩa khi dry-run
  assert.equal(existsSync(target), false);
});

test('installFramework: cài đặt thực tế sao chép orchestrator, schemas, config và lockfile', () => {
  const target = mkdtempSync(join(tmpdir(), 'af-inst-real-'));

  const res = installFramework({
    targetDir: target,
    profileName: 'angular',
    dryRun: false,
  });

  assert.equal(res.success, true);
  assert.equal(res.dry_run, false);

  // 1. Thư mục orchestrator và schemas
  assert.equal(existsSync(join(target, 'orchestrator', 'cli.mjs')), true);
  assert.equal(existsSync(join(target, 'schemas', 'report.schema.json')), true);
  assert.equal(existsSync(join(target, 'schemas', 'reviewer-report.schema.json')), true);

  // 2. project.config.json
  const configPath = join(target, 'project.config.json');
  assert.equal(existsSync(configPath), true);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.framework_version, '0.4.0');
  assert.equal(config.git.merge_strategy, 'squash');

  // 3. CLAUDE.md
  const claudeMdPath = join(target, 'CLAUDE.md');
  assert.equal(existsSync(claudeMdPath), true);
  const claudeMd = readFileSync(claudeMdPath, 'utf8');
  assert.match(claudeMd, /agent-framework/);

  // 4. .claude/settings.json
  const settingsPath = join(target, '.claude', 'settings.json');
  assert.equal(existsSync(settingsPath), true);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(Array.isArray(settings.hooks.PreToolUse), true);

  // 5. agent-framework.lock.json
  const lockPath = join(target, 'agent-framework.lock.json');
  assert.equal(existsSync(lockPath), true);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.framework_version, '0.4.0');
  assert.equal(lock.profile, 'angular');
});

test('installFramework: gộp an toàn settings.json bảo toàn cấu hình người dùng có sẵn', () => {
  const target = mkdtempSync(join(tmpdir(), 'af-inst-merge-'));
  const claudeDir = join(target, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // Giả lập người dùng đã có settings.json với cấu hình riêng
  const initialSettings = {
    permissions: {
      allow: ['CustomTool'],
      deny: ['ForbiddenTool'],
    },
    userPreference: 'custom-value',
  };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(initialSettings, null, 2), 'utf8');

  installFramework({
    targetDir: target,
    profileName: 'node-ts',
    dryRun: false,
  });

  const mergedSettings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));

  // Bảo toàn cấu hình riêng của người dùng
  assert.equal(mergedSettings.userPreference, 'custom-value');
  assert.equal(mergedSettings.permissions.allow.includes('CustomTool'), true);
  assert.equal(mergedSettings.permissions.deny.includes('ForbiddenTool'), true);

  // Gộp thêm hooks từ framework
  assert.equal(Array.isArray(mergedSettings.hooks.PreToolUse), true);
  assert.equal(Array.isArray(mergedSettings.hooks.PostToolUse), true);
});

test('CLI: node install.mjs hỗ trợ cờ --dry-run qua dòng lệnh', () => {
  const target = join(tmpdir(), `af-inst-cli-dry-${Date.now()}`);

  const r = spawnSync(
    'node',
    [INSTALL_SCRIPT, target, '--profile', 'angular', '--dry-run'],
    { encoding: 'utf8' }
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[DRY-RUN\] Simulation completed successfully/);
  assert.equal(existsSync(target), false);
});
