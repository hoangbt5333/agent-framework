# CLAUDE.md - Agent Framework (v0.4.0)

Hướng dẫn bối cảnh, quy chuẩn kỹ thuật và quy trình điều phối đa tác nhân cho Claude Code trong kho mã nguồn **agent-framework**.

---

## 1. Tổng quan & Bản sắc dự án (Project Overview)

`agent-framework` là khung điều phối phát triển phần mềm đa tác nhân (Multi-Agent Orchestration Framework) gọn nhẹ, chạy độc lập không phụ thuộc thư viện ngoài (Zero-dependency, Pure ESM, Node.js >= 20).
Khung hỗ trợ hàng đầu cho cả hai hệ sinh thái:
- **Claude Code** (`.claude/`, `settings.fragment.json`, `CLAUDE.md`)
- **Google Antigravity** (`.agents/`, `hooks.json`, `GEMINI.md`)

### Lệnh phát triển & kiểm thử chính
- **Chạy toàn bộ kiểm thử:** `node --test "tests/*.test.mjs"`
  *(Lưu ý: Không dùng `npm test` trực tiếp trên môi trường Windows PowerShell bị hạn chế ExecutionPolicy).*
- **Chạy kiểm thử đơn lẻ:** `node --test "tests/<test-name>.test.mjs"`
- **Cài đặt framework vào dự án đích:** `node install.mjs <target_dir> [--profile angular|node-ts] [--dry-run]`

---

## 2. Quy chuẩn kiến trúc & Ranh giới bất biến (Strict Constraints)

1. **Không thư viện ngoài (Zero External Dependencies):**
   - Toàn bộ mã nguồn trong `core/orchestrator/` và gốc framework CHỈ dùng các module tích hợp sẵn của Node.js (`node:fs`, `node:path`, `node:child_process`, `node:util`, `node:os`).
2. **Tương thích đa nền tảng (Windows & POSIX):**
   - Chuẩn hóa đường dẫn: Luôn xử lý dấu gạch `/` và `\` qua `path.resolve` hoặc `path.normalize`.
   - Worktree `node_modules`: Trên Windows dùng NTFS Directory Junction (`symlinkSync(..., 'junction')`), trên Unix/Linux/macOS dùng Symbolic Link (`symlinkSync(..., 'dir')`).
   - Xử lý ngắt dòng CRLF (`\r\n`) trong `git status` và `git diff`.
3. **Triết lý bảo mật:**
   - **Fail-closed (exit 2):** Các chốt bảo vệ an toàn (`guard-edit`, `guard-bash`, kiểm tra tính toàn vẹn trạng thái) BẮT BUỘC thoát mã lỗi `2` khi vi phạm hoặc dữ liệu bị thiếu/sai lệch.
   - **Fail-open (exit 0):** Nhật ký và ghi nhận telemetry (`log-event`, tích hợp Jira MCP) không bao giờ được làm gián đoạn luồng làm việc của lập trình viên khi gặp sự cố mạng/ngoại vi.
   - **Secret Redaction:** Tự động che giấu mật khẩu, token, khóa bí mật (`.env*`, `.pem`, `.key`) thành `[REDACTED]` trước khi ghi log hoặc hiển thị.

---

## 3. Quy trình điều phối đa tác nhân (Multi-Agent Workflow Rules)

<!-- framework:start -->
### Canonical Orchestration Commands
- **Khởi tạo Execution:** `node orchestrator/cli.mjs init --exec <id> --tasks tasks.json`
- **Tạo Task Worktree:** `node orchestrator/cli.mjs worktree <task_id> --exec <id>` *(tự động tạo worktree từ nhánh integration/<id>, liên kết node_modules qua Junction/Symlink, tự động reset nhánh cũ nếu stale, và chuyển task sang in_progress)*
- **Kiểm định Coder Gate:** `node orchestrator/validate.mjs <task_id> ../wt/<task_id> --exec <id> --base integration/<id>` *(kiểm tra git_clean, new_commit, build, typecheck, lint, unit_test và xuất bằng chứng result.json)*
- **Bàn giao Task:** Coder tạo `.task-report.json` trong worktree với `result: "READY_FOR_REVIEW"`.
- **Ghi nhận Review:** `node orchestrator/cli.mjs review-record <task_id> --exec <id> --verdict APPROVED` *(tự động chuyển task từ in_progress sang ready_for_review)*
- **Tích hợp Task:** `node orchestrator/cli.mjs integrate <task_id> --exec <id> --clean-worktree` *(tự động autostash, merge vào integration/<id>, chạy Integration Gate, dọn dẹp worktree và khôi phục stash)*
- **Báo cáo Tổng kết:** `node orchestrator/cli.mjs report --exec <id> --format markdown`
- **Tự động Phục hồi:** `node orchestrator/cli.mjs recover --exec <id>`

### Nguyên tắc Điều phối Song song (Parallel Dispatching)
Khi `node orchestrator/cli.mjs next --exec <id>` trả về nhiều task sẵn sàng trong mảng `ready` (không có dependency và không trùng `owned_files`):
1. **Khởi tạo đồng thời:** Tạo worktree cho toàn bộ các task sẵn sàng.
2. **Ủy quyền song song:** Gọi đồng thời (batch) các subagent Coder trong cùng một lượt xử lý.
3. **Không chờ tuần tự:** Tuyệt đối không chờ Task 1 hoàn tất tích hợp mới bắt đầu Task 2 nếu hai task độc lập.

### Task Scope & Guardrails
- Coder làm việc strictly trong worktree `../wt/<task_id>`, chỉ sửa các file được phân quyền trong `owned_files`.
- Không được sửa file khung (`orchestrator/`, `state/`, `logs/`, `.claude/`, `.agents/`, `project.config.json`).
- Mọi thao tác ngoài worktree hoặc chạy lệnh nguy hiểm (`git push`, `rm -rf`) sẽ bị Hook chặn ngay lập tức.
<!-- framework:end -->

---

## 4. Cấu trúc thư mục kho mã nguồn

- `core/orchestrator/`:
  - `cli.mjs`: Bộ điều phối CLI trung tâm.
  - `init.mjs`, `worktree.mjs`, `state.mjs`, `dag.mjs`, `ownership.mjs`.
  - `validate.mjs`: Bộ kiểm định Coder Gate tự động.
  - `integrate.mjs`: Tích hợp tự động, xử lý autostash và dọn dẹp worktree.
  - `recover.mjs`: Tự động phục hồi trạng thái từ 5 nguồn sự thật khi có gián đoạn.
  - `report.mjs`: Xuất báo cáo đợt thực thi (Markdown / JSON).
  - `paths-policy.mjs`: Xử lý đường dẫn và liên kết `node_modules` (Junction trên Windows).
- `core/orchestrator/hooks/`:
  - `guard-edit.mjs`: Chặn sửa file ngoài worktree hoặc ngoài `owned_files`.
  - `guard-bash.mjs`: Chặn các lệnh nguy hiểm (Windows native commands, shell bypass, git push).
  - `guard-handoff.mjs`: Kiểm chứng bàn giao `.task-report.json`, git diff và bằng chứng.
  - `hook-adapter.mjs`: Cầu nối thích ứng sự kiện giữa Claude Code CLI và Antigravity.
  - `log-event.mjs`: Ghi audit log vào `logs/<exec>/hooks.jsonl`.
- `core/.claude/` & `core/.agents/`: Cấu hình hook runner cho Claude Code và Antigravity.
- `templates/`: Mẫu `CLAUDE.md.tmpl` và `GEMINI.md.tmpl` được dùng khi cài vào dự án khác.
- `tests/`: Bộ kiểm thử toàn diện với 94 test cases (`node:test`).
- `install.mjs`: Kịch bản cài đặt tự động an toàn vào dự án đích.
