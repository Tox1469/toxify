//! Scrobbling: manda o que você ouviu pro ListenBrainz e pro Last.fm. Conta como ouvida a música
//! com mais de 30 s tocada até a metade ou por 4 min (a regra do Last.fm). Sem internet, guarda numa
//! fila (scrobbles.json) e manda depois.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Chave do aplicativo Toxify no Last.fm. Vem do build (segredo do GitHub), não fica no código.
/// Segredo ausente no GitHub vira variável vazia no build: conta como "sem Last.fm".
pub const LASTFM_KEY: Option<&str> = filled(option_env!("TOXIFY_LASTFM_KEY"));
const LASTFM_SECRET: Option<&str> = filled(option_env!("TOXIFY_LASTFM_SECRET"));

const fn filled(v: Option<&'static str>) -> Option<&'static str> {
    match v {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}
const LASTFM_API: &str = "https://ws.audioscrobbler.com/2.0/";
const LB_API: &str = "https://api.listenbrainz.org/1";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Accounts {
    #[serde(default)]
    pub lb_token: String,
    #[serde(default)]
    pub lb_user: String,
    #[serde(default)]
    pub lastfm: Option<LastFm>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LastFm {
    pub user: String,
    pub key: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Listen {
    pub artist: String,
    pub title: String,
    pub album: String,
    pub secs: f64,
    /// Quando começou a tocar (segundos Unix).
    pub at: i64,
}

impl Listen {
    /// A regra do Last.fm (o ListenBrainz recomenda a mesma).
    pub fn counts(&self, heard: f64) -> bool {
        self.secs > 30.0 && heard >= (self.secs / 2.0).min(240.0)
    }
}

pub enum Msg {
    Now(Listen),
    Done(Listen),
    Accounts(Accounts),
}

#[derive(Serialize, Deserialize, Default)]
struct Queue {
    lb: Vec<Listen>,
    lastfm: Vec<Listen>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Toxify/", env!("CARGO_PKG_VERSION"), " (github.com/Tox1469/toxify)"))
        .timeout(Duration::from_secs(15))
        .build()
        .expect("cliente http")
}

pub fn spawn(rx: Receiver<Msg>, accounts: Accounts, queue_path: PathBuf) {
    std::thread::Builder::new()
        .name("scrobble".into())
        .spawn(move || run(rx, accounts, queue_path))
        .expect("thread do scrobble");
}

fn run(rx: Receiver<Msg>, mut acc: Accounts, path: PathBuf) {
    let http = client();
    let mut q: Queue = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    fn block<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }
    loop {
        match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(Msg::Accounts(a)) => acc = a,
            Ok(Msg::Now(l)) => {
                if !acc.lb_token.is_empty() {
                    let _ = block(lb_submit(&http, &acc.lb_token, "playing_now", std::slice::from_ref(&l)));
                }
                if let Some(f) = &acc.lastfm {
                    let _ = block(lastfm_track(f, "track.updateNowPlaying", &l));
                }
                continue;
            }
            Ok(Msg::Done(l)) => {
                if !acc.lb_token.is_empty() {
                    q.lb.push(l.clone());
                }
                if acc.lastfm.is_some() {
                    q.lastfm.push(l);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if q.lb.is_empty() && q.lastfm.is_empty() {
            continue;
        }
        // Manda o que deu; o que falhou (sem internet) fica pra próxima.
        if !acc.lb_token.is_empty() && !q.lb.is_empty() && block(lb_submit(&http, &acc.lb_token, "import", &q.lb)).is_ok() {
            q.lb.clear();
        }
        if let Some(f) = &acc.lastfm {
            while let Some(l) = q.lastfm.first() {
                if block(lastfm_track(f, "track.scrobble", l)).is_err() {
                    break;
                }
                q.lastfm.remove(0);
            }
        }
        // Conta desconectada ou sem internet por semanas: não deixa a fila crescer sem fim.
        for v in [&mut q.lb, &mut q.lastfm] {
            if v.len() > 1000 {
                v.drain(..v.len() - 1000);
            }
        }
        if let Ok(s) = serde_json::to_string(&q) {
            let _ = std::fs::write(&path, s);
        }
    }
}

// ---------------------------------------------------------------- ListenBrainz

/// Confere o token e devolve o nome do usuário.
pub async fn lb_validate(token: &str) -> Result<String> {
    let v: Value = client().get(format!("{LB_API}/validate-token")).header("Authorization", format!("Token {token}")).send().await?.json().await?;
    match (v["valid"].as_bool(), v["user_name"].as_str()) {
        (Some(true), Some(u)) => Ok(u.to_string()),
        _ => bail!("token inválido"),
    }
}

async fn lb_submit(http: &reqwest::Client, token: &str, kind: &str, ls: &[Listen]) -> Result<()> {
    let payload: Vec<Value> = ls
        .iter()
        .map(|l| {
            let mut p = json!({ "track_metadata": {
                "artist_name": l.artist,
                "track_name": l.title,
                "release_name": l.album,
                "additional_info": {
                    "duration_ms": (l.secs * 1000.0) as i64,
                    "media_player": "Toxify",
                    "submission_client": "Toxify",
                    "submission_client_version": env!("CARGO_PKG_VERSION"),
                },
            }});
            if kind != "playing_now" {
                p["listened_at"] = json!(l.at);
            }
            p
        })
        .collect();
    // "import" com uma só vira "single" (é o que a API pede).
    let kind = if kind == "import" && ls.len() == 1 { "single" } else { kind };
    for chunk in payload.chunks(100) {
        http.post(format!("{LB_API}/submit-listens"))
            .header("Authorization", format!("Token {token}"))
            .json(&json!({ "listen_type": kind, "payload": chunk }))
            .send()
            .await?
            .error_for_status()?;
    }
    Ok(())
}

// ---------------------------------------------------------------- Last.fm

/// Assinatura do Last.fm: md5 dos parâmetros em ordem (nome+valor) + o segredo.
fn sign(params: &mut Vec<(&str, String)>) -> Result<()> {
    let secret = LASTFM_SECRET.ok_or_else(|| anyhow!("este build não tem a chave do Last.fm"))?;
    params.sort_by(|a, b| a.0.cmp(&b.0));
    let mut s: String = params.iter().map(|(k, v)| format!("{k}{v}")).collect();
    s.push_str(secret);
    params.push(("api_sig", md5_hex(s.as_bytes())));
    params.push(("format", "json".into()));
    Ok(())
}

fn md5_hex(data: &[u8]) -> String {
    use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_MD5_ALG_HANDLE};
    let mut out = [0u8; 16];
    let _ = unsafe { BCryptHash(BCRYPT_MD5_ALG_HANDLE, None, data, &mut out) };
    out.iter().map(|b| format!("{b:02x}")).collect()
}

async fn lastfm_call(params: Vec<(&str, String)>, post: bool) -> Result<Value> {
    let key = LASTFM_KEY.ok_or_else(|| anyhow!("este build não tem a chave do Last.fm"))?;
    let mut params = params;
    params.push(("api_key", key.into()));
    sign(&mut params)?;
    let http = client();
    let req = if post { http.post(LASTFM_API).form(&params) } else { http.get(LASTFM_API).query(&params) };
    let v: Value = req.send().await?.json().await?;
    if let Some(e) = v.get("error") {
        // 14 = token ainda não autorizado no site.
        if e.as_i64() == Some(14) {
            bail!("o Last.fm ainda não recebeu sua autorização. Autorize na página que abriu no navegador e tente de novo");
        }
        bail!("Last.fm {e}: {}", v["message"].as_str().unwrap_or(""));
    }
    Ok(v)
}

/// Passo 1 do login: um token pra pessoa autorizar no site. Devolve (token, url).
pub async fn lastfm_begin() -> Result<(String, String)> {
    let v = lastfm_call(vec![("method", "auth.getToken".into())], false).await?;
    let token = v["token"].as_str().ok_or_else(|| anyhow!("Last.fm não mandou o token"))?.to_string();
    let url = format!("https://www.last.fm/api/auth/?api_key={}&token={token}", LASTFM_KEY.unwrap_or_default());
    Ok((token, url))
}

/// Passo 2: depois que a pessoa autorizou no site, troca o token pela sessão.
pub async fn lastfm_finish(token: &str) -> Result<LastFm> {
    let v = lastfm_call(vec![("method", "auth.getSession".into()), ("token", token.into())], false).await?;
    let s = &v["session"];
    match (s["name"].as_str(), s["key"].as_str()) {
        (Some(user), Some(key)) => Ok(LastFm { user: user.into(), key: key.into() }),
        _ => bail!("ainda não autorizado no site do Last.fm"),
    }
}

async fn lastfm_track(f: &LastFm, method: &str, l: &Listen) -> Result<()> {
    let mut p = vec![
        ("method", method.to_string()),
        ("sk", f.key.clone()),
        ("artist", l.artist.clone()),
        ("track", l.title.clone()),
        ("album", l.album.clone()),
        ("duration", (l.secs.round() as i64).to_string()),
    ];
    if method == "track.scrobble" {
        p.push(("timestamp", l.at.to_string()));
    }
    lastfm_call(p, true).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_e_regra() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        let l = Listen { artist: "A".into(), title: "T".into(), album: "B".into(), secs: 200.0, at: 0 };
        assert!(l.counts(100.0) && !l.counts(99.0));
        let long = Listen { secs: 1200.0, ..l.clone() };
        assert!(long.counts(240.0) && !long.counts(200.0));
        let short = Listen { secs: 25.0, ..l };
        assert!(!short.counts(25.0));
    }
}
