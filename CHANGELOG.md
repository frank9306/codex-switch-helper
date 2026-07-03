# Changelog

## 0.1.0 - 2026-07-03

- Initial Windows Tauri desktop app for managing Codex Profiles.
- Added managed Profile import: selected Codex Home directories are copied into tool-owned Profile homes.
- Added per-Profile auth modes: account login clears `OPENAI_API_KEY`, API-key login writes the Profile key.
- Added user-level `CODEX_HOME` switching with Windows environment change broadcast.
- Added default Codex launch and restore-default-home actions.
- Added Codex AppID auto-detection preferring `OpenAI.Codex_*`.
- Added dark Codex-style React UI with directory picker support.
