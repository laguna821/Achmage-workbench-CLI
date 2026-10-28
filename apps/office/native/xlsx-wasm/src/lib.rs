//! IeumOffice's xlsx engine (apps/sheets/native/xlsx-engine, used unchanged) as a WebAssembly module
//! for the spreadsheet editor's worker in Workbench. IeumOffice runs the engine as a separate
//! process speaking JSON lines over stdin/stdout; here the editor's worker calls `wb_handle` with
//! the same request and gets the same response, one request at a time. Files are the worker's
//! own (WASI, served from its memory), so no process and no disk are involved.
//!
//! Adapted from apps/sheets/native/xlsx-engine/src/main.rs @ 30ff4f0 (IeumOffice v0.12.7, Apache-2.0):
//! its request types and dispatch, made one synchronous call per request instead of a stdin/stdout
//! loop with worker threads (recalculation and cancellation run inline).

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use xlsx_sidecar::archive::{
    EntryContent, archive_manifest, read_entries_to_dir, save_archive, scan_entries_for_text,
};
use xlsx_sidecar::find::FindCellsRequest;
use xlsx_sidecar::recalc::{RecalcCache, RecalcEdit, RecalcRead, recalc_cells};
use xlsx_sidecar::{CellRange, SidecarError, WorkbookSessions};

const PROTOCOL_VERSION: u8 = 1;

fn default_locale() -> String {
    "ko".to_owned()
}

// The engine's request vocabulary (apps/sheets/native/xlsx-engine/src/main.rs).
#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    Open {
        path: PathBuf,
        #[serde(default = "default_locale")]
        locale: String,
        #[serde(default, rename = "shortDateFormat")]
        short_date_format: Option<String>,
    },
    ReadRange {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
        range: CellRange,
    },
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    ReadMedia {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "visualId")]
        visual_id: String,
    },
    ReadFormulaCells {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
    },
    FindCells(FindCellsRequest),
    ReadRowOutline {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
    },
    Cancel {
        #[serde(rename = "targetRequestId")]
        #[allow(dead_code)]
        target_request_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ArchiveManifest { path: PathBuf },
    #[serde(rename_all = "camelCase")]
    ReadEntries {
        path: PathBuf,
        entries: Vec<String>,
        output_dir: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ScanEntries {
        path: PathBuf,
        entries: Vec<String>,
        needle: String,
    },
    #[serde(rename_all = "camelCase")]
    ConvertWorkbook { path: PathBuf, target_path: PathBuf },
    #[serde(rename_all = "camelCase")]
    SaveArchive {
        source_path: PathBuf,
        target_path: PathBuf,
        replacements: Vec<EntryContent>,
        removals: Vec<String>,
        additions: Vec<EntryContent>,
    },
    #[serde(rename_all = "camelCase")]
    RecalcCells {
        path: PathBuf,
        edits: Vec<RecalcEdit>,
        reads: Vec<RecalcRead>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    version: u8,
    request_id: String,
    #[serde(flatten)]
    command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl Response {
    fn success(request_id: String, result: Value) -> Self {
        Self { version: PROTOCOL_VERSION, request_id, ok: true, result: Some(result), error: None }
    }

    fn failure(request_id: String, code: &'static str, message: String) -> Self {
        Self { version: PROTOCOL_VERSION, request_id, ok: false, result: None, error: Some(ErrorBody { code, message }) }
    }

    fn from_error(request_id: String, error: SidecarError) -> Self {
        let code = match error {
            SidecarError::InvalidRequest(_) => "invalid_request",
            SidecarError::Io(_) => "io_error",
            SidecarError::Workbook(_) => "workbook_error",
            SidecarError::Cancelled => "cancelled",
        };
        Self::failure(request_id, code, error.to_string())
    }
}

struct Engine {
    sessions: WorkbookSessions,
    recalc: RecalcCache,
    /// Requests run to completion one at a time here; nothing ever cancels one midway.
    never_cancelled: Arc<AtomicBool>,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn to_json_value<T: Serialize>(value: T) -> Result<Value, SidecarError> {
    serde_json::to_value(value).map_err(SidecarError::from)
}

fn handle(engine: &mut Engine, request: Request) -> Response {
    if request.version != PROTOCOL_VERSION {
        return Response::failure(request.request_id, "unsupported_version", "Unsupported sidecar protocol version.".into());
    }
    let request_id = request.request_id;
    let sessions = &mut engine.sessions;
    let result = match request.command {
        Command::Open { path, locale, short_date_format } => sessions
            .open_with_locale(&path, &locale, short_date_format.as_deref(), &engine.never_cancelled)
            .and_then(to_json_value),
        Command::ReadRange { session_id, sheet_id, range } => sessions.read_range(&session_id, &sheet_id, &range).and_then(to_json_value),
        Command::Close { session_id } => {
            if let Some(path) = sessions.session_path(&session_id) {
                engine.recalc.purge(&path);
            }
            sessions.close(&session_id).and_then(|()| to_json_value(serde_json::json!({ "closed": true })))
        }
        Command::ReadMedia { session_id, visual_id } => sessions.read_media(&session_id, &visual_id).and_then(to_json_value),
        Command::ReadFormulaCells { session_id, sheet_id } => sessions.read_formula_cells(&session_id, &sheet_id).and_then(to_json_value),
        Command::FindCells(find) => sessions.find_cells(&find, &engine.never_cancelled).and_then(to_json_value),
        Command::ReadRowOutline { session_id, sheet_id } => sessions.read_row_outline(&session_id, &sheet_id).and_then(to_json_value),
        Command::Cancel { .. } => to_json_value(serde_json::json!({ "cancelled": true })),
        Command::ConvertWorkbook { path, target_path } => xlsx_sidecar::convert::convert_to_xlsx(&path, &target_path)
            .and_then(|result| to_json_value(serde_json::json!({ "sheets": result.sheets, "cells": result.cells }))),
        Command::ArchiveManifest { path } => archive_manifest(&path).and_then(|entries| to_json_value(serde_json::json!({ "entries": entries }))),
        Command::ReadEntries { path, entries, output_dir } => {
            read_entries_to_dir(&path, &entries, &output_dir).and_then(|extracted| to_json_value(serde_json::json!({ "entries": extracted })))
        }
        Command::ScanEntries { path, entries, needle } => {
            scan_entries_for_text(&path, &entries, &needle).and_then(|matches| to_json_value(serde_json::json!({ "matches": matches })))
        }
        Command::SaveArchive { source_path, target_path, replacements, removals, additions } => {
            // The saved bytes supersede any formula model for the target (as the engine's own loop does).
            engine.recalc.purge(&target_path);
            save_archive(&source_path, &target_path, &replacements, &removals, &additions).and_then(to_json_value)
        }
        Command::RecalcCells { path, edits, reads } => recalc_cells(&mut engine.recalc, &path, &edits, &reads).and_then(to_json_value),
    };
    match result {
        Ok(value) => Response::success(request_id, value),
        Err(error) => Response::from_error(request_id, error),
    }
}

/// Memory for a request the worker is about to pass in.
#[unsafe(no_mangle)]
pub extern "C" fn wb_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Give back memory from `wb_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `wb_alloc` call, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wb_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
}

/// Handle one request (JSON, `len` bytes at `ptr`, freed here). Returns the reply's address; its
/// length is `wb_reply_len()`. The reply stays valid until the next call.
///
/// # Safety
/// `ptr` and `len` must come from one `wb_alloc` call holding the request bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wb_handle(ptr: *mut u8, len: usize) -> *const u8 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    let response = match serde_json::from_slice::<Request>(&bytes) {
        Ok(request) => ENGINE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let engine = slot.get_or_insert_with(|| Engine {
                sessions: WorkbookSessions::new(),
                recalc: RecalcCache::new(),
                never_cancelled: Arc::new(AtomicBool::new(false)),
            });
            handle(engine, request)
        }),
        Err(error) => Response::failure(String::new(), "invalid_json", format!("Invalid sidecar request: {error}")),
    };
    REPLY.with(|reply| {
        let mut reply = reply.borrow_mut();
        *reply = serde_json::to_vec(&response).unwrap_or_else(|_| b"{\"version\":1,\"requestId\":\"\",\"ok\":false}".to_vec());
        reply.as_ptr()
    })
}

/// Length of the reply `wb_handle` returned last.
#[unsafe(no_mangle)]
pub extern "C" fn wb_reply_len() -> usize {
    REPLY.with(|reply| reply.borrow().len())
}
