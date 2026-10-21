#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod mft;
use mft::{Case, Detail, Entry, Summary};
use serde::Serialize;
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct AppState {
    case: RwLock<Option<Arc<Case>>>,
    loading: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    rows: Vec<Entry>,
    total: usize,
}
fn current(state: &AppState) -> Result<Arc<Case>, String> {
    state
        .case
        .read()
        .map_err(|_| "案例锁异常")?
        .clone()
        .ok_or("请先导入 $MFT".into())
}
fn checked_case(state: &AppState, case_id: &str) -> Result<Arc<Case>, String> {
    let case = current(state)?;
    if case.summary.sha256 != case_id {
        return Err("证据已更新，请在分析窗口重新选择记录".into());
    }
    Ok(case)
}
#[tauri::command]
fn get_summary(state: State<'_, AppState>) -> Result<Summary, String> {
    Ok(current(&state)?.summary.clone())
}
#[tauri::command]
async fn open_results(
    filter: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    current(&state)?;
    let filter = match filter.as_str() {
        "active" => "active",
        "deleted" => "deleted",
        "resident" => "resident",
        "differences" => "differences",
        "directories" => "directories",
        _ => "all",
    };
    if let Some(window) = app.get_webview_window("results") {
        window
            .emit("results-filter", filter)
            .map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(
            &app,
            "results",
            WebviewUrl::App(format!("index.html?view=results&filter={filter}").into()),
        )
        .title("AURA / 证据分析")
        .inner_size(1500.0, 960.0)
        .min_inner_size(1100.0, 740.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn import_mft(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Summary, String> {
    if state.loading.swap(true, Ordering::SeqCst) {
        return Err("已有导入任务正在运行".into());
    }
    let path = PathBuf::from(path);
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        Case::load(&path, |done, total| {
            let _ = progress_app.emit("parse-progress", (done, total));
        })
    })
    .await;
    state.loading.store(false, Ordering::SeqCst);
    let case = Arc::new(result.map_err(|e| e.to_string())??);
    let summary = case.summary.clone();
    *state.case.write().map_err(|_| "案例锁异常")? = Some(case);
    let _ = app.emit("case-changed", &summary);
    Ok(summary)
}
#[tauri::command]
async fn query_records(
    search: String,
    filter: String,
    page: usize,
    case_id: String,
    state: State<'_, AppState>,
) -> Result<Page, String> {
    let case = checked_case(&state, &case_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let needle = search.trim().to_lowercase();
        let exact_id = needle.trim_start_matches('#').parse::<u64>().ok();
        let matched: Vec<_> = case
            .entries
            .iter()
            .filter(|e| match filter.as_str() {
                "active" => e.in_use,
                "deleted" => !e.in_use,
                "resident" => e.resident,
                "differences" => e.time_difference,
                "directories" => e.directory,
                _ => true,
            })
            .filter(|e| {
                if let Some(id) = exact_id {
                    e.id == id
                } else {
                    needle.is_empty() || e.path.to_lowercase().contains(&needle)
                }
            })
            .collect();
        Page {
            total: matched.len(),
            rows: matched
                .into_iter()
                .skip(page.saturating_mul(80))
                .take(80)
                .cloned()
                .collect(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_detail(id: u64, case_id: String, state: State<'_, AppState>) -> Result<Detail, String> {
    checked_case(&state, &case_id)?.detail(id)
}
#[derive(Serialize)]
struct Extraction {
    bytes: usize,
    sha256: String,
    path: String,
}
#[tauri::command]
fn extract_resident(
    id: u64,
    attribute_id: u16,
    path: String,
    case_id: String,
    state: State<'_, AppState>,
) -> Result<Extraction, String> {
    let case = checked_case(&state, &case_id)?;
    let data = case.extract(id, attribute_id)?;
    // Never overwrite an evidence file or any existing destination, including hard links.
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("无法创建文件（请选择尚不存在的路径）：{e}"))?;
    out.write_all(&data)
        .and_then(|_| out.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(Extraction {
        bytes: data.len(),
        sha256: mft::hash(&data),
        path,
    })
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            import_mft,
            get_summary,
            open_results,
            query_records,
            get_detail,
            extract_resident
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
