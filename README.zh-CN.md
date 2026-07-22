# Codex Switch Helper

一个 Windows 桌面客户端，用于管理和切换 Codex App 的多个 Profile。

[English](README.md)

## 产品截图

![Codex Switch Helper 产品截图](docs/screenshot.png)

## 功能

- 管理多个 Codex Profile，并为每个 Profile 保存独立登录数据。
- 每个 Profile 使用独立的工具托管目录。
- 支持账号登录 Profile 和 API Key 登录 Profile。
- 查看和编辑全局 `~/.agents/AGENTS.md`；该文件会链接到所有托管 Profile Home，同时列出 `~/.agents/skills`。
- 按 Profile 扫描本地 session 用量。
- 支持为本工具和 Codex 启动配置 HTTP / SOCKS5 代理。
- 支持同时启动和停止多个独立 Codex 实例。
- 可为每个 Profile 单独启用 Codex 背景皮肤，背景图和设置保存在该 Profile 的托管目录中。
- Profile 检查、启动准备和进程状态查询不会占用 UI 事件线程，Codex 运行任务时切换工具仍可保持响应。
- 删除 Profile、修改用户级环境变量等危险操作会显示保护性确认弹窗。
- Profile 实例通过安装包声明的 Codex 桌面入口启动，默认实例仍通过 `shell:AppsFolder` 启动。
- 可以删除用户级 `CODEX_HOME`，恢复 Codex 默认 Home 行为。
- 通过发布到 GitHub Releases 的 Tauri 签名更新产物检查和安装应用更新。
- 支持 Windows 系统托盘、登录 Windows 后自动启动，以及持久化的 Light/Dark 主题。
- 耗时操作会显示明确进度；发现更新时会展示当前版本、目标版本、发布日期和版本内容。

## Profile 隔离

- 新建 Profile 自动把默认 Codex Home 复制到 `app_data/profiles/<profileId>/home`。
- 除非用户明确选择已有 `auth.json`，账号 Profile 不会继承默认 Home 的登录凭据。
- 旧共享 Profile 会安全复制到新的托管目录，原 Home 不会删除。
- 启动时为每个 Profile 设置独立进程级 `CODEX_HOME` 和 `--user-data-dir`。
- 删除 Profile 只删除工具托管目录。

## 登录行为

- 登录凭据和 `OPENAI_API_KEY` 只传递给对应 Codex 进程，不修改用户级变量。
- 新建账号 Profile 不需要手动修改 `config.toml` 或寻找 `auth.json`；创建后启动 Codex 并在其中完成登录即可。
- 托管账号 Home 会自动使用文件凭据存储，确保每个 Profile 的登录状态相互隔离。
- API Key 以及保存的 auth/config 数据当前明文存储在本地 JSON 中，暂未加密。

## 默认启动

- `默认启动 Codex` 不修改 `CODEX_HOME` 或 `OPENAI_API_KEY`，只启动 Codex。
- `恢复默认 Home` 删除用户级 `CODEX_HOME`，让手动启动 Codex 回到默认 Home，通常是 `C:\Users\frank\.codex`。

## Codex 皮肤

- 在 Profile 详情中选择 PNG、JPEG 或 WebP 背景，可配置浅色/深色外观、视觉焦点、安全区和任务页背景模式。
- 皮肤通过仅监听 `127.0.0.1` 的 CDP 注入，不修改 Codex 官方安装包、`app.asar` 或签名。
- 各 Profile 使用独立 CDP 端口和主题目录；未启用皮肤的 Profile 保持原启动行为。
- 运行皮肤需要 `PATH` 中存在 Node.js 22 或更高版本。背景图不得超过 16 MB；运行时还会校验图片尺寸与像素数。
- 默认启动 Codex 不会开启皮肤。皮肤运行期间，请勿运行来路不明的本机程序，因为同一用户下的其他进程仍可能访问本机调试端口。

该功能基于 [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)，使用上游 commit `e776fa6d5361a2bdd5c1614674397681e7b00874`，遵循 MIT License。本项目不分发上游人物、角色、名人或用户提供的图片预设。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [上游 MIT License](src-tauri/resources/dream-skin/LICENSE)。Codex Dream Skin 与本项目均非 OpenAI 官方产品。

## 设置和代理

设置页面包含 Codex 启动设置、代理设置、登录 Windows 后自动启动和 Light/Dark 主题选择。

- 代理支持 `http` 和 `socks5`。
- 保存代理后，本工具会立即使用该代理。
- 代理通过进程环境传递给之后启动的 Codex 实例。
- 启用代理时，`127.0.0.1`、`localhost` 和 `::1` 会绕过代理，确保 Codex 皮肤的本机 CDP 连接保持直连；已有的 `NO_PROXY` 配置会保留。
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

应用启动时会检查 GitHub Releases 上的签名更新元数据，也可以在关于面板手动检查更新。发现新版本时，会在安装前展示当前版本、目标版本、发布日期和版本内容。

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

当前版本：`0.2.6`。
