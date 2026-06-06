use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use tiny_http::{Header, Method, Response, Server};

static CURRENT_PROJECT: Mutex<String> = Mutex::new(String::new());
static ALL_PROJECTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (name, path)
static PENDING_CLIPS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (projectPath, filePath)
static CLIP_TOKEN: Mutex<String> = Mutex::new(String::new());

/// Daemon status: 0=starting, 1=running, 2=port_conflict, 3=error
static DAEMON_STATUS: AtomicU8 = AtomicU8::new(0);

const PORT: u16 = 19827;
const MAX_BIND_RETRIES: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 10;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const RESTART_DELAY_SECS: u64 = 5;

/// Get current daemon status as a string
pub fn get_daemon_status() -> &'static str {
    match DAEMON_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn get_clip_server_token() -> String {
    match CLIP_TOKEN.lock() {
        Ok(token) => token.clone(),
        Err(_) => String::new(),
    }
}

fn set_clip_server_token(token: String) {
    if let Ok(mut guard) = CLIP_TOKEN.lock() {
        *guard = token;
    }
}

fn safe_header(name: &str, value: &str) -> Header {
    match Header::from_bytes(name, value) {
        Ok(h) => h,
        Err(_) => Header::from_bytes("Content-Type", "application/json").unwrap(),
    }
}

fn verify_token(request: &tiny_http::Request) -> bool {
    let expected = get_clip_server_token();
    if expected.is_empty() {
        return true; // Should not happen after init, but allow to avoid lockout
    }
    for header in request.headers().iter() {
        let field = header.field.as_str().to_string();
        if field.eq_ignore_ascii_case("X-Clip-Token")
            || field.eq_ignore_ascii_case("Authorization") {
            let value = header.value.as_str().to_string();
            if value == expected || value == format!("Bearer {}", expected) {
                return true;
            }
        }
    }
    false
}

pub fn start_clip_server() {
    // Generate a fresh token on every startup
    set_clip_server_token(generate_token());

    thread::spawn(|| {
        let mut restart_count: u32 = 0;

        loop {
            // Try to bind the port with retries
            let server = {
                let mut last_err = String::new();
                let mut bound = None;
                for attempt in 1..=MAX_BIND_RETRIES {
                    match Server::http(format!("127.0.0.1:{}", PORT)) {
                        Ok(s) => {
                            bound = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = format!("{}", e);
                            eprintln!(
                                "[Clip Server] Bind attempt {}/{} failed: {}",
                                attempt, MAX_BIND_RETRIES, e
                            );
                            if attempt < MAX_BIND_RETRIES {
                                thread::sleep(std::time::Duration::from_secs(BIND_RETRY_DELAY_SECS));
                            }
                        }
                    }
                }
                match bound {
                    Some(s) => s,
                    None => {
                        eprintln!(
                            "[Clip Server] Port {} unavailable after {} attempts: {}",
                            PORT, MAX_BIND_RETRIES, last_err
                        );
                        DAEMON_STATUS.store(2, Ordering::Relaxed); // port_conflict
                        return; // Don't retry on port conflict — needs user action
                    }
                }
            };

            DAEMON_STATUS.store(1, Ordering::Relaxed); // running
            restart_count = 0; // Reset on successful bind
            println!("[Clip Server] Listening on http://127.0.0.1:{}", PORT);

        for mut request in server.incoming_requests() {
            let cors_headers = vec![
                safe_header("Access-Control-Allow-Origin", "*"),
                safe_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                safe_header("Access-Control-Allow-Headers", "Content-Type, X-Clip-Token, Authorization"),
                safe_header("Content-Type", "application/json"),
            ];

            // Handle CORS preflight
            if request.method() == &Method::Options {
                let mut response = Response::from_string("").with_status_code(204);
                for h in &cors_headers {
                    response.add_header(h.clone());
                }
                let _ = request.respond(response);
                continue;
            }

            let url = request.url().to_string();

            match (request.method(), url.as_str()) {
                (&Method::Get, "/status") => {
                    let body = r#"{"ok":true,"version":"0.1.0"}"#;
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/project") => {
                    if !verify_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let path = match CURRENT_PROJECT.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let body = format!(r#"{{"ok":true,"path":"{}"}}"#, path);
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/project") => {
                    if !verify_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_set_project(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        400
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/projects") => {
                    if !verify_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let projects = match ALL_PROJECTS.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let current = match CURRENT_PROJECT.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let items: Vec<String> = projects.iter()
                        .map(|(name, path)| format!(r#"{{"name":"{}","path":"{}","current":{}}}"#,
                            name.replace('"', r#"\""#),
                            path.replace('"', r#"\""#),
                            path == &current))
                        .collect();
                    let body = format!(r#"{{"ok":true,"projects":[{}]}}"#, items.join(","));
                    let mut response = Response::from_string(body);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/projects") => {
                    if !verify_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_ok() {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                            if let Some(arr) = parsed["projects"].as_array() {
                                if let Ok(mut projects) = ALL_PROJECTS.lock() {
                                    projects.clear();
                                    for item in arr {
                                        let name = item["name"].as_str().unwrap_or("").to_string();
                                        let path = item["path"].as_str().unwrap_or("").to_string();
                                        if !path.is_empty() {
                                            projects.push((name, path));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let mut response = Response::from_string(r#"{"ok":true}"#);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/clips/pending") => {
                    if !verify_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let mut pending = match PENDING_CLIPS.lock() {
                        Ok(guard) => guard,
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let items: Vec<String> = pending.iter()
                        .map(|(proj, file)| format!(r#"{{"projectPath":"{}","filePath":"{}"}}"#,
                            proj.replace('"', r#"\""#), file.replace('"', r#"\""#)))
                        .collect();
                    let body = format!(r#"{{"ok":true,"clips":[{}]}}"#, items.join(","));
                    pending.clear();
                    let mut response = Response::from_string(body);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/clip") => {
                    if !verify_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_clip(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        500
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                _ => {
                    let body = r#"{"ok":false,"error":"Not found"}"#;
                    let mut response = Response::from_string(body).with_status_code(404);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
            }
        }

            // Server loop exited (shouldn't happen normally)
            DAEMON_STATUS.store(3, Ordering::Relaxed); // error
            restart_count += 1;

            if restart_count >= MAX_RESTART_RETRIES {
                eprintln!(
                    "[Clip Server] Exceeded max restarts ({}). Giving up.",
                    MAX_RESTART_RETRIES
                );
                return;
            }

            eprintln!(
                "[Clip Server] Crashed. Restarting in {}s (attempt {}/{})",
                RESTART_DELAY_SECS, restart_count, MAX_RESTART_RETRIES
            );
            thread::sleep(std::time::Duration::from_secs(RESTART_DELAY_SECS));
        }
    });
}

fn handle_set_project(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let path = match parsed["path"].as_str() {
        Some(p) => p.to_string(),
        None => return r#"{"ok":false,"error":"path field is required"}"#.to_string(),
    };

    match CURRENT_PROJECT.lock() {
        Ok(mut guard) => {
            *guard = path;
            r#"{"ok":true}"#.to_string()
        }
        Err(_) => r#"{"ok":false,"error":"Lock error"}"#.to_string(),
    }
}

fn handle_clip(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let title = parsed["title"].as_str().unwrap_or("Untitled");
    let url = parsed["url"].as_str().unwrap_or("");
    let content = parsed["content"].as_str().unwrap_or("");

    // Use projectPath from request body, or fall back to globally-set project path
    let project_path_from_body = parsed["projectPath"].as_str().unwrap_or("").to_string();
    let project_path = if project_path_from_body.is_empty() {
        match CURRENT_PROJECT.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => return r#"{"ok":false,"error":"Lock error"}"#.to_string(),
        }
    } else {
        project_path_from_body
    };

    if project_path.is_empty() {
        return r#"{"ok":false,"error":"projectPath is required (set via POST /project or include in request body)"}"#
            .to_string();
    }

    if content.is_empty() {
        return r#"{"ok":false,"error":"content is required"}"#.to_string();
    }

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_compact = chrono::Local::now().format("%Y%m%d").to_string();

    // Generate slug from title
    let slug_raw: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    let slug: String = slug_raw.chars().take(50).collect();

    let base_name = format!("{}-{}", slug, date_compact);
    // Use PathBuf for cross-platform path construction
    let dir_path = std::path::Path::new(&project_path).join("raw").join("sources");

    // Ensure directory exists
    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(
            r#"{{"ok":false,"error":"Failed to create directory: {}"}}"#,
            e
        );
    }

    // Find unique filename
    let mut file_path = dir_path.join(format!("{}.md", base_name));
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = dir_path.join(format!("{}-{}.md", base_name, counter));
        counter += 1;
    }
    let file_path = file_path.to_string_lossy().to_string();

    // Build markdown content with web-clip origin
    let markdown = format!(
        "---\ntype: clip\ntitle: \"{}\"\nurl: \"{}\"\nclipped: {}\norigin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# {}\n\nSource: {}\n\n{}\n",
        title.replace('"', r#"\""#),
        url.replace('"', r#"\""#),
        date,
        title,
        url,
        content,
    );

    if let Err(e) = std::fs::write(&file_path, &markdown) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write file: {}"}}"#,
            e
        );
    }

    // Compute relative path using Path for cross-platform separator handling
    let relative_path = {
        let full = std::path::Path::new(&file_path);
        let base = std::path::Path::new(&project_path);
        full.strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.replace('\\', "/"))
    };

    // Add to pending clips for frontend to pick up and auto-ingest
    match PENDING_CLIPS.lock() {
        Ok(mut pending) => {
            pending.push((project_path, file_path.clone()));
        }
        Err(_) => {
            return r#"{"ok":false,"error":"Lock error"}"#.to_string();
        }
    }

    format!(r#"{{"ok":true,"path":"{}"}}"#, relative_path)
}
