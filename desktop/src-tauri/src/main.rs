use tauri::Manager;

#[tauri::command]
async fn start_stack(app: tauri::AppHandle) -> Result<String, String> {
    // This command is invoked from frontend to ensure stack is up; main.rs also auto-starts on setup
    Ok("Stack start requested".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Auto-start stack in background thread - MySQL + API + Web
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 1. Ensure MySQL via Docker
                let _ = start_mysql().await;
                // 2. Start backend (tsx watch) and frontend (vite) are handled via beforeDevCommand/tauri dev
                //    In production build, server is started via sidecar or docker compose
                // 3. Optionally start tunnel if TUNNEL_TOKEN exists
                let _ = start_tunnel().await;
                let _ = handle;
            });
            Ok(())
        })
        .system_tray(tauri::SystemTray::new().with_menu(tauri::SystemTrayMenu::new()
            .add_item(tauri::CustomMenuItem::new("show".to_string(), "Show WorkTracker"))
            .add_item(tauri::CustomMenuItem::new("restart_api".to_string(), "Restart API"))
            .add_item(tauri::CustomMenuItem::new("open_logs".to_string(), "Open Logs"))
            .add_item(tauri::CustomMenuItem::new("copy_link".to_string(), "Copy Tunnel Link"))
            .add_item(tauri::CustomMenuItem::new("quit".to_string(), "Quit"))
        ))
        .on_system_tray_event(|app, event| match event {
            tauri::SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => std::process::exit(0),
                "show" => { if let Some(w) = app.get_window("main") { let _ = w.show(); let _ = w.set_focus(); } },
                "copy_link" => { /* TODO: read cf.log and copy trycloudflare URL */ },
                _ => {}
            },
            tauri::SystemTrayEvent::LeftClick { .. } => { if let Some(w) = app.get_window("main") { let _ = w.show(); } },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![start_stack])
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}

async fn start_mysql() -> Result<(), String> {
    // Check docker, then compose up db
    let output = std::process::Command::new("docker").arg("info").output();
    if output.is_err() {
        eprintln!("[TAURI] Docker not found, skipping MySQL auto-start");
        return Ok(());
    }
    let _ = std::process::Command::new("docker")
        .args(["compose", "up", "-d", "db"])
        .current_dir("..")
        .output();
    Ok(())
}

async fn start_tunnel() -> Result<(), String> {
    // If TUNNEL_TOKEN in ../.env, docker compose already handles cloudflared.
    // For quick trycloudflare, spawn cloudflared sidecar to 42780
    if std::env::var("TUNNEL_TOKEN").is_ok() { return Ok(()); }
    // Quick tunnel is started manually via launcher.js or docker; keep minimal here
    Ok(())
}
