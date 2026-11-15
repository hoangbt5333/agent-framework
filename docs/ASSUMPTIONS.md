# Bảng Giả định & Quy trình Kiểm chứng (ASSUMPTIONS.md)

Tài liệu này ghi nhận 4 giả định kỹ thuật cốt lõi khi tích hợp `agent-framework` với Claude Code CLI, kèm theo quy trình kiểm chứng thủ công và tự động.

---

## 1. Giả định 1: Giao thức Hook JSON qua Stdin/Stdout (Hook Protocol)

### Mô tả giả định
- Claude Code hỗ trợ các hook sự kiện: `PreToolUse`, `PostToolUse`, `SubagentStop`, `UserPromptSubmit`.
- Khi hook được kích hoạt, Claude Code truyền payload JSON qua **stdin** chứa các trường:
  - `hook_event_name`: tên sự kiện (ví dụ `PreToolUse`)
  - `tool_name`: tên công cụ (`Bash`, `Edit`, `Write`, `MultiEdit`, ...)
  - `tool_input`: tham số gọi công cụ (`command`, `file_path`, ...)
  - `cwd`: thư mục làm việc hiện tại của Agent
  - `session_id`, `tool_use_id`
- **Mã thoát (Exit Code)**:
  - `PreToolUse`: Exit `0` cho phép thực thi; Exit `2` chặn công cụ và trả nội dung `stderr` làm lý do gửi lại cho Agent (fail-closed).
  - `PostToolUse` / `SubagentStop`: Chạy ngầm để ghi log audit; luôn thoát `0` (fail-open) để không cản trở luồng công việc.

### Quy trình kiểm chứng
```bash
# Kiểm chứng chặn lệnh cấm (mong đợi: Exit 2, thông báo cấm ở stderr)
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"."}' | node orchestrator/hooks/guard-bash.mjs
echo $?

# Kiểm chứng cho qua lệnh hợp lệ (mong đợi: Exit 0, không có lỗi)
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"cwd":"."}' | node orchestrator/hooks/guard-bash.mjs
echo $?
```

---

## 2. Giả định 2: Xác định Thư mục Gốc trong Git Worktree (Worktree Path Resolution)

### Mô tả giả định
- Khi chạy song song nhiều Coder, mỗi Coder hoạt động độc lập trong một git worktree: `<git.worktree_dir>/<TASK-ID>`.
- Hook và công cụ kiểm chứng chạy từ bên trong thư mục worktree cần tìm về đúng thư mục gốc của dự án chính (chứa `state/`, `logs/`, `project.config.json`).
- Thư mục gốc được xác định tin cậy bằng lệnh `git rev-parse --git-common-dir` kết hợp biến môi trường `CLAUDE_PROJECT_DIR`.

### Quy trình kiểm chứng
```bash
# Đứng từ trong thư mục worktree của Task
cd ../wt/TASK-001

# Kiểm tra git common dir
git rev-parse --git-common-dir
# Mong đợi: đường dẫn trỏ về .git của repo chính

# Kiểm tra đường dẫn suy ra của root
node -e "const { resolveCommonRoot } = await import('./orchestrator/paths-policy.mjs'); console.log(resolveCommonRoot(process.cwd()));"
```

---

## 3. Giả định 3: Cơ chế Phân quyền & Chặn Lệnh Native trên Windows (Windows Hardening)

### Mô tả giả định
- Trên hệ điều hành Windows, Agent có thể chạy lệnh thông qua các wrapper shell:
  - `cmd.exe /c <command>`
  - `powershell.exe -Command <command>` hoặc `pwsh -c <command>`
- Agent có thể dùng các lệnh xóa native của Windows: `del`, `erase`, `rmdir`, `rd`.
- Bộ lọc `guard-policy.mjs` phải bóc tách wrapper (`cmd /c`, `powershell -c`) và chuẩn hóa đường dẫn có dấu gạch chéo ngược `\` (tránh việc `\` bị nuốt ký tự như ký tự escape trong shell).
- Các lệnh `git.exe push`, `del state\*.json`, `rmdir /s /q .git` phải bị chặn triệt để.

### Quy trình kiểm chứng
```powershell
# Chạy bộ test chuyên biệt về Windows security
node --test tests/guard.test.mjs
# Mong đợi: pass 100% tất cả các trường hợp bypass shell cmd/powershell và lệnh del/rmdir
```

---

## 4. Giả định 4: Giới hạn Thu thập Dữ liệu Token Usage từ CLI (Observability Transparency)

### Mô tả giả định
- Claude Code CLI phiên bản hiện tại không xuất dữ liệu thống kê token sử dụng hoặc chi phí chi tiết theo từng turn của Agent ra đầu ra chuẩn JSON hoặc payload hook.
- Không thể suy đoán số lượng token nếu không có nguồn sự thật tin cậy. Do đó, framework chủ động ghi nhận minh bạch trường `token_usage`: `"Nguồn dữ liệu không khả dụng từ CLI"`.
- Báo cáo tổng kết thực thi (`report-summary.mjs`) tập trung vào các chỉ số đo lường chất lượng thực tế: số lần thử (`attempts`), số vòng review (`review_rounds`), phân loại lỗi (`code` vs `environment` vs `review`), và số sự kiện vi phạm bảo mật (`guard_denied`).

### Quy trình kiểm chứng
```bash
# Xuất báo cáo tổng kết phiên thực thi
node orchestrator/cli.mjs report --exec EXEC-001 --format markdown
# Mong đợi: Báo cáo có mục 5 với dòng: "Token Usage / Chi phí: Nguồn dữ liệu không khả dụng từ CLI"
```
