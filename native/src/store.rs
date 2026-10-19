//! Library persistence.
//!
//! Deliberately boring: read one JSON file, validate, and write atomically
//! with a rolling backup. Everything that can lose a user's notes lives here,
//! so the rules are explicit rather than incidental.

use crate::model::{self, Library};
use std::fs;
use std::path::{Path, PathBuf};

/// Never silently replace real notebooks with an empty library. That can only
/// be a bug, never an intent — deleting the last notebook goes through an
/// explicit flag instead.
pub fn should_refuse_empty_save(incoming: usize, existing: usize, intentional: bool) -> bool {
    incoming == 0 && existing > 0 && !intentional
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// Copy the previous good library aside before overwriting it.
fn write_backup(path: &Path) {
    if path.exists() {
        let _ = fs::copy(path, backup_path(path));
    }
}

pub fn notebook_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Library>(&t).ok())
        .map(|l| l.notebooks.len())
        .unwrap_or(0)
}

/// Load the library, or an empty one when the file is absent.
///
/// A corrupt file is an error rather than an empty result: silently returning
/// "no notebooks" is how data gets overwritten.
pub fn load(path: &Path) -> Result<Library, String> {
    if !path.exists() {
        return Ok(Library::default());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(Library::default());
    }
    let lib: Library = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    model::validate(&lib)?;
    Ok(lib)
}

pub fn save(path: &Path, lib: &Library, intentional: bool) -> Result<(), String> {
    model::validate(lib)?;
    let incoming = lib.notebooks.len();
    let existing = notebook_count(path);
    if should_refuse_empty_save(incoming, existing, intentional) {
        return Err(format!(
            "refusing to overwrite {existing} notebooks with an empty library"
        ));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_backup(path);
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string(lib).map_err(|e| e.to_string())?;
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Notebook;

    fn nb(name: &str) -> Notebook {
        Notebook {
            id: format!("id-{name}"),
            name: name.into(),
            color: "#000".into(),
            ruled: true,
            updated_at: "2026-01-01".into(),
            pages: vec![],
        }
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ej-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips_and_leaves_no_temp_file() {
        let d = tmpdir("rt");
        let p = d.join("library.json");
        let lib = Library { notebooks: vec![nb("Physics")] };
        save(&p, &lib, false).unwrap();
        assert!(!p.with_extension("json.tmp").exists(), "temp file must be renamed away");
        let back = load(&p).unwrap();
        assert_eq!(back.notebooks[0].name, "Physics");
    }

    #[test]
    fn missing_file_loads_empty_rather_than_failing() {
        let d = tmpdir("missing");
        assert_eq!(load(&d.join("nope.json")).unwrap().notebooks.len(), 0);
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_library() {
        let d = tmpdir("corrupt");
        let p = d.join("library.json");
        fs::write(&p, "{ not json").unwrap();
        assert!(load(&p).is_err(), "corrupt data must not read as empty");
    }

    #[test]
    fn empty_save_cannot_wipe_real_notes() {
        let d = tmpdir("guard");
        let p = d.join("library.json");
        save(&p, &Library { notebooks: vec![nb("a"), nb("b")] }, false).unwrap();
        let err = save(&p, &Library::default(), false).unwrap_err();
        assert!(err.contains("refusing"));
        assert_eq!(load(&p).unwrap().notebooks.len(), 2, "data must survive");
    }

    #[test]
    fn deleting_the_last_notebook_is_allowed_when_intentional() {
        let d = tmpdir("intent");
        let p = d.join("library.json");
        save(&p, &Library { notebooks: vec![nb("a")] }, false).unwrap();
        save(&p, &Library::default(), true).unwrap();
        assert_eq!(load(&p).unwrap().notebooks.len(), 0);
    }

    #[test]
    fn first_ever_save_of_nothing_is_allowed() {
        let d = tmpdir("first");
        let p = d.join("library.json");
        assert!(!should_refuse_empty_save(0, 0, false));
        save(&p, &Library::default(), false).unwrap();
    }

    #[test]
    fn backup_holds_the_previous_state() {
        let d = tmpdir("bak");
        let p = d.join("library.json");
        save(&p, &Library { notebooks: vec![nb("kept")] }, false).unwrap();
        save(&p, &Library::default(), true).unwrap();
        let bak: Library =
            serde_json::from_str(&fs::read_to_string(backup_path(&p)).unwrap()).unwrap();
        assert_eq!(bak.notebooks.len(), 1);
        assert_eq!(bak.notebooks[0].name, "kept", "backup must be recoverable");
    }

    #[test]
    fn invalid_library_is_refused_before_touching_disk() {
        let d = tmpdir("invalid");
        let p = d.join("library.json");
        let bad = Library { notebooks: vec![nb("ok")] };
        save(&p, &bad, false).unwrap();
        let mut broken = bad.clone();
        broken.notebooks[0].id = String::new();
        assert!(save(&p, &broken, false).is_err());
        assert_eq!(load(&p).unwrap().notebooks.len(), 1, "bad save must not overwrite");
    }

    #[test]
    fn counts_strokes_across_notebooks() {
        use crate::model::{Page, Point, Stroke};
        let page = Page {
            id: "p".into(),
            order: 0,
            width: 1024.0,
            height: 1408.0,
            strokes: vec![Stroke {
                id: "s".into(),
                tool: "pen".into(),
                color: "#000".into(),
                width: 3.0,
                pen_style: None,
                points: vec![Point { x: 0.0, y: 0.0, p: Some(0.5) }],
            }],
            images: vec![],
            background: None,
        };
        let lib = Library {
            notebooks: vec![Notebook {
                pages: vec![page.clone(), page],
                ..nb("x")
            }],
        };
        assert_eq!(lib.count_strokes(), 2);
    }
}