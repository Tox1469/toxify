mod discord;
mod engine;
mod library;
mod m3u;
mod media;
mod online;
mod scrobble;
mod source;
mod stretch;
mod tags;
mod watch;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use engine::{Cmd, Prefs};
use library::{Library, Track};
use online::{Lyrics, Online};
use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response};
use tauri::{AppHandle, Emitter, Listener, Manager, State};

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    folders: Vec<String>,
    prefs: Prefs,
    #[serde(default = "yes")]
    translate: bool,
    /// Mostrar "Ouvindo Toxify" no Discord.
    #[serde(default = "yes")]
    discord: bool,
    /// Aplicar sozinho as correções do "Arrumar biblioteca" depois de cada leitura.
    #[serde(default = "yes")]
    auto_fix: bool,
    /// Saída de som escolhida (id do WASAPI); None = a padrão do Windows.
    #[serde(default)]
    device: Option<String>,
    /// Contas de scrobbling (ListenBrainz e Last.fm).
    #[serde(default)]
    scrobble: scrobble::Accounts,
}

fn yes() -> bool {
    true
}

/// Aplicativo "Toxify" no Discord: é o nome que aparece no "Ouvindo ..." do perfil.
const DISCORD_APP: &str = "1569192621711032343";

impl Default for Settings {
    fn default() -> Self {
        let music = if Path::new("D:\\Music").is_dir() {
            "D:\\Music".to_string()
        } else {
            std::env::var("USERPROFILE").map(|h| format!("{h}\\Music")).unwrap_or_default()
        };
        // Exclusivo desligado por padrão: ele toma a placa só pra si e o Discord e afins ficam mudos.
        Settings {
            folders: vec![music],
            prefs: Prefs { volume: 1.0, crossfade: true, crossfade_secs: 6.0, exclusive: false, speed: 1.0, pitch: 1.0, replaygain: 0 },
            translate: true,
            discord: true,
            auto_fix: true,
            device: None,
            scrobble: Default::default(),
        }
    }
}

struct App {
    lib: Arc<Library>,
    tx: Sender<Cmd>,
    settings: Mutex<Settings>,
    online: Arc<Online>,
    cfg: PathBuf,
    covers: PathBuf,
    tag_log: PathBuf,
    scanning: AtomicBool,
    discord: Sender<discord::Msg>,
    /// Gênero escolhido por artista (chave do artista → nome do grupo). Vale mais que a tag do arquivo,
    /// que em música brasileira baixada vem errada ("Pop/Rock" no Nelson Gonçalves).
    genres: Mutex<std::collections::BTreeMap<String, String>>,
    genres_path: PathBuf,
    /// Lê a biblioteca de novo sozinho quando entra ou sai música das pastas.
    watcher: watch::Watcher,
    scrobble: Sender<scrobble::Msg>,
    /// Login do Last.fm em andamento (token esperando a pessoa autorizar no site).
    lastfm_token: Mutex<Option<String>>,
}

impl App {
    fn save(&self) {
        let s = self.settings.lock().unwrap().clone();
        if let Ok(j) = serde_json::to_string_pretty(&s) {
            let _ = std::fs::write(&self.cfg, j);
        }
    }
    fn send(&self, c: Cmd) {
        let _ = self.tx.send(c);
    }
}

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- biblioteca

#[derive(Serialize, Clone)]
struct ScanMsg {
    done: usize,
    total: usize,
    finished: bool,
}

fn start_scan(app: &AppHandle) {
    let st = app.state::<App>();
    if st.scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<App>();
        let folders = st.settings.lock().unwrap().folders.clone();
        let res = st.lib.scan(&folders, |done, total| {
            // Nada novo (o caso comum quando quem chamou foi o vigia das pastas): não pisca "Lendo" na tela.
            if total > 0 {
                let _ = app.emit("scan", ScanMsg { done, total, finished: false });
            }
        });
        if let Err(e) = res {
            eprintln!("varredura falhou: {e:#}");
        }
        st.scanning.store(false, Ordering::SeqCst);
        let _ = app.emit("scan", ScanMsg { done: 0, total: 0, finished: true });
    });
}

#[tauri::command]
fn get_library(s: State<'_, App>) -> R<Vec<Track>> {
    s.lib.all().map_err(err)
}

#[tauri::command]
fn get_settings(s: State<'_, App>) -> Settings {
    s.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_folders(app: AppHandle, s: State<'_, App>, folders: Vec<String>) {
    s.watcher.watch(&folders);
    s.settings.lock().unwrap().folders = folders;
    s.save();
    start_scan(&app);
}

#[tauri::command]
fn rescan(app: AppHandle) {
    start_scan(&app);
}

#[tauri::command]
fn set_translate(s: State<'_, App>, on: bool) {
    s.settings.lock().unwrap().translate = on;
    s.save();
}

#[tauri::command]
fn get_genres(s: State<'_, App>) -> std::collections::BTreeMap<String, String> {
    s.genres.lock().unwrap().clone()
}

/// `genre` vazio = volta a usar a tag do arquivo.
#[tauri::command]
fn set_genre(s: State<'_, App>, artist: String, genre: String) -> R<()> {
    let mut g = s.genres.lock().unwrap();
    if genre.trim().is_empty() {
        g.remove(&artist);
    } else {
        g.insert(artist, genre.trim().to_string());
    }
    std::fs::write(&s.genres_path, serde_json::to_string_pretty(&*g).map_err(err)?).map_err(err)
}

#[tauri::command]
fn is_scanning(s: State<'_, App>) -> bool {
    s.scanning.load(Ordering::SeqCst)
}

/// Registro do que o "arrumar sozinho" fez (auto.log), pra dar pra conferir depois.
#[tauri::command]
fn log_auto(s: State<'_, App>, msg: String) {
    use std::io::Write;
    let path = s.genres_path.with_file_name("auto.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{now} {msg}");
    }
}

#[tauri::command]
fn set_auto(s: State<'_, App>, auto_fix: bool) {
    s.settings.lock().unwrap().auto_fix = auto_fix;
    s.save();
}

/// Anota os artistas que ainda estão sem gênero em genres-pending.json. Quem classifica é o Tox
/// pedindo pro Claude Code ("classifica os novos"), que grava em genres.json. Nada de API paga.
#[tauri::command]
fn write_pending_genres(s: State<'_, App>, artists: Vec<online::ArtistInfo>) -> R<()> {
    let g = s.genres.lock().unwrap();
    let pending: Vec<&online::ArtistInfo> = artists.iter().filter(|a| !g.contains_key(&a.key)).collect();
    let path = s.genres_path.with_file_name("genres-pending.json");
    if pending.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::write(path, serde_json::to_string_pretty(&pending).map_err(err)?).map_err(err)
}

#[tauri::command]
async fn artist_top(s: State<'_, App>, name: String) -> R<Vec<String>> {
    let online = s.online.clone();
    Ok(online.artist_top(&name).await)
}

/// Volta a fila e a música de quando o app fechou, pausada no mesmo ponto.
#[tauri::command]
fn restore(s: State<'_, App>, ids: Vec<i64>, index: usize, at: f64, shuffle: bool, repeat: u8) {
    let queue = s.lib.qtracks(&ids);
    let target = ids.get(index).copied();
    let index = target.and_then(|id| queue.iter().position(|t| t.id == id));
    if let Some(index) = index {
        s.send(Cmd::Restore { queue, index, at, shuffle, repeat });
    }
}

#[tauri::command]
fn set_discord(s: State<'_, App>, on: bool) {
    s.settings.lock().unwrap().discord = on;
    s.save();
    let _ = s.discord.send(discord::Msg::Config { on, app_id: DISCORD_APP.into() });
}

#[tauri::command]
fn likes(s: State<'_, App>) -> Vec<i64> {
    s.lib.likes()
}

#[tauri::command]
fn set_like(s: State<'_, App>, id: i64, on: bool) -> R<()> {
    s.lib.set_like(id, on).map_err(err)
}

#[tauri::command]
fn plays(s: State<'_, App>) -> Vec<[i64; 5]> {
    s.lib.plays()
}

#[tauri::command]
fn play_log(s: State<'_, App>, from: i64, to: i64) -> Vec<(i64, i64, f64, bool)> {
    s.lib.play_log(from, to)
}

/// Grava o PNG que a tela desenhou (cartão da Retrospectiva) no caminho escolhido no diálogo de salvar.
#[tauri::command]
fn save_file(path: String, data: Vec<u8>) -> R<()> {
    if !path.to_ascii_lowercase().ends_with(".png") {
        return Err("só dá pra salvar imagem .png".into());
    }
    std::fs::write(&path, data).map_err(err)
}

// ---------------------------------------------------------------- playlists

#[tauri::command]
fn playlists(s: State<'_, App>) -> Vec<library::Playlist> {
    s.lib.playlists()
}

#[tauri::command]
fn playlist_create(s: State<'_, App>, name: String, tracks: Vec<i64>) -> R<i64> {
    s.lib.playlist_create(&name, &tracks).map_err(err)
}

#[tauri::command]
fn playlist_rename(s: State<'_, App>, id: i64, name: String) -> R<()> {
    s.lib.playlist_rename(id, &name).map_err(err)
}

#[tauri::command]
fn playlist_delete(s: State<'_, App>, id: i64) -> R<()> {
    s.lib.playlist_delete(id).map_err(err)
}

#[tauri::command]
fn playlist_set(s: State<'_, App>, id: i64, tracks: Vec<i64>) -> R<()> {
    s.lib.playlist_set(id, &tracks).map_err(err)
}

/// Grava a playlist em .m3u8 (abre no foobar2000, MusicBee, VLC...).
#[tauri::command]
fn export_playlist(s: State<'_, App>, id: i64, path: String) -> R<()> {
    let pl = s.lib.playlists().into_iter().find(|p| p.id == id).ok_or("playlist não existe")?;
    let tracks: Vec<Track> = pl.tracks.iter().filter_map(|&t| s.lib.get(t)).collect();
    std::fs::write(&path, m3u::write(&tracks)).map_err(err)
}

#[derive(Serialize)]
struct Imported {
    id: i64,
    name: String,
    found: usize,
    missing: usize,
}

/// Lê uma .m3u/.m3u8 de outro player e cria a playlist com o que achar na biblioteca.
#[tauri::command]
fn import_playlist(s: State<'_, App>, path: String) -> R<Imported> {
    let file = Path::new(&path);
    let paths = m3u::read(file).map_err(err)?;
    let (ids, missing) = m3u::match_tracks(&paths, &s.lib.all().map_err(err)?);
    if ids.is_empty() {
        return Err("nenhuma música dessa playlist está na sua biblioteca".into());
    }
    let name = file.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Playlist".into());
    let id = s.lib.playlist_create(&name, &ids).map_err(err)?;
    Ok(Imported { id, name, found: ids.len(), missing })
}

// ---------------------------------------------------------------- player

#[tauri::command]
fn play(s: State<'_, App>, ids: Vec<i64>, index: usize) {
    let queue = s.lib.qtracks(&ids);
    // Se alguma faixa sumiu do disco, o índice ainda aponta pra certa.
    let target = ids.get(index).copied();
    let index = target.and_then(|id| queue.iter().position(|t| t.id == id)).unwrap_or(0);
    if !queue.is_empty() {
        s.send(Cmd::Play { queue, index });
    }
}

#[tauri::command]
fn toggle(s: State<'_, App>) {
    s.send(Cmd::Toggle)
}
#[tauri::command]
fn next(s: State<'_, App>) {
    s.send(Cmd::Next)
}
#[tauri::command]
fn prev(s: State<'_, App>) {
    s.send(Cmd::Prev)
}
#[tauri::command]
fn seek(s: State<'_, App>, secs: f64) {
    s.send(Cmd::Seek(secs))
}
#[tauri::command]
fn set_shuffle(s: State<'_, App>, on: bool) {
    s.send(Cmd::Shuffle(on))
}
#[tauri::command]
fn set_repeat(s: State<'_, App>, mode: u8) {
    s.send(Cmd::Repeat(mode))
}
#[tauri::command]
fn enqueue(s: State<'_, App>, ids: Vec<i64>) {
    s.send(Cmd::Enqueue(s.lib.qtracks(&ids)))
}
#[tauri::command]
fn play_next(s: State<'_, App>, ids: Vec<i64>) {
    s.send(Cmd::PlayNext(s.lib.qtracks(&ids)))
}
#[tauri::command]
fn jump_to(s: State<'_, App>, index: usize) {
    s.send(Cmd::JumpTo(index))
}
#[tauri::command]
fn remove_at(s: State<'_, App>, index: usize) {
    s.send(Cmd::RemoveAt(index))
}

#[tauri::command]
fn set_volume(s: State<'_, App>, v: f32) {
    s.settings.lock().unwrap().prefs.volume = v;
    s.save();
    s.send(Cmd::Volume(v))
}

#[tauri::command]
fn set_crossfade(s: State<'_, App>, on: bool, secs: f32) {
    {
        let mut st = s.settings.lock().unwrap();
        st.prefs.crossfade = on;
        st.prefs.crossfade_secs = secs;
    }
    s.save();
    s.send(Cmd::Crossfade { on, secs })
}

#[tauri::command]
fn set_speed(s: State<'_, App>, v: f32) {
    s.settings.lock().unwrap().prefs.speed = v;
    s.save();
    s.send(Cmd::Speed(v))
}

#[tauri::command]
fn set_pitch(s: State<'_, App>, v: f32) {
    s.settings.lock().unwrap().prefs.pitch = v;
    s.save();
    s.send(Cmd::Pitch(v))
}

#[tauri::command]
fn set_exclusive(s: State<'_, App>, on: bool) {
    s.settings.lock().unwrap().prefs.exclusive = on;
    s.save();
    s.send(Cmd::Exclusive(on))
}

/// 0 = desligado, 1 = por faixa, 2 = por álbum.
#[tauri::command]
fn set_replaygain(s: State<'_, App>, mode: u8) {
    s.settings.lock().unwrap().prefs.replaygain = mode.min(2);
    s.save();
    s.send(Cmd::ReplayGain(mode))
}

#[derive(Serialize)]
struct OutDevice {
    id: String,
    name: String,
}

/// Saídas de som ligadas agora. Roda numa thread com COM próprio (o WASAPI exige).
#[tauri::command]
async fn list_devices() -> R<Vec<OutDevice>> {
    tauri::async_runtime::spawn_blocking(|| -> R<Vec<OutDevice>> {
        let _ = wasapi::initialize_mta();
        let list = wasapi::DeviceEnumerator::new().and_then(|e| e.get_device_collection(wasapi::Direction::Render)).map_err(err)?;
        let n = list.get_nbr_devices().map_err(err)?;
        Ok((0..n)
            .filter_map(|i| list.get_device_at_index(i).ok())
            .map(|d| OutDevice { id: d.get_id().unwrap_or_default(), name: d.get_friendlyname().unwrap_or_default() })
            .collect())
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------- scrobbling

fn set_accounts(s: &App, f: impl FnOnce(&mut scrobble::Accounts)) {
    let acc = {
        let mut st = s.settings.lock().unwrap();
        f(&mut st.scrobble);
        st.scrobble.clone()
    };
    s.save();
    let _ = s.scrobble.send(scrobble::Msg::Accounts(acc));
}

/// Confere o token do ListenBrainz e liga. Devolve o nome do usuário.
#[tauri::command]
async fn listenbrainz_connect(s: State<'_, App>, token: String) -> R<String> {
    let token = token.trim().to_string();
    let user = scrobble::lb_validate(&token).await.map_err(err)?;
    set_accounts(&s, |a| {
        a.lb_token = token;
        a.lb_user = user.clone();
    });
    Ok(user)
}

#[tauri::command]
fn lastfm_available() -> bool {
    scrobble::LASTFM_KEY.is_some()
}

/// Abre o site do Last.fm pra pessoa autorizar o Toxify.
#[tauri::command]
async fn lastfm_begin(s: State<'_, App>) -> R<()> {
    let (token, url) = scrobble::lastfm_begin().await.map_err(err)?;
    *s.lastfm_token.lock().unwrap() = Some(token);
    std::process::Command::new("explorer").arg(&url).spawn().map_err(err)?;
    Ok(())
}

/// Depois de autorizar no site: pega a sessão e liga. Devolve o nome do usuário.
#[tauri::command]
async fn lastfm_finish(s: State<'_, App>) -> R<String> {
    let token = s.lastfm_token.lock().unwrap().clone().ok_or("comece pelo Conectar")?;
    let f = scrobble::lastfm_finish(&token).await.map_err(err)?;
    let user = f.user.clone();
    *s.lastfm_token.lock().unwrap() = None;
    set_accounts(&s, |a| a.lastfm = Some(f));
    Ok(user)
}

/// "listenbrainz" ou "lastfm".
#[tauri::command]
fn scrobble_disconnect(s: State<'_, App>, service: String) {
    set_accounts(&s, |a| match service.as_str() {
        "listenbrainz" => {
            a.lb_token.clear();
            a.lb_user.clear();
        }
        _ => a.lastfm = None,
    });
}

/// `None` = acompanhar a saída padrão do Windows.
#[tauri::command]
fn set_device(s: State<'_, App>, id: Option<String>) {
    s.settings.lock().unwrap().device = id.clone();
    s.save();
    s.send(Cmd::Device(id))
}

// ---------------------------------------------------------------- letra

#[tauri::command]
async fn lyrics(s: State<'_, App>, id: i64, to: Option<String>) -> R<Option<Lyrics>> {
    let Some(t) = s.lib.get(id) else { return Ok(None) };
    let online = s.online.clone();
    let translate = s.settings.lock().unwrap().translate;
    let to = to.unwrap_or_else(|| "pt".into());
    let mut l = match online.lyrics(&t).await {
        Some(l) => l,
        None => return Ok(None),
    };
    // Tradução guardada em outro idioma (trocou o idioma do app): traduz de novo.
    let stale = l.translation.is_none() || l.to.as_deref().unwrap_or("pt") != to;
    if translate && stale && !l.lines.is_empty() {
        let texts: Vec<String> = l.lines.iter().map(|x| x.text.clone()).collect();
        if let Some((lang, tr)) = online.translate(&texts, &to).await {
            l.lang = Some(lang);
            l.translation = Some(tr);
            l.to = Some(to);
            online.save_lyrics(&t, &l);
        }
    }
    Ok(Some(l))
}

// ---------------------------------------------------------------- atualização

#[tauri::command]
async fn check_update(s: State<'_, App>) -> R<Option<online::Update>> {
    Ok(s.online.clone().check_update().await)
}

/// Baixa e confere o instalador da última release, abre ele no modo `--update` (instala e reabre o
/// Toxify sozinho) e fecha o app. A URL vem da consulta feita aqui, nunca da tela.
#[tauri::command]
async fn install_update(app: AppHandle, s: State<'_, App>) -> R<()> {
    let online = s.online.clone();
    let u = online.check_update().await.ok_or("não achei a versão nova no GitHub")?;
    let exe = std::env::temp_dir().join(format!("Toxify-Setup-{}.exe", u.version));
    online.download_update(&u, &exe).await.map_err(err)?;
    std::process::Command::new(&exe).arg("--update").spawn().map_err(err)?;
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------- tags

#[tauri::command]
async fn save_tags(app: AppHandle, changes: Vec<tags::Change>) -> R<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<App>();
        let res = tags::apply(&st.lib, &st.tag_log, &changes, |done, total| {
            let _ = app.emit("tag-progress", (done, total));
        });
        res.map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn undo_tags(app: AppHandle) -> R<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<App>();
        tags::undo(&st.lib, &st.tag_log).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn has_undo(s: State<'_, App>) -> bool {
    tags::has_undo(&s.tag_log)
}

// ---------------------------------------------------------------- imagens (protocolos cover:// e artist://)

fn not_found() -> Response<Vec<u8>> {
    Response::builder().status(404).body(Vec::new()).unwrap()
}

fn image(bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "max-age=604800")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap()
}

fn cover_response(app: &AppHandle, req: &Request<Vec<u8>>) -> Option<Response<Vec<u8>>> {
    let id: i64 = req.uri().path().trim_matches('/').parse().ok()?;
    let size: u32 = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("s=")))
        .and_then(|v| v.parse().ok())
        .unwrap_or(300)
        .clamp(64, 1200);
    let st = app.state::<App>();
    let (path, key) = st.lib.path_of(id)?;
    let ck = if key.ends_with('|') { path.clone() } else { key };
    let file = st.covers.join(format!("{}_{size}.jpg", online::hash(&ck)));
    if let Ok(b) = std::fs::read(&file) {
        return Some(image(b));
    }
    // Sem capa no arquivo nem na pasta: busca a do álbum no Deezer (fica no cache depois).
    let raw = match library::cover_bytes(Path::new(&path)) {
        Some(b) => b,
        None => {
            let t = st.lib.get(id)?;
            let who = if t.album_artist.is_empty() { t.artist.clone() } else { t.album_artist.clone() };
            let online = st.online.clone();
            tauri::async_runtime::block_on(async move {
                let url = online.album_cover_url(&who.replace("; ", ", "), &t.album).await?;
                online.download(&url).await
            })?
        }
    };
    let img = image::load_from_memory(&raw).ok()?;
    let img = if img.width() > size || img.height() > size { img.thumbnail(size, size) } else { img };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img.to_rgb8()).ok()?;
    let _ = std::fs::write(&file, &out);
    Some(image(out))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|_| ()).and_then(|h| u8::from_str_radix(h, 16).map_err(|_| ())) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn artist_response(app: &AppHandle, req: &Request<Vec<u8>>) -> Option<Response<Vec<u8>>> {
    let name = percent_decode(req.uri().path().trim_matches('/'));
    if name.trim().is_empty() {
        return None;
    }
    let online = app.state::<App>().online.clone();
    let file = tauri::async_runtime::block_on(async move { online.artist_image(&name).await })?;
    Some(image(std::fs::read(file).ok()?))
}

// ---------------------------------------------------------------- início

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("cover", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(cover_response(&app, &req).unwrap_or_else(not_found)));
        })
        .register_asynchronous_uri_scheme_protocol("artist", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(artist_response(&app, &req).unwrap_or_else(not_found)));
        })
        .setup(|app| {
            let paths = app.path();
            let data = paths.app_data_dir()?;
            let cache = paths.app_cache_dir()?;
            std::fs::create_dir_all(&data)?;
            std::fs::create_dir_all(cache.join("covers"))?;
            let cfg = data.join("settings.json");
            let settings: Settings = std::fs::read_to_string(&cfg).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let lib = Arc::new(Library::open(&data.join("library.db"))?);
            let (tx, rx) = channel();
            engine::Engine::spawn(app.handle().clone(), rx, settings.prefs, settings.device.clone());
            let online = Arc::new(Online::new(cache.clone()));

            // Teclas de mídia + painel do Windows, e o "Ouvindo Toxify" do Discord.
            let (media_tx, media_rx) = channel();
            if let Some(hwnd) = app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
                media::spawn(hwnd.0 as isize, tx.clone(), media_rx);
            }
            let (dc_tx, dc_rx) = channel();
            discord::spawn(dc_rx, online.clone(), settings.discord, DISCORD_APP.into());
            {
                #[derive(Deserialize)]
                struct P {
                    track_id: Option<i64>,
                    playing: bool,
                    position: f64,
                    duration: f64,
                    #[serde(default)]
                    speed: f64,
                }
                let lib = lib.clone();
                let dc_tx = dc_tx.clone();
                let last = Mutex::new((None::<i64>, false, 0.0f64, std::time::Instant::now()));
                app.listen_any("player", move |e| {
                    let Ok(p) = serde_json::from_str::<P>(e.payload()) else { return };
                    let mut l = last.lock().unwrap();
                    let (lid, lplay, lpos, lat) = *l;
                    *l = (p.track_id, p.playing, p.position, std::time::Instant::now());
                    let expected = if lplay { lpos + lat.elapsed().as_secs_f64() } else { lpos };
                    let changed = p.track_id != lid;
                    let jumped = (p.position - expected).abs() > 3.0;
                    if !changed && p.playing == lplay && !jumped {
                        return;
                    }
                    let t = p.track_id.and_then(|id| lib.get(id));
                    let artist = t.as_ref().map(|t| if t.artist.is_empty() { &t.album_artist } else { &t.artist }).map(|a| a.replace("; ", ", ")).unwrap_or_default();
                    if changed {
                        if let Some(t) = &t {
                            let _ = media_tx.send(media::Msg::Track { title: t.title.clone(), artist: artist.clone(), album: t.album.clone(), path: PathBuf::from(&t.path) });
                        }
                    }
                    let _ = media_tx.send(media::Msg::Playing(p.playing));
                    match (&t, p.playing) {
                        (Some(t), true) => {
                            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                            let speed = if p.speed > 0.0 { p.speed } else { 1.0 };
                            let start_ms = now_ms - (p.position * 1000.0 / speed) as i64;
                            let _ = dc_tx.send(discord::Msg::Playing(discord::Now {
                                title: t.title.clone(),
                                artist,
                                album: t.album.clone(),
                                start_ms,
                                end_ms: start_ms + (p.duration * 1000.0 / speed) as i64,
                            }));
                        }
                        _ => {
                            let _ = dc_tx.send(discord::Msg::Paused);
                        }
                    }
                });
            }

            let (scr_tx, scr_rx) = channel();
            scrobble::spawn(scr_rx, settings.scrobble.clone(), data.join("scrobbles.json"));

            app.manage(App {
                lib: lib.clone(),
                tx,
                scrobble: scr_tx.clone(),
                lastfm_token: Mutex::new(None),
                settings: Mutex::new(settings),
                online,
                cfg,
                covers: cache.join("covers"),
                tag_log: data.join("tag-history.jsonl"),
                scanning: AtomicBool::new(false),
                discord: dc_tx,
                genres: Mutex::new(
                    std::fs::read_to_string(data.join("genres.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                ),
                genres_path: data.join("genres.json"),
                watcher: {
                    let h = app.handle().clone();
                    watch::Watcher::new(move || start_scan(&h))
                },
            });
            app.state::<App>().save();
            {
                let st = app.state::<App>();
                let folders = st.settings.lock().unwrap().folders.clone();
                st.watcher.watch(&folders);
            }
            // Scrobbling: o que começou a tocar ("ouvindo agora") e o que terminou (se contou como ouvida).
            let listen = |t: &Track, at: i64| scrobble::Listen {
                artist: (if t.artist.is_empty() { &t.album_artist } else { &t.artist }).replace(';', ", "),
                title: t.title.clone(),
                album: t.album.clone(),
                secs: t.secs,
                at,
            };
            let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
            {
                let (lib, scr) = (lib.clone(), scr_tx.clone());
                app.listen_any("track-started", move |e| {
                    if let Some(t) = serde_json::from_str::<i64>(e.payload()).ok().and_then(|id| lib.get(id)) {
                        let _ = scr.send(scrobble::Msg::Now(listen(&t, now())));
                    }
                });
            }
            // Histórico: quanto ouviu de cada faixa e se pulou. É o que molda os mixes.
            app.listen_any("track-ended", move |e| {
                #[derive(Deserialize)]
                struct H {
                    id: i64,
                    secs: f64,
                    skipped: bool,
                }
                if let Ok(h) = serde_json::from_str::<H>(e.payload()) {
                    let _ = lib.record_play(h.id, h.secs, h.skipped);
                    if let Some(t) = lib.get(h.id) {
                        let l = listen(&t, now() - h.secs as i64);
                        if l.counts(h.secs) {
                            let _ = scr_tx.send(scrobble::Msg::Done(l));
                        }
                    }
                }
            });
            start_scan(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            get_settings,
            set_folders,
            rescan,
            set_translate,
            set_discord,
            get_genres,
            set_genre,
            set_auto,
            write_pending_genres,
            is_scanning,
            log_auto,
            restore,
            artist_top,
            likes,
            set_like,
            plays,
            play_log,
            save_file,
            playlists,
            playlist_create,
            playlist_rename,
            playlist_delete,
            playlist_set,
            play,
            toggle,
            next,
            prev,
            seek,
            set_shuffle,
            set_repeat,
            enqueue,
            play_next,
            jump_to,
            remove_at,
            set_volume,
            set_crossfade,
            set_exclusive,
            set_speed,
            set_pitch,
            lyrics,
            save_tags,
            undo_tags,
            has_undo,
            check_update,
            install_update,
            set_replaygain,
            list_devices,
            set_device,
            export_playlist,
            import_playlist,
            listenbrainz_connect,
            lastfm_available,
            lastfm_begin,
            lastfm_finish,
            scrobble_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("erro ao abrir o Toxify");
}
