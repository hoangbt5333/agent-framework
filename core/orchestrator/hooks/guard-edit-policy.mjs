// Chính sách cho Edit/Write: Coder chỉ được sửa file thuộc owned_files của Task mình.
// Quy ước: worktree của Task nằm ở <mainRoot>/<git.worktree_dir>/<TASK-ID>/.
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hasGlob, matchesAny, normalize } from '../ownership.mjs';
import { realResolve } from './repo-root.mjs';

const ALLOW = { allow: true };
const deny = (reason, extra = {}) => ({ allow: false, reason, ...extra });
const GUIDE = 'Nếu thật sự cần sửa file này, hãy báo Orchestrator để Architect cập nhật owned_files hoặc tách Task; đừng tự vượt phạm vi.';

// Phần của khung / bằng chứng: Coder không bao giờ được sửa
export const FRAMEWORK_PATHS = ['.git', '.claude', 'orchestrator', 'state', 'logs', 'project.config.json'];
// Ở checkout chính, ngay cả Orchestrator cũng không được sửa tay (phải qua CLI/hook)
export const MAIN_PROTECTED = ['state', 'logs'];

const isInside = (rel) => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

function taskFromPath(p, base) {
  const rel = relative(base, p);
  if (!isInside(rel)) return null;
  const [taskId, ...rest] = rel.split(sep);
  return { taskId, rel: rest.join('/') };
}

/** Tìm Task đang in_progress trong state/ (ưu tiên execId nếu có, rồi file mới nhất). */
export function findActiveTask(root, taskId, execId) {
  const dir = join(root, 'state');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (execId) files = files.filter((f) => f === `${execId}.json`);
  const sorted = files.map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const { f } of sorted) {
    try {
      const state = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const task = state.tasks?.find((t) => t.id === taskId && t.status === 'in_progress');
      if (task) return { execId: state.exec_id, task };
    } catch { /* bỏ qua file hỏng */ }
  }
  return null;
}

/**
 * Trả về { allow, reason?, actor?, execId? }.
 * actor = Task của người đang sửa: lấy từ AGENT_TASK_ID (chạy riêng từng Task) hoặc từ cwd nằm trong worktree.
 */
export function evaluateEdit({ filePath, cwd, mainRoot, config, env = process.env, findTask = findActiveTask }) {
  const wtBase = realResolve(resolve(mainRoot, config.git.worktree_dir));
  const target = realResolve(resolve(cwd, filePath));
  const actor = env.AGENT_TASK_ID || taskFromPath(realResolve(cwd), wtBase)?.taskId || null;

  if (!actor) {
    // Checkout chính / phiên phát triển thường: chỉ bảo vệ state và log (đi qua CLI, không sửa tay)
    const rel = relative(realResolve(mainRoot), target);
    if (isInside(rel) && MAIN_PROTECTED.includes(rel.split(sep)[0])) {
      return deny(`"${rel.split(sep)[0]}/" do Orchestrator quản lý, không sửa tay. Dùng orchestrator/cli.mjs.`);
    }
    return ALLOW;
  }

  const where = taskFromPath(target, wtBase);
  if (!where || where.taskId !== actor) {
    return deny(`Bạn đang làm ${actor}: chỉ được sửa file trong worktree ${join(wtBase, actor)} (đích: ${target}).`, { actor });
  }
  const rel = normalize(where.rel);
  if (!rel) return deny('Không sửa thư mục gốc của worktree.', { actor });

  if (FRAMEWORK_PATHS.includes(rel.split('/')[0])) {
    return deny(`"${rel}" thuộc khung/bằng chứng (${FRAMEWORK_PATHS.join(', ')}) — Coder không được sửa.`, { actor });
  }
  if (matchesAny(rel, config.security.deny_read)) {
    return deny(`"${rel}" khớp security.deny_read (file nhạy cảm) — không được sửa.`, { actor });
  }

  const found = findTask(mainRoot, actor, env.AGENT_EXEC_ID || undefined);
  if (!found) {
    return deny(`Không thấy ${actor} ở trạng thái in_progress trong state/ (Task chưa được giao, đã xong, hoặc không đọc được state).`, { actor });
  }
  const owned = found.task.owned_files ?? [];
  if (!owned.length) return deny(`${actor} chưa khai báo owned_files nên không có quyền sửa file nào. ${GUIDE}`, { actor, execId: found.execId });

  const shared = config.ownership.shared_files ?? [];
  if (matchesAny(rel, shared) && !owned.some((p) => !hasGlob(p) && normalize(p) === rel)) {
    return deny(`"${rel}" là file dùng chung: Task phải liệt kê tường minh trong owned_files (glob rộng như "src/**" không đủ). ${GUIDE}`, { actor, execId: found.execId });
  }
  if (!matchesAny(rel, owned)) {
    return deny(`"${rel}" không thuộc owned_files của ${actor} [${owned.join(', ')}]. ${GUIDE}`, { actor, execId: found.execId });
  }
  return { allow: true, actor, execId: found.execId };
}
