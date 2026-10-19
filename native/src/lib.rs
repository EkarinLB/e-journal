//! E-Journal — native ink notebook.
//!
//! Phase 1 is a dependency-light core: geometry, model and storage, all
//! testable without a window. Later phases add the canvas and input.

pub mod ink;

/// Page rendering, caching and viewport culling.
pub mod page;

/// Pen input policy: kinds, phases, pressure normalisation, palm rejection.
pub mod pen;

/// Native window: real pen input, rasterised without a webview.
#[cfg(not(all(test, feature = "headless")))]
pub mod app;

/// Library format, matching the existing on-disk JSON so notebooks written
/// by earlier builds open without migration.
pub mod model {
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct Image {
        pub id: String,
        pub x: f32,
        pub y: f32,
        pub w: f32,
        pub h: f32,
        #[serde(rename = "dataUrl")]
        pub data_url: String,
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct Stroke {
        pub id: String,
        pub tool: String,
        pub color: String,
        pub width: f32,
        #[serde(rename = "penStyle", default, skip_serializing_if = "Option::is_none")]
        pub pen_style: Option<String>,
        pub points: Vec<Point>,
    }

    #[derive(Clone, Copy, Debug, Serialize, Deserialize)]
    pub struct Point {
        pub x: f32,
        pub y: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub p: Option<f32>,
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct Page {
        pub id: String,
        #[serde(default)]
        pub order: usize,
        #[serde(default = "default_width")]
        pub width: f32,
        #[serde(default = "default_height")]
        pub height: f32,
        #[serde(default)]
        pub strokes: Vec<Stroke>,
        #[serde(default)]
        pub images: Vec<Image>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub background: Option<String>,
    }

    fn default_width() -> f32 {
        1024.0
    }
    fn default_height() -> f32 {
        1408.0
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct Notebook {
        pub id: String,
        pub name: String,
        #[serde(default)]
        pub color: String,
        #[serde(default)]
        pub ruled: bool,
        #[serde(rename = "updatedAt", default)]
        pub updated_at: String,
        #[serde(default)]
        pub pages: Vec<Page>,
    }

    #[derive(Clone, Debug, Serialize, Deserialize, Default)]
    pub struct Library {
        #[serde(default)]
        pub notebooks: Vec<Notebook>,
    }

    /// Reject anything structurally broken rather than silently loading it.
    ///
    /// A half-valid library is worse than none: it would overwrite good data
    /// on the next save.
    pub fn validate(lib: &Library) -> Result<(), String> {
        for nb in &lib.notebooks {
            if nb.id.is_empty() {
                return Err("notebook is missing an id".into());
            }
            for pg in &nb.pages {
                if pg.id.is_empty() {
                    return Err(format!("page in \"{}\" is missing an id", nb.name));
                }
            }
        }
        Ok(())
    }

    impl Library {
        pub fn count_strokes(&self) -> usize {
            self.notebooks
                .iter()
                .flat_map(|n| n.pages.iter())
                .map(|p| p.strokes.len())
                .sum()
        }
    }
}

/// Atomic storage: write to a temporary file, then rename into place.
///
/// An interrupted write must never leave a truncated library on disk.
pub mod store;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_library_is_valid() {
        assert!(model::validate(&model::Library::default()).is_ok());
    }

    #[test]
    fn validation_rejects_missing_ids() {
        let lib = model::Library {
            notebooks: vec![model::Notebook {
                id: String::new(),
                name: "x".into(),
                color: String::new(),
                ruled: true,
                updated_at: String::new(),
                pages: vec![],
            }],
        };
        assert!(model::validate(&lib).is_err());
    }
}