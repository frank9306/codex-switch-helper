#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const DEFAULT_CODEX_APP_ID: &str = "OpenAI.Codex_2p2nqsd0c76g0!App";
const CODEX_HOME_ENV_KEY: &str = "CODEX_HOME";
const OPENAI_API_KEY: &str = "OPENAI_API_KEY";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    name: String,
    home_path: String,
    import_source_path: Option<String>,
    #[serde(default)]
    auth_mode: AuthMode,
    api_key: Option<String>,
    #[serde(default)]
    managed: bool,
    created_at: String,
    updated_at: String,
    last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum AuthMode {
    #[default]
    Account,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    codex_app_id: String,
    env_key: String,
    delete_open_ai_api_key_before_launch: bool,
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

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_app_id: DEFAULT_CODEX_APP_ID.to_string(),
            env_key: CODEX_HOME_ENV_KEY.to_string(),
            delete_open_ai_api_key_before_launch: false,
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
) -> Result<Profile, String> {
    let name = normalized_name(&name)?;
    let source_path = normalized_home_path(&source_path)?;
    if !source_path.is_dir() {
        return Err("导入源目录不存在或不是目录。".to_string());
    }
    validate_auth(&auth_mode, api_key.as_deref())?;

    let mut data = load_data(&app)?;
    let profile = new_profile(&app, &name, &source_path, auth_mode, api_key)?;
    copy_dir_recursive(&source_path, Path::new(&profile.home_path)).map_err(format_io_error)?;
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
) -> Result<Profile, String> {
    let name = normalized_name(&name)?;
    validate_auth(&auth_mode, api_key.as_deref())?;

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
    profile.updated_at = Utc::now().to_rfc3339();
    let updated = profile.clone();
    save_data(&app, &data)?;
    Ok(updated)
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

    let output = Command::new("powershell.exe")
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
fn inspect_profile(app: AppHandle, profile_id: String) -> Result<ProfileInspection, String> {
    let data = load_data(&app)?;
    let profile = find_profile(&data, &profile_id)?;
    let home = Path::new(&profile.home_path);
    Ok(ProfileInspection {
        exists: home.exists(),
        has_auth_json: home.join("auth.json").is_file(),
        has_config_toml: home.join("config.toml").is_file(),
        file_count: count_files(home).map_err(format_io_error)?,
    })
}

#[tauri::command]
fn launch_codex(app: AppHandle, profile_id: String) -> Result<(), String> {
    let mut data = load_data(&app)?;
    let profile_index = data
        .profiles
        .iter()
        .position(|profile| profile.id == profile_id)
        .ok_or_else(|| "Profile 不存在。".to_string())?;

    let home_path = PathBuf::from(&data.profiles[profile_index].home_path);
    fs::create_dir_all(&home_path).map_err(format_io_error)?;
    write_user_env(CODEX_HOME_ENV_KEY, path_to_string(&home_path)?)?;

    match data.profiles[profile_index].auth_mode {
        AuthMode::Account => delete_user_env(OPENAI_API_KEY)?,
        AuthMode::ApiKey => {
            let api_key = data.profiles[profile_index]
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "API Key 登录方式需要填写 OPENAI_API_KEY。".to_string())?;
            write_user_env(OPENAI_API_KEY, api_key.to_string())?;
        }
    }
    broadcast_environment_change();

    launch_codex_app(&data.settings.codex_app_id)?;

    let now = Utc::now().to_rfc3339();
    data.profiles[profile_index].last_used_at = Some(now.clone());
    data.profiles[profile_index].updated_at = now;
    data.active_profile_id = Some(profile_id);
    save_data(&app, &data)
}

#[tauri::command]
fn reveal_profile_folder(app: AppHandle, profile_id: String) -> Result<(), String> {
    let data = load_data(&app)?;
    let profile = find_profile(&data, &profile_id)?;
    fs::create_dir_all(&profile.home_path).map_err(format_io_error)?;
    Command::new("explorer.exe")
        .arg(&profile.home_path)
        .spawn()
        .map_err(format_io_error)?;
    Ok(())
}

fn launch_codex_app(app_id: &str) -> Result<(), String> {
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Err("Codex AppID 不能为空。".to_string());
    }

    Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{app_id}"))
        .spawn()
        .map_err(format_io_error)?;
    Ok(())
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    if settings.codex_app_id.trim().is_empty() {
        return Err("Codex AppID 不能为空。".to_string());
    }

    let mut data = load_data(&app)?;
    data.settings = AppSettings {
        codex_app_id: settings.codex_app_id.trim().to_string(),
        env_key: CODEX_HOME_ENV_KEY.to_string(),
        delete_open_ai_api_key_before_launch: settings.delete_open_ai_api_key_before_launch,
    };
    save_data(&app, &data)
}

fn new_profile(
    app: &AppHandle,
    name: &str,
    source_path: &Path,
    auth_mode: AuthMode,
    api_key: Option<String>,
) -> Result<Profile, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let home_path = managed_profile_home(app, &id)?;
    Ok(Profile {
        id,
        name: name.to_string(),
        home_path: path_to_string(&home_path)?,
        import_source_path: Some(path_to_string(source_path)?),
        auth_mode,
        api_key: api_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        managed: true,
        created_at: now.clone(),
        updated_at: now,
        last_used_at: None,
    })
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

fn normalized_home_path(home_path: &str) -> Result<PathBuf, String> {
    let value = home_path.trim();
    if value.is_empty() {
        return Err("Codex Home 目录不能为空。".to_string());
    }
    Ok(PathBuf::from(value))
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
    Ok(app_data_dir(app)?.join("data.json"))
}

fn load_data(app: &AppHandle) -> Result<StoredData, String> {
    let path = data_file(app)?;
    if !path.exists() {
        return Ok(StoredData::default());
    }
    let content = fs::read_to_string(path).map_err(format_io_error)?;
    serde_json::from_str(&content).map_err(|error| format!("配置文件解析失败：{error}"))
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

fn write_user_env(key: &str, value: String) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env, _) = hkcu
        .create_subkey("Environment")
        .map_err(|error| format!("无法打开用户环境变量注册表：{error}"))?;
    env.set_value(key, &value)
        .map_err(|error| format!("无法写入 {key}：{error}"))
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
            5000,
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            create_profile,
            update_profile,
            delete_profile,
            detect_codex_app_id,
            launch_default_codex,
            clear_codex_home,
            inspect_profile,
            launch_codex,
            reveal_profile_folder,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
