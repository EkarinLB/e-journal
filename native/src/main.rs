//! E-Journal binary: a native window, no webview, no browser engine.
//!
//! The window layer is not built yet, so the binary exists to prove the core
//! compiles and links as an executable on every target. When `app` lands this
//! becomes the real entry point.

#[cfg(all(not(test), not(feature = "headless"), feature = "window"))]
fn main() {
    if let Err(e) = ejournal::app::run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// Placeholder for the headless build: the core is exercised by `cargo test`.
#[cfg(any(test, feature = "headless", not(feature = "window")))]
fn main() {
    // Deliberately empty. A stub would print on every CI run and add noise.
}