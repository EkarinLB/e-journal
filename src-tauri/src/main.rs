// Hide the console window on Windows release builds (keep it for debug).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// E-Journal native backend (Tauri v2).
// Library format mirrors lib/model.js so Electron and Tauri share files:
//   { "version": 1, "notebooks": [ {id,name,color,icon,ruled,updatedAt,
//     pages: [{id,order,width,height,strokes,images,background}]} ] }

use serde_json::Value;
use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
const LIBRARY_FILE: &str = "e-journal-library.json";

/// Canonical, product-named data folder: %APPDATA%\E-Journal
/// (independent of the bundle identifier, so branding and packaging changes
/// never orphan a library).
fn canonical_dir() -> Result<std::path::PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .ok_or("APPDATA not set")?;
    let dir = base.join("E-Journal");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Library filename used before the E-Journal rename. Migration must keep
/// looking for this exact name in the pre-rename locations, otherwise a
/// rebranding pass can silently rewrite history away.
const LEGACY_LIBRARY_FILE: &str = "openjournal-library.json";

/// Pre-rename locations, newest convention last:
///   - %APPDATA%\<old-identifier>\openjournal-library.json  (identifier-keyed)
///   - %APPDATA%\OpenJournal\openjournal-library.json      (pre-rename canonical)
///   - %APPDATA%\openjournal\openjournal-library.json      (Electron shell;
///     identical to the line above on case-insensitive filesystems)
fn legacy_candidates(
    base: &std::path::Path,
    app_data: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = app_data {
        out.push(d.join(LEGACY_LIBRARY_FILE));
        out.push(d.join(LIBRARY_FILE));
    }
    out.push(base.join("OpenJournal").join(LEGACY_LIBRARY_FILE));
    out.push(base.join("openjournal").join(LEGACY_LIBRARY_FILE));
    out.push(base.join("openjournal").join(LIBRARY_FILE));
    out
}

fn legacy_paths(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let app_data = app.path().app_data_dir().ok();
    legacy_candidates(&base, app_data.as_deref())
}

fn library_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(canonical_dir()?.join(LIBRARY_FILE))
}

fn notebook_count(path: &std::path::Path) -> usize {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return 0,
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("notebooks").and_then(|n| n.as_array()).map(|a| a.len()))
        .unwrap_or(0)
}

/// Adopt the first legacy library that actually contains notebooks, so
/// upgrading never silently presents an empty app.
fn migrate_legacy(app: &AppHandle, canonical: &std::path::Path) -> Result<Option<String>, String> {
    if notebook_count(canonical) > 0 {
        return Ok(None);
    }
    for legacy in legacy_paths(app) {
        if legacy == canonical || !legacy.exists() {
            continue;
        }
        let count = notebook_count(&legacy);
        if count == 0 {
            continue;
        }
        let text = fs::read_to_string(&legacy).map_err(|e| e.to_string())?;
        fs::write(canonical, &text).map_err(|e| e.to_string())?;
        return Ok(Some(format!(
            "Migrated {count} notebooks from {}",
            legacy.display()
        )));
    }
    Ok(None)
}

fn is_finite_number(v: &Value) -> bool {
    v.as_f64().map(|f| f.is_finite()).unwrap_or(false)
}

fn validate_library(lib: &Value) -> Result<(), String> {
    let notebooks = lib
        .get("notebooks")
        .and_then(|n| n.as_array())
        .ok_or("notebooks must be array")?;
    for nb in notebooks {
        if nb.get("id").and_then(|v| v.as_str()).is_none()
            || nb.get("name").and_then(|v| v.as_str()).is_none()
        {
            return Err("bad notebook id/name".into());
        }
        let pages = nb
            .get("pages")
            .and_then(|p| p.as_array())
            .ok_or("notebook pages must be array")?;
        for pg in pages {
            if pg.get("id").and_then(|v| v.as_str()).is_none()
                || pg.get("strokes").and_then(|s| s.as_array()).is_none()
            {
                return Err("bad page".into());
            }
            for st in pg["strokes"].as_array().unwrap() {
                if st.get("points").and_then(|p| p.as_array()).is_none()
                    || st.get("color").and_then(|c| c.as_str()).is_none()
                {
                    return Err("bad stroke".into());
                }
            }
            if let Some(bg) = pg.get("background") {
                if !bg.is_string() {
                    return Err("bad page background".into());
                }
            }
            if let Some(images) = pg.get("images") {
                let arr = images.as_array().ok_or("bad page images")?;
                for im in arr {
                    let nums = ["x", "y", "w", "h"]
                        .iter()
                        .all(|k| im.get(k).map(is_finite_number).unwrap_or(false));
                    if im.get("id").and_then(|v| v.as_str()).is_none()
                        || im.get("dataUrl").and_then(|v| v.as_str()).is_none()
                        || !nums
                    {
                        return Err("bad image".into());
                    }
                }
            }
        }
    }
    Ok(())
}

/// Keep only the notebooks array (drops unknown root fields) and validate.
fn normalize(library: Value) -> Result<Value, String> {
    let lib = serde_json::json!({
        "notebooks": library.get("notebooks").cloned().unwrap_or(Value::Array(vec![]))
    });
    validate_library(&lib)?;
    Ok(lib)
}

#[tauri::command]
fn library_load(app: AppHandle) -> Result<Value, String> {
    let path = library_path(&app)?;
    if let Some(msg) = migrate_legacy(&app, &path)? {
        eprintln!("{msg}");
    }
    if !path.exists() {
        return Ok(serde_json::json!({ "notebooks": [] }));
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    normalize(raw)
}

/// Keep one rolling backup of the previous good library. Written before
/// every overwrite so a bad write can never destroy the last known-good copy.
fn write_backup(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let bak = path.with_extension("json.bak");
    let _ = fs::copy(path, &bak);
    Ok(())
}

/// True when a save must be refused: replacing real notes with an empty
/// library is a bug, never a user intent.
fn should_refuse_empty_save(incoming: usize, existing: usize) -> bool {
    incoming == 0 && existing > 0
}

#[tauri::command]
fn library_save(app: AppHandle, library: Value) -> Result<(), String> {
    let lib = normalize(library)?;
    let path = library_path(&app)?;
    let incoming = lib["notebooks"].as_array().map(|a| a.len()).unwrap_or(0);
    let existing = notebook_count(&path);
    if should_refuse_empty_save(incoming, existing) {
        return Err(format!(
            "refusing to overwrite {existing} notebooks with an empty library"
        ));
    }
    write_backup(&path)?;
    let tmp = path.with_extension("json.tmp");
    let payload =
        serde_json::to_string(&serde_json::json!({ "version": 1, "notebooks": lib["notebooks"] }))
            .map_err(|e| e.to_string())?;
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn library_export(app: AppHandle, library: Value) -> Result<bool, String> {
    let lib = normalize(library)?;
    let picked = app
        .dialog()
        .file()
        .add_filter("E-Journal", &["E-Journal"])
        .set_file_name("notebook.E-Journal")
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Ok(false);
    };
    let fs_path = file_path.into_path().map_err(|e| e.to_string())?;
    let payload =
        serde_json::to_string(&serde_json::json!({ "version": 1, "notebooks": lib["notebooks"] }))
            .map_err(|e| e.to_string())?;
    fs::write(fs_path, payload).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn library_import(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("E-Journal", &["E-Journal"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let fs_path = file_path.into_path().map_err(|e| e.to_string())?;
    Ok(Some(
        fs::read_to_string(fs_path).map_err(|e| e.to_string())?,
    ))
}

#[derive(serde::Serialize)]
struct PickedImage {
    name: String,
    mime: String,
    base64: String,
}

fn mime_for(ext: &str) -> &str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn media_pick_image(app: AppHandle) -> Result<Option<PickedImage>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let fs_path = file_path.into_path().map_err(|e| e.to_string())?;
    let len = fs::metadata(&fs_path).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err("Image is larger than 12 MB".into());
    }
    let bytes = fs::read(&fs_path).map_err(|e| e.to_string())?;
    let ext = fs_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let name = fs_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    Ok(Some(PickedImage {
        name,
        mime: mime_for(&ext).to_string(),
        base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
    }))
}

#[tauri::command]
fn util_sqlwasm() -> Vec<u8> {
    include_bytes!("../../renderer/vendor/sql-wasm.wasm").to_vec()
}

fn main() {
    tauri::Builder::default()
        // A second instance would hold a stale in-memory library and could
        // overwrite newer saves (including deletions) on quit.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                let _ = w.show();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            library_load,
            library_save,
            library_export,
            library_import,
            media_pick_image,
            util_sqlwasm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good_lib() -> Value {
        json!({ "notebooks": [{
            "id": "n1", "name": "Physics", "color": "#4FA3CD",
            "pages": [{ "id": "p1", "order": 0, "strokes": [
                { "id": "s1", "tool": "pen", "color": "#101418", "width": 3,
                  "points": [{ "x": 1.0, "y": 2.0, "p": 0.5 }] }
            ],
            "images": [{ "id": "i1", "x": 10.0, "y": 20.0, "w": 300.0, "h": 200.0,
                         "dataUrl": "data:image/png;base64,AAA" }],
            "background": "data:image/png;base64,BBB" }]
        }]})
    }

    #[test]
    fn accepts_good_library() {
        assert!(normalize(good_lib()).is_ok());
    }

    #[test]
    fn rejects_bad_notebook() {
        assert!(normalize(json!({ "notebooks": [{ "id": 1 }] })).is_err());
    }

    #[test]
    fn rejects_bad_image() {
        let mut lib = good_lib();
        lib["notebooks"][0]["pages"][0]["images"][0]["w"] = json!("wide");
        assert!(normalize(lib).is_err());
    }

    #[test]
    fn defaults_missing_notebooks() {
        assert_eq!(normalize(json!({})).unwrap()["notebooks"], json!([]));
    }

    #[test]
    fn migration_still_targets_pre_rename_locations() {
        // Guards against a rebranding pass rewriting the *old* paths away:
        // migration must keep looking for the legacy filename in the old
        // folders, or existing notebooks silently vanish on upgrade.
        let base = std::path::Path::new("/appdata");
        let cands = legacy_candidates(base, Some(std::path::Path::new("/appdata/com.old.id")));
        assert!(
            cands.contains(&base.join("OpenJournal").join(LEGACY_LIBRARY_FILE)),
            "missing pre-rename canonical path in {cands:?}"
        );
        assert!(
            cands.contains(&base.join("openjournal").join(LEGACY_LIBRARY_FILE)),
            "missing Electron-shell path in {cands:?}"
        );
        assert!(
            cands.contains(&std::path::Path::new("/appdata/com.old.id").join(LEGACY_LIBRARY_FILE)),
            "missing identifier-keyed path in {cands:?}"
        );
        // The current canonical location must never be treated as a source.
        assert!(!cands.contains(&base.join("E-Journal").join(LIBRARY_FILE)));
    }

    #[test]
    fn empty_save_is_refused_over_real_data() {
        // Replicates the save guard: an empty library must not replace a
        // populated one, because that silently destroys a user's notes.
        let dir = std::env::temp_dir().join(format!("oj-guard-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.json");
        fs::write(&path, serde_json::to_string(&good_lib()).unwrap()).unwrap();
        assert_eq!(notebook_count(&path), 1);
        // 0 incoming over 1 existing -> refused
        assert!(should_refuse_empty_save(0, 1), "empty save must be refused");
        // normal saves still allowed
        assert!(!should_refuse_empty_save(1, 1));
        assert!(!should_refuse_empty_save(3, 1));
        // first-ever launch (nothing on disk) must still be allowed
        assert!(!should_refuse_empty_save(0, 0));
        // a backup copy is produced before overwrite
        write_backup(&path).unwrap();
        assert!(path.with_extension("json.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_notebooks_in_a_library_file() {
        let dir = std::env::temp_dir().join(format!("oj-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.json");
        let empty = dir.join("empty.json");
        let junk = dir.join("junk.json");
        fs::write(&good, serde_json::to_string(&good_lib()).unwrap()).unwrap();
        fs::write(&empty, "{}").unwrap();
        fs::write(&junk, "not json").unwrap();
        assert_eq!(notebook_count(&good), 1);
        assert_eq!(notebook_count(&empty), 0);
        assert_eq!(notebook_count(&junk), 0);
        assert_eq!(notebook_count(&dir.join("missing.json")), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
