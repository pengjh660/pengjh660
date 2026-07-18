# Linux 构建依赖清单

在 Linux 上编译 `claude-haha` 原生二进制需要的所有依赖。

## 另见

关键配置（环境变量、defaultShell、OpenAI Chat 等）：`D:\documents\cladue\关键配置.md`

---

## 获取源码

```bash
git clone <你的仓库地址> claude-sourcecode
cd claude-sourcecode
git checkout <分支名>
```

---

## 1. 装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
# 验证版本
bun --version  # 需 ≥ 1.3.14
```

---

## 2. 安装依赖 + 编译

```bash
bun install
bun build --compile --target=bun --outfile=dist/claude-haha src/entrypoints/cli.tsx
```

构建成功后输出示例：
```
[15.278s]  bundle  6361 modules
 [573ms] compile  dist/claude-haha
```

---

## 依赖说明

### 不需要的系统库

所有原生模块都自带预编译二进制，`bun install` 后会直接放到 `node_modules/`：

| 包 | Linux 预编译文件 | 备注 |
|----|----------------|------|
| `bun-pty` | `librust_psy.so` / `librust_psy_musl.so` | PTY 终端支持 |
| `sharp` | `@img/sharp-linux-x64/sharp-*.node` | 图片处理 |
| `@rollup/rollup` | `rollup.linux-x64-gnu.node` | 打包工具（非必需） |

因此 **不需要**：
- ❌ `build-essential`（C++ 编译器）
- ❌ `libvips-dev`（sharp 自带 libvips）
- ❌ Rust / cargo（bun-pty 自带 `.so`）
- ❌ 任何其他系统 `-dev` 包

### 只需要

- ✅ Bun（唯一必须安装的工具）

---

## 打包发行版

```bash
mkdir -p dist/claude-haha-v0.3.2-linux-x64
cp dist/claude-haha dist/claude-haha-v0.3.2-linux-x64/
cd dist
tar czf claude-haha-v0.3.2-linux-x64.tar.gz claude-haha-v0.3.2-linux-x64/
```

---

## 注意事项

- Linux 二进制不需要 `rg.exe`（Windows 专用），用系统 `ripgrep` 即可
- 编译后的二进制自带 Bun runtime，无需额外运行时
- 如需 cross-compile（Linux → Windows），需要在 Windows 上跑 `bun build --compile`
