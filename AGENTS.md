# AGENTS.md

## Project Shape

- This is a Windows-focused Tauri v2 desktop app: React/Vite frontend in `src/`, Rust backend in `src-tauri/src/main.rs`.
- The app manages Codex Profiles by copying a selected source Codex Home into a tool-owned directory: `app_data/profiles/<profileId>/home`.
- New Profiles must not directly reference the user-selected source directory; import means copy source to the generated managed home.
- Deleting a new managed Profile deletes only the tool-owned managed home, never the original import source.

## Codex Environment Rules

- Profile launch writes user-level `HKCU\Environment\CODEX_HOME` to the Profile managed home, broadcasts `WM_SETTINGCHANGE`, then launches the Codex Windows App.
- Account-login Profiles clear user-level `OPENAI_API_KEY` before launch.
- API-key Profiles write user-level `OPENAI_API_KEY` from the Profile's saved key before launch. Keys are currently stored in local JSON without encryption.
- `默认启动 Codex` must not modify `CODEX_HOME` or `OPENAI_API_KEY`.
- `恢复默认 Home` only deletes user-level `CODEX_HOME`; this lets manual Codex launches fall back to the default home, usually `C:\Users\frank\.codex`.
- Codex AppID auto-detection must prefer `OpenAI.Codex_*`; do not use broad `*Codex*` first because it can pick unrelated apps like `BFCodexHelp`.

## Commands

- Install dependencies: `npm install`.
- Frontend typecheck/build: `npm run build`.
- Rust check: `cargo check` from `src-tauri/`.
- Rust formatting check: `cargo fmt --check` from `src-tauri/`.
- Dev app: `npm run tauri:dev`.
- Production bundle: `npm run tauri:build`.

## Toolchain Gotchas

- Tauri dev/build on Windows needs Visual Studio Build Tools with the C++ workload; `link.exe not found` means MSVC is missing, not necessarily a code error.
- Vite dev server is pinned to port `1420` with `strictPort: true`; Tauri `devUrl` expects the same port.
- Tauri icons are required for Windows resources. Keep `src-tauri/icons/icon.ico` and the icon paths in `src-tauri/tauri.conf.json` valid.
- Tauri dialog access depends on `tauri-plugin-dialog` and `src-tauri/capabilities/default.json` permission `dialog:default`.

## Release Checklist

- Before any release or publish, generate/update `CHANGELOG.md`.
- Before any release or publish, update `README.md` for changed usage, setup, and release notes.
- Verify before release: `npm run build`, `cargo fmt --check`, and `cargo check`.
- If packaging locally, run `npm run tauri:build` after the checks above.
