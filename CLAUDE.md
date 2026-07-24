# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
# CLI (Linux: use ./bin/claude-haha directly — `bun run start` is broken on Linux)
./bin/claude-haha

# Desktop app dev server (port 1420, Vite + React 18 + Tailwind CSS v4)
cd desktop && bun run dev

# API/WebSocket server for desktop backend
SERVER_PORT=3456 bun run src/server/index.ts
```

Install dependencies separately for each workspace:
```bash
bun install          # root (CLI + server)
cd desktop && bun install       # Tauri 2 desktop app
cd adapters && bun install      # IM adapters (Telegram/Feishu/WeChat/DingTalk)
```

Copy `.env.example` to `.env` for third-party provider config (MiniMax, LiteLLM, OpenRouter, Azure).

## Architecture

This is a community fork of Anthropic's Claude Code CLI, focused on **Windows terminal compatibility fixes** and a **Tauri 2 desktop app**. Three workspaces:

| Workspace | Tech | Purpose |
|-----------|------|---------|
| Root `src/` | TypeScript + Bun + Ink (React TUI) | CLI, agent loop, tools, server, services |
| `desktop/` | Tauri 2 + React 18 + Vite + Tailwind CSS v4 + Vitest | Desktop GUI wrapping the CLI |
| `adapters/` | Bun + platform SDKs | IM sidecars (Telegram/Feishu/WeChat/DingTalk) |

**Entry points:**
- `src/entrypoints/cli.tsx` — CLI entry with fast-path routing (--version, --dump-system-prompt, daemon, remote-control, etc.)
- `src/main.tsx` — Full CLI (Commander commands, Ink TUI, agent loop, session management)
- `bin/claude-haha` — Bash launcher: sets `CALLER_DIR`, loads `.env`, then runs `cli.tsx` via Bun
- `preload.ts` — Bun preload (via `bunfig.toml`): sets `globalThis.MACRO` + auto-chdir to `CALLER_DIR`

**Key subsystems:**
- `src/tools/` — ~60 tool implementations (`BashTool`, `FileEditTool`, `GlobTool`, `GrepTool`, etc.), registered in `src/tools.ts`
- `src/server/` — Bun.serve HTTP + WebSocket server (REST API, desktop backend, H5 access, OpenAI proxy)
- `src/services/` — Auth, MCP, analytics, policy limits, remote management, persistence upgrades
- `src/ink/` — Forked Ink terminal rendering library (reconciler, renderer, components)
- `src/utils/shell/ptySession.ts` — PTY-based shell execution (marker parsing with `__CLAUDE__` sentinels)
- `src/commands/` — ~90 CLI subcommands (help, config, session, mcp, memory, etc.)

**Feature flags:** Extensive use of `import { feature } from 'bun:bundle'` for build-time dead code elimination. Flags include `ABLATION_BASELINE`, `BRIDGE_MODE`, `DAEMON`, `BG_SESSIONS`, `TEMPLATES`, `BYOC_ENVIRONMENT_RUNNER`, `SELF_HOSTED_RUNNER`, `DUMP_SYSTEM_PROMPT`.

**Stubs:** `stubs/` provides empty replacements for missing native modules (`@ant/claude-for-chrome-mcp`, `color-diff-napi`) via tsconfig paths.

## Quality Gate (Pre-PR)

```bash
bun run verify              # Primary pre-PR gate (= bun run quality:pr)
bun run check:impact        # Print impacted-area report
bun run check:desktop       # Desktop lint + vitest + build
bun run check:server        # Server test suite
bun run check:adapters      # Adapter tests (cd adapters && bun install first)
bun run check:native        # Sidecar build + cargo check (needs Tauri deps)
bun run check:docs          # VitePress build (uses npm ci, not Bun — don't parallelize)
bun run check:persistence-upgrade  # Required when config/storage format changes
bun run check:quarantine    # Quarantine review date enforcement
bun run check:coverage      # Coverage check
bun run quality:providers   # Live provider tests
bun run quality:smoke       # Smoke tests (provider + desktop)
```

The quality gate is change-policy-driven: `check:impact` determines which lanes run based on changed files. Coverage uses a ratchet — baselines must not decrease without maintainer approval.

Test files live in `__tests__/` directories co-located with source. Desktop uses Vitest + jsdom + Testing Library. Root and adapters use `bun test`.

Quality reports are written to `artifacts/quality-runs/<timestamp>/` and `artifacts/coverage/<timestamp>/`.

## CLI Binary Build

```bash
bun build --compile --target=bun --outfile=dist/claude-haha src/entrypoints/cli.tsx
```

## FileEditTool — Architecture & Known Issues

### Input Processing Pipeline (model output → disk write)

```
模型生成 old_string
  ↓
normalizeContentFromAPI() [messages.ts:2651]
  → normalizeToolInput() [api.ts:566: FileEditTool case, line 622]
    → normalizeFileEditInput() [utils.ts:581]  — 去脱敏(<fnr>→<function_results>), new_string尾部空格裁剪
  ↓
validateInput() [FileEditTool.ts:137]
  → 读文件 buffer, BOM检测编码, CRLF→LF [line 207-214]
  → 陈旧检测: mtime对比+内容对比, errorCode 7 [line 289-311] ← **问题2根因**
  → findActualString(file, old_string) [line 316] ← **问题1根因**
  ↓
call() [FileEditTool.ts:387]
  → 二次陈旧检测 + 实际文件写入
```

### `findActualString` (utils.ts:73-93) — 当前只有两层匹配

| 层级 | 方法 | 局限性 |
|------|------|--------|
| 1 | 精确子串匹配 `includes()` | 任一字符差异就失败 |
| 2 | 弯引号→直引号标准化后 `indexOf` | 只处理引号 |
| - | 无行号前缀剥离 | 模型误带 Read 输出的 `123\t` 前缀 |
| - | 无空白容错 | 多余换行/尾随空格导致失败 |
| - | 无缩进标准化 | tab vs space 直接失败 |
| - | 无模糊/近似匹配 | 任何差异都无法容错 |

### 陈旧检测 (FileEditTool.ts:289-316) — 文件级一刀切

- `validateInput()`: 陈旧检测在 `findActualString` **之前**执行 — 文件被修改后 old_string 匹配永远走不到
- `call()`: 同样在写盘前做全文件级别二次检测 (line 451-468)
- `readFileState` 缓存了原始内容 (content + timestamp)，diff 基准数据在手但未利用
- 用户修改第1行，模型编辑第200行 → 整文件被拒绝，需重新 Read

### 相关工具函数

- `stripLineNumberPrefix` in `src/utils/file.ts:325-328` — 已有剥离 `N→`/`N\t` 前缀的函数，但 Edit 匹配流水线从未调用
- `addLineNumbers` in `src/utils/file.ts:290-318` — Read 工具输出的行号格式
- `getPatchFromContents` in `src/utils/diff.ts:81-109` — 使用 `diff` 包的 `structuredPatch`
- `normalizeFileEditInput` in `utils.ts:581-657` — 在 `normalizeToolInput` (api.ts:622) 中调用，做输入预处理

## PTY / Bash Tool (Linux-Specific)

- Bash tool uses PTY mode (`usePty: true`) via `src/utils/shell/ptySession.ts`
- Linux bash bracketed paste mode produces `\r` before `__CLAUDE__` markers (Windows PowerShell uses `\r\n`)
- `waitForMarker()` searches for both `\r\n__CLAUDE__` and `\r__CLAUDE__`
- When modifying `ptySession.ts`, verify marker detection on both platforms

## Coding Conventions

- TypeScript, 2-space indent, ESM, no semicolons
- Desktop: `@` alias → `src/`, build target `safari15` (macOS 12 Tauri WebView)
- Icons: `lucide-react`
- `.env` is gitignored; reference `.env.example`
- Persistence: never modify `~/.claude/projects/**/*.jsonl`, `~/.claude/settings.json`, `.mcp.json`, or adapter session files. Preserve unknown fields when reading user config files.

## Primary Contract

`AGENTS.md` — full repo agent contract (startup, structure, quality gate details, release process, persistence rules). `.github/copilot-instructions.md` — short quality contract. `CONTRIBUTING.md` — detailed quality gate process.
