fn main() {
    println!(
        "cargo:rustc-env=ROOST_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("Cargo target")
    );
    tauri_build::build()
}
