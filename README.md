# agent-framework (v0.3.0)

Cấu hình dự án + state Task + Coder Completion Gate + file ownership + Hook bảo vệ (3 hook chặn, 1 hook log).
Không cần thư viện ngoài (Node >= 20). `npm test` chạy 47 test.

## Cấu trúc
- `core/orchestrator/`        config, state, ownership, validate, cli, schema-lite
- `core/orchestrator/hooks/`  guard-bash, guard-edit (chặn, fail-closed) · log-event (log, fail-open)
- `core/.claude/settings.fragment.json`  hook + permissions để GỘP vào settings.json
- `core/schemas/`, `profiles/`, `tests/`

## Cài vào dự án (thủ công, chưa có install.mjs)
1. Copy `core/orchestrator/` -> `orchestrator/`, `core/schemas/` -> `schemas/` ở gốc dự án (ngang hàng nhau).
2. Copy `profiles/angular.json` -> `project.config.json`, sửa lệnh cho khớp dự án.
3. GỘP `core/.claude/settings.fragment.json` vào `.claude/settings.json` (đừng ghi đè). Đối chiếu cú pháp hook/permissions với tài liệu Claude Code bạn dùng.
4. `.gitignore`: thêm `state/` và `logs/`.
5. Commit `orchestrator/`, `.claude/`, `project.config.json` TRƯỚC khi tạo worktree.

## Quy ước bắt buộc
- Worktree của Task nằm ở `<git.worktree_dir>/<TASK-ID>/` (mặc định `../wt/TASK-001`), tên thư mục = id Task.
  guard-edit suy ra "ai đang sửa" từ đường dẫn này (hoặc biến `AGENT_TASK_ID` khi chạy riêng từng Task).
- Thư mục gốc dự án được tìm bằng `git rev-parse --git-common-dir` nên hook chạy đúng cả từ trong worktree.

## guard-edit: luật (thứ tự kiểm tra)
Ở checkout chính (không có Task): chỉ chặn sửa tay `state/` và `logs/`.
Khi người sửa đang ở worktree của Task T:
1. Chỉ được sửa trong worktree của T (kể cả qua `..` hay symlink).
2. Không đụng `.git .claude orchestrator state logs project.config.json`, và file khớp `security.deny_read`.
3. T phải đang `in_progress` trong `state/` (không đọc được state => chặn).
4. File phải khớp `owned_files` của T.
5. File trong `ownership.shared_files` phải được liệt kê TƯỜNG MINH trong owned_files (glob như `src/**` không đủ).
Mỗi lần chặn được ghi vào `logs/<exec>/hooks.jsonl` (event `guard_denied`).

## Lệnh chính
    node orchestrator/cli.mjs check  --tasks tasks.json
    node orchestrator/cli.mjs init   --exec EXEC-001 --tasks tasks.json
    node orchestrator/cli.mjs next   --exec EXEC-001
    node orchestrator/cli.mjs move TASK-001 in_progress --exec EXEC-001 --agent coder-a
    node orchestrator/validate.mjs TASK-001 ../wt/TASK-001 --exec EXEC-001 --base integration/EXEC-001
    node orchestrator/cli.mjs status --exec EXEC-001

## Giới hạn đã biết
- guard-edit chỉ kiểm soát Edit/Write/MultiEdit/NotebookEdit. Bash vẫn ghi file được (`sed -i`, `echo >`):
  chưa có kiểm soát đường dẫn ghi cho Bash.
- Không có AGENT_EXEC_ID thì guard-edit lấy state mới nhất (theo mtime) có Task đó đang in_progress.
- Task không khai báo owned_files: kế hoạch chỉ bị cảnh báo, nhưng guard-edit chặn mọi lần sửa của Task đó.
- Chưa so khớp phân biệt hoa/thường trên Windows; chưa kiểm thử trên Windows native.
- guard-bash là so khớp chuỗi: không bắt được alias git, script tự viết, `curl | bash`, `find -delete`.
- Chưa làm: recovery khi khởi động lại, Stop hook kiểm tra báo cáo, install.mjs, execution report.
