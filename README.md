# Codex Switch Helper

Tauri desktop helper for switching Codex App profiles on Windows.

[简体中文](README.zh-CN.md)

## What It Does

- Imports an existing Codex Home directory into a tool-owned managed Profile directory.
- Writes the selected Profile home to the user-level `CODEX_HOME` environment variable.
- Supports account-login Profiles and API-key Profiles.
- Launches the Windows Codex App through `shell:AppsFolder`.
- Can restore default Codex Home behavior by deleting user-level `CODEX_HOME`.

## Profile Behavior

- New Profiles copy the selected source Codex Home into `app_data/profiles/<profileId>/home`.
- The original import source is never modified by Profile launches.
- Deleting a managed Profile deletes only the tool-owned managed home, not the original source directory.
- Account-login Profiles clear user-level `OPENAI_API_KEY` before launch.
- API-key Profiles write their saved key to user-level `OPENAI_API_KEY` before launch.
- API keys are currently stored in local JSON without encryption.

## Default Launch

- `默认启动 Codex` launches Codex without changing `CODEX_HOME` or `OPENAI_API_KEY`.
- `恢复默认 Home` deletes user-level `CODEX_HOME`, so manual Codex launches fall back to the default home, usually `C:\Users\frank\.codex`.

## Default Codex AppID

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

The app auto-detects `OpenAI.Codex_*` first to avoid unrelated apps such as `BFCodexHelp`. You can change the AppID in advanced settings if needed.

## Development

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

On Windows, Rust/Tauri requires the Visual Studio Build Tools C++ toolchain. If `cargo check` or `tauri build` reports `link.exe not found`, install Visual Studio Build Tools with the C++ workload.

## Release

Before publishing a release:

```bash
npm run build
cd src-tauri
cargo fmt --check
cargo check
cd ..
npm run tauri:build
```

Also update `CHANGELOG.md` and `README.md` before tagging a release.
