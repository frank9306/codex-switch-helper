use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 单次调用的 token 记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub recorded_at: i64,
    pub session_id: String,
    pub home_path: String,
    pub profile_id: Option<String>,
    pub cwd: Option<String>,
    pub turn_id: String,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    pub model_context_window: Option<i64>,
    pub plan_type: Option<String>,
    pub primary_used_percent: Option<f64>,
    pub primary_resets_at: Option<i64>,
}

/// 时间桶聚合（按 day/week/month）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub bucket_start: i64,
    pub bucket_label: String,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    pub call_count: i64,
    pub session_count: i64,
    pub by_plan: BTreeMap<String, TokenSum>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenSum {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub call_count: i64,
}

/// 按 home_path 聚合（关联到 Profile）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsage {
    pub home_path: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub call_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    pub last_used_at: Option<i64>,
    pub current_plan_type: Option<String>,
    pub current_used_percent: Option<f64>,
    pub current_resets_at: Option<i64>,
}

/// 整体摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_calls: i64,
    pub total_tokens: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_reasoning_tokens: i64,
    pub first_recorded_at: Option<i64>,
    pub last_recorded_at: Option<i64>,
    pub active_sessions: i64,
    pub by_profile: Vec<ProfileUsage>,
}

/// 时间粒度
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UsageGranularity {
    Day,
    Week,
    Month,
}

impl UsageGranularity {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }
}

/// 单个 session 摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub home_path: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub cwd: Option<String>,
    pub first_recorded_at: i64,
    pub last_recorded_at: i64,
    pub call_count: i64,
    pub total_tokens: i64,
}
