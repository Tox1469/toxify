fn main() {
    // Signalsmith Stretch (MIT): velocidade e tom independentes. O código C++ fica em vendor/ e é
    // compilado aqui direto, sem bindgen (que exigiria o LLVM instalado).
    println!("cargo::rerun-if-changed=vendor/signalsmith/wrapper.cpp");
    println!("cargo::rerun-if-changed=vendor/signalsmith/wrapper.h");
    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .file("vendor/signalsmith/wrapper.cpp")
        .include("vendor/signalsmith/signalsmith-stretch")
        .include("vendor/signalsmith")
        .opt_level(3)
        .warnings(false)
        .compile("signalsmith-stretch");
    tauri_build::build()
}
