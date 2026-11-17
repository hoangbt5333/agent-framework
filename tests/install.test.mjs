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
  assert.equal(lock.managed_directories.includes('.agents/skills/orchestrator'), true);
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

test('installFramework: gộp an toàn .agents/hooks.json bảo toàn custom hooks của dự án', () => {
  const target = mkdtempSync(join(tmpdir(), 'af-inst-hooks-'));
  const agentsDir = join(target, '.agents');
  mkdirSync(agentsDir, { recursive: true });

  // Giả lập dự án đã có hooks riêng của người dùng
  const initialHooks = {
    'custom-linter': {
      PostToolUse: [
        {
          matcher: 'write_file',
          hooks: [{ type: 'command', command: 'npm run lint:custom' }],
        },
      ],
    },
  };
  writeFileSync(join(agentsDir, 'hooks.json'), JSON.stringify(initialHooks, null, 2), 'utf8');

  installFramework({
    targetDir: target,
    profileName: 'angular',
    dryRun: false,
  });

  const mergedHooks = JSON.parse(readFileSync(join(agentsDir, 'hooks.json'), 'utf8'));

  // 1. Phải bảo toàn hook riêng 'custom-linter'
  assert.ok(mergedHooks['custom-linter'], 'custom-linter phải được giữ nguyên');
  assert.equal(mergedHooks['custom-linter'].PostToolUse[0].hooks[0].command, 'npm run lint:custom');

  // 2. Phải tích hợp thêm hook 'framework-guard' từ framework
  assert.ok(mergedHooks['framework-guard'], 'framework-guard phải được thêm vào');
  assert.equal(Array.isArray(mergedHooks['framework-guard'].PreToolUse), true);
  assert.equal(Array.isArray(mergedHooks['framework-guard'].Stop), true);

  // 3. Phải có hook-runner.mjs
  assert.equal(existsSync(join(agentsDir, 'hook-runner.mjs')), true);
});

test('installFramework: bảo toàn agent tùy biến trong .agents/agents/ và .claude/agents/, không bị ghi đè', () => {
  const target = mkdtempSync(join(tmpdir(), 'af-inst-agents-'));
  const agentsAgentsDir = join(target, '.agents', 'agents');
  const claudeAgentsDir = join(target, '.claude', 'agents');
  mkdirSync(agentsAgentsDir, { recursive: true });
  mkdirSync(claudeAgentsDir, { recursive: true });

  // 1. Tạo agent tùy biến trong .agents/agents/
  const customCoderContent = '# CUSTOM CODER PROMPT FOR ANGULAR PROJECT';
  writeFileSync(join(agentsAgentsDir, 'coder.md'), customCoderContent, 'utf8');

  // 2. Tạo agent tùy biến trong .claude/agents/
  const customArchitectContent = '# CUSTOM ARCHITECT PROMPT WITH FACADE PATTERN';
  writeFileSync(join(claudeAgentsDir, 'architect.md'), customArchitectContent, 'utf8');

  const res = installFramework({
    targetDir: target,
    profileName: 'angular',
    dryRun: false,
  });

  // Kiểm tra danh sách preserved
  const agentAction = res.actions.find((a) => a.action === 'install_agents');
  assert.ok(agentAction);
  assert.equal(agentAction.preserved.includes('coder.md'), true);
  assert.equal(agentAction.preserved.includes('architect.md'), true);

  // coder.md trong .agents/agents/ không bị ghi đè nội dung tùy biến
  const actualCoder = readFileSync(join(agentsAgentsDir, 'coder.md'), 'utf8');
  assert.equal(actualCoder, customCoderContent);

  // architect.md được đồng bộ từ .claude/agents/ sang .agents/agents/ với nội dung tùy biến
  const actualArchitect = readFileSync(join(agentsAgentsDir, 'architect.md'), 'utf8');
  assert.equal(actualArchitect, customArchitectContent);

  // Các agent chưa có (reviewer.md, release-agent.md, documentation-agent.md) được cài đặt mẫu
  assert.equal(agentAction.installed.includes('reviewer.md'), true);
  assert.equal(existsSync(join(agentsAgentsDir, 'reviewer.md')), true);
});

test('installFramework: chỉ cài đặt skill orchestrator và giữ nguyên các custom skills khác trong .agents/skills/', () => {
  const target = mkdtempSync(join(tmpdir(), 'af-inst-skills-'));
  const customSkillDir = join(target, '.agents', 'skills', 'custom-debugging');
  mkdirSync(customSkillDir, { recursive: true });
  writeFileSync(join(customSkillDir, 'SKILL.md'), '# Custom Debugging Skill\n', 'utf8');

  installFramework({
    targetDir: target,
    profileName: 'angular',
    dryRun: false,
  });

  // 1. Skill orchestrator được cài đặt
  assert.equal(existsSync(join(target, '.agents', 'skills', 'orchestrator', 'SKILL.md')), true);

  // 2. Skill riêng của dự án hoàn toàn nguyên vẹn
  assert.equal(existsSync(join(customSkillDir, 'SKILL.md')), true);
  const customContent = readFileSync(join(customSkillDir, 'SKILL.md'), 'utf8');
  assert.equal(customContent, '# Custom Debugging Skill\n');
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
