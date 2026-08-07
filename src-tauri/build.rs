fn main() {
    // The bundled Firecrawl key is compile-time (option_env! in firecrawl.rs);
    // without this line cargo would keep a stale binary when the key changes.
    println!("cargo:rerun-if-env-changed=LATTICE_FIRECRAWL_KEY");
    tauri_build::build()
}
