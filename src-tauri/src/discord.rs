//! "Ouvindo Toxify" no perfil do Discord, com música, artista, capa e barrinha de tempo.
//! Precisa do ID de um aplicativo criado em discord.com/developers (o nome dele é o que aparece).

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};

use crate::online::Online;

#[derive(Clone)]
pub struct Now {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Milissegundos (relógio do PC) de quando a música "começou" e de quando acaba.
    pub start_ms: i64,
    pub end_ms: i64,
}

pub enum Msg {
    Playing(Now),
    Paused,
    /// Liga/desliga e troca o ID do aplicativo.
    Config { on: bool, app_id: String },
}

pub fn spawn(rx: Receiver<Msg>, online: Arc<Online>, on: bool, app_id: String) {
    std::thread::Builder::new()
        .name("discord".into())
        .spawn(move || run(rx, online, on, app_id))
        .expect("thread do discord");
}

/// O Discord recusa texto com menos de 2 letras.
fn fit(s: &str) -> String {
    let s: String = s.chars().take(120).collect();
    if s.chars().count() < 2 { format!("{s}  ") } else { s }
}

fn run(rx: Receiver<Msg>, online: Arc<Online>, mut on: bool, mut app_id: String) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut now: Option<Now> = None;
    let mut cover: Option<(String, Option<String>)> = None; // (álbum, link da capa)
    let mut dirty = true;
    loop {
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Msg::Playing(n)) => {
                now = Some(n);
                dirty = true;
            }
            Ok(Msg::Paused) => {
                now = None;
                dirty = true;
            }
            Ok(Msg::Config { on: o, app_id: id }) => {
                if id != app_id || !o {
                    if let Some(mut c) = client.take() {
                        let _ = c.clear_activity();
                        let _ = c.close();
                    }
                }
                on = o;
                app_id = id;
                dirty = true;
            }
            Err(RecvTimeoutError::Timeout) => {} // tenta reconectar se o Discord abriu depois
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if !on || app_id.trim().is_empty() {
            continue;
        }
        if client.is_none() {
            let mut c = DiscordIpcClient::new(app_id.trim());
            if c.connect().is_err() {
                continue; // Discord fechado: tenta de novo daqui a pouco
            }
            client = Some(c);
            dirty = true;
        }
        if !dirty {
            continue;
        }
        let c = client.as_mut().unwrap();
        let res = match &now {
            None => c.clear_activity(),
            Some(n) => {
                let key = format!("{}|{}", n.artist, n.album);
                if cover.as_ref().map(|(k, _)| k != &key).unwrap_or(true) {
                    let url = tauri::async_runtime::block_on(online.album_cover_url(&n.artist, &n.album));
                    cover = Some((key, url));
                }
                let (title, artist, album) = (fit(&n.title), fit(&n.artist), fit(&n.album));
                let mut assets = Assets::new().large_text(album.as_str());
                if let Some((_, Some(url))) = &cover {
                    assets = assets.large_image(url.as_str());
                }
                let act = Activity::new()
                    .activity_type(ActivityType::Listening)
                    .details(title.as_str())
                    .state(artist.as_str())
                    .assets(assets)
                    .timestamps(Timestamps::new().start(n.start_ms).end(n.end_ms));
                c.set_activity(act)
            }
        };
        if res.is_err() {
            client = None; // Discord fechou: reconecta na próxima
        } else {
            dirty = false;
        }
    }
}
