#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod mft;
mod usn;
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
    journal: RwLock<Option<Arc<usn::Session>>>,
    loading: AtomicBool,
}
struct LoadingReset<'a>(&'a AtomicBool);
impl Drop for LoadingReset<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn journal_session(
    state: &AppState,
    session_id: Option<&str>,
) -> Result<Arc<usn::Session>, String> {
    let session = state
        .journal
        .read()
        .map_err(|_| "日志锁异常")?
        .clone()
        .ok_or("请先导入 $J 日志")?;
    if let Some(id) = session_id {
        if session.summary().session_id != id {
            return Err("日志或 MFT 关联已更新，请重新选择记录".into());
        }
    }
    Ok(session)
}
#[tauri::command]
fn get_journal_summary(state: State<'_, AppState>) -> Result<usn::Summary, String> {
    Ok(journal_session(&state, None)?.summary())
}
#[tauri::command]
async fn import_journal(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usn::Summary, String> {
    if state.loading.swap(true, Ordering::SeqCst) {
        return Err("已有导入任务正在运行".into());
    }
    let _reset = LoadingReset(&state.loading);
    let progress_app = app.clone();
    let journal = tauri::async_runtime::spawn_blocking(move || {
        usn::Journal::load(std::path::Path::new(&path), |done, total| {
            let _ = progress_app.emit("parse-progress", (done, total));
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let session = Arc::new(usn::Session {
        journal: Arc::new(journal),
        mft: None,
    });
    let summary = session.summary();
    *state.journal.write().map_err(|_| "日志锁异常")? = Some(session);
    let _ = app.emit("journal-changed", &summary);
    Ok(summary)
}
#[tauri::command]
async fn open_journal_results(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    journal_session(&state, None)?;
    if let Some(window) = app.get_webview_window("journal") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(
            &app,
            "journal",
            WebviewUrl::App("index.html?view=usn".into()),
        )
        .title("AURA / USN Journal 分析")
        .inner_size(1500.0, 960.0)
        .min_inner_size(1100.0, 740.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn query_journal(
    search: String,
    filter: String,
    page: usize,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<usn::Page, String> {
    let session = journal_session(&state, Some(&session_id))?;
    tauri::async_runtime::spawn_blocking(move || session.query(&search, &filter, page))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_journal_detail(
    id: usize,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<usn::Detail, String> {
    journal_session(&state, Some(&session_id))?.detail(id)
}
#[tauri::command]
fn set_journal_mft(
    session_id: String,
    mft_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usn::Summary, String> {
    let mut lock = state.journal.write().map_err(|_| "日志锁异常")?;
    let old = lock.as_ref().ok_or("请先导入 $J 日志")?;
    if old.summary().session_id != session_id {
        return Err("日志关联已更新，请重试".into());
    }
    let mft = if let Some(id) = mft_id {
        Some(checked_case(&state, &id)?)
    } else {
        None
    };
    let session = Arc::new(usn::Session {
        journal: old.journal.clone(),
        mft,
    });
    let summary = session.summary();
    *lock = Some(session);
    drop(lock);
    let _ = app.emit("journal-changed", &summary);
    Ok(summary)
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
    let _reset = LoadingReset(&state.loading);
    let path = PathBuf::from(path);
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        Case::load(&path, |done, total| {
            let _ = progress_app.emit("parse-progress", (done, total));
        })
    })
    .await;
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
            import_journal,
            get_journal_summary,
            open_journal_results,
            query_journal,
            get_journal_detail,
            set_journal_mft,
            get_summary,
            open_results,
            query_records,
            get_detail,
            extract_resident
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
