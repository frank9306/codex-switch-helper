# Changelog

## 0.1.5 - 2026-07-08

- Added a dedicated settings page for proxy and Codex launch settings.
- Added HTTP and SOCKS5 proxy support for the app process and Codex launches.
- Added protective in-app confirmation dialogs for dangerous actions, including typed confirmation before deleting Profiles.
- Added the project GitHub repository link to the About page.
- Replaced the README product screenshot with the current dashboard screenshot.
- Added `DESIGN.md` to document the app's visual system.

## 0.1.4 - 2026-07-07

- Added signed Tauri updater support backed by GitHub Releases.
- Added startup and manual update checks in the app UI.
- Updated the release workflow to publish updater-compatible artifacts and metadata.
- Redesigned the app UI as a light dashboard with summary cards and a left navigation rail.
- Added the Tauri process plugin required to relaunch after installing updates.
- Regenerated the npm lockfile with npm 10 compatibility so release CI can run `npm ci`.

## 0.1.3 - 2026-07-07

- Reworked Profile switching around two environment modes: shared environment and sandbox mode.
- Shared environment Profiles now reuse one Codex Home while switching saved auth data and Profile-specific `config.toml` content.
- Sandbox mode preserves the previous isolated behavior by copying a source Codex Home into a tool-owned Profile home and launching with `CODEX_HOME` set to that home.
- Removed the Shared Library feature and related skills/prompts/MCP/sessions toggles.
- Added `CODEX_SWITCH_HELPER_DATA_FILE` for testing against an alternate data file without touching the user's real `data.json`.
- API-key launches now remove stale `auth.json` from the target Home to avoid showing the previous account.

## 0.1.2 - 2026-07-03

- Reverted the release workflow dependency install step back to `npm ci` after merging the lockfile fix.
- Added CI tool version logging for release debugging.

## 0.1.1 - 2026-07-03

- Replaced the README product screenshot with a redacted screenshot.
- Fixed the release workflow to upload Windows installer assets explicitly.
- Added a manual release workflow dispatch path for republishing assets to an existing tag.
- Updated English and Chinese README release notes and screenshot sections.

## 0.1.0 - 2026-07-03

- Initial Windows Tauri desktop app for managing Codex Profiles.
- Added managed Profile import: selected Codex Home directories are copied into tool-owned Profile homes.
- Added per-Profile auth modes: account login clears `OPENAI_API_KEY`, API-key login writes the Profile key.
- Added user-level `CODEX_HOME` switching with Windows environment change broadcast.
- Added default Codex launch and restore-default-home actions.
- Added Codex AppID auto-detection preferring `OpenAI.Codex_*`.
- Added dark Codex-style React UI with directory picker support.
