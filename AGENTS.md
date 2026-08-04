# AGENTS.md

## Project Shape

- This is a Windows-focused Tauri v2 desktop app: React/Vite frontend in `src/`, Rust backend in `src-tauri/src/main.rs`.
- Every Codex Profile uses a tool-owned directory: `app_data/profiles/<profileId>/home`.
- New Profiles copy the default Codex Home into the generated managed Home.
- Legacy shared Profiles migrate by copying their old Home into a managed Home; never delete the original source.
- Deleting a Profile deletes only its tool-owned managed Home.

## Codex Environment Rules

- Profile launch passes `CODEX_HOME`, credentials, and proxy settings only to the launched process.
- Each Profile uses a dedicated Codex `--user-data-dir` so multiple instances can run concurrently.
- Account-login Profiles write saved `auth.json` into the target Home.
- API-key Profiles pass `OPENAI_API_KEY` to the launched process and remove stale `auth.json` from the target Home. Keys are currently stored in local JSON without encryption.
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

- When asked to release, increment the patch version by one automatically without asking for a version number.
- Before any release or publish, generate/update `CHANGELOG.md`.
- Before any release or publish, update `README.md` and `README.zh-CN.md` for changed usage, setup, and release notes.
- Verify before release: `npm run build`, `cargo fmt --check`, and `cargo check`.
- If packaging locally, run `npm run tauri:build` after the checks above.

<!-- polyharness:start -->
<!-- polyharness:agents-version 1 -->
## PolyHarness project contract

### Purpose

- Use the repository Harness to make bounded changes and produce current, admissible evidence.
- Treat this file as the project map; detailed rules remain in their canonical project-owned files.

### Project map

- `root`: path `.`; capabilities: gui, web-ui.

### Commands

Workspace `root`:

- `setup`: `npm install`
- `dev`: `npm run tauri:dev`
- `lint`: `<not configured>`
- `typecheck`: `npx tsc --noEmit`
- `test`: `cargo test --manifest-path src-tauri/Cargo.toml`
- `browser-test`: `<not configured>`
- `build`: `npm run tauri:build`
- `check`: `npm run build && cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo check --manifest-path src-tauri/Cargo.toml`

<!-- polyharness:commands-begin -->
{"root":{"browser-test":null,"build":"npm run tauri:build","check":"npm run build && cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo check --manifest-path src-tauri/Cargo.toml","dev":"npm run tauri:dev","lint":null,"setup":"npm install","test":"cargo test --manifest-path src-tauri/Cargo.toml","typecheck":"npx tsc --noEmit"}}
<!-- polyharness:commands-end -->

### Boundaries

- Preserve explicit goals, constraints, non-goals, deliverables, public APIs, and user-owned content.
- Keep secrets out of repositories, prompts, examples, command output, and logs.
- Require explicit approval for destructive actions, protected writes, releases, migrations, and external side effects.
- Never update a managed project's language, framework, dependency, or lock-file versions.
- Workspace `root` approval boundaries: Delete files, user data, or managed Profile data, Run database migrations, Change authentication or authorization behavior, Add dependencies or upgrade major dependency versions, Stage, commit, push, create branches or pull requests, publish, or release.

### Definition of done

- Run the smallest relevant project-owned checks after material changes.
- Run the configured final `check` command after the last material edit.
- Treat static configuration as at most `PRESENT`; only commands executed in the current run are `EXERCISED`.
- Report changed files, exercised checks, unverified areas, remaining risk, external effects, and recovery steps.
- Do not declare a goal achieved until every required criterion, constraint, and deliverable has current evidence.

### Knowledge references

- Workspace `root` `agentMap`: [AGENTS.md](AGENTS.md)

<!-- polyharness:knowledge-begin -->
{"root":{"agentMap":"AGENTS.md","architecture":null,"reliability":null,"security":null}}
<!-- polyharness:knowledge-end -->

<!-- polyharness:end -->
