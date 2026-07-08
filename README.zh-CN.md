# Codex Switch Helper

一个 Windows 桌面客户端，用于管理和切换 Codex App 的多个 Profile。

[English](README.md)

## 产品截图

![Codex Switch Helper 产品截图](docs/screenshot.png)

## 功能

- 管理多个 Codex Profile，并为每个 Profile 保存独立登录数据。
- 支持两种环境模式：共享环境和沙盒模式。
- 支持账号登录 Profile 和 API Key 登录 Profile。
- 支持为本工具和 Codex 启动配置 HTTP / SOCKS5 代理。
- 删除 Profile、修改用户级环境变量等危险操作会显示保护性确认弹窗。
- 通过 `shell:AppsFolder` 启动 Windows Codex App。
- 可以删除用户级 `CODEX_HOME`，恢复 Codex 默认 Home 行为。
- 通过发布到 GitHub Releases 的 Tauri 签名更新产物检查和安装应用更新。

## 环境模式

### 共享环境

共享环境 Profile 共用同一个 Codex Home 路径，应用只切换身份和模型行为所需的数据：

- 账号登录 Profile 会把保存的 `auth.json` 写入共享 Home。
- API Key Profile 会写入保存的 `OPENAI_API_KEY`，并移除共享 Home 里残留的 `auth.json`。
- Profile 自己的 `config.toml` 内容会写入共享 Home，让模型、provider、base_url 等配置跟随 Profile 切换。
- 启动前应用会把用户级 `CODEX_HOME` 写为共享 Home。

适合多个 Profile 共享本地 sessions、缓存、工具等 Codex Home 状态，但账号和模型配置需要切换的场景。

### 沙盒模式

沙盒模式保留原来的隔离行为：

- 新建 Profile 时把选择的源 Codex Home 复制到 `app_data/profiles/<profileId>/home`。
- 启动沙盒 Profile 时把用户级 `CODEX_HOME` 写为该托管 Home。
- 删除沙盒 Profile 只删除工具生成的托管 Home，不删除原始导入目录。

如果需要完整隔离 Codex Home 状态，请使用沙盒模式。

## 登录行为

- 账号登录 Profile 启动前会清除用户级 `OPENAI_API_KEY`。
- API Key 登录 Profile 启动前会把保存的 key 写入用户级 `OPENAI_API_KEY`。
- API Key 以及保存的 auth/config 数据当前明文存储在本地 JSON 中，暂未加密。

## 默认启动

- `默认启动 Codex` 不修改 `CODEX_HOME` 或 `OPENAI_API_KEY`，只启动 Codex。
- `恢复默认 Home` 删除用户级 `CODEX_HOME`，让手动启动 Codex 回到默认 Home，通常是 `C:\Users\frank\.codex`。

## 设置和代理

设置页面包含 Codex 启动设置和代理设置。

- 代理支持 `http` 和 `socks5`。
- 保存代理后，本工具会立即使用该代理。
- 启用代理后启动 Codex，会写入用户级 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`。
- 关闭代理后启动 Codex，会清理由本工具管理的代理环境变量。
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

当前版本：`0.1.5`。
