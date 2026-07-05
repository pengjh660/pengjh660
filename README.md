# Claude Code Haha — Windows 优化版

Claude Code 的社区分支，**重点修复 Windows 下的终端兼容性**，同时保留完整功能。

## 🎯 主要优化

### 1. 默认启用 Alt Screen（全屏模式）
原版只对内部用户启用，外部用户需要手动设置 `CLAUDE_CODE_NO_FLICKER=1`。  
本版本默认开启，无需任何配置。

### 2. 修复 Windows ConPTY VT 序列穿透问题
**根因：** Windows 上 `writeSync(1, ...)` 不走 ConPTY 管道，VT 转义序列无法到达终端模拟器，导致 alt screen 进入/退出失效、退出后终端内容错乱。

**修复：**
- 所有 VT 序列（alt screen 进入/退出、清屏等）改用 `process.stdout.write()`，确保通过 ConPTY 正确传递
- 启动清屏、退出清理全部走正确路径

### 3. Bash 工具重写：调用 Windows 原生 PowerShell
原版 Bash 工具在 Windows 上依赖 `bash`、`sed` 等 Unix 工具，经常出现找不到命令、`sed` 破坏文件编码等问题。

**修复：**
- 重写 Bash 工具，Windows 下默认调用 `powershell.exe`，使用原生 PowerShell 命令
- 不再依赖 WSL、Git Bash、Cygwin 等外部环境
- 环境变量、路径格式完全兼容 Windows

### 4. 退出后终端干净
`/exit` 后 alt screen 正常退出，终端恢复之前的 shell 内容，无残留、无错位。

## 🚀 一键安装

```powershell
irm https://github.com/pengjh660/pengjh660/releases/latest/download/install.ps1 | iex
```

## 📦 手动安装

1. 下载 [最新 Release](https://github.com/pengjh660/pengjh660/releases/latest)
2. 解压，把 `bin/` 目录加到 PATH
3. 运行 `claude-haha`

## 🔧 本地开发

```bash
git clone https://github.com/pengjh660/pengjh660.git
cd pengjh660
bun install
bun run start
```

## 📄 License

本项目基于 Claude Code 的社区修改，遵循原项目许可证。
