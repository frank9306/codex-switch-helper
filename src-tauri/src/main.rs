#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dream_skin;
mod models;
mod modules;

use chrono::Utc;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::fs::symlink_file;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use uuid::Uuid;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const DEFAULT_CODEX_APP_ID: &str = "OpenAI.Codex_2p2nqsd0c76g0!App";
const CODEX_HOME_ENV_KEY: &str = "CODEX_HOME";
const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
const HTTP_PROXY_ENV_KEY: &str = "HTTP_PROXY";
const HTTPS_PROXY_ENV_KEY: &str = "HTTPS_PROXY";
const ALL_PROXY_ENV_KEY: &str = "ALL_PROXY";
const NO_PROXY_ENV_KEY: &str = "NO_PROXY";
const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,::1";
const DATA_FILE_OVERRIDE_ENV_KEY: &str = "CODEX_SWITCH_HELPER_DATA_FILE";
const AUTOSTART_REGISTRY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE_NAME: &str = "Codex Switch Helper";

const CODEX_PROCESS_NAME: &str = "Codex.exe";
const CODEX_CONFIG_FILENAME: &str = "config.toml";
const FILE_AUTH_CREDENTIALS_SETTING: &str = "cli_auth_credentials_store = \"file\"";
const SHARED_AGENTS_FILENAME: &str = "AGENTS.md";
const ENVIRONMENT_BROADCAST_TIMEOUT_MS: u32 = 500;
const DETECT_CODEX_EXECUTABLE_SCRIPT: &str = r#"
$packages = Get-AppxPackage | Where-Object { $_.Name -like 'OpenAI.Codex*' -or $_.PackageFamilyName -like 'OpenAI.Codex_*' }
foreach ($package in $packages) {
  $manifest = $package | Get-AppxPackageManifest
  $application = $manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' } | Select-Object -First 1
  if (-not $application) {
    $application = $manifest.Package.Applications.Application | Select-Object -First 1
  }
  $relativePath = [string]$application.Executable
  if (-not [string]::IsNullOrWhiteSpace($relativePath)) {
    $candidate = Join-Path $package.InstallLocation $relativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate; exit }
  }
}
$command = Get-Command ChatGPT.exe -ErrorAction SilentlyContinue
if ($command) { $command.Source }
"#;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    name: String,
    home_path: String,
    #[serde(default, skip_serializing)]
    import_source_path: Option<String>,
    #[serde(default, skip_serializing)]
    environment_mode: EnvironmentMode,
    #[serde(default)]
    auth_mode: AuthMode,
    api_key: Option<String>,
    #[serde(default)]
    api_provider: Option<String>,
    #[serde(default)]
    api_base_url: Option<String>,
    #[serde(default)]
    api_route_enabled: bool,
    #[serde(default)]
    api_route_model: Option<String>,
    auth_json: Option<String>,
    config_toml: Option<String>,
    #[serde(default)]
    managed: bool,
    created_at: String,
    updated_at: String,
    last_used_at: Option<String>,
    #[serde(default)]
    skin: ProfileSkinSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSkinSettings {
    #[serde(default)]
    enabled: bool,
    background_path: Option<String>,
    #[serde(default = "default_skin_appearance")]
    appearance: String,
    #[serde(default = "default_skin_focus")]
    focus_x: f64,
    #[serde(default = "default_skin_focus")]
    focus_y: f64,
    #[serde(default = "default_skin_safe_area")]
    safe_area: String,
    #[serde(default = "default_skin_task_mode")]
    task_mode: String,
}

impl Default for ProfileSkinSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            background_path: None,
            appearance: default_skin_appearance(),
            focus_x: default_skin_focus(),
            focus_y: default_skin_focus(),
            safe_area: default_skin_safe_area(),
            task_mode: default_skin_task_mode(),
        }
    }
}

fn default_skin_appearance() -> String {
    "auto".to_string()
}
fn default_skin_focus() -> f64 {
    0.5
}
fn default_skin_safe_area() -> String {
    "auto".to_string()
}
fn default_skin_task_mode() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum AuthMode {
    #[default]
    Account,
    ApiKey,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum EnvironmentMode {
    Shared,
    #[default]
    Sandbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    codex_app_id: String,
    env_key: String,
    delete_open_ai_api_key_before_launch: bool,
    #[serde(default)]
    proxy_enabled: bool,
    #[serde(default = "default_proxy_protocol")]
    proxy_protocol: String,
    #[serde(default)]
    proxy_host: String,
    #[serde(default)]
    proxy_port: String,
    #[serde(default)]
    launch_at_startup: bool,
    #[serde(default = "default_theme")]
    theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredData {
    profiles: Vec<Profile>,
    settings: AppSettings,
    active_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppState {
    profiles: Vec<Profile>,
    settings: AppSettings,
    active_profile_id: Option<String>,
    current_codex_home: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileInspection {
    exists: bool,
    has_auth_json: bool,
    has_config_toml: bool,
    file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTestResult {
    ok: bool,
    status: String,
    endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillInfo {
    name: String,
    path: String,
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedResources {
    agents_path: String,
    agents_content: String,
    skills_path: String,
    skills: Vec<SkillInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexInstance {
    profile_id: String,
    profile_name: String,
    pid: u32,
    started_at: String,
    skin_injector_pid: Option<u32>,
    skin_cdp_port: Option<u16>,
}

static CODEX_INSTANCES: OnceLock<Mutex<Vec<CodexInstance>>> = OnceLock::new();

fn codex_instances() -> &'static Mutex<Vec<CodexInstance>> {
    CODEX_INSTANCES.get_or_init(|| Mutex::new(Vec::new()))
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_app_id: DEFAULT_CODEX_APP_ID.to_string(),
            env_key: CODEX_HOME_ENV_KEY.to_string(),
            delete_open_ai_api_key_before_launch: false,
            proxy_enabled: false,
            proxy_protocol: default_proxy_protocol(),
            proxy_host: String::new(),
            proxy_port: String::new(),
            launch_at_startup: false,
            theme: default_theme(),
        }
    }
}

impl Default for StoredData {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            settings: AppSettings::default(),
            active_profile_id: None,
        }
    }
}

#[tauri::command]
fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    let data = load_data(&app)?;
    if apply_proxy_settings(&data.settings)? {
        broadcast_environment_change();
    }
    Ok(AppState {
        profiles: data.profiles,
        settings: data.settings,
        active_profile_id: data.active_profile_id,
        current_codex_home: read_user_env(CODEX_HOME_ENV_KEY)?,
    })
}

#[tauri::command]
fn create_profile(
    app: AppHandle,
    name: String,
    source_path: String,
    auth_mode: AuthMode,
    api_key: Option<String>,
    auth_json_path: Option<String>,
    api_provider: Option<String>,
    api_base_url: Option<String>,
    api_route_enabled: bool,
    api_route_model: Option<String>,
) -> Result<Profile, String> {
    let name = normalized_name(&name)?;
    validate_auth(&auth_mode, api_key.as_deref())?;
    validate_api_route(
        &auth_mode,
        api_route_enabled,
        api_base_url.as_deref(),
        api_route_model.as_deref(),
    )?;
    let source_path = normalize_optional_home_path(&source_path)?.unwrap_or(default_codex_home()?);
    let auth_json_path =
        normalize_optional_home_path(auth_json_path.as_deref().unwrap_or_default())?;
    if !source_path.is_dir() {
        return Err("导入源目录不存在或不是目录。".to_string());
    }
    if let Some(auth_json_path) = auth_json_path.as_deref() {
        if !auth_json_path.is_file() {
            return Err("auth.json 文件不存在。".to_string());
        }
    }
    let mut data = load_data(&app)?;
    let profile = new_profile(
        &app,
        &name,
        Some(source_path.as_path()),
        auth_mode,
        api_key,
        auth_json_path.as_deref(),
        api_provider,
        api_base_url,
        api_route_enabled,
        api_route_model,
        EnvironmentMode::Sandbox,
    )?;
    copy_dir_recursive(&source_path, Path::new(&profile.home_path)).map_err(format_io_error)?;
    initialize_new_profile_auth_files(&profile, Path::new(&profile.home_path))?;
    ensure_shared_agents_link(Path::new(&profile.home_path))?;
    if let Some(config_toml) = profile.config_toml.as_deref() {
        fs::write(
            Path::new(&profile.home_path).join(CODEX_CONFIG_FILENAME),
            config_toml,
        )
        .map_err(format_io_error)?;
    }
    data.profiles.push(profile.clone());
    if data.active_profile_id.is_none() {
        data.active_profile_id = Some(profile.id.clone());
    }
    save_data(&app, &data)?;
    Ok(profile)
}

#[tauri::command]
fn update_profile(
    app: AppHandle,
    profile_id: String,
    name: String,
    auth_mode: AuthMode,
    api_key: Option<String>,
    auth_json_path: Option<String>,
    api_provider: Option<String>,
    api_base_url: Option<String>,
    api_route_enabled: bool,
    api_route_model: Option<String>,
) -> Result<Profile, String> {
    let name = normalized_name(&name)?;
    validate_auth(&auth_mode, api_key.as_deref())?;
    validate_api_route(
        &auth_mode,
        api_route_enabled,
        api_base_url.as_deref(),
        api_route_model.as_deref(),
    )?;
    let auth_json_path =
        normalize_optional_home_path(auth_json_path.as_deref().unwrap_or_default())?;

    let mut data = load_data(&app)?;
    let profile = data
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "Profile 不存在。".to_string())?;
    profile.name = name;
    profile.auth_mode = auth_mode;
    profile.api_key = api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    profile.api_provider = normalize_optional_string(api_provider);
    profile.api_base_url = normalize_optional_string(api_base_url);
    profile.api_route_enabled = api_route_enabled;
    profile.api_route_model = normalize_optional_string(api_route_model);
    if matches!(auth_mode, AuthMode::Account) {
        if let Some(auth_json_path) = auth_json_path.as_deref() {
            if !auth_json_path.is_file() {
                return Err("auth.json 文件不存在。".to_string());
            }
            profile.auth_json = Some(fs::read_to_string(auth_json_path).map_err(format_io_error)?);
        }
        let config_toml =
            with_file_auth_credentials_store(profile.config_toml.as_deref().unwrap_or_default());
        fs::create_dir_all(&profile.home_path).map_err(format_io_error)?;
        fs::write(
            Path::new(&profile.home_path).join(CODEX_CONFIG_FILENAME),
            &config_toml,
        )
        .map_err(format_io_error)?;
        profile.config_toml = Some(config_toml);
    } else {
        profile.auth_json = None;
        if api_route_enabled {
            profile.config_toml = Some(build_api_route_config(
                profile.api_base_url.as_deref().unwrap_or_default(),
                profile.api_route_model.as_deref().unwrap_or_default(),
            ));
        }
    }
    profile.updated_at = Utc::now().to_rfc3339();
    let updated = profile.clone();
    save_data(&app, &data)?;
    Ok(updated)
}

#[tauri::command]
fn update_profile_skin(
    app: AppHandle,
    profile_id: String,
    mut skin: ProfileSkinSettings,
    selected_image_path: Option<String>,
) -> Result<Profile, String> {
    validate_skin_settings(&skin)?;
    let mut data = load_data(&app)?;
    let profile = data
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "Profile 不存在。".to_string())?;
    if let Some(selected) = normalize_optional_string(selected_image_path) {
        let source = PathBuf::from(selected);
        let metadata = fs::metadata(&source).map_err(format_io_error)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 16 * 1024 * 1024 {
            return Err("皮肤背景必须是 1 字节到 16 MB 的图片文件。".to_string());
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
            .ok_or_else(|| "皮肤背景仅支持 PNG、JPEG 或 WebP。".to_string())?;
        let theme_dir = Path::new(&profile.home_path)
            .join(".codex-switch-helper")
            .join("dream-skin");
        fs::create_dir_all(&theme_dir).map_err(format_io_error)?;
        let destination = theme_dir.join(format!("background.{extension}"));
        let temporary = theme_dir.join(format!(".background-{}.tmp", Uuid::new_v4()));
        fs::copy(&source, &temporary).map_err(format_io_error)?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(format_io_error)?;
        }
        fs::rename(&temporary, &destination).map_err(format_io_error)?;
        skin.background_path = Some(path_to_string(&destination)?);
    } else if skin.background_path.is_none() {
        skin.background_path = profile.skin.background_path.clone();
    }
    if skin.enabled && skin.background_path.is_none() {
        return Err("启用皮肤前请先选择背景图。".to_string());
    }
    profile.skin = skin;
    profile.updated_at = Utc::now().to_rfc3339();
    let updated = profile.clone();
    save_data(&app, &data)?;
    Ok(updated)
}

fn validate_skin_settings(skin: &ProfileSkinSettings) -> Result<(), String> {
    if !matches!(skin.appearance.as_str(), "auto" | "light" | "dark") {
        return Err("皮肤外观只能是 auto、light 或 dark。".to_string());
    }
    if !(0.0..=1.0).contains(&skin.focus_x) || !(0.0..=1.0).contains(&skin.focus_y) {
        return Err("皮肤焦点必须在 0 到 1 之间。".to_string());
    }
    if !matches!(
        skin.safe_area.as_str(),
        "auto" | "left" | "right" | "center" | "none"
    ) {
        return Err("皮肤安全区设置无效。".to_string());
    }
    if !matches!(
        skin.task_mode.as_str(),
        "auto" | "ambient" | "banner" | "off"
    ) {
        return Err("皮肤任务页模式无效。".to_string());
    }
    Ok(())
}

fn write_skin_theme(profile: &Profile, theme_dir: &Path) -> Result<(), String> {
    validate_skin_settings(&profile.skin)?;
    let background = PathBuf::from(
        profile
            .skin
            .background_path
            .as_deref()
            .ok_or_else(|| "皮肤背景图未配置。".to_string())?,
    );
    let image_name = background
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "皮肤背景文件名无效。".to_string())?;
    if background.parent() != Some(theme_dir) {
        return Err("皮肤背景不在此 Profile 的受管主题目录中。".to_string());
    }
    fs::create_dir_all(theme_dir).map_err(format_io_error)?;
    let theme = serde_json::json!({
        "schemaVersion": 1,
        "id": format!("profile-{}", profile.id),
        "name": profile.name,
        "image": image_name,
        "appearance": profile.skin.appearance,
        "art": {
            "focusX": profile.skin.focus_x,
            "focusY": profile.skin.focus_y,
            "safeArea": profile.skin.safe_area,
            "taskMode": profile.skin.task_mode,
        }
    });
    fs::write(
        theme_dir.join("theme.json"),
        serde_json::to_string_pretty(&theme).map_err(|error| error.to_string())?,
    )
    .map_err(format_io_error)
}

#[tauri::command]
fn delete_profile(app: AppHandle, profile_id: String) -> Result<(), String> {
    let mut data = load_data(&app)?;
    let profile = find_profile(&data, &profile_id)?.clone();
    data.profiles.retain(|item| item.id != profile_id);
    if data.active_profile_id.as_deref() == Some(&profile.id) {
        data.active_profile_id = data.profiles.first().map(|item| item.id.clone());
    }
    if profile.managed
        && managed_profile_home(&app, &profile.id)? == PathBuf::from(&profile.home_path)
    {
        let home_path = PathBuf::from(&profile.home_path);
        if home_path.exists() {
            fs::remove_dir_all(home_path).map_err(format_io_error)?;
        }
    }
    save_data(&app, &data)
}

#[tauri::command]
fn detect_codex_app_id() -> Result<Option<String>, String> {
    let script = r#"
$candidate = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*' } | Select-Object -First 1 -ExpandProperty AppID
if ($candidate) { $candidate; exit }
$candidate = Get-StartApps | Where-Object { $_.Name -eq 'Codex' -and $_.AppID -like '*Codex*' } | Select-Object -First 1 -ExpandProperty AppID
if ($candidate) { $candidate; exit }
"#;

    let output = hidden_command("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .output()
        .map_err(format_io_error)?;

    if !output.status.success() {
        return Ok(None);
    }

    let app_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if app_id.is_empty() {
        Ok(None)
    } else {
        Ok(Some(app_id))
    }
}

#[tauri::command]
fn launch_default_codex(app: AppHandle) -> Result<(), String> {
    let data = load_data(&app)?;
    if apply_proxy_settings(&data.settings)? {
        broadcast_environment_change();
    }
    launch_codex_app(&data.settings.codex_app_id)
}

#[tauri::command]
fn clear_codex_home(app: AppHandle) -> Result<(), String> {
    delete_user_env(CODEX_HOME_ENV_KEY)?;
    broadcast_environment_change();

    let mut data = load_data(&app)?;
    data.active_profile_id = None;
    save_data(&app, &data)
}

#[tauri::command]
async fn inspect_profile(app: AppHandle, profile_id: String) -> Result<ProfileInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_profile_blocking(app, profile_id))
        .await
        .map_err(|error| format!("Profile 检查任务失败：{error}"))?
}

fn inspect_profile_blocking(
    app: AppHandle,
    profile_id: String,
) -> Result<ProfileInspection, String> {
    let data = load_data(&app)?;
    let profile = find_profile(&data, &profile_id)?;
    let home = Path::new(&profile.home_path);
    Ok(ProfileInspection {
        exists: home.exists(),
        has_auth_json: home.join("auth.json").is_file(),
        has_config_toml: home.join(CODEX_CONFIG_FILENAME).is_file(),
        file_count: count_files(home).map_err(format_io_error)?,
    })
}

#[tauri::command]
fn test_profile_connection(
    app: AppHandle,
    profile_id: String,
) -> Result<ConnectionTestResult, String> {
    let data = load_data(&app)?;
    let profile = find_profile(&data, &profile_id)?;
    test_connection_for_profile(profile)
}

#[tauri::command]
fn test_login_connection(
    auth_mode: AuthMode,
    api_key: Option<String>,
    auth_json_path: Option<String>,
    source_path: Option<String>,
    api_base_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    match auth_mode {
        AuthMode::ApiKey => {
            let endpoint = models_endpoint(api_base_url.as_deref());
            let api_key = api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "测试 API Key 需要先填写 Key。".to_string())?;
            test_http_bearer(&endpoint, api_key)
        }
        AuthMode::Account => {
            let auth_json =
                read_account_test_auth_json(auth_json_path.as_deref(), source_path.as_deref())?;
            validate_auth_json_content(&auth_json)?;
            Ok(ConnectionTestResult {
                ok: true,
                status: "auth.json 可读取".to_string(),
                endpoint: "local auth.json".to_string(),
            })
        }
    }
}

#[tauri::command]
fn test_proxy_connection(settings: AppSettings) -> Result<ConnectionTestResult, String> {
    if !settings.proxy_enabled {
        return Err("请先启用代理。".to_string());
    }
    let proxy = proxy_url(&settings)?;
    test_http_proxy(&proxy, "https://api.openai.com/v1/models")
}

#[tauri::command]
async fn launch_codex(app: AppHandle, profile_id: String) -> Result<CodexInstance, String> {
    tauri::async_runtime::spawn_blocking(move || launch_codex_blocking(app, profile_id))
        .await
        .map_err(|error| format!("Codex 启动任务失败：{error}"))?
}

fn launch_codex_blocking(app: AppHandle, profile_id: String) -> Result<CodexInstance, String> {
    let mut data = load_data(&app)?;
    let profile_index = data
        .profiles
        .iter()
        .position(|profile| profile.id == profile_id)
        .ok_or_else(|| "Profile 不存在。".to_string())?;

    let home_path = PathBuf::from(&data.profiles[profile_index].home_path);
    fs::create_dir_all(&home_path).map_err(format_io_error)?;
    seed_profile_config_if_missing(&app, &data.profiles[profile_index], &home_path)?;
    if let Some(config_toml) = migrate_home_config_paths(&app, &home_path)? {
        data.profiles[profile_index].config_toml = Some(config_toml);
    }
    apply_profile_auth_files_to_home(&data.profiles[profile_index], &home_path, false)?;
    ensure_shared_agents_link(&home_path)?;
    if let Some(config_toml) = migrate_home_config_paths(
        &app,
        &PathBuf::from(&data.profiles[profile_index].home_path),
    )? {
        data.profiles[profile_index].config_toml = Some(config_toml);
    }

    let executable = detect_codex_executable()?
        .ok_or_else(|| "未找到 Codex 桌面应用入口，无法启动独立实例。".to_string())?;
    let app_user_data = app_data_dir(&app)?.join("codex-app-data").join(&profile_id);
    fs::create_dir_all(&app_user_data).map_err(format_io_error)?;
    let skin = data.profiles[profile_index].skin.clone();
    let skin_runtime = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("dream-skin");
    let skin_theme_dir = home_path.join(".codex-switch-helper").join("dream-skin");
    let skin_launch = if skin.enabled {
        let background = skin
            .background_path
            .as_deref()
            .ok_or_else(|| "此 Profile 已启用皮肤，但尚未选择背景图。".to_string())?;
        if !Path::new(background).is_file() {
            return Err("此 Profile 的皮肤背景图不存在，请重新选择。".to_string());
        }
        write_skin_theme(&data.profiles[profile_index], &skin_theme_dir)?;
        let node = dream_skin::validate_node()?;
        let port = dream_skin::reserve_loopback_port()?;
        Some((node, port))
    } else {
        None
    };
    let mut command = hidden_command(executable.to_string_lossy().as_ref());
    command
        .arg(user_data_dir_arg(&app_user_data))
        .env(CODEX_HOME_ENV_KEY, &home_path);
    if let Some((_, port)) = skin_launch.as_ref() {
        command
            .arg("--remote-debugging-address=127.0.0.1")
            .arg(format!("--remote-debugging-port={port}"));
    }
    apply_profile_process_env(&mut command, &data.profiles[profile_index])?;
    apply_proxy_process_env(&mut command, &data.settings)?;
    let mut child = command.spawn().map_err(format_io_error)?;
    let (skin_injector_pid, skin_cdp_port) = if let Some((node, port)) = skin_launch {
        let browser_id =
            match dream_skin::wait_for_browser_id(port, std::time::Duration::from_secs(30)) {
                Ok(browser_id) => browser_id,
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            };
        let injector = match dream_skin::start_injector(
            &node,
            &skin_runtime,
            &skin_theme_dir,
            &home_path.join(".codex-switch-helper").join("logs"),
            port,
            &browser_id,
        ) {
            Ok(injector) => injector,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        (Some(injector.id()), Some(port))
    } else {
        (None, None)
    };

    let launched_at = Utc::now();
    let now = launched_at.to_rfc3339();
    open_usage_db(&app)?.record_profile_launch(
        &profile_id,
        &data.profiles[profile_index].home_path,
        launched_at.timestamp(),
    )?;
    data.profiles[profile_index].last_used_at = Some(now.clone());
    data.profiles[profile_index].updated_at = now.clone();
    data.active_profile_id = Some(profile_id.clone());
    save_data(&app, &data)?;
    let instance = CodexInstance {
        profile_id,
        profile_name: data.profiles[profile_index].name.clone(),
        pid: child.id(),
        started_at: now,
        skin_injector_pid,
        skin_cdp_port,
    };
    codex_instances()
        .lock()
        .map_err(|_| "实例状态锁已损坏。".to_string())?
        .push(instance.clone());
    Ok(instance)
}

fn apply_profile_process_env(command: &mut Command, profile: &Profile) -> Result<(), String> {
    match profile.auth_mode {
        AuthMode::Account => {
            command.env_remove(OPENAI_API_KEY);
        }
        AuthMode::ApiKey => {
            let key = profile
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "API Key 登录方式需要填写 OPENAI_API_KEY。".to_string())?;
            command.env(OPENAI_API_KEY, key);
        }
    }
    Ok(())
}

fn apply_proxy_process_env(command: &mut Command, settings: &AppSettings) -> Result<(), String> {
    if settings.proxy_enabled {
        let proxy = proxy_url(settings)?;
        let no_proxy = loopback_no_proxy_value(env::var_os(NO_PROXY_ENV_KEY));
        command
            .env(HTTP_PROXY_ENV_KEY, &proxy)
            .env(HTTPS_PROXY_ENV_KEY, &proxy)
            .env(ALL_PROXY_ENV_KEY, &proxy)
            .env(NO_PROXY_ENV_KEY, no_proxy);
    } else {
        command
            .env_remove(HTTP_PROXY_ENV_KEY)
            .env_remove(HTTPS_PROXY_ENV_KEY)
            .env_remove(ALL_PROXY_ENV_KEY);
    }
    Ok(())
}

#[tauri::command]
fn reveal_profile_folder(app: AppHandle, profile_id: String) -> Result<(), String> {
    let data = load_data(&app)?;
    let profile = find_profile(&data, &profile_id)?;
    fs::create_dir_all(&profile.home_path).map_err(format_io_error)?;
    hidden_command("explorer.exe")
        .arg(&profile.home_path)
        .spawn()
        .map_err(format_io_error)?;
    Ok(())
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    if settings.codex_app_id.trim().is_empty() {
        return Err("Codex AppID 不能为空。".to_string());
    }
    validate_proxy_settings(&settings)?;
    validate_theme(&settings.theme)?;
    set_launch_at_startup(settings.launch_at_startup)?;
    apply_proxy_settings_to_current_process(&settings)?;

    let mut data = load_data(&app)?;
    data.settings = AppSettings {
        codex_app_id: settings.codex_app_id.trim().to_string(),
        env_key: CODEX_HOME_ENV_KEY.to_string(),
        delete_open_ai_api_key_before_launch: settings.delete_open_ai_api_key_before_launch,
        proxy_enabled: settings.proxy_enabled,
        proxy_protocol: settings.proxy_protocol.trim().to_string(),
        proxy_host: settings.proxy_host.trim().to_string(),
        proxy_port: settings.proxy_port.trim().to_string(),
        launch_at_startup: settings.launch_at_startup,
        theme: settings.theme.trim().to_string(),
    };
    save_data(&app, &data)
}

fn default_theme() -> String {
    "light".to_string()
}

fn validate_theme(theme: &str) -> Result<(), String> {
    if matches!(theme.trim(), "light" | "dark") {
        Ok(())
    } else {
        Err("主题只能是 light 或 dark。".to_string())
    }
}

#[cfg(windows)]
fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(AUTOSTART_REGISTRY_PATH)
        .map_err(|error| format!("无法打开开机启动注册表项：{error}"))?;
    if enabled {
        let executable = env::current_exe().map_err(format_io_error)?;
        key.set_value(
            AUTOSTART_VALUE_NAME,
            &format!("\"{}\"", executable.display()),
        )
        .map_err(|error| format!("无法启用开机启动：{error}"))?;
    } else {
        match key.delete_value(AUTOSTART_VALUE_NAME) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法关闭开机启动：{error}")),
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_launch_at_startup(_enabled: bool) -> Result<(), String> {
    Err("开机启动设置目前仅支持 Windows。".to_string())
}

#[tauri::command]
fn is_codex_process_running() -> bool {
    codex_process_running()
}

fn launch_codex_app(app_id: &str) -> Result<(), String> {
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Err("Codex AppID 不能为空。".to_string());
    }

    hidden_command("explorer.exe")
        .arg(format!("shell:AppsFolder\\{app_id}"))
        .spawn()
        .map_err(format_io_error)?;
    Ok(())
}

fn detect_codex_executable() -> Result<Option<PathBuf>, String> {
    let output = hidden_command("powershell.exe")
        .args(["-NoProfile", "-Command", DETECT_CODEX_EXECUTABLE_SCRIPT])
        .output()
        .map_err(format_io_error)?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(path)))
    }
}

fn user_data_dir_arg(path: &Path) -> OsString {
    let mut arg = OsString::from("--user-data-dir=");
    arg.push(path.as_os_str());
    arg
}

#[tauri::command]
async fn list_codex_instances() -> Result<Vec<CodexInstance>, String> {
    let instances = codex_instances()
        .lock()
        .map_err(|_| "实例状态锁已损坏。".to_string())?
        .clone();
    let checked_pids = instances
        .iter()
        .map(|instance| instance.pid)
        .collect::<Vec<_>>();
    let running = tauri::async_runtime::spawn_blocking(move || {
        filter_running_instances(instances, process_running)
    })
    .await
    .map_err(|error| format!("实例状态检查任务失败：{error}"))?;
    let running_pids = running
        .iter()
        .map(|instance| instance.pid)
        .collect::<Vec<_>>();
    for instance in codex_instances()
        .lock()
        .map_err(|_| "实例状态锁已损坏。".to_string())?
        .iter()
        .filter(|instance| {
            checked_pids.contains(&instance.pid) && !running_pids.contains(&instance.pid)
        })
    {
        if let Some(injector_pid) = instance.skin_injector_pid {
            let _ = hidden_command("taskkill.exe")
                .args(taskkill_args(injector_pid))
                .status();
        }
    }
    codex_instances()
        .lock()
        .map_err(|_| "实例状态锁已损坏。".to_string())?
        .retain(|instance| {
            !checked_pids.contains(&instance.pid) || running_pids.contains(&instance.pid)
        });
    Ok(running)
}

fn filter_running_instances(
    instances: Vec<CodexInstance>,
    mut is_running: impl FnMut(u32) -> bool,
) -> Vec<CodexInstance> {
    instances
        .into_iter()
        .filter(|instance| is_running(instance.pid))
        .collect()
}

#[tauri::command]
fn stop_codex_instance(pid: u32) -> Result<(), String> {
    let tracked = codex_instances()
        .lock()
        .map_err(|_| "实例状态锁已损坏。".to_string())?
        .iter()
        .find(|instance| instance.pid == pid)
        .cloned();
    let Some(tracked) = tracked else {
        return Err("该 PID 不是本程序启动的 Codex 实例。".to_string());
    };
    if let Some(injector_pid) = tracked.skin_injector_pid {
        let _ = hidden_command("taskkill.exe")
            .args(taskkill_args(injector_pid))
            .status();
    }
    let status = hidden_command("taskkill.exe")
        .args(taskkill_args(pid))
        .status()
        .map_err(format_io_error)?;
    if !status.success() {
        return Err(format!("无法停止 Codex 实例 PID {pid}。"));
    }
    if process_running(pid) {
        return Err(format!("Codex 实例 PID {pid} 在强制终止后仍在运行。"));
    }
    codex_instances()
        .lock()
        .map_err(|_| "实例状态锁已损坏。".to_string())?
        .retain(|instance| instance.pid != pid);
    Ok(())
}

fn taskkill_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

fn process_running(pid: u32) -> bool {
    hidden_command("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

fn new_profile(
    app: &AppHandle,
    name: &str,
    source_path: Option<&Path>,
    auth_mode: AuthMode,
    api_key: Option<String>,
    auth_json_path: Option<&Path>,
    api_provider: Option<String>,
    api_base_url: Option<String>,
    api_route_enabled: bool,
    api_route_model: Option<String>,
    environment_mode: EnvironmentMode,
) -> Result<Profile, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let home_path = if environment_mode == EnvironmentMode::Sandbox {
        managed_profile_home(app, &id)?
    } else {
        source_path
            .map(Path::to_path_buf)
            .unwrap_or(default_codex_home()?)
    };
    let auth_json = if matches!(auth_mode, AuthMode::Account) {
        auth_json_path.map(read_auth_json_file).transpose()?
    } else {
        None
    };
    let mut config_toml = if environment_mode == EnvironmentMode::Sandbox {
        match source_path {
            Some(source_path) => read_config_toml(source_path)?,
            None => None,
        }
    } else {
        None
    };
    if environment_mode == EnvironmentMode::Sandbox && matches!(auth_mode, AuthMode::Account) {
        config_toml = Some(with_file_auth_credentials_store(
            config_toml.as_deref().unwrap_or_default(),
        ));
    }
    let api_provider = normalize_optional_string(api_provider);
    let api_base_url = normalize_optional_string(api_base_url);
    let api_route_model = normalize_optional_string(api_route_model);
    if matches!(auth_mode, AuthMode::ApiKey) && api_route_enabled {
        config_toml = Some(build_api_route_config(
            api_base_url.as_deref().unwrap_or_default(),
            api_route_model.as_deref().unwrap_or_default(),
        ));
    }
    Ok(Profile {
        id,
        name: name.to_string(),
        home_path: path_to_string(&home_path)?,
        import_source_path: source_path.map(path_to_string).transpose()?,
        environment_mode,
        auth_mode,
        api_key: normalize_optional_string(api_key),
        api_provider,
        api_base_url,
        api_route_enabled,
        api_route_model,
        auth_json,
        config_toml,
        managed: environment_mode == EnvironmentMode::Sandbox,
        created_at: now.clone(),
        updated_at: now,
        last_used_at: None,
        skin: ProfileSkinSettings::default(),
    })
}

fn default_codex_home() -> Result<PathBuf, String> {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            Some(PathBuf::from(format!(
                "{}{}",
                drive.to_string_lossy(),
                path.to_string_lossy()
            )))
        })
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "无法定位当前用户 Home 目录。".to_string())
}

fn agents_root() -> Result<PathBuf, String> {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| home.join(".agents"))
        .ok_or_else(|| "无法定位当前用户 Home 目录。".to_string())
}

fn shared_agents_path() -> Result<PathBuf, String> {
    Ok(agents_root()?.join(SHARED_AGENTS_FILENAME))
}

fn ensure_shared_agents_link(codex_home: &Path) -> Result<(), String> {
    let source = shared_agents_path()?;
    if let Some(parent) = source.parent() {
        fs::create_dir_all(parent).map_err(format_io_error)?;
    }
    if !source.exists() {
        fs::write(&source, "").map_err(format_io_error)?;
    }
    link_agents_file(&source, codex_home)
}

fn link_agents_file(source: &Path, codex_home: &Path) -> Result<(), String> {
    fs::create_dir_all(codex_home).map_err(format_io_error)?;
    let target = codex_home.join(SHARED_AGENTS_FILENAME);
    if fs::read_link(&target).ok().as_deref() == Some(source) {
        return Ok(());
    }
    if target.exists() || fs::symlink_metadata(&target).is_ok() {
        fs::remove_file(&target).map_err(format_io_error)?;
    }
    #[cfg(windows)]
    {
        symlink_file(&source, &target).or_else(|symlink_error| {
            fs::hard_link(&source, &target).map_err(|hard_link_error| {
                io::Error::new(
                    hard_link_error.kind(),
                    format!(
                        "无法创建 AGENTS.md 符号链接（{symlink_error}），硬链接回退也失败（{hard_link_error}）"
                    ),
                )
            })
        })
        .map_err(format_io_error)
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&source, &target).map_err(format_io_error)
}

#[tauri::command]
fn get_shared_resources() -> Result<SharedResources, String> {
    let root = agents_root()?;
    let agents_path = root.join(SHARED_AGENTS_FILENAME);
    let skills_path = root.join("skills");
    let agents_content = if agents_path.is_file() {
        fs::read_to_string(&agents_path).map_err(format_io_error)?
    } else {
        String::new()
    };
    let mut skills = Vec::new();
    if skills_path.is_dir() {
        for entry in fs::read_dir(&skills_path).map_err(format_io_error)? {
            let entry = entry.map_err(format_io_error)?;
            let path = entry.path();
            let skill_file = path.join("SKILL.md");
            if !path.is_dir() || !skill_file.is_file() {
                continue;
            }
            let content = fs::read_to_string(&skill_file).unwrap_or_default();
            let description = content
                .lines()
                .find_map(|line| line.strip_prefix("description:"))
                .map(|value| value.trim().trim_matches('"').to_string());
            skills.push(SkillInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                description,
            });
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(SharedResources {
        agents_path: agents_path.to_string_lossy().to_string(),
        agents_content,
        skills_path: skills_path.to_string_lossy().to_string(),
        skills,
    })
}

#[tauri::command]
fn save_shared_agents(app: AppHandle, content: String) -> Result<(), String> {
    let path = shared_agents_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(format_io_error)?;
    }
    fs::write(path, content).map_err(format_io_error)?;
    let data = load_data(&app)?;
    for profile in data.profiles.iter().filter(|profile| profile.managed) {
        ensure_shared_agents_link(Path::new(&profile.home_path))?;
    }
    Ok(())
}

fn read_auth_json(source_path: &Path) -> Result<String, String> {
    read_auth_json_file(&source_path.join("auth.json"))
}

fn read_auth_json_file(auth_path: &Path) -> Result<String, String> {
    if !auth_path.is_file() {
        return Err("账号登录 Profile 需要导入 auth.json 文件。".to_string());
    }
    fs::read_to_string(auth_path).map_err(format_io_error)
}

fn read_config_toml(source_path: &Path) -> Result<Option<String>, String> {
    let config_path = source_path.join(CODEX_CONFIG_FILENAME);
    if !config_path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(config_path)
        .map(Some)
        .map_err(format_io_error)
}

fn seed_profile_config_if_missing(
    app: &AppHandle,
    profile: &Profile,
    codex_home: &Path,
) -> Result<(), String> {
    let config_path = codex_home.join(CODEX_CONFIG_FILENAME);
    if config_path.is_file() {
        return Ok(());
    }

    if let Some(config_toml) = profile.config_toml.as_deref() {
        let config_toml = rewrite_shared_paths_to_home(app, config_toml, codex_home)?;
        seed_config_file_if_missing(&config_path, &config_toml)?;
    }
    Ok(())
}

fn seed_config_file_if_missing(config_path: &Path, config_toml: &str) -> Result<(), String> {
    if !config_path.is_file() {
        fs::write(config_path, config_toml).map_err(format_io_error)?;
    }
    Ok(())
}

fn with_file_auth_credentials_store(config_toml: &str) -> String {
    let mut found = false;
    let mut lines = config_toml
        .lines()
        .map(|line| {
            let is_auth_store = line
                .split_once('=')
                .is_some_and(|(key, _)| key.trim() == "cli_auth_credentials_store");
            if is_auth_store {
                found = true;
                FILE_AUTH_CREDENTIALS_SETTING.to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();

    if !found {
        // This is a root-level Codex setting. Prepend it so a trailing TOML table
        // (for example `[mcp_servers.foo]`) cannot capture it.
        lines.insert(0, FILE_AUTH_CREDENTIALS_SETTING.to_string());
    }
    let mut result = lines.join("\n");
    result.push('\n');
    result
}

fn migrate_home_config_paths(app: &AppHandle, codex_home: &Path) -> Result<Option<String>, String> {
    let config_path = codex_home.join(CODEX_CONFIG_FILENAME);
    if !config_path.is_file() {
        return Ok(None);
    }

    let config_toml = fs::read_to_string(&config_path).map_err(format_io_error)?;
    let migrated = rewrite_shared_paths_to_home(app, &config_toml, codex_home)?;
    if migrated != config_toml {
        fs::write(config_path, &migrated).map_err(format_io_error)?;
    }
    Ok(Some(migrated))
}

fn rewrite_shared_paths_to_home(
    app: &AppHandle,
    config_toml: &str,
    codex_home: &Path,
) -> Result<String, String> {
    let shared_root = app_data_dir(app)?.join("shared");
    rewrite_shared_root_to_home(config_toml, &shared_root, codex_home)
}

fn rewrite_shared_root_to_home(
    config_toml: &str,
    shared_root: &Path,
    codex_home: &Path,
) -> Result<String, String> {
    let shared_root = path_to_string(shared_root)?;
    let codex_home = path_to_string(codex_home)?;

    let mut migrated = config_toml.replace(&shared_root, &codex_home);
    let shared_root_forward = shared_root.replace('\\', "/");
    if shared_root_forward != shared_root {
        let codex_home_forward = codex_home.replace('\\', "/");
        migrated = migrated.replace(&shared_root_forward, &codex_home_forward);
    }

    Ok(migrated)
}

fn apply_profile_auth_files_to_home(
    profile: &Profile,
    codex_home: &Path,
    require_stored_account_auth: bool,
) -> Result<(), String> {
    match profile.auth_mode {
        AuthMode::Account => {
            let auth_json = profile.auth_json.as_deref();
            let auth_path = codex_home.join("auth.json");
            if auth_json.is_none() && !require_stored_account_auth {
                return Ok(());
            }
            let auth_json = auth_json
                .ok_or_else(|| "此 Profile 没有保存 auth.json，无法切换账号登录态。".to_string())?;
            fs::create_dir_all(codex_home).map_err(format_io_error)?;
            fs::write(auth_path, auth_json).map_err(format_io_error)
        }
        AuthMode::ApiKey => {
            fs::create_dir_all(codex_home).map_err(format_io_error)?;
            let auth_path = codex_home.join("auth.json");
            if auth_path.exists() {
                fs::remove_file(auth_path).map_err(format_io_error)?;
            }
            Ok(())
        }
    }
}

fn initialize_new_profile_auth_files(profile: &Profile, codex_home: &Path) -> Result<(), String> {
    let auth_path = codex_home.join("auth.json");
    match profile.auth_mode {
        AuthMode::Account => {
            if let Some(auth_json) = profile.auth_json.as_deref() {
                fs::write(auth_path, auth_json).map_err(format_io_error)?;
            } else if auth_path.exists() {
                fs::remove_file(auth_path).map_err(format_io_error)?;
            }
        }
        AuthMode::ApiKey => {
            if auth_path.exists() {
                fs::remove_file(auth_path).map_err(format_io_error)?;
            }
        }
    }
    Ok(())
}

fn managed_profile_home(app: &AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?
        .join("profiles")
        .join(profile_id)
        .join("home"))
}

fn validate_auth(auth_mode: &AuthMode, api_key: Option<&str>) -> Result<(), String> {
    if matches!(auth_mode, AuthMode::ApiKey)
        && api_key.map(str::trim).unwrap_or_default().is_empty()
    {
        return Err("API Key 登录方式需要填写 OPENAI_API_KEY。".to_string());
    }
    Ok(())
}

fn test_connection_for_profile(profile: &Profile) -> Result<ConnectionTestResult, String> {
    match profile.auth_mode {
        AuthMode::ApiKey => {
            let api_key = profile
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "此 Profile 没有保存 API Key。".to_string())?;
            let endpoint = models_endpoint(profile.api_base_url.as_deref());
            test_http_bearer(&endpoint, api_key)
        }
        AuthMode::Account => {
            let auth_json = match profile.auth_json.as_deref() {
                Some(auth_json) => auth_json.to_string(),
                None => read_auth_json_file(&Path::new(&profile.home_path).join("auth.json"))?,
            };
            validate_auth_json_content(&auth_json)?;
            Ok(ConnectionTestResult {
                ok: true,
                status: "auth.json 可读取".to_string(),
                endpoint: "local auth.json".to_string(),
            })
        }
    }
}

fn models_endpoint(api_base_url: Option<&str>) -> String {
    let base_url = api_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if base_url.ends_with("/models") {
        base_url.to_string()
    } else {
        format!("{base_url}/models")
    }
}

fn read_account_test_auth_json(
    auth_json_path: Option<&str>,
    source_path: Option<&str>,
) -> Result<String, String> {
    if let Some(path) = auth_json_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return read_auth_json_file(Path::new(path));
    }
    if let Some(path) = source_path.map(str::trim).filter(|value| !value.is_empty()) {
        return read_auth_json(Path::new(path));
    }
    read_auth_json(&default_codex_home()?)
}

fn validate_auth_json_content(auth_json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(auth_json)
        .map(|_| ())
        .map_err(|error| format!("auth.json 解析失败：{error}"))
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn test_http_bearer(endpoint: &str, bearer: &str) -> Result<ConnectionTestResult, String> {
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$headers = @{{ Authorization = 'Bearer {bearer}' }}
try {{
  $response = Invoke-WebRequest -Uri '{endpoint}' -Headers $headers -Method Get -TimeoutSec 20 -UseBasicParsing
  Write-Output ("OK|" + [int]$response.StatusCode)
}} catch {{
  if ($_.Exception.Response) {{
    Write-Output ("ERR|" + [int]$_.Exception.Response.StatusCode)
  }} else {{
    Write-Output ("ERR|" + $_.Exception.Message)
  }}
}}
"#,
        bearer = escape_powershell_single_quote(bearer),
        endpoint = escape_powershell_single_quote(endpoint)
    );
    let output = hidden_command("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(format_io_error)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = stdout.splitn(2, '|');
    let kind = parts.next().unwrap_or_default();
    let status = parts.next().unwrap_or_default().to_string();
    Ok(ConnectionTestResult {
        ok: kind == "OK",
        status: if status.is_empty() { stdout } else { status },
        endpoint: endpoint.to_string(),
    })
}

fn test_http_proxy(proxy: &str, endpoint: &str) -> Result<ConnectionTestResult, String> {
    let output = hidden_command("curl.exe")
        .args([
            "--connect-timeout",
            "10",
            "--max-time",
            "20",
            "--proxy",
            proxy,
            "-o",
            "NUL",
            "-sS",
            "-w",
            "%{http_code}",
            endpoint,
        ])
        .output()
        .map_err(format_io_error)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let ok = output.status.success() && !stdout.is_empty() && stdout != "000";
    Ok(ConnectionTestResult {
        ok,
        status: if stdout.is_empty() || stdout == "000" {
            stderr
        } else {
            stdout
        },
        endpoint: format!("{endpoint} via {proxy}"),
    })
}

fn escape_powershell_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn validate_api_route(
    auth_mode: &AuthMode,
    route_enabled: bool,
    api_base_url: Option<&str>,
    api_route_model: Option<&str>,
) -> Result<(), String> {
    if !route_enabled {
        return Ok(());
    }
    if !matches!(auth_mode, AuthMode::ApiKey) {
        return Err("第三方 API 路由只支持 API Key 登录方式。".to_string());
    }
    if api_base_url.map(str::trim).unwrap_or_default().is_empty() {
        return Err("启用第三方 API 路由需要填写 Base URL。".to_string());
    }
    if api_route_model
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        return Err("启用第三方 API 路由需要填写模型名。".to_string());
    }
    Ok(())
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_proxy_protocol() -> String {
    "http".to_string()
}

fn validate_proxy_settings(settings: &AppSettings) -> Result<(), String> {
    if !settings.proxy_enabled {
        return Ok(());
    }
    let protocol = settings.proxy_protocol.trim();
    if protocol != "http" && protocol != "socks5" {
        return Err("代理协议只支持 http 或 socks5。".to_string());
    }
    if settings.proxy_host.trim().is_empty() {
        return Err("启用代理需要填写主机。".to_string());
    }
    let port_number = settings
        .proxy_port
        .trim()
        .parse::<u16>()
        .map_err(|_| "代理端口必须是 1-65535 的数字。".to_string())?;
    if port_number == 0 {
        return Err("代理端口必须是 1-65535 的数字。".to_string());
    }
    Ok(())
}

fn proxy_url(settings: &AppSettings) -> Result<String, String> {
    validate_proxy_settings(settings)?;
    Ok(format!(
        "{}://{}:{}",
        settings.proxy_protocol.trim(),
        settings.proxy_host.trim(),
        settings.proxy_port.trim()
    ))
}

fn loopback_no_proxy_value(existing: Option<OsString>) -> OsString {
    let mut entries = existing
        .as_deref()
        .map(|value| {
            value
                .to_string_lossy()
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for loopback in LOOPBACK_NO_PROXY.split(',') {
        if !entries
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(loopback))
        {
            entries.push(loopback.to_string());
        }
    }
    OsString::from(entries.join(","))
}

fn apply_proxy_settings_to_current_process(settings: &AppSettings) -> Result<(), String> {
    if settings.proxy_enabled {
        let proxy_url = proxy_url(settings)?;
        let no_proxy = loopback_no_proxy_value(env::var_os(NO_PROXY_ENV_KEY));
        unsafe {
            env::set_var(HTTP_PROXY_ENV_KEY, &proxy_url);
            env::set_var(HTTPS_PROXY_ENV_KEY, &proxy_url);
            env::set_var(ALL_PROXY_ENV_KEY, &proxy_url);
            env::set_var(NO_PROXY_ENV_KEY, no_proxy);
        }
    } else {
        unsafe {
            env::remove_var(HTTP_PROXY_ENV_KEY);
            env::remove_var(HTTPS_PROXY_ENV_KEY);
            env::remove_var(ALL_PROXY_ENV_KEY);
        }
    }
    Ok(())
}

fn apply_proxy_settings(settings: &AppSettings) -> Result<bool, String> {
    apply_proxy_settings_to_current_process(settings)?;
    let legacy_proxy_url =
        if settings.proxy_host.trim().is_empty() || settings.proxy_port.trim().is_empty() {
            None
        } else {
            Some(format!(
                "{}://{}:{}",
                settings.proxy_protocol.trim(),
                settings.proxy_host.trim(),
                settings.proxy_port.trim()
            ))
        };
    let mut changed = false;
    for key in [HTTP_PROXY_ENV_KEY, HTTPS_PROXY_ENV_KEY, ALL_PROXY_ENV_KEY] {
        if let Some(expected) = legacy_proxy_url.as_deref() {
            if read_user_env(key)?.as_deref() == Some(expected) {
                delete_user_env(key)?;
                changed = true;
            }
        }
    }
    Ok(changed)
}

fn build_api_route_config(api_base_url: &str, model: &str) -> String {
    format!(
        r#"model_provider = "third_party"
model = "{}"

[model_providers.third_party]
name = "Third-party OpenAI-compatible"
base_url = "{}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
"#,
        escape_toml_string(model.trim()),
        escape_toml_string(api_base_url.trim())
    )
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalize_optional_home_path(home_path: &str) -> Result<Option<PathBuf>, String> {
    let value = home_path.trim();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(value)))
}

fn normalized_name(name: &str) -> Result<String, String> {
    let value = name.trim();
    if value.is_empty() {
        return Err("Profile 名称不能为空。".to_string());
    }
    Ok(value.to_string())
}

fn find_profile<'a>(data: &'a StoredData, profile_id: &str) -> Result<&'a Profile, String> {
    data.profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "Profile 不存在。".to_string())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法读取应用数据目录：{error}"))
}

fn data_file(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os(DATA_FILE_OVERRIDE_ENV_KEY) {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Ok(path);
        }
        return Ok(app_data_dir(app)?.join(path));
    }
    Ok(app_data_dir(app)?.join("data.json"))
}

fn load_data(app: &AppHandle) -> Result<StoredData, String> {
    let path = data_file(app)?;
    if !path.exists() {
        return Ok(StoredData::default());
    }
    let content = fs::read_to_string(&path).map_err(format_io_error)?;
    let mut data: StoredData =
        serde_json::from_str(&content).map_err(|error| format!("配置文件解析失败：{error}"))?;
    let mut migrated = false;
    for profile in &mut data.profiles {
        if profile.environment_mode == EnvironmentMode::Sandbox && profile.managed {
            continue;
        }
        let source = PathBuf::from(&profile.home_path);
        let target = managed_profile_home(app, &profile.id)?;
        if source != target && !target.exists() {
            if !source.is_dir() {
                return Err(format!(
                    "无法迁移 Profile“{}”：原 Home 不存在：{}",
                    profile.name,
                    source.display()
                ));
            }
            copy_dir_recursive(&source, &target).map_err(format_io_error)?;
        }
        profile.home_path = path_to_string(&target)?;
        profile.import_source_path = None;
        profile.environment_mode = EnvironmentMode::Sandbox;
        profile.managed = true;
        profile.updated_at = Utc::now().to_rfc3339();
        migrated = true;
    }
    for profile in data.profiles.iter().filter(|profile| profile.managed) {
        ensure_shared_agents_link(Path::new(&profile.home_path))?;
    }
    if migrated {
        let next = serde_json::to_string_pretty(&data)
            .map_err(|error| format!("配置序列化失败：{error}"))?;
        fs::write(path, next).map_err(format_io_error)?;
    }
    Ok(data)
}

fn save_data(app: &AppHandle, data: &StoredData) -> Result<(), String> {
    let path = data_file(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(format_io_error)?;
    }
    let content =
        serde_json::to_string_pretty(data).map_err(|error| format!("配置序列化失败：{error}"))?;
    fs::write(path, content).map_err(format_io_error)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn count_files(path: &Path) -> io::Result<usize> {
    if !path.exists() {
        return Ok(0);
    }

    let mut count = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            count += count_files(&entry_path)?;
        } else {
            count += 1;
        }
    }
    Ok(count)
}

fn codex_process_running() -> bool {
    let output = hidden_command("tasklist.exe")
        .args(["/FI", &format!("IMAGENAME eq {CODEX_PROCESS_NAME}"), "/NH"])
        .output();
    match output {
        Ok(value) => {
            let stdout = String::from_utf8_lossy(&value.stdout);
            let needle = CODEX_PROCESS_NAME.to_lowercase();
            stdout
                .lines()
                .any(|line| line.to_lowercase().contains(&needle))
        }
        Err(_) => false,
    }
}

fn read_user_env(key: &str) -> Result<Option<String>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey("Environment")
        .map_err(|error| format!("无法读取用户环境变量：{error}"))?;
    match env.get_value::<String, _>(key) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 {key}：{error}")),
    }
}

fn delete_user_env(key: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", winreg::enums::KEY_SET_VALUE)
        .map_err(|error| format!("无法打开用户环境变量注册表：{error}"))?;
    match env.delete_value(key) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除 {key}：{error}")),
    }
}

fn broadcast_environment_change() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        let message: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
        let mut result: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            message.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            ENVIRONMENT_BROADCAST_TIMEOUT_MS,
            &mut result as *mut usize,
        );
    }
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "路径包含无效 Unicode。".to_string())
}

fn format_io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod usage_scanner_tests {
    use super::modules::usage_scanner;
    use std::path::PathBuf;

    fn userprofile() -> Option<PathBuf> {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }

    fn real_session_path() -> Option<PathBuf> {
        let up = userprofile()?;
        let p = up.join(r".codex\sessions\2026\07\07\rollout-2026-07-07T16-55-49-019f3bca-6d8b-7053-acab-5d7112efc164.jsonl");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }

    #[test]
    fn parses_real_session_file() {
        let Some(path) = real_session_path() else {
            eprintln!("[skip] real session file not found");
            return;
        };
        let home_str = r"C:\Users\frank\.codex";

        let result = usage_scanner::scan_session_file(
            home_str,
            &path,
            "019f3bca-6d8b-7053-acab-5d7112efc164",
            0,
            &[(0, "test-profile".to_string())],
        )
        .expect("scan should succeed");

        assert!(!result.new_records.is_empty(), "should have records");
        let r = &result.new_records[0];
        assert_eq!(r.session_id, "019f3bca-6d8b-7053-acab-5d7112efc164");
        assert!(r.input_tokens > 0);
        assert!(r.total_tokens > 0);
        assert_eq!(r.plan_type.as_deref(), Some("free"));
        assert!(r.primary_used_percent.is_some());
    }

    #[test]
    fn incremental_scan_skips_already_read() {
        let Some(path) = real_session_path() else {
            return;
        };
        let home_str = r"C:\Users\frank\.codex";

        let r1 = usage_scanner::scan_session_file(
            home_str,
            &path,
            "test",
            0,
            &[(0, "test-profile".to_string())],
        )
        .expect("first scan ok");
        let offset = r1.new_offset;
        assert!(offset > 0);

        let r2 = usage_scanner::scan_session_file(
            home_str,
            &path,
            "test",
            offset,
            &[(0, "test-profile".to_string())],
        )
        .expect("second scan ok");
        assert_eq!(r2.new_records.len(), 0);
        assert_eq!(r2.new_offset, offset);
    }

    #[test]
    fn walks_session_files() {
        let Some(up) = userprofile() else { return };
        let home = up.join(".codex");
        let files = usage_scanner::walk_session_files(&home).expect("walk ok");
        if files.is_empty() {
            eprintln!("[skip] no session files in current default Codex Home");
            return;
        }
        assert!(files
            .iter()
            .all(|path| path.extension().is_some_and(|ext| ext == "jsonl")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_profile(home_path: &Path) -> Profile {
        Profile {
            id: "test-profile".to_string(),
            name: "test".to_string(),
            home_path: home_path.to_string_lossy().to_string(),
            import_source_path: None,
            environment_mode: EnvironmentMode::Sandbox,
            auth_mode: AuthMode::Account,
            api_key: None,
            api_provider: None,
            api_base_url: None,
            api_route_enabled: false,
            api_route_model: None,
            auth_json: None,
            config_toml: None,
            managed: true,
            created_at: String::new(),
            updated_at: String::new(),
            last_used_at: None,
            skin: ProfileSkinSettings::default(),
        }
    }

    #[test]
    fn codex_executable_detection_uses_the_appx_manifest_entrypoint() {
        assert!(DETECT_CODEX_EXECUTABLE_SCRIPT.contains("Get-AppxPackageManifest"));
        assert!(DETECT_CODEX_EXECUTABLE_SCRIPT.contains("$application.Executable"));
        assert!(!DETECT_CODEX_EXECUTABLE_SCRIPT.contains("-Filter Codex.exe -Recurse"));
    }

    #[test]
    fn stopping_an_instance_forcefully_kills_the_entire_process_tree() {
        assert_eq!(
            taskkill_args(42),
            ["/PID", "42", "/T", "/F"].map(str::to_string)
        );
    }

    #[test]
    fn loopback_proxy_bypass_preserves_existing_hosts() {
        assert_eq!(
            loopback_no_proxy_value(None),
            OsString::from("127.0.0.1,localhost,::1")
        );
        assert_eq!(
            loopback_no_proxy_value(Some(OsString::from("example.internal"))),
            OsString::from("example.internal,127.0.0.1,localhost,::1")
        );
        assert_eq!(
            loopback_no_proxy_value(Some(OsString::from(
                "example.internal,localhost,127.0.0.1,::1"
            ))),
            OsString::from("example.internal,localhost,127.0.0.1,::1")
        );
    }

    #[test]
    fn proxied_codex_process_receives_loopback_bypass() {
        let settings = AppSettings {
            proxy_enabled: true,
            proxy_protocol: "http".to_string(),
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: "7890".to_string(),
            ..AppSettings::default()
        };
        let mut command = Command::new("cmd.exe");

        apply_proxy_process_env(&mut command, &settings).unwrap();

        let value = command
            .get_envs()
            .find(|(name, _)| name.to_string_lossy() == NO_PROXY_ENV_KEY)
            .and_then(|(_, value)| value)
            .expect("loopback proxy bypass must be set")
            .to_string_lossy();
        for loopback in LOOPBACK_NO_PROXY.split(',') {
            assert!(value.split(',').any(|entry| entry == loopback));
        }
    }

    #[test]
    fn instance_status_filter_checks_each_snapshot_without_the_registry_lock() {
        let instances = vec![
            CodexInstance {
                profile_id: "one".to_string(),
                profile_name: "one".to_string(),
                pid: 11,
                started_at: String::new(),
                skin_injector_pid: None,
                skin_cdp_port: None,
            },
            CodexInstance {
                profile_id: "two".to_string(),
                profile_name: "two".to_string(),
                pid: 22,
                started_at: String::new(),
                skin_injector_pid: None,
                skin_cdp_port: None,
            },
        ];
        let mut checked = Vec::new();

        let running = filter_running_instances(instances, |pid| {
            checked.push(pid);
            pid == 22
        });

        assert_eq!(checked, vec![11, 22]);
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].pid, 22);
    }

    #[test]
    fn profiles_share_live_agents_content_through_a_link() {
        let root = env::temp_dir().join(format!("codex-agents-link-test-{}", Uuid::new_v4()));
        let source = root.join("shared").join(SHARED_AGENTS_FILENAME);
        let home = root.join("profile-home");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "first").unwrap();

        link_agents_file(&source, &home).unwrap();
        fs::write(&source, "second").unwrap();

        assert_eq!(
            fs::read_to_string(home.join(SHARED_AGENTS_FILENAME)).unwrap(),
            "second"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_data_directory_is_passed_as_a_chromium_switch_value() {
        let path = Path::new(r"C:\Users\tester\App Data\profile-1");

        assert_eq!(
            user_data_dir_arg(path),
            OsString::from(r"--user-data-dir=C:\Users\tester\App Data\profile-1")
        );
    }

    #[test]
    fn rewrites_legacy_shared_paths_to_current_home() {
        let config = "model_instructions_file = 'C:\\Users\\frank\\AppData\\Roaming\\com.frank.codex-switch-helper\\shared\\prompts\\AGENTS.md'\npath = 'C:\\Users\\frank\\AppData\\Roaming\\com.frank.codex-switch-helper\\shared\\skills\\hunt'";
        let shared_root =
            Path::new(r"C:\Users\frank\AppData\Roaming\com.frank.codex-switch-helper\shared");
        let codex_home = Path::new(
            r"C:\Users\frank\AppData\Roaming\com.frank.codex-switch-helper\profiles\p1\home",
        );

        let migrated = rewrite_shared_root_to_home(config, shared_root, codex_home).unwrap();

        assert!(!migrated.contains(r"com.frank.codex-switch-helper\shared"));
        assert!(migrated.contains(r"profiles\p1\home\prompts\AGENTS.md"));
        assert!(migrated.contains(r"profiles\p1\home\skills\hunt"));
    }

    #[test]
    fn rewrites_forward_slash_legacy_shared_paths_to_current_home() {
        let config = "path = 'C:/Users/frank/AppData/Roaming/com.frank.codex-switch-helper/shared/skills/hunt'";
        let shared_root =
            Path::new(r"C:\Users\frank\AppData\Roaming\com.frank.codex-switch-helper\shared");
        let codex_home = Path::new(
            r"C:\Users\frank\AppData\Roaming\com.frank.codex-switch-helper\profiles\p1\home",
        );

        let migrated = rewrite_shared_root_to_home(config, shared_root, codex_home).unwrap();

        assert_eq!(
            migrated,
            "path = 'C:/Users/frank/AppData/Roaming/com.frank.codex-switch-helper/profiles/p1/home/skills/hunt'"
        );
    }

    #[test]
    fn account_profiles_force_file_based_credentials_without_losing_config() {
        let config = "model = \"gpt-5.5\"\ncli_auth_credentials_store = \"keyring\"\n";

        let updated = with_file_auth_credentials_store(config);

        assert!(updated.contains("model = \"gpt-5.5\""));
        assert_eq!(
            updated
                .lines()
                .filter(|line| line.starts_with("cli_auth_credentials_store"))
                .collect::<Vec<_>>(),
            vec![FILE_AUTH_CREDENTIALS_SETTING]
        );
    }

    #[test]
    fn account_profiles_add_file_based_credentials_to_empty_config() {
        assert_eq!(
            with_file_auth_credentials_store(""),
            format!("{FILE_AUTH_CREDENTIALS_SETTING}\n")
        );
    }

    #[test]
    fn account_credentials_setting_stays_at_toml_root() {
        let config = "[mcp_servers.docs]\nurl = \"https://example.com\"\n";

        let updated = with_file_auth_credentials_store(config);

        assert!(updated.starts_with(FILE_AUTH_CREDENTIALS_SETTING));
        assert!(updated.contains("[mcp_servers.docs]"));
    }

    #[test]
    fn existing_profile_config_is_not_replaced_by_saved_snapshot() {
        let home = env::temp_dir().join(format!("codex-profile-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        let config_path = home.join(CODEX_CONFIG_FILENAME);
        let current = "[mcp_servers.browser]\ncommand = \"browser\"\n";
        fs::write(&config_path, current).unwrap();

        let profile = Profile {
            config_toml: Some("model = \"stale-snapshot\"\n".to_string()),
            ..account_profile(&home)
        };

        seed_config_file_if_missing(&config_path, profile.config_toml.as_deref().unwrap()).unwrap();

        assert_eq!(fs::read_to_string(config_path).unwrap(), current);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn settings_accept_only_supported_themes() {
        assert!(validate_theme("light").is_ok());
        assert!(validate_theme("dark").is_ok());
        assert!(validate_theme("system").is_err());
    }

    #[test]
    fn account_profile_can_launch_before_first_login() {
        let home = env::temp_dir().join(format!("codex-profile-test-{}", Uuid::new_v4()));
        let profile = account_profile(&home);

        assert!(apply_profile_auth_files_to_home(&profile, &home, false).is_ok());
        assert!(!home.exists());
    }

    #[test]
    fn new_account_profile_does_not_inherit_source_auth() {
        let home = env::temp_dir().join(format!("codex-profile-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("auth.json"), "source credentials").unwrap();
        let profile = account_profile(&home);

        initialize_new_profile_auth_files(&profile, &home).unwrap();

        assert!(!home.join("auth.json").exists());
        fs::remove_dir(&home).unwrap();
    }
}

// region: usage commands
use crate::models::usage::UsageGranularity;
use crate::modules::usage_db::{self as usage_db_mod, UsageDb};
use crate::modules::usage_scanner as usage_scanner_mod;

fn open_usage_db(app: &AppHandle) -> Result<UsageDb, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let db_path = dir.join("usage.db");
    UsageDb::open(&db_path)
}

fn build_usage_profile_map(data: &StoredData) -> Vec<(String, String, String)> {
    data.profiles
        .iter()
        .map(|p| (p.home_path.clone(), p.id.clone(), p.name.clone()))
        .collect()
}

#[tauri::command]
fn scan_usage(app: AppHandle) -> Result<crate::models::usage::UsageSummary, String> {
    let data = load_data(&app)?;
    let profiles = build_usage_profile_map(&data);
    let mut homes: Vec<String> = profiles.iter().map(|(h, _, _)| h.clone()).collect();
    homes.sort();
    homes.dedup();

    let mut db = open_usage_db(&app)?;
    let mut total_new = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for home in &homes {
        let path = std::path::Path::new(home);
        let session_files = match usage_scanner_mod::walk_session_files(path) {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{}: {}", home, e));
                continue;
            }
        };
        for sf in session_files {
            let hint = sf
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.split("rollout-").nth(1))
                .unwrap_or("unknown")
                .to_string();
            let start_offset = db.get_scan_offset(home, &hint).unwrap_or(0) as u64;
            let profile_launches = db.list_profile_launches(home)?;
            match usage_scanner_mod::scan_session_file(
                home,
                &sf,
                &hint,
                start_offset,
                &profile_launches,
            ) {
                Ok(result) => {
                    let inserted = db.insert_records(&result.new_records)?;
                    total_new += inserted;
                    db.update_scan_offset(home, &hint, result.new_offset as i64)?;
                }
                Err(e) => {
                    errors.push(format!("{}: {}", sf.display(), e));
                }
            }
        }
    }

    let profile_map = usage_db_mod::build_profile_map(&profiles);
    let summary = db.compute_summary(&profile_map)?;
    if !errors.is_empty() {
        eprintln!("[usage] scan warnings: {}", errors.join("; "));
    }
    if total_new > 0 {
        eprintln!("[usage] inserted {} new records", total_new);
    }
    Ok(summary)
}

#[tauri::command]
fn get_usage_summary(app: AppHandle) -> Result<crate::models::usage::UsageSummary, String> {
    let data = load_data(&app)?;
    let profiles = build_usage_profile_map(&data);
    let db = open_usage_db(&app)?;
    let profile_map = usage_db_mod::build_profile_map(&profiles);
    db.compute_summary(&profile_map)
}

#[tauri::command]
fn get_usage_buckets(
    app: AppHandle,
    granularity: UsageGranularity,
    since: Option<i64>,
    until: Option<i64>,
    profile_id: Option<String>,
) -> Result<Vec<crate::models::usage::UsageBucket>, String> {
    let profile_filter = profile_id.as_deref();
    let db = open_usage_db(&app)?;
    db.compute_buckets(granularity, since, until, profile_filter)
}

#[tauri::command]
fn get_usage_sessions(
    app: AppHandle,
    profile_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<crate::models::usage::SessionInfo>, String> {
    let data = load_data(&app)?;
    let profiles = build_usage_profile_map(&data);
    let profile_map = usage_db_mod::build_profile_map(&profiles);
    let profile_filter = profile_id.as_deref();
    let db = open_usage_db(&app)?;
    db.list_sessions(&profile_map, profile_filter, limit.unwrap_or(20))
}

#[tauri::command]
fn clear_usage_data(app: AppHandle, before: i64) -> Result<usize, String> {
    let mut db = open_usage_db(&app)?;
    db.clear_before(before)
}
// endregion: usage commands

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Codex Switch Helper")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            scan_usage,
            get_usage_summary,
            get_usage_buckets,
            get_usage_sessions,
            clear_usage_data,
            create_profile,
            update_profile,
            update_profile_skin,
            delete_profile,
            detect_codex_app_id,
            launch_default_codex,
            clear_codex_home,
            inspect_profile,
            test_profile_connection,
            test_login_connection,
            test_proxy_connection,
            launch_codex,
            list_codex_instances,
            stop_codex_instance,
            reveal_profile_folder,
            save_settings,
            is_codex_process_running,
            get_shared_resources,
            save_shared_agents,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
