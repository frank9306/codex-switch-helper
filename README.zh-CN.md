# Codex Switch Helper

一个 Windows 桌面客户端，用于管理和切换 Codex App 的多个 Profile。

[English](README.md)

## 功能

- 将已有 Codex Home 目录导入到工具托管的 Profile 目录。
- 启动 Profile 时写入用户级环境变量 `CODEX_HOME`。
- 支持账号登录 Profile 和 API Key 登录 Profile。
- 通过 `shell:AppsFolder` 启动 Windows Codex App。
- 可以删除用户级 `CODEX_HOME`，恢复 Codex 默认 Home 行为。

## Profile 行为

- 新建 Profile 会把选择的源 Codex Home 复制到 `app_data/profiles/<profileId>/home`。
- Profile 启动不会继续写入原始导入目录。
- 删除托管 Profile 只删除工具生成的托管 Home，不删除原始导入目录。
- 账号登录 Profile 启动前会清除用户级 `OPENAI_API_KEY`。
- API Key 登录 Profile 启动前会把保存的 key 写入用户级 `OPENAI_API_KEY`。
- API Key 当前明文存储在本地 JSON 中，暂未加密。

## 默认启动

- `默认启动 Codex` 不修改 `CODEX_HOME` 或 `OPENAI_API_KEY`，只启动 Codex。
- `恢复默认 Home` 删除用户级 `CODEX_HOME`，让手动启动 Codex 回到默认 Home，通常是 `C:\Users\frank\.codex`。

## 默认 Codex AppID

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

应用会优先自动检测 `OpenAI.Codex_*`，避免误选 `BFCodexHelp` 这类无关应用。必要时可在高级设置里手动修改 AppID。

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
