# Codex Switch Helper

Tauri desktop helper for switching Codex App profiles on Windows.

[简体中文](README.zh-CN.md)

## Screenshot

![Codex Switch Helper screenshot](docs/screenshot.png)

## What It Does

- Manages multiple Codex Profiles with separate saved auth data.
- Gives every Profile an isolated tool-managed Home.
- Supports account-login Profiles and API-key Profiles.
- Edits one global `~/.agents/AGENTS.md`, linked into every managed Profile Home, and lists `~/.agents/skills`.
- Scans local session usage by Profile.
- Supports HTTP and SOCKS5 proxy settings for the helper app and Codex launches.
- Runs multiple isolated Codex instances in parallel.
- Provides protective confirmation dialogs for dangerous actions such as deleting Profiles or changing user-level environment variables.
- Launches Profile instances through the packaged Codex desktop entry point and default instances through `shell:AppsFolder`.
- Can restore default Codex Home behavior by deleting user-level `CODEX_HOME`.
- Checks for app updates through signed Tauri updater artifacts published on GitHub Releases.

## Profile Isolation

- New Profiles copy the default Codex Home into `app_data/profiles/<profileId>/home`.
- Account Profiles do not inherit credentials from the default Home unless an existing `auth.json` is explicitly selected.
- Legacy shared Profiles are copied into managed Homes without deleting their original directories.
- Each launch gets a process-local `CODEX_HOME` and a dedicated `--user-data-dir`.
- Deleting a Profile removes only its tool-managed directory.

## Auth Behavior

- Credentials and `OPENAI_API_KEY` are passed only to the launched Codex process.
- Creating an account Profile does not require editing `config.toml` or locating `auth.json`. Launch it and complete sign-in inside Codex.
- Managed account Homes automatically use file-based credential storage so each Profile keeps an isolated login.
- API keys and saved auth/config data are currently stored in local JSON without encryption.

## Default Launch

- `默认启动 Codex` launches Codex without changing `CODEX_HOME` or `OPENAI_API_KEY`.
- `恢复默认 Home` deletes user-level `CODEX_HOME`, so manual Codex launches fall back to the default home, usually `C:\Users\frank\.codex`.

## Settings And Proxy

The settings page contains Codex launch settings and proxy settings.

- Proxy supports `http` and `socks5`.
- Saving proxy settings applies them to this helper app immediately.
- Proxy settings are passed to newly launched Codex instances through their process environment.
- The new behavior clears user-level `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` values written by older versions.
- Dangerous operations use in-app confirmation dialogs. Deleting a Profile requires typing the Profile name.

## Testing With Alternate Data

Set `CODEX_SWITCH_HELPER_DATA_FILE` to test against another data file without touching the real `data.json`:

```powershell
$env:CODEX_SWITCH_HELPER_DATA_FILE="C:\Users\frank\AppData\Roaming\com.frank.codex-switch-helper\data-test.json"
npm run tauri:dev
```

## Default Codex AppID

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

The app auto-detects `OpenAI.Codex_*` first to avoid unrelated apps that happen to contain `Codex` in their name. You can change the AppID in advanced settings if needed.

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

## App Updates

The app checks GitHub Releases for signed updater metadata at startup and also provides a manual update check in the About panel.

Before publishing updater-enabled releases, add these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of `updater.key.local`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: contents of `updater.key.password.local`

Keep both files private. Losing the key or password prevents installed apps from accepting future updates.

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

Also update `CHANGELOG.md`, `README.md`, and `README.zh-CN.md` before tagging a release.

Current release: `0.2.2`.
