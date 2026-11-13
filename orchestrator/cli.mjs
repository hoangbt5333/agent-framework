#!/usr/bin/env node
// CLI mỏng để skill/Agent gọi, thay vì tự sửa file state.
//   node cli.mjs check  --tasks tasks.json                 (kiểm tra kế hoạch: trùng owned_files)
//   node cli.mjs init   --exec E1 --tasks tasks.json [--force] [--allow-conflicts]
//   node cli.mjs next   --exec E1
//   node cli.mjs move   <TASK> <status> --exec E1 [--agent coder-a] [--note "..."]
//   node cli.mjs status --exec E1
// Exit code: 0 ok, 1 kế hoạch có xung đột (check), 2 lỗi sử dụng/cấu hình/state.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import {
  createState, saveState, loadState, updateState, transition,
  readyTasks, detectDeadlock, statePath,
} from './state.mjs';
import { planCheck } from './ownership.mjs';

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    exec: { type: 'string' }, root: { type: 'string', default: process.cwd() },
    tasks: { type: 'string' }, agent: { type: 'string' }, note: { type: 'string' },
    force: { type: 'boolean', default: false },
    'allow-conflicts': { type: 'boolean', default: false },
  },
});
const root = resolve(values.root);
const out = (obj) => console.log(JSON.stringify(obj, null, 2));
const readTasks = () => {
  if (!values.tasks) throw new Error('Thiếu --tasks <file>');
  const parsed = JSON.parse(readFileSync(resolve(values.tasks), 'utf8'));
  return parsed.tasks ?? parsed;
};

try {
  if (!['check', 'init', 'next', 'move', 'status'].includes(command)) throw new Error('Lệnh: check | init | next | move | status');
  if (command !== 'check' && !values.exec) throw new Error('Thiếu --exec <exec_id>');
  const config = loadConfig(root);

  if (command === 'check') {
    const result = planCheck(readTasks(), { sharedFiles: config.ownership.shared_files });
    out(result);
    process.exit(result.errors.length ? 1 : 0);
  } else if (command === 'init') {
    if (existsSync(statePath(root, values.exec)) && !values.force) throw new Error(`State ${values.exec} đã tồn tại (dùng --force để ghi đè)`);
    const tasks = readTasks();
    const plan = planCheck(tasks, { sharedFiles: config.ownership.shared_files });
    if (plan.errors.length && !values['allow-conflicts']) {
      throw new Error(`Kế hoạch có xung đột file:\n  - ${plan.errors.join('\n  - ')}`);
    }
    const state = createState({ execId: values.exec, tasks, maxAttempts: config.limits.max_attempts });
    saveState(root, state);
    out({ ok: true, exec_id: state.exec_id, tasks: state.tasks.length, warnings: plan.warnings, conflicts: plan.errors });
  } else if (command === 'next') {
    const state = loadState(root, values.exec);
    out({ ready: readyTasks(state, config.limits.max_parallel).map((t) => t.id), ...detectDeadlock(state) });
  } else if (command === 'move') {
    const [taskId, to] = positionals;
    if (!taskId || !to) throw new Error('Dùng: move <TASK> <status> --exec <id>');
    updateState(root, values.exec, (s) => transition(s, taskId, to, { agent: values.agent, note: values.note }));
    out({ ok: true, task_id: taskId, status: to });
  } else {
    const state = loadState(root, values.exec);
    out({ exec_id: state.exec_id, tasks: state.tasks.map((t) => ({ id: t.id, status: t.status, attempts: t.attempts, assigned_to: t.assigned_to })), ...detectDeadlock(state) });
  }
} catch (e) {
  console.error(`Lỗi: ${e.message}`);
  process.exit(2);
}
