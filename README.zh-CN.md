# Codex Switch Helper

一个 Windows 桌面客户端，用于管理和切换 Codex App 的多个 Profile。

[English](README.md)

## 产品截图

![Codex Switch Helper 产品截图](docs/screenshot.png)

## 功能

- 管理多个 Codex Profile，并为每个 Profile 保存独立登录数据。
- 每个 Profile 使用独立的工具托管目录。
- 支持账号登录 Profile 和 API Key 登录 Profile。
- 查看和编辑共享的 `~/.agents/AGENTS.md`，并列出 `~/.agents/skills`。
- 按 Profile 扫描本地 session 用量。
- 支持为本工具和 Codex 启动配置 HTTP / SOCKS5 代理。
- 支持同时启动和停止多个独立 Codex 实例。
- 删除 Profile、修改用户级环境变量等危险操作会显示保护性确认弹窗。
- Profile 实例通过安装包声明的 Codex 桌面入口启动，默认实例仍通过 `shell:AppsFolder` 启动。
- 可以删除用户级 `CODEX_HOME`，恢复 Codex 默认 Home 行为。
- 通过发布到 GitHub Releases 的 Tauri 签名更新产物检查和安装应用更新。

## Profile 隔离

- 新建 Profile 自动把默认 Codex Home 复制到 `app_data/profiles/<profileId>/home`。
- 旧共享 Profile 会安全复制到新的托管目录，原 Home 不会删除。
- 启动时为每个 Profile 设置独立进程级 `CODEX_HOME` 和 `--user-data-dir`。
- 删除 Profile 只删除工具托管目录。

## 登录行为

- 登录凭据和 `OPENAI_API_KEY` 只传递给对应 Codex 进程，不修改用户级变量。
- API Key 以及保存的 auth/config 数据当前明文存储在本地 JSON 中，暂未加密。

## 默认启动

- `默认启动 Codex` 不修改 `CODEX_HOME` 或 `OPENAI_API_KEY`，只启动 Codex。
- `恢复默认 Home` 删除用户级 `CODEX_HOME`，让手动启动 Codex 回到默认 Home，通常是 `C:\Users\frank\.codex`。

## 设置和代理

设置页面包含 Codex 启动设置和代理设置。

- 代理支持 `http` 和 `socks5`。
- 保存代理后，本工具会立即使用该代理。
- 代理通过进程环境传递给之后启动的 Codex 实例。
- 新版本会清理旧版本曾写入的用户级 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`。
- 危险操作使用应用内确认弹窗。删除 Profile 时必须输入 Profile 名称。

## 使用测试数据

设置 `CODEX_SWITCH_HELPER_DATA_FILE` 可以让应用读取另一个数据文件，不污染真实 `data.json`：

```powershell
$env:CODEX_SWITCH_HELPER_DATA_FILE="C:\Users\frank\AppData\Roaming\com.frank.codex-switch-helper\data-test.json"
npm run tauri:dev
```

## 默认 Codex AppID

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

应用会优先自动检测 `OpenAI.Codex_*`，避免误选名称里碰巧包含 `Codex` 的无关应用。必要时可在高级设置里手动修改 AppID。

## 开发

```bash
npm install
npm run tauri:dev
```

## 构建

```bash
npm run tauri:build
```

Windows 上 Tauri/Rust 需要 Visual Studio Build Tools C++ 工具链。如果 `cargo check` 或 `tauri build` 报 `link.exe not found`，请安装带 C++ workload 的 Visual Studio Build Tools。

## 应用更新

应用启动时会检查 GitHub Releases 上的签名更新元数据，也可以在关于面板手动检查更新。

发布支持自动更新的版本前，需要添加这些 GitHub 仓库 secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：`updater.key.local` 的内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：`updater.key.password.local` 的内容

这两个文件必须保密。如果丢失私钥或密码，已安装的应用将无法接受后续更新。

## 发布

发布前执行：

```bash
npm run build
cd src-tauri
cargo fmt --check
cargo check
cd ..
npm run tauri:build
```

发布前必须更新 `CHANGELOG.md`、`README.md` 和 `README.zh-CN.md`。

当前版本：`0.2.1`。
