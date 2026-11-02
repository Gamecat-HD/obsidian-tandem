//! Bettet die Admin-Oberfläche (admin-ui/) in den Binary ein. Fehlt eine Datei, wird ein Platzhalter eingebettet.
use std::path::Path;

fn main() {
    let out = std::env::var("OUT_DIR").unwrap();
    let mut code = String::new();
    for (name, file) in [("INDEX_HTML", "index.html"), ("APP_CSS", "app.css"), ("APP_JS", "app.js")] {
        let p = Path::new("admin-ui").join(file);
        println!("cargo:rerun-if-changed={}", p.display());
        let s = std::fs::read_to_string(&p).unwrap_or_else(|_| format!("/* {file} fehlt beim Bauen */"));
        code.push_str(&format!("pub const {name}: &str = {s:?};\n"));
    }
    println!("cargo:rerun-if-changed=admin-ui");
    std::fs::write(Path::new(&out).join("admin_ui.rs"), code).unwrap();
}
