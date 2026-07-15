use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::models::usage::UsageRecord;

#[derive(Debug)]
#[allow(dead_code)]
pub struct SessionScanResult {
    pub home_path: String,
    pub session_id: String,
    pub new_records: Vec<UsageRecord>,
    pub new_offset: u64,
}

/// 增量扫描一个 session JSONL 文件
pub fn scan_session_file(
    home_path: &str,
    session_path: &Path,
    session_id_hint: &str,
    start_offset: u64,
    profile_launches: &[(i64, String)],
) -> Result<SessionScanResult, String> {
    let file = File::open(session_path).map_err(|e| e.to_string())?;
    let total_size = file.metadata().map_err(|e| e.to_string())?.len();
    if start_offset >= total_size {
        return Ok(SessionScanResult {
            home_path: home_path.to_string(),
            session_id: session_id_hint.to_string(),
            new_records: vec![],
            new_offset: start_offset,
        });
    }

    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(start_offset))
        .map_err(|e| e.to_string())?;

    let mut records: Vec<UsageRecord> = Vec::new();
    let mut current_session: Option<String> = Some(session_id_hint.to_string());
    let mut current_cwd: Option<String> = None;
    let mut current_turn: Option<String> = None;
    let mut line = String::new();
    let mut bytes_read = start_offset;

    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes_read += n as u64;

        let Ok(event) = serde_json::from_str::<SessionEvent>(&line) else {
            continue;
        };

        match event.event_type.as_str() {
            "session_meta" => {
                if let Some(payload) = &event.payload {
                    if let Some(sid) = payload.get("session_id").and_then(|v| v.as_str()) {
                        current_session = Some(sid.to_string());
                    }
                }
            }
            "turn_context" => {
                if let Some(payload) = &event.payload {
                    if let Some(cwd) = payload.get("cwd").and_then(|v| v.as_str()) {
                        current_cwd = Some(cwd.to_string());
                    }
                    if let Some(tid) = payload.get("turn_id").and_then(|v| v.as_str()) {
                        current_turn = Some(tid.to_string());
                    }
                }
            }
            "event_msg" => {
                if let Some(payload) = &event.payload {
                    if payload.get("type").and_then(|v| v.as_str()) == Some("token_count") {
                        if let Some(record) = parse_token_count(
                            &event,
                            payload,
                            home_path,
                            current_session.as_deref(),
                            current_cwd.as_deref(),
                            current_turn.as_deref(),
                            profile_launches,
                        ) {
                            records.push(record);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let final_session = current_session.unwrap_or_else(|| session_id_hint.to_string());

    Ok(SessionScanResult {
        home_path: home_path.to_string(),
        session_id: final_session,
        new_records: records,
        new_offset: bytes_read,
    })
}

#[derive(serde::Deserialize)]
struct SessionEvent {
    timestamp: String,
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    payload: Option<serde_json::Value>,
}

fn parse_token_count(
    event: &SessionEvent,
    payload: &serde_json::Value,
    home_path: &str,
    session_id: Option<&str>,
    cwd: Option<&str>,
    turn_id: Option<&str>,
    profile_launches: &[(i64, String)],
) -> Option<UsageRecord> {
    let info = payload.get("info")?;
    let last = info.get("last_token_usage")?;
    let total = info.get("total_token_usage");

    let rate_limits = payload.get("rate_limits");
    let plan_type = rate_limits
        .and_then(|r| r.get("plan_type"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && *s != "null")
        .map(String::from);
    let primary = rate_limits.and_then(|r| r.get("primary"));
    let primary_used_percent = primary
        .and_then(|p| p.get("used_percent"))
        .and_then(|v| v.as_f64());
    let primary_resets_at = primary
        .and_then(|p| p.get("resets_at"))
        .and_then(|v| v.as_i64());

    let recorded_at = chrono::DateTime::parse_from_rfc3339(&event.timestamp)
        .ok()?
        .timestamp();

    let input_tokens = last.get("input_tokens")?.as_i64()?;
    let output_tokens = last.get("output_tokens")?.as_i64()?;

    let cached = last
        .get("cached_input_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let reasoning = last
        .get("reasoning_output_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let total_tokens = last
        .get("total_tokens")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            total
                .and_then(|t| t.get("total_tokens"))
                .and_then(|v| v.as_i64())
        })
        .unwrap_or(input_tokens + output_tokens);

    Some(UsageRecord {
        recorded_at,
        session_id: session_id?.to_string(),
        home_path: home_path.to_string(),
        profile_id: profile_id_at(profile_launches, recorded_at),
        cwd: cwd.map(String::from),
        turn_id: turn_id?.to_string(),
        input_tokens,
        cached_input_tokens: cached,
        output_tokens,
        reasoning_output_tokens: reasoning,
        total_tokens,
        model_context_window: info.get("model_context_window").and_then(|v| v.as_i64()),
        plan_type,
        primary_used_percent,
        primary_resets_at,
    })
}

fn profile_id_at(profile_launches: &[(i64, String)], recorded_at: i64) -> Option<String> {
    profile_launches
        .iter()
        .take_while(|(launched_at, _)| *launched_at <= recorded_at)
        .last()
        .map(|(_, profile_id)| profile_id.clone())
}

/// 遍历 home 下的所有 session JSONL 文件
pub fn walk_session_files(home: &Path) -> Result<Vec<PathBuf>, String> {
    let sessions_dir = home.join("sessions");
    if !sessions_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    visit_jsonl(&sessions_dir, &mut out)?;
    out.sort();
    Ok(out)
}

fn visit_jsonl(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            visit_jsonl(&path, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    Ok(())
}
