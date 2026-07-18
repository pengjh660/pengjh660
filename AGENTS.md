# 仓库 Agent 合约

面向 AI 编码代理的紧凑指引。除非另有说明，默认遵循标准 TypeScript/Bun 惯例。此处每一条都是没有帮助就容易遗漏的仓库特定上下文。

## 如何启动
- `./bin/claude-haha` 或 `bun run start` — CLI 入口（`src/entrypoints/cli.tsx`）
- `cd desktop && bun run dev` — 桌面前端（端口 1420, Vite + React 18 + Tailwind CSS v4）
- `SERVER_PORT=3456 bun run src/server/index.ts` — 桌面端依赖的本地 API/WebSocket 服务
- 安装依赖：根目录、`desktop/`、`adapters/` 各自需要 `bun install`（独立 workspace）
- `cp .env.example .env` — 第三方提供商配置（MiniMax、LiteLLM 代理、OpenRouter、Azure）

## 预加载与启动机制
- `bunfig.toml` 预加载 `preload.ts`：设置 `globalThis.MACRO` + 自动 `chdir` 到 `CALLER_DIR`
- `bin/claude-haha` 导出 `CALLER_DIR`（启动时的 CWD），支持 `CC_HAHA_SKIP_DOTENV=1` 和 `CLAUDE_CODE_FORCE_RECOVERY_CLI=1`
- `stubs/` 下的桩文件替代缺失的原生模块：`@ant/claude-for-chrome-mcp` 和 `color-diff-napi`（通过根 `tsconfig.json` paths 映射）
- 适配器 tsconfig 额外添加 `@server/*` → `../src/server/*`

## 项目结构
| 路径 | 内容 |
|---|---|
| `src/` | CLI 运行时：入口、Ink TUI（screens/components）、服务（API/MCP/OAuth）、工具、服务器（WebSocket）、命令 |
| `desktop/` | Tauri 2 应用：React UI（`src/`）、`@/` 别名 → `src/`、Tauri 胶水（`src-tauri/`） |
| `adapters/` | IM 适配器侧车（Telegram/Feishu/WeChat/DingTalk），各自独立目录 |
| `docs/` | VitePress 文档（使用 `npm ci`，不是 Bun） |
| `scripts/` | 质量门禁、发布工具、PR 变更策略 |
| `tests/` | 根级别集成测试 |

## 质量门禁（必须知道）
- **`bun run verify`** = `bun run quality:pr` — 统一的 PR 前门禁（push/PR 前运行）
- **`bun run check:impact`** — 打印变更区域影响报告
- **`bun run check:desktop`** = lint + vitest + build（三步）
- **`bun run check:server`** — 服务端测试套件
- **`bun run check:adapters`**（需先执行 `cd adapters && bun install`）
- **`bun run check:native`** = sidecar 构建 + `cargo check`（需要 Tauri 系统依赖）
- **`bun run check:docs`** 运行 `npm ci`（不是 Bun）— 不要与其他检查并行
- **`bun run check:persistence-upgrade`** — 配置/存储格式变更时必须运行
- 测试文件与源码放在同目录的 `__tests__/` 中；桌面端使用 vitest + jsdom 环境
- 桌面构建目标为 `safari15`（兼容 macOS 12 的 Tauri WebView）

## Bash 工具已知问题（Linux PTY）
- Bash 工具默认使用 PTY 模式（`usePty: true`），通过 `ptySession.ts` 执行
- Linux 上 bash 启用 bracketed paste 模式，导致标记行 `__CLAUDE__` 前为 `\r`（而非 Windows 的 `\r\n`）
- 修复在 `waitForMarker()` 中同时搜索 `\r\n__CLAUDE__`（PowerShell）和 `\r__CLAUDE__`（Linux bash）
- 修改 `ptySession.ts` 时需同时在两个平台验证标记检测逻辑

## CI 与发布
- CI 基于 PR：`change-policy` 步骤选择执行哪些 job（desktop/server/adapter/native/docs/coverage）
- Native 检查在 `ubuntu-22.04` 上运行，需要 `libwebkit2gtk-4.1-dev`、Rust 工具链
- 桌面发布：tag `v*.*.*` 触发 GitHub Actions；使用 `bun run scripts/release.ts <version>` 切版本
- 发布说明在 `release-notes/vX.Y.Z.md`
- 文档 CI 使用 Node 22 + `npm ci` — 依赖变更时保持 `package-lock.json` 同步

## CLI 二进制构建
```bash
bun build --compile --target=bun --outfile=dist/claude-haha src/entrypoints/cli.tsx
```
不需要系统构建依赖（bun-pty、sharp 均已预编译）。

## 编码约定
- TypeScript，2 空格缩进，ESM，无分号
- 桌面端 `@` 别名同时配置在 Vite 和 Vitest 中
- 使用 `lucide-react` 图标，匹配现有组件模式
- `.env` 已 gitignore；参考 `.env.example`

## 持久化规则
- 禁止修改 `~/.claude/projects/**/*.jsonl`、`~/.claude/settings.json`、`.mcp.json` 或适配器会话文件
- 读写用户自有配置文件时始终保留未知字段
- Desktop Doctor 修复默认拒绝；只能操作 `cc-haha-*` localStorage 键

## 参考文档
- `.github/copilot-instructions.md` — 简版质量合约（必读）
- `CONTRIBUTING.md` — 详细的质量门禁流程、覆盖率基线、quarantine 策略
