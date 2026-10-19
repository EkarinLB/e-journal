//! E-Journal binary: a native window, no webview, no browser engine.

fn main() {
    if let Err(e) = ejournal::app::run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}