// Hide the console window on Windows release builds (keep it for debug).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// OpenJournal native backend (Tauri v2).
// Library format mirrors lib/model.js so Electron and Tauri share files:
//   { "version": 1, "notebooks": [ {id,name,color,icon,ruled,updatedAt,
//     pages: [{id,order,width,height,strokes,images,background}]} ] }

use serde_json::Value;
use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
const LIBRARY_FILE: &str = "openjournal-library.json";

/// Canonical, product-named data folder: %APPDATA%\OpenJournal
/// (stable across packaging changes; the Tauri `app_data_dir()` is keyed to
/// the bundle identifier and changes if the identifier ever changes).
fn canonical_dir() -> Result<std::path::PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .ok_or("APPDATA not set")?;
    let dir = base.join("OpenJournal");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Older locations that may hold a real library, newest convention last:
///   - %APPDATA%\com.openjournal.app  (previous native builds)
///   - %APPDATA%\openjournal         (Electron dev/legacy shell)
fn legacy_paths(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        out.push(d.join(LIBRARY_FILE));
    }
    if let Some(base) = std::env::var_os("APPDATA") {
        let base = std::path::PathBuf::from(base);
        out.push(base.join("openjournal").join(LIBRARY_FILE));
    }
    out
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

#[tauri::command]
fn library_save(app: AppHandle, library: Value) -> Result<(), String> {
    let lib = normalize(library)?;
    let path = library_path(&app)?;
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
        .add_filter("OpenJournal", &["openjournal"])
        .set_file_name("notebook.openjournal")
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
        .add_filter("OpenJournal", &["openjournal"])
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
