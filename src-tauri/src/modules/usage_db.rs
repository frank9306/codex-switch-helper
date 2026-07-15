use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::usage::{
    ProfileUsage, SessionInfo, UsageBucket, UsageGranularity, UsageRecord, UsageSummary,
};

const SCHEMA_VERSION: i32 = 2;

pub struct UsageDb {
    conn: Connection,
}

/// profile_id -> (home_path, profile_name) 的反查表
pub type ProfileMap = BTreeMap<String, (String, String)>;

impl UsageDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS schema_version (
                    version INTEGER PRIMARY KEY
                );

                CREATE TABLE IF NOT EXISTS usage_record (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recorded_at INTEGER NOT NULL,
                    session_id TEXT NOT NULL,
                    home_path TEXT NOT NULL,
                    profile_id TEXT,
                    cwd TEXT,
                    turn_id TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    cached_input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    reasoning_output_tokens INTEGER NOT NULL,
                    total_tokens INTEGER NOT NULL,
                    model_context_window INTEGER,
                    plan_type TEXT,
                    primary_used_percent REAL,
                    primary_resets_at INTEGER,
                    UNIQUE(session_id, turn_id, recorded_at)
                );
                CREATE INDEX IF NOT EXISTS idx_recorded_at ON usage_record(recorded_at);
                CREATE INDEX IF NOT EXISTS idx_home_path ON usage_record(home_path);
                CREATE INDEX IF NOT EXISTS idx_session_id ON usage_record(session_id);

                CREATE TABLE IF NOT EXISTS scan_state (
                    home_path TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    last_offset INTEGER NOT NULL,
                    PRIMARY KEY (home_path, session_id)
                );

                CREATE TABLE IF NOT EXISTS profile_launch (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id TEXT NOT NULL,
                    home_path TEXT NOT NULL,
                    launched_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_profile_launch_home_time
                    ON profile_launch(home_path, launched_at);
                "#,
            )
            .map_err(|e| e.to_string())?;
        if !self.column_exists("usage_record", "profile_id")? {
            self.conn
                .execute("ALTER TABLE usage_record ADD COLUMN profile_id TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        self.conn
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_profile_id ON usage_record(profile_id)",
                [],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO schema_version (version) VALUES (?1)",
                params![SCHEMA_VERSION],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn column_exists(&self, table: &str, column: &str) -> Result<bool, String> {
        let mut stmt = self
            .conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        for name in names {
            if name.map_err(|e| e.to_string())? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn insert_records(&mut self, records: &[UsageRecord]) -> Result<usize, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut inserted = 0;
        for r in records {
            let n = tx
                .execute(
                    r#"INSERT OR IGNORE INTO usage_record
                       (recorded_at, session_id, home_path, profile_id, cwd, turn_id,
                        input_tokens, cached_input_tokens, output_tokens,
                        reasoning_output_tokens, total_tokens, model_context_window,
                        plan_type, primary_used_percent, primary_resets_at)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
                    params![
                        r.recorded_at,
                        r.session_id,
                        r.home_path,
                        r.profile_id,
                        r.cwd,
                        r.turn_id,
                        r.input_tokens,
                        r.cached_input_tokens,
                        r.output_tokens,
                        r.reasoning_output_tokens,
                        r.total_tokens,
                        r.model_context_window,
                        r.plan_type,
                        r.primary_used_percent,
                        r.primary_resets_at,
                    ],
                )
                .map_err(|e| e.to_string())?;
            inserted += n;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(inserted)
    }

    pub fn record_profile_launch(
        &self,
        profile_id: &str,
        home_path: &str,
        launched_at: i64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO profile_launch (profile_id, home_path, launched_at) VALUES (?1, ?2, ?3)",
                params![profile_id, home_path, launched_at],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_profile_launches(&self, home_path: &str) -> Result<Vec<(i64, String)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT launched_at, profile_id
                   FROM profile_launch
                   WHERE home_path = ?1
                   ORDER BY launched_at ASC"#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![home_path], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn get_scan_offset(&self, home_path: &str, session_id: &str) -> Result<i64, String> {
        let offset: Option<i64> = self
            .conn
            .query_row(
                "SELECT last_offset FROM scan_state WHERE home_path = ?1 AND session_id = ?2",
                params![home_path, session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(offset.unwrap_or(0))
    }

    pub fn update_scan_offset(
        &mut self,
        home_path: &str,
        session_id: &str,
        offset: i64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                r#"INSERT INTO scan_state (home_path, session_id, last_offset)
                   VALUES (?1, ?2, ?3)
                   ON CONFLICT(home_path, session_id) DO UPDATE SET last_offset = excluded.last_offset"#,
                params![home_path, session_id, offset],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_before(&mut self, before_ts: i64) -> Result<usize, String> {
        let n = self
            .conn
            .execute(
                "DELETE FROM usage_record WHERE recorded_at < ?1",
                params![before_ts],
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    /// 整体摘要 + 按 profile_id 拆分，只统计本工具启动后能归属到 Profile 的记录。
    pub fn compute_summary(&self, profile_map: &ProfileMap) -> Result<UsageSummary, String> {
        // 总计（每行 = 一次 token_count 事件 = 一次调用）
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT
                     COUNT(*),
                     COALESCE(SUM(input_tokens), 0),
                     COALESCE(SUM(output_tokens), 0),
                     COALESCE(SUM(reasoning_output_tokens), 0),
                     COALESCE(SUM(total_tokens), 0),
                     MIN(recorded_at),
                     MAX(recorded_at),
                     COUNT(DISTINCT session_id)
                   FROM usage_record
                   WHERE profile_id IS NOT NULL"#,
            )
            .map_err(|e| e.to_string())?;

        let row = stmt
            .query_row([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let summary = UsageSummary {
            total_calls: row.0,
            total_input_tokens: row.1,
            total_output_tokens: row.2,
            total_reasoning_tokens: row.3,
            total_tokens: row.4,
            first_recorded_at: row.5,
            last_recorded_at: row.6,
            active_sessions: row.7,
            by_profile: Vec::new(),
        };

        // 按 profile_id 聚合
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT
                     profile_id,
                     home_path,
                     COUNT(DISTINCT session_id),
                     COALESCE(SUM(input_tokens), 0),
                     COALESCE(SUM(output_tokens), 0),
                     COALESCE(SUM(reasoning_output_tokens), 0),
                     COALESCE(SUM(total_tokens), 0),
                     COALESCE(SUM(cached_input_tokens), 0),
                     MAX(recorded_at)
                   FROM usage_record
                   WHERE profile_id IS NOT NULL
                   GROUP BY profile_id, home_path
                   ORDER BY MAX(recorded_at) DESC"#,
            )
            .map_err(|e| e.to_string())?;

        let mut by_profile: Vec<ProfileUsage> = Vec::new();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            let (
                profile_id,
                home,
                session_count,
                in_tok,
                out_tok,
                reas_tok,
                tot_tok,
                _cached,
                last_at,
            ) = row.map_err(|e| e.to_string())?;
            let profile_name = profile_map.get(&profile_id).map(|(_, name)| name.clone());
            let (plan_type, used_percent, resets_at) = self.get_current_quota(&profile_id)?;

            by_profile.push(ProfileUsage {
                home_path: home,
                profile_id: Some(profile_id),
                profile_name,
                call_count: session_count,
                input_tokens: in_tok,
                output_tokens: out_tok,
                reasoning_output_tokens: reas_tok,
                total_tokens: tot_tok,
                last_used_at: last_at,
                current_plan_type: plan_type,
                current_used_percent: used_percent,
                current_resets_at: resets_at,
            });
        }

        Ok(UsageSummary {
            by_profile,
            ..summary
        })
    }

    fn get_current_quota(
        &self,
        profile_id: &str,
    ) -> Result<(Option<String>, Option<f64>, Option<i64>), String> {
        let row = self
            .conn
            .query_row(
                r#"SELECT plan_type, primary_used_percent, primary_resets_at
                   FROM usage_record
                   WHERE profile_id = ?1 AND plan_type IS NOT NULL
                   ORDER BY recorded_at DESC LIMIT 1"#,
                params![profile_id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.unwrap_or((None, None, None)))
    }

    /// 时序桶聚合
    #[allow(unused_assignments)]
    pub fn compute_buckets(
        &self,
        granularity: UsageGranularity,
        since: Option<i64>,
        until: Option<i64>,
        profile_filter: Option<&str>,
    ) -> Result<Vec<UsageBucket>, String> {
        let since_ts = since.unwrap_or(0);
        let until_ts = until.unwrap_or(i64::MAX);

        // SQLite strftime 把 Unix 秒转成 bucket label
        // 注意：strftime('%s', ...) 依赖本地时区；这里假设是 UTC，与 chrono 解析一致
        let bucket_expr = match granularity {
            UsageGranularity::Day => "strftime('%Y-%m-%d', recorded_at, 'unixepoch')",
            UsageGranularity::Week => "strftime('%Y-W%W', recorded_at, 'unixepoch')",
            UsageGranularity::Month => "strftime('%Y-%m', recorded_at, 'unixepoch')",
        };

        let mut sql = format!(
            r#"SELECT
                 {bucket} as bucket_label,
                 COALESCE(SUM(input_tokens), 0),
                 COALESCE(SUM(cached_input_tokens), 0),
                 COALESCE(SUM(output_tokens), 0),
                 COALESCE(SUM(reasoning_output_tokens), 0),
                 COALESCE(SUM(total_tokens), 0),
                 COUNT(*),
                 COUNT(DISTINCT session_id)
               FROM usage_record
               WHERE recorded_at >= ?1 AND recorded_at < ?2
                 AND profile_id IS NOT NULL"#,
            bucket = bucket_expr
        );

        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(since_ts), Box::new(until_ts)];
        if let Some(profile_id) = profile_filter {
            sql += " AND profile_id = ?3";
            param_values.push(Box::new(profile_id.to_string()));
        }

        sql += &format!(" GROUP BY bucket_label ORDER BY bucket_label ASC");

        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = param_values
            .iter()
            .map(|b| b.as_ref() as &dyn rusqlite::ToSql)
            .collect();

        let rows = stmt
            .query_map(param_refs.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            let (label, in_tok, cached, out_tok, reas_tok, tot_tok, call_count, sess_count) =
                row.map_err(|e| e.to_string())?;
            // bucket_start 用 label 解析（避免重新算）
            let bucket_start = parse_bucket_start(&label, granularity);
            out.push(UsageBucket {
                bucket_start,
                bucket_label: label,
                input_tokens: in_tok,
                cached_input_tokens: cached,
                output_tokens: out_tok,
                reasoning_output_tokens: reas_tok,
                total_tokens: tot_tok,
                call_count,
                session_count: sess_count,
                by_plan: BTreeMap::new(), // 简化：第一版不按 plan 拆 bucket
            });
        }
        Ok(out)
    }

    /// 最近 session 列表
    pub fn list_sessions(
        &self,
        profile_map: &ProfileMap,
        profile_filter: Option<&str>,
        limit: i64,
    ) -> Result<Vec<SessionInfo>, String> {
        let mut sql = String::from(
            r#"SELECT
                 session_id,
                 home_path,
                 profile_id,
                 cwd,
                 MIN(recorded_at),
                 MAX(recorded_at),
                 COUNT(*),
                 COALESCE(SUM(total_tokens), 0)
               FROM usage_record
               WHERE profile_id IS NOT NULL"#,
        );

        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(profile_id) = profile_filter {
            sql += " AND profile_id = ?1";
            param_values.push(Box::new(profile_id.to_string()));
        }

        sql += " GROUP BY session_id, home_path, profile_id ORDER BY MAX(recorded_at) DESC LIMIT ?";
        let limit_idx = param_values.len() + 1;
        param_values.push(Box::new(limit));
        let _ = limit_idx; // 避免 unused 警告

        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = param_values
            .iter()
            .map(|b| b.as_ref() as &dyn rusqlite::ToSql)
            .collect();

        let rows = stmt
            .query_map(param_refs.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            let (sid, home, profile_id, cwd, first_at, last_at, call_count, total_tok) =
                row.map_err(|e| e.to_string())?;
            let profile_name = profile_map.get(&profile_id).map(|(_, name)| name.clone());
            out.push(SessionInfo {
                session_id: sid,
                home_path: home,
                profile_id: Some(profile_id),
                profile_name,
                cwd,
                first_recorded_at: first_at,
                last_recorded_at: last_at,
                call_count,
                total_tokens: total_tok,
            });
        }
        Ok(out)
    }
}

fn parse_bucket_start(label: &str, granularity: UsageGranularity) -> i64 {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
    let parse = |s: &str, fmt: &str| -> Option<i64> {
        NaiveDateTime::parse_from_str(s, fmt)
            .ok()
            .and_then(|dt| Utc.from_local_datetime(&dt).single())
            .map(|dt: DateTime<Utc>| dt.timestamp())
    };
    match granularity {
        UsageGranularity::Day => parse(&format!("{} 00:00:00", label), "%Y-%m-%d %H:%M:%S")
            .unwrap_or_else(|| {
                // 退化：按日期解析（不带时间）
                NaiveDate::parse_from_str(label, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .and_then(|dt| Utc.from_local_datetime(&dt).single())
                    .map(|dt| dt.timestamp())
                    .unwrap_or(0)
            }),
        UsageGranularity::Week => {
            // %Y-W%WW 形如 "2026-W27"
            // 简化：取 label 字符串里的年份和周数，手动算周一
            let parts: Vec<&str> = label.split("-W").collect();
            if parts.len() == 2 {
                if let (Ok(y), Ok(w)) = (parts[0].parse::<i32>(), parts[1].parse::<u32>()) {
                    if let Some(date) = NaiveDate::from_isoywd_opt(y, w, chrono::Weekday::Mon) {
                        if let Some(dt) = date.and_hms_opt(0, 0, 0) {
                            if let Some(utc) = Utc.from_local_datetime(&dt).single() {
                                return utc.timestamp();
                            }
                        }
                    }
                }
            }
            0
        }
        UsageGranularity::Month => {
            parse(&format!("{}-01 00:00:00", label), "%Y-%m-%d %H:%M:%S").unwrap_or(0)
        }
    }
}

/// 构造 profile_id -> (home_path, profile_name) 反查表
pub fn build_profile_map(
    profiles: &[(String, String, String)], // (home_path, id, name)
) -> ProfileMap {
    let mut map = BTreeMap::new();
    for (home, id, name) in profiles {
        map.insert(id.clone(), (home.clone(), name.clone()));
    }
    map
}

#[cfg(test)]
mod tests {
    use super::UsageDb;
    use rusqlite::Connection;

    #[test]
    fn upgrades_legacy_usage_table_before_creating_profile_index() {
        let path = std::env::temp_dir().join(format!("usage-legacy-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).expect("create legacy database");
        conn.execute_batch(
            r#"
            CREATE TABLE usage_record (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                home_path TEXT NOT NULL,
                cwd TEXT,
                turn_id TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                cached_input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                reasoning_output_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                model_context_window INTEGER,
                plan_type TEXT,
                primary_used_percent REAL,
                primary_resets_at INTEGER,
                UNIQUE(session_id, turn_id, recorded_at)
            );
            "#,
        )
        .expect("create legacy schema");
        drop(conn);

        let db = UsageDb::open(&path).expect("upgrade legacy database");
        assert!(db
            .column_exists("usage_record", "profile_id")
            .expect("read migrated columns"));
        let index_exists: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_profile_id'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated index");
        assert_eq!(index_exists, 1);
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
