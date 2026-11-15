import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_DIR = import.meta.dirname;
const FRAMEWORK_VERSION = fs.readFileSync(path.resolve(SCRIPT_DIR, 'VERSION'), 'utf8').trim();

/**
 * Deep merge objects (arrays concatenated and deduplicated)
 */
function mergeDeep(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (Array.isArray(source[key])) {
      const existing = Array.isArray(target[key]) ? target[key] : [];
      output[key] = Array.from(new Set([...existing, ...source[key]]));
    } else if (source[key] && typeof source[key] === 'object') {
      output[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

/**
 * Copy directory recursively
 */
function copyDirSync(src, dest, recordedFiles = [], { dryRun = false } = {}) {
  if (!dryRun && !fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, recordedFiles, { dryRun });
    } else {
      if (!dryRun) {
        fs.copyFileSync(srcPath, destPath);
      }
      recordedFiles.push(destPath);
    }
  }
  return recordedFiles;
}

/**
 * Update or inject CLAUDE.md framework section
 */
function updateClaudeMd(targetDir, projectName, baseBranch, { dryRun = false } = {}) {
  const claudeMdPath = path.resolve(targetDir, 'CLAUDE.md');
  const tmplPath = path.resolve(SCRIPT_DIR, 'templates', 'CLAUDE.md.tmpl');
  const tmplContent = fs.readFileSync(tmplPath, 'utf8')
    .replaceAll('{{FRAMEWORK_VERSION}}', FRAMEWORK_VERSION)
    .replaceAll('{{PROJECT_NAME}}', projectName)
    .replaceAll('{{BASE_BRANCH}}', baseBranch);

  const startMarker = '<!-- framework:start -->';
  const endMarker = '<!-- framework:end -->';

  const tmplFrameworkSection = tmplContent.substring(
    tmplContent.indexOf(startMarker),
    tmplContent.indexOf(endMarker) + endMarker.length
  );

  if (!fs.existsSync(claudeMdPath)) {
    if (!dryRun) fs.writeFileSync(claudeMdPath, tmplContent, 'utf8');
    return 'created';
  }

  const currentContent = fs.readFileSync(claudeMdPath, 'utf8');
  if (currentContent.includes(startMarker) && currentContent.includes(endMarker)) {
    const before = currentContent.substring(0, currentContent.indexOf(startMarker));
    const after = currentContent.substring(currentContent.indexOf(endMarker) + endMarker.length);
    if (!dryRun) fs.writeFileSync(claudeMdPath, `${before}${tmplFrameworkSection}${after}`, 'utf8');
    return 'updated_framework_section';
  } else {
    // Prepend framework section if no markers found
    if (!dryRun) fs.writeFileSync(claudeMdPath, `${tmplFrameworkSection}\n\n${currentContent}`, 'utf8');
    return 'prepended_framework_section';
  }
}

/**
 * Merge settings.fragment.json into target .claude/settings.json
 */
function mergeSettings(targetDir, { dryRun = false } = {}) {
  const fragmentPath = path.resolve(SCRIPT_DIR, 'core', '.claude', 'settings.fragment.json');
  if (!fs.existsSync(fragmentPath)) return null;

  const targetClaudeDir = path.resolve(targetDir, '.claude');
  const targetSettingsPath = path.resolve(targetClaudeDir, 'settings.json');
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'));

  let existing = {};
  if (fs.existsSync(targetSettingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(targetSettingsPath, 'utf8'));
    } catch (_) {
      existing = {};
    }
  }

  const merged = mergeDeep(existing, fragment);
  if (!dryRun) {
    if (!fs.existsSync(targetClaudeDir)) {
      fs.mkdirSync(targetClaudeDir, { recursive: true });
    }
    fs.writeFileSync(targetSettingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }
  return merged;
}

/**
 * Update target .gitignore with framework temporary folders
 */
function updateGitignore(targetDir, { dryRun = false } = {}) {
  const gitignorePath = path.resolve(targetDir, '.gitignore');
  const entriesToAdd = ['state/', 'logs/'];

  let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = content.split('\n').map((l) => l.trim());

  let added = false;
  for (const entry of entriesToAdd) {
    if (!lines.includes(entry)) {
      if (!added && content.length > 0 && !content.endsWith('\n')) {
        content += '\n';
      }
      content += `${entry}\n`;
      added = true;
    }
  }

  if (added && !dryRun) {
    fs.writeFileSync(gitignorePath, content, 'utf8');
  }
  return { added, entries: entriesToAdd };
}

/**
 * Main install / upgrade runner
 */
export function installFramework({
  targetDir,
  profileName = 'angular',
  forceConfig = false,
  dryRun = false,
}) {
  if (!targetDir) {
    throw new Error('targetDir is required');
  }

  const resolvedTarget = path.resolve(targetDir);
  if (!dryRun && !fs.existsSync(resolvedTarget)) {
    fs.mkdirSync(resolvedTarget, { recursive: true });
  }

  const prefix = dryRun ? '[agent-framework] [DRY-RUN]' : '[agent-framework]';
  console.log(`${prefix} Installing v${FRAMEWORK_VERSION} into: ${resolvedTarget}`);

  const copiedFiles = [];
  const actions = [];

  // 1. Copy core/orchestrator -> <target>/orchestrator
  const srcOrchestrator = path.resolve(SCRIPT_DIR, 'core', 'orchestrator');
  const destOrchestrator = path.resolve(resolvedTarget, 'orchestrator');
  copyDirSync(srcOrchestrator, destOrchestrator, copiedFiles, { dryRun });
  actions.push({ action: 'copy_orchestrator', count: copiedFiles.length });

  // 2. Copy core/schemas -> <target>/schemas
  const schemaFiles = [];
  const srcSchemas = path.resolve(SCRIPT_DIR, 'core', 'schemas');
  const destSchemas = path.resolve(resolvedTarget, 'schemas');
  copyDirSync(srcSchemas, destSchemas, schemaFiles, { dryRun });
  actions.push({ action: 'copy_schemas', count: schemaFiles.length });

  // 3. Initialize project.config.json if not present or forced
  const targetConfigPath = path.resolve(resolvedTarget, 'project.config.json');
  let projectName = path.basename(resolvedTarget);
  let baseBranch = 'main';

  if (!fs.existsSync(targetConfigPath) || forceConfig) {
    const profileFile = path.resolve(SCRIPT_DIR, 'profiles', `${profileName}.json`);
    if (!fs.existsSync(profileFile)) {
      throw new Error(`Profile "${profileName}" not found at ${profileFile}`);
    }
    const profileData = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    profileData.project.name = projectName;
    baseBranch = profileData.project.base_branch || 'main';
    if (!dryRun) {
      fs.writeFileSync(targetConfigPath, JSON.stringify(profileData, null, 2) + '\n', 'utf8');
    }
    console.log(`  + Created project.config.json from profile: ${profileName}`);
    actions.push({ action: 'create_config', profile: profileName });
  } else {
    try {
      const existing = JSON.parse(fs.readFileSync(targetConfigPath, 'utf8'));
      projectName = existing.project?.name || projectName;
      baseBranch = existing.project?.base_branch || 'main';
    } catch (_) {}
    console.log(`  = Preserved existing project.config.json`);
    actions.push({ action: 'preserve_config' });
  }

  // 4. Update CLAUDE.md
  const claudeResult = updateClaudeMd(resolvedTarget, projectName, baseBranch, { dryRun });
  console.log(`  + CLAUDE.md (${claudeResult})`);
  actions.push({ action: 'claude_md', status: claudeResult });

  // 5. Merge settings.fragment.json
  const mergedSettings = mergeSettings(resolvedTarget, { dryRun });
  console.log(`  + Merged .claude/settings.json`);
  actions.push({ action: 'merge_settings' });

  // 6. Update .gitignore
  const gitignoreResult = updateGitignore(resolvedTarget, { dryRun });
  actions.push({ action: 'gitignore', added: gitignoreResult.added });

  // 7. Write lockfile
  const lockData = {
    framework_version: FRAMEWORK_VERSION,
    installed_at: new Date().toISOString(),
    profile: profileName,
    managed_directories: ['orchestrator', 'schemas'],
  };
  if (!dryRun) {
    fs.writeFileSync(
      path.resolve(resolvedTarget, 'agent-framework.lock.json'),
      JSON.stringify(lockData, null, 2) + '\n',
      'utf8'
    );
    console.log(`  + Generated agent-framework.lock.json (v${FRAMEWORK_VERSION})`);
    console.log(`[agent-framework] Installation completed successfully.`);
  } else {
    console.log(`[agent-framework] [DRY-RUN] Simulation completed successfully. No files written.`);
  }

  return {
    success: true,
    dry_run: dryRun,
    version: FRAMEWORK_VERSION,
    target_dir: resolvedTarget,
    profile: profileName,
    actions,
  };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const targetDir = args.find((a) => !a.startsWith('-')) || '.';
  const profileIdx = args.indexOf('--profile');
  const profileName = profileIdx !== -1 && args[profileIdx + 1] ? args[profileIdx + 1] : 'angular';
  const forceConfig = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  try {
    installFramework({ targetDir, profileName, forceConfig, dryRun });
  } catch (err) {
    console.error(`[agent-framework] Installation failed: ${err.message}`);
    process.exit(1);
  }
}
