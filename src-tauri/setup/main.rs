//! Instalador do Toxify. Uma janela com a cara do app que instala só para o usuário atual, em
//! %LOCALAPPDATA%\Programs\Toxify: sem senha de administrador e sem conta. O Toxify.exe vai
//! comprimido dentro deste executável (quem monta é o scripts/release.mjs). Com --uninstall, a
//! mesma janela desinstala: é assim que "Aplicativos instalados" do Windows chama.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

/// Toxify.exe em gzip.
const PAYLOAD: &[u8] = include_bytes!(env!("TOXIFY_PAYLOAD"));
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Toxify";
const EXE: &str = "Toxify.exe";
const UNINSTALLER: &str = "uninstall.exe";
const LINK: &str = "Toxify.lnk";
const NO_WINDOW: u32 = 0x0800_0000;

/// Onde cada coisa vai. Nos testes aponta tudo pra uma pasta temporária.
struct Places {
    dir: PathBuf,
    menu: PathBuf,
    desktop: PathBuf,
    data: Vec<PathBuf>,
    key: String,
}

impl Places {
    fn system(dir: PathBuf) -> Places {
        use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_Programs};
        let env = |v: &str, sub: &str| std::env::var(v).map(|p| Path::new(&p).join(sub)).unwrap_or_default();
        Places {
            dir,
            menu: known(&FOLDERID_Programs),
            desktop: known(&FOLDERID_Desktop),
            // Biblioteca, playlists e preferências (roaming) e capas/letras em cache (local).
            data: vec![env("APPDATA", "dev.tox.toxify"), env("LOCALAPPDATA", "dev.tox.toxify")],
            key: KEY.into(),
        }
    }
}

/// Pasta especial do Windows (Área de Trabalho, menu Iniciar). Segue o OneDrive quando ele move a pasta.
fn known(id: &windows::core::GUID) -> PathBuf {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
    unsafe {
        let Ok(p) = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None) else { return PathBuf::new() };
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as _));
        PathBuf::from(s)
    }
}

fn default_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA").map(|p| Path::new(&p).join("Programs").join("Toxify")).unwrap_or_default()
}

/// Onde já está instalado e qual versão ("" quando foi copiado na mão, sem registro).
fn installed(key: &str) -> Option<(PathBuf, String)> {
    if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(key) {
        let dir: String = k.get_value("InstallLocation").ok()?;
        return Some((dir.into(), k.get_value("DisplayVersion").unwrap_or_default()));
    }
    let dir = default_dir();
    dir.join(EXE).is_file().then_some((dir, String::new()))
}

// ---------------------------------------------------------------- instalar

fn install(p: &Places, desktop: bool, step: &dyn Fn(&str, f64)) -> Result<(), String> {
    std::fs::create_dir_all(&p.dir).map_err(|e| format!("Não foi possível criar a pasta {}: {e}", p.dir.display()))?;

    step("Copiando o Toxify", 0.1);
    let exe = p.dir.join(EXE);
    let tmp = p.dir.join("Toxify.exe.novo");
    unpack(&tmp, &|f| step("Copiando o Toxify", 0.1 + f * 0.6)).map_err(|e| format!("Não foi possível gravar o Toxify: {e}"))?;
    // Logo depois de fechar o Toxify, o Windows às vezes ainda segura o arquivo por um instante.
    retry(|| std::fs::rename(&tmp, &exe)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Não foi possível substituir o Toxify.exe: {e}")
    })?;

    // O desinstalador é este mesmo executável, chamado com --uninstall.
    let un = p.dir.join(UNINSTALLER);
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    if !same(&me, &un) {
        retry(|| std::fs::copy(&me, &un).map(|_| ())).map_err(|e| format!("Não foi possível gravar o desinstalador: {e}"))?;
    }

    step("Criando os atalhos", 0.78);
    if !p.menu.as_os_str().is_empty() {
        shortcut(&p.menu.join(LINK), &exe).map_err(|e| format!("Não foi possível criar o atalho no menu Iniciar: {e}"))?;
    }
    if desktop && !p.desktop.as_os_str().is_empty() {
        shortcut(&p.desktop.join(LINK), &exe).map_err(|e| format!("Não foi possível criar o atalho na Área de Trabalho: {e}"))?;
    }

    step("Registrando em Aplicativos instalados", 0.9);
    register(p, &exe, &un).map_err(|e| format!("Não foi possível registrar no Windows: {e}"))?;
    step("Pronto", 1.0);
    Ok(())
}

/// Descomprime o Toxify.exe avisando o andamento (0 a 1).
fn unpack(to: &Path, progress: &dyn Fn(f64)) -> std::io::Result<()> {
    // O rodapé do gzip guarda o tamanho original.
    let total = u32::from_le_bytes(PAYLOAD[PAYLOAD.len() - 4..].try_into().unwrap()).max(1) as f64;
    let mut gz = flate2::read::GzDecoder::new(PAYLOAD);
    let mut out = std::fs::File::create(to)?;
    let mut buf = vec![0; 1 << 20];
    let mut done = 0usize;
    loop {
        let n = gz.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        done += n;
        progress(done as f64 / total);
    }
    out.sync_all()
}

fn retry(mut f: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..20 {
        match f() {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(last.unwrap())
}

fn same(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn shortcut(lnk: &Path, target: &Path) -> windows::core::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    if let Some(dir) = lnk.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(target.as_os_str()))?;
        link.SetWorkingDirectory(&HSTRING::from(target.parent().unwrap_or(target).as_os_str()))?;
        link.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)?;
        link.SetDescription(&HSTRING::from("Player de música"))?;
        link.cast::<IPersistFile>()?.Save(&HSTRING::from(lnk.as_os_str()), true)
    }
}

fn register(p: &Places, exe: &Path, un: &Path) -> std::io::Result<()> {
    let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&p.key)?;
    let kb = [exe, un].iter().filter_map(|f| f.metadata().ok()).map(|m| m.len()).sum::<u64>() / 1024;
    k.set_value("DisplayName", &"Toxify")?;
    k.set_value("DisplayVersion", &VERSION)?;
    k.set_value("Publisher", &"Tox")?;
    k.set_value("DisplayIcon", &exe.display().to_string())?;
    k.set_value("InstallLocation", &p.dir.display().to_string())?;
    k.set_value("UninstallString", &format!("\"{}\" --uninstall", un.display()))?;
    k.set_value("URLInfoAbout", &"https://github.com/Tox1469/toxify")?;
    k.set_value("EstimatedSize", &(kb as u32))?;
    k.set_value("NoModify", &1u32)?;
    k.set_value("NoRepair", &1u32)
}

// ---------------------------------------------------------------- desinstalar

/// Tira o programa, os atalhos e o registro. As músicas nunca são tocadas; os dados do app
/// (biblioteca, playlists, preferências) só saem se a pessoa pedir.
fn uninstall(p: &Places, wipe: bool, step: &dyn Fn(&str, f64)) -> Result<(), String> {
    step("Removendo o Toxify", 0.2);
    let exe = p.dir.join(EXE);
    if exe.exists() {
        retry(|| std::fs::remove_file(&exe)).map_err(|e| format!("Não foi possível apagar o Toxify.exe: {e}"))?;
    }
    step("Removendo os atalhos", 0.5);
    for lnk in [p.menu.join(LINK), p.desktop.join(LINK)] {
        let _ = std::fs::remove_file(lnk);
    }
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&p.key);
    if wipe {
        step("Apagando playlists e preferências", 0.75);
        for d in &p.data {
            if !d.as_os_str().is_empty() {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    }
    // O desinstalador em uso não pode se apagar: fica pra quando a janela fechar.
    let un = p.dir.join(UNINSTALLER);
    if !same(&std::env::current_exe().unwrap_or_default(), &un) {
        let _ = std::fs::remove_file(&un);
        let _ = std::fs::remove_dir(&p.dir); // só se ficou vazia: a pasta pode ter coisa de outra pessoa
    }
    step("Pronto", 1.0);
    Ok(())
}

/// Depois que o processo sai, apaga o desinstalador e a pasta (se vazia).
fn delete_after_exit(file: &Path, dir: &Path) {
    let _ = Command::new("cmd")
        .raw_arg(format!("/C ping 127.0.0.1 -n 3 > nul & del /f /q \"{}\" & rmdir \"{}\"", file.display(), dir.display()))
        .creation_flags(NO_WINDOW)
        .spawn();
}

// ---------------------------------------------------------------- Toxify aberto

fn toxify_running() -> bool {
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Toxify.exe", "/NH"])
        .creation_flags(NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains("toxify.exe"))
        .unwrap_or(false)
}

/// Pede pro Toxify fechar (como clicar no X, ele salva o que precisa) e só força se ele não sair.
fn close_toxify() -> Result<(), String> {
    if !toxify_running() {
        return Ok(());
    }
    let kill = |force: bool| {
        let mut c = Command::new("taskkill");
        c.args(["/IM", EXE]);
        if force {
            c.arg("/F");
        }
        let _ = c.creation_flags(NO_WINDOW).output();
    };
    kill(false);
    let t = Instant::now();
    while toxify_running() {
        if t.elapsed() > Duration::from_secs(6) {
            kill(true);
            std::thread::sleep(Duration::from_millis(500));
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if toxify_running() { Err("Não foi possível fechar o Toxify. Feche ele e tente de novo.".into()) } else { Ok(()) }
}

// ---------------------------------------------------------------- janela

struct Setup {
    uninstall: bool,
    /// Aberto pelo botão "Atualizar" do app: instala direto e reabre o Toxify, sem perguntar nada.
    update: bool,
    /// Desinstalador rodando de dentro da pasta: apagar ao sair.
    cleanup: Mutex<Option<(PathBuf, PathBuf)>>,
}

#[derive(Serialize)]
struct Info {
    uninstall: bool,
    update: bool,
    /// Marcar "atalho na Área de Trabalho": sim na primeira instalação; ao atualizar, só se ainda existe.
    desktop: bool,
    version: &'static str,
    dir: String,
    installed: Option<String>,
    running: bool,
}

#[derive(Serialize, Clone)]
struct Step {
    label: String,
    pct: f64,
}

fn emitter(app: &AppHandle) -> impl Fn(&str, f64) + use<> {
    let app = app.clone();
    move |label: &str, pct: f64| {
        let _ = app.emit("step", Step { label: label.into(), pct });
    }
}

#[tauri::command]
fn info(s: State<'_, Setup>) -> Info {
    let found = installed(KEY);
    let link = known(&windows::Win32::UI::Shell::FOLDERID_Desktop).join(LINK).is_file();
    Info {
        uninstall: s.uninstall,
        update: s.update,
        desktop: found.is_none() || link,
        version: VERSION,
        dir: found.as_ref().map(|f| f.0.clone()).unwrap_or_else(default_dir).display().to_string(),
        installed: found.map(|f| f.1),
        running: toxify_running(),
    }
}

#[tauri::command]
async fn pick_dir(app: AppHandle, current: String) -> Option<String> {
    let start = Path::new(&current).ancestors().find(|p| p.is_dir()).map(Path::to_path_buf).unwrap_or_default();
    let dir = app.dialog().file().set_title("Onde instalar o Toxify").set_directory(start).blocking_pick_folder()?;
    let dir = dir.into_path().ok()?;
    // Escolheu "D:\Apps"? Instala em "D:\Apps\Toxify", pra não misturar com o que já está lá.
    let named = dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("toxify"));
    Some(if named { dir } else { dir.join("Toxify") }.display().to_string())
}

#[tauri::command]
async fn run_install(app: AppHandle, dir: String, desktop: bool) -> Result<(), String> {
    let step = emitter(&app);
    tauri::async_runtime::spawn_blocking(move || {
        step("Fechando o Toxify", 0.02);
        close_toxify()?;
        install(&Places::system(PathBuf::from(dir)), desktop, &step)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_uninstall(app: AppHandle, wipe: bool) -> Result<(), String> {
    let step = emitter(&app);
    let dir = installed(KEY)
        .map(|f| f.0)
        .or_else(|| std::env::current_exe().ok()?.parent().map(Path::to_path_buf))
        .ok_or("Não achei onde o Toxify está instalado.")?;
    let p = Places::system(dir.clone());
    tauri::async_runtime::spawn_blocking(move || {
        step("Fechando o Toxify", 0.05);
        close_toxify()?;
        uninstall(&p, wipe, &step)
    })
    .await
    .map_err(|e| e.to_string())??;
    let un = dir.join(UNINSTALLER);
    if same(&std::env::current_exe().unwrap_or_default(), &un) {
        *app.state::<Setup>().cleanup.lock().unwrap() = Some((un, dir));
    }
    Ok(())
}

#[tauri::command]
fn open_toxify(app: AppHandle, dir: String) -> Result<(), String> {
    let exe = Path::new(&dir).join(EXE);
    Command::new(&exe).current_dir(&dir).spawn().map_err(|e| format!("Não foi possível abrir o Toxify: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Sem o WebView2 a janela não abre. Vem no Windows 11 e na maioria dos Windows 10 atualizados.
fn webview_missing() {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONINFORMATION, MB_YESNO};
    let text = "O Toxify precisa do Microsoft Edge WebView2, que não está instalado neste computador.\n\nAbrir a página de download da Microsoft?";
    let r = unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("Instalar o Toxify"), MB_YESNO | MB_ICONINFORMATION) };
    if r == IDYES {
        let _ = Command::new("explorer").arg("https://developer.microsoft.com/microsoft-edge/webview2/").spawn();
    }
}

fn main() {
    let uninstall = std::env::args().any(|a| a == "--uninstall");
    let update = std::env::args().any(|a| a == "--update");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Setup { uninstall, update, cleanup: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![info, pick_dir, run_install, run_uninstall, open_toxify])
        .setup(move |app| {
            let built = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
                .title(if uninstall { "Desinstalar o Toxify" } else { "Instalar o Toxify" })
                .inner_size(600.0, 420.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .center()
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(18, 18, 18, 255))
                // O WebView2 guarda dados numa pasta; a do instalador fica no %TEMP%, não sobra nada em AppData.
                .data_directory(std::env::temp_dir().join("Toxify Setup"))
                .build();
            if built.is_err() {
                webview_missing();
                std::process::exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!("setup/tauri.conf.json"))
        .expect("erro ao abrir o instalador do Toxify");
    app.run(|app, e| {
        if let RunEvent::Exit = e {
            if let Some((file, dir)) = app.state::<Setup>().cleanup.lock().unwrap().take() {
                delete_after_exit(&file, &dir);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Instala e desinstala numa pasta temporária, com chave de registro própria. Não encosta no
    /// Toxify de verdade: nada de fechar app, atalho real nem dados reais.
    #[test]
    fn instala_e_desinstala() {
        let root = std::env::temp_dir().join(format!("toxify-setup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("dados");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("settings.json"), "{}").unwrap();
        let p = Places {
            dir: root.join("Programs").join("Toxify"),
            menu: root.join("menu"),
            desktop: root.join("desktop"),
            data: vec![data.clone()],
            key: r"Software\ToxifySetupTest".into(),
        };

        install(&p, true, &|_, _| {}).unwrap();
        let exe = p.dir.join(EXE);
        let mut original = Vec::new();
        flate2::read::GzDecoder::new(PAYLOAD).read_to_end(&mut original).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), original, "Toxify.exe diferente do embutido");
        assert!(p.dir.join(UNINSTALLER).is_file());
        assert!(p.menu.join(LINK).is_file() && p.desktop.join(LINK).is_file());
        let (dir, ver) = installed(&p.key).unwrap();
        assert_eq!((dir, ver.as_str()), (p.dir.clone(), VERSION));

        // Reinstalar por cima (atualização) funciona com tudo já no lugar.
        install(&p, false, &|_, _| {}).unwrap();

        // Desinstalar sem apagar dados: dados ficam, o resto sai.
        uninstall(&p, false, &|_, _| {}).unwrap();
        assert!(!exe.exists() && !p.dir.exists(), "pasta do programa ficou");
        assert!(!p.menu.join(LINK).exists() && !p.desktop.join(LINK).exists());
        assert!(RegKey::predef(HKEY_CURRENT_USER).open_subkey(&p.key).is_err());
        assert!(data.join("settings.json").is_file(), "apagou dados sem pedir");

        // Pasta escolhida com coisa de fora: desinstalar não leva o que não é nosso.
        install(&p, false, &|_, _| {}).unwrap();
        std::fs::write(p.dir.join("de-outra-pessoa.txt"), "fica").unwrap();
        uninstall(&p, true, &|_, _| {}).unwrap();
        assert!(p.dir.join("de-outra-pessoa.txt").is_file());
        assert!(!data.exists(), "pediu pra apagar os dados e ficaram");

        let _ = std::fs::remove_dir_all(&root);
    }
}
