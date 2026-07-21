use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MIN_NODE_MAJOR: u32 = 22;

pub fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法分配皮肤调试端口：{error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("无法读取皮肤调试端口：{error}"))
}

pub fn validate_node() -> Result<PathBuf, String> {
    let output = Command::new("node.exe")
        .arg("--version")
        .output()
        .map_err(|_| {
            "Codex 皮肤需要 Node.js 22 或更高版本，请安装后重新启动本程序。".to_string()
        })?;
    if !output.status.success() {
        return Err("无法运行 Node.js，Codex 皮肤未启动。".to_string());
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let major = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or_default();
    if major < MIN_NODE_MAJOR {
        return Err(format!(
            "Codex 皮肤需要 Node.js {MIN_NODE_MAJOR} 或更高版本，当前为 {}。",
            version.trim()
        ));
    }
    Ok(PathBuf::from("node.exe"))
}

pub fn wait_for_browser_id(port: u16, timeout: Duration) -> Result<String, String> {
    let started = Instant::now();
    let mut last_error = "CDP 尚未就绪".to_string();
    while started.elapsed() < timeout {
        match fetch_browser_id(port) {
            Ok(browser_id) => return Ok(browser_id),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!("等待 Codex 皮肤调试端口超时：{last_error}"))
}

fn fetch_browser_id(port: u16) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .map_err(|error| format!("无效 CDP 地址：{error}"))?,
        Duration::from_millis(500),
    )
    .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(750)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            format!(
                "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&buffer[..read]),
            Err(error)
                if !response.is_empty()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                break;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let response = String::from_utf8(response).map_err(|error| error.to_string())?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "CDP 返回了无效 HTTP 响应".to_string())?;
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return Err("CDP /json/version 未返回 200".to_string());
    }
    let value: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    let url = value
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "CDP 响应缺少 Browser WebSocket".to_string())?;
    let prefix = format!("ws://127.0.0.1:{port}/devtools/browser/");
    let browser_id = url
        .strip_prefix(&prefix)
        .ok_or_else(|| "CDP Browser WebSocket 不是预期的本机地址".to_string())?;
    if browser_id.is_empty()
        || browser_id.len() > 200
        || !browser_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("CDP Browser ID 无效".to_string());
    }
    Ok(browser_id.to_string())
}

pub fn start_injector(
    node: &Path,
    runtime_root: &Path,
    theme_dir: &Path,
    log_dir: &Path,
    port: u16,
    browser_id: &str,
) -> Result<Child, String> {
    fs::create_dir_all(log_dir).map_err(|error| error.to_string())?;
    let stdout = fs::File::create(log_dir.join("dream-skin.log"))
        .map_err(|error| format!("无法创建皮肤日志：{error}"))?;
    let stderr = fs::File::create(log_dir.join("dream-skin-error.log"))
        .map_err(|error| format!("无法创建皮肤错误日志：{error}"))?;
    Command::new(node)
        .arg(runtime_root.join("scripts").join("injector.mjs"))
        .args([
            "--watch",
            "--port",
            &port.to_string(),
            "--browser-id",
            browser_id,
        ])
        .arg("--theme-dir")
        .arg(theme_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("无法启动 Codex 皮肤注入器：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_a_non_privileged_loopback_port() {
        let port = reserve_loopback_port().unwrap();
        assert!(port >= 1024);
    }
}
