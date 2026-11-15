# agent-framework (v0.4.0)

Cấu hình dự án + state Task + Coder Completion Gate + file ownership + Hook bảo vệ (3 hook chặn, 1 hook log) + Tích hợp tự động (integrate).
Không cần thư viện ngoài (Node >= 20). `npm test` chạy 69 test.

## Cấu trúc
- `core/orchestrator/`        config, state, ownership, validate, report, integrate, cli, schema-lite
- `core/orchestrator/hooks/`  guard-bash, guard-edit (chặn, fail-closed) · guard-handoff (cổng chất lượng, fail-open) · log-event (log, fail-open)
- `core/.claude/settings.fragment.json`  hook + permissions để GỘP vào settings.json
- `core/schemas/`, `profiles/`, `tests/`

## Cài vào dự án
1. Dùng lệnh cài đặt tự động: `node install.mjs <target_dir> [--profile angular|node-ts] [--dry-run]`
   - `--dry-run`: mô phỏng cài đặt, kiểm tra các thao tác mà không ghi đè bất kỳ file nào.
   - Tự động sao chép `orchestrator/`, `schemas/`, khởi tạo `project.config.json`, cập nhật `CLAUDE.md`, gộp an toàn `.claude/settings.json`, và sinh `agent-framework.lock.json`.
2. Hoặc cài thủ công:
   - Copy `core/orchestrator/` -> `orchestrator/`, `core/schemas/` -> `schemas/` ở gốc dự án.
   - Copy `profiles/angular.json` -> `project.config.json`, sửa lệnh cho khớp dự án.
   - GỘP `core/.claude/settings.fragment.json` vào `.claude/settings.json` (đừng ghi đè).
   - `.gitignore`: thêm `state/` và `logs/`.
   - Commit `orchestrator/`, `.claude/`, `project.config.json` TRƯỚC khi tạo worktree.

## Quy ước bắt buộc
- Worktree của Task nằm ở `<git.worktree_dir>/<TASK-ID>/` (mặc định `../wt/TASK-001`), tên thư mục = id Task.
  guard-edit suy ra "ai đang sửa" từ đường dẫn này (hoặc biến `AGENT_TASK_ID` khi chạy riêng từng Task).
- Thư mục gốc dự án được tìm bằng `git rev-parse --git-common-dir` nên hook chạy đúng cả từ trong worktree.
- Nhánh tích hợp: `<git.integration_branch_prefix><exec_id>` (mặc định `integration/<exec_id>`). Merge vào `main` cần người duyệt qua PR.
- Xử lý tương thích Windows: chuẩn hóa ngắt dòng CRLF (`\r\n`) trong `git status` và `git diff`.

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
    node orchestrator/cli.mjs brief  TASK-001 --exec EXEC-001
    node orchestrator/cli.mjs move   TASK-001 in_progress --exec EXEC-001 --agent coder
    node orchestrator/validate.mjs   TASK-001 ../wt/TASK-001 --exec EXEC-001 --base integration/EXEC-001
    node orchestrator/cli.mjs report-check TASK-001 --exec EXEC-001
    node orchestrator/cli.mjs review-record TASK-001 --exec EXEC-001 --verdict APPROVED
    node orchestrator/cli.mjs recover      --exec EXEC-001
    node orchestrator/cli.mjs report       --exec EXEC-001 [--format markdown|json]
    node orchestrator/cli.mjs integrate    TASK-001 --exec EXEC-001
    node orchestrator/cli.mjs status --exec EXEC-001

## Phục hồi & Độ tin cậy (H2)
- **Review Rounds & Gating**: Quản lý vòng phản hồi của Reviewer độc lập với attempts của Coder. Vượt quá `limits.max_review_rounds` (mặc định 2) sẽ tự động chuyển Task sang `blocked` và đánh dấu `needs_human: true`.
- **Tự động phục hồi (recover)**: Đối chiếu 5 nguồn sự thật (State JSON, worktree git status, git log, validation evidence, execution log) khi Orchestrator hoặc Coder bị crash/ngắt quãng.
  - File dở dang chưa commit -> bảo lưu trong `in_progress`.
  - Không có commit mới -> đặt lại `pending` và tăng `attempts`.
  - Có commit mới kèm evidence hợp lệ -> tự động chuyển `ready_for_review`.
  - Có commit nhưng chưa chạy gate -> tự động chạy gate để kiểm chứng.
  - Lỗi môi trường (timeout, disk) -> thử lại có backoff, không trừ attempts của Coder.
- **Circuit Breaker**: Khi xảy ra 3 thất bại liên tiếp (`consecutive_failures >= 3`), hệ thống tự động ngắt điều phối (`circuit_breaker_tripped = true`), ngăn vòng lặp tiêu tốn tài nguyên và thông báo deadlock cần can thiệp.

## Quan sát & Báo cáo Tổng kết (H3)
- **Báo cáo Thực thi (Execution Summary Report)**: Tự động tổng hợp dữ liệu từ `state/<exec_id>.json` và `logs/<exec_id>/hooks.jsonl` ra định dạng Markdown hoặc JSON.
- **Chỉ số theo dõi**:
  - Tiến độ, tỷ lệ hoàn thành (completion rate).
  - Vòng đời Task, số lần thử (`attempts`), số vòng review (`review_rounds`).
  - Phân loại nguyên nhân lỗi (`code` vs `environment` vs `review`).
  - Lịch sử vi phạm bảo mật bị chặn (`guard_denied`) với cơ chế tự động che secret (`[REDACTED]`).
  - Trạng thái tích hợp Jira MCP (đồng bộ hoặc bỏ qua fail-open).
  - Minh bạch về Token Usage: ghi chú rõ `Nguồn dữ liệu không khả dụng từ CLI` do hạn chế trích xuất trực tiếp từ Claude Code CLI transcript.

## Bảo vệ Windows Native & Schema Reviewer (H4)
- **Làm cứng bảo mật trên Windows**:
  - Tự động bóc tách và phân tích các wrapper shell: `cmd.exe /c`, `powershell.exe -Command`, `pwsh -c`.
  - Chặn các lệnh xóa native nguy hiểm của Windows: `del`, `erase`, `rmdir`, `rd`, `Remove-Item` khi tác động ra ngoài worktree hoặc vào thư mục nhạy cảm (`.git`, `state/`, `logs/`, `orchestrator/`).
  - Xử lý tương thích đường dẫn `\` trong tokenizer, ngăn chặn kỹ thuật bypass bằng ký tự escape.
- **Schema & Giả định**:
  - `core/schemas/reviewer-report.schema.json`: đặc tả JSON Schema kiểm chứng báo cáo đánh giá của Reviewer (`APPROVED` / `CHANGES_REQUESTED`, checklist AC, findings phân loại theo mức độ nghiêm trọng).
  - `docs/ASSUMPTIONS.md`: tài liệu hóa 4 giả định kỹ thuật về Claude Code kèm hướng dẫn kiểm chứng độc lập.

## Giới hạn đã biết
- guard-edit chỉ kiểm soát Edit/Write/MultiEdit/NotebookEdit. Bash vẫn ghi file được (`sed -i`, `echo >`):
  đã có kiểm soát đối chiếu `git diff` ở chốt chặn bàn giao (report-check và integrate).
- Không có AGENT_EXEC_ID thì guard-edit lấy state mới nhất (theo mtime) có Task đó đang in_progress.
- Task không khai báo owned_files: kế hoạch chỉ bị cảnh báo, nhưng guard-edit chặn mọi lần sửa của Task đó.
- guard-bash là so khớp chuỗi tokenized: chưa bắt được alias git tinh vi, script tự viết hoặc `curl | bash`.
