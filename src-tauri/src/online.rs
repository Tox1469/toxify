//! O que vem da internet: letra (LRCLIB), tradução (Google Tradutor, sem chave) e foto de artista
//! (Deezer). Tudo fica em cache no disco; sem internet, o player continua funcionando normal.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

use lofty::prelude::*;
use serde::{Deserialize, Serialize};

use crate::library::{norm, Track};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Line {
    /// Segundos. Negativo = letra sem tempo.
    pub t: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Lyrics {
    pub synced: bool,
    pub lines: Vec<Line>,
    pub source: String,
    /// Idioma detectado da letra e as linhas traduzidas pra português (mesma ordem).
    pub lang: Option<String>,
    pub translation: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ArtistInfo {
    pub key: String,
    pub name: String,
    pub albums: Vec<String>,
    pub tags: Vec<String>,
}

pub struct Online {
    http: reqwest::Client,
    cache: PathBuf,
}

pub fn hash(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// "Joji feat. Clams Casino" → "Joji".
pub fn primary_artist(a: &str) -> String {
    let low = a.to_lowercase();
    let cut = [";", " feat. ", " feat ", " ft. ", " ft ", " featuring ", " (feat", " part. "]
        .iter()
        .filter_map(|s| low.find(s))
        .min()
        .unwrap_or(a.len());
    a.get(..cut).unwrap_or(a).trim().to_string()
}

pub fn parse_lrc(text: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            if let Some(t) = parse_time(tag) {
                times.push(t);
            }
            rest = &stripped[end + 1..];
        }
        for t in times {
            out.push(Line { t, text: rest.trim().to_string() });
        }
    }
    out.sort_by(|a, b| a.t.total_cmp(&b.t));
    out
}

fn parse_time(tag: &str) -> Option<f64> {
    let (m, s) = tag.split_once(':')?;
    let m: f64 = m.trim().parse().ok()?;
    let s: f64 = s.trim().replace(',', ".").parse().ok()?;
    Some(m * 60.0 + s)
}

fn to_lyrics(text: &str, source: &str) -> Option<Lyrics> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let synced = parse_lrc(text);
    if synced.len() >= 3 {
        return Some(Lyrics { synced: true, lines: synced, source: source.into(), ..Default::default() });
    }
    let lines = text.lines().map(|l| Line { t: -1.0, text: l.trim().to_string() }).collect();
    Some(Lyrics { synced: false, lines, source: source.into(), ..Default::default() })
}

#[derive(Deserialize)]
struct LrcLib {
    #[serde(rename = "syncedLyrics")]
    synced: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
}

#[derive(Deserialize)]
struct DeezerArtists {
    data: Vec<DeezerArtist>,
}

#[derive(Deserialize)]
struct DeezerArtist {
    name: String,
    picture_xl: Option<String>,
}

impl Online {
    pub fn new(cache: PathBuf) -> Online {
        let http = reqwest::Client::builder()
            .user_agent("Toxify/0.1 (player de musica pessoal)")
            .timeout(Duration::from_secs(12))
            .build()
            .expect("cliente http");
        Online { http, cache }
    }

    fn file(&self, dir: &str, name: &str) -> PathBuf {
        let d = self.cache.join(dir);
        let _ = std::fs::create_dir_all(&d);
        d.join(name)
    }

    // ------------------------------------------------ foto de artista

    pub async fn artist_image(&self, name: &str) -> Option<PathBuf> {
        let h = hash(&norm(name));
        let img = self.file("artists", &format!("{h}.jpg"));
        let none = self.file("artists", &format!("{h}.none"));
        if img.exists() {
            return Some(img);
        }
        if none.exists() {
            return None;
        }
        let res: DeezerArtists = self
            .http
            .get("https://api.deezer.com/search/artist")
            .query(&[("q", name), ("limit", "10")])
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let want = norm(name);
        let pick = res.data.iter().find(|a| norm(&a.name) == want).or(res.data.first());
        // Deezer devolve um boneco cinza quando não tem foto: a URL vem com "/artist//".
        let url = pick.and_then(|a| a.picture_xl.clone()).filter(|u| !u.is_empty() && !u.contains("/artist//"));
        let Some(url) = url else {
            let _ = std::fs::write(&none, b"");
            return None;
        };
        let bytes = self.http.get(&url).send().await.ok()?.bytes().await.ok()?;
        std::fs::write(&img, &bytes).ok()?;
        Some(img)
    }

    // ------------------------------------------------ populares (o que o mundo mais ouve do artista)

    /// Títulos das músicas mais ouvidas do artista no Deezer, da mais pra menos popular.
    /// Fica guardado por uma semana.
    pub async fn artist_top(&self, name: &str) -> Vec<String> {
        #[derive(Deserialize)]
        struct Search {
            data: Vec<A>,
        }
        #[derive(Deserialize)]
        struct A {
            id: u64,
            name: String,
        }
        #[derive(Deserialize)]
        struct Top {
            data: Vec<T>,
        }
        #[derive(Deserialize)]
        struct T {
            title: String,
        }
        let f = self.file("top", &format!("{}.json", hash(&norm(name))));
        let fresh = std::fs::metadata(&f).and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age < Duration::from_secs(7 * 86400));
        let cached: Option<Vec<String>> = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str(&s).ok());
        if fresh {
            if let Some(c) = cached {
                return c;
            }
        }
        let got: Option<Vec<String>> = async {
            let s: Search = self.http.get("https://api.deezer.com/search/artist").query(&[("q", name), ("limit", "5")]).send().await.ok()?.json().await.ok()?;
            let want = norm(name);
            let a = s.data.iter().find(|a| norm(&a.name) == want).or(s.data.first())?;
            let top: Top = self.http.get(format!("https://api.deezer.com/artist/{}/top", a.id)).query(&[("limit", "50")]).send().await.ok()?.json().await.ok()?;
            Some(top.data.into_iter().map(|t| t.title).collect())
        }
        .await;
        match got {
            Some(list) => {
                let _ = std::fs::write(&f, serde_json::to_string(&list).unwrap_or_default());
                list
            }
            None => cached.unwrap_or_default(), // sem internet: usa o que tinha
        }
    }

    pub async fn download(&self, url: &str) -> Option<Vec<u8>> {
        let r = self.http.get(url).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        Some(r.bytes().await.ok()?.to_vec())
    }

    // ------------------------------------------------ capa por link (Discord só aceita imagem da internet)

    pub async fn album_cover_url(&self, artist: &str, album: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct R {
            data: Vec<A>,
        }
        #[derive(Deserialize)]
        struct A {
            cover_xl: Option<String>,
            artist: Ar,
        }
        #[derive(Deserialize)]
        struct Ar {
            name: String,
        }
        let artist = primary_artist(artist);
        let f = self.file("albums", &format!("{}.txt", hash(&format!("{}|{}", norm(&artist), norm(album)))));
        if let Ok(s) = std::fs::read_to_string(&f) {
            return (!s.is_empty()).then_some(s);
        }
        let mut url = String::new();
        // Primeiro a busca exata; se não achar, a solta (nome de álbum com "(Deluxe)" e afins).
        for q in [format!("artist:\"{artist}\" album:\"{album}\""), format!("{artist} {album}")] {
            let r: Option<R> = async { self.http.get("https://api.deezer.com/search/album").query(&[("q", q.as_str()), ("limit", "5")]).send().await.ok()?.json().await.ok() }.await;
            let Some(r) = r else { return None }; // sem internet: tenta de novo outra hora
            let pick = r.data.iter().find(|a| norm(&a.artist.name) == norm(&artist)).or(r.data.first());
            if let Some(u) = pick.and_then(|a| a.cover_xl.clone()) {
                url = u;
                break;
            }
        }
        let _ = std::fs::write(&f, &url);
        (!url.is_empty()).then_some(url)
    }

    // ------------------------------------------------ letra

    fn lyrics_cache(&self, t: &Track) -> PathBuf {
        self.file("lyrics", &format!("{}.json", hash(&t.path)))
    }

    pub fn save_lyrics(&self, t: &Track, l: &Lyrics) {
        if let Ok(s) = serde_json::to_string(l) {
            let _ = std::fs::write(self.lyrics_cache(t), s);
        }
    }

    pub async fn lyrics(&self, t: &Track) -> Option<Lyrics> {
        // 1. .lrc do lado do arquivo
        let lrc = Path::new(&t.path).with_extension("lrc");
        if let Ok(s) = std::fs::read_to_string(&lrc) {
            if let Some(l) = to_lyrics(&s, "arquivo .lrc") {
                return Some(self.with_cached_translation(t, l));
            }
        }
        // 2. letra embutida na tag
        if let Ok(tf) = lofty::read_from_path(&t.path) {
            for tag in tf.tags() {
                for k in [ItemKey::Lyrics, ItemKey::UnsyncLyrics] {
                    if let Some(s) = tag.get_string(k) {
                        if let Some(l) = to_lyrics(s, "arquivo") {
                            return Some(self.with_cached_translation(t, l));
                        }
                    }
                }
            }
        }
        // 3. cache
        if let Some(l) = std::fs::read_to_string(self.lyrics_cache(t)).ok().and_then(|s| serde_json::from_str::<Lyrics>(&s).ok()) {
            return Some(l);
        }
        // 4. LRCLIB
        let artist = primary_artist(if t.artist.is_empty() { &t.album_artist } else { &t.artist });
        let dur = (t.secs.round() as i64).to_string();
        let got: Option<LrcLib> = async {
            let r = self
                .http
                .get("https://lrclib.net/api/get")
                .query(&[("artist_name", artist.as_str()), ("track_name", t.title.as_str()), ("album_name", t.album.as_str()), ("duration", dur.as_str())])
                .send()
                .await
                .ok()?;
            if r.status().is_success() { r.json().await.ok() } else { None }
        }
        .await;
        let got = match got {
            Some(g) => Some(g),
            None => {
                let list: Vec<LrcLib> = self
                    .http
                    .get("https://lrclib.net/api/search")
                    .query(&[("artist_name", artist.as_str()), ("track_name", t.title.as_str())])
                    .send()
                    .await
                    .ok()?
                    .json()
                    .await
                    .ok()?;
                let close = |g: &LrcLib| g.duration.is_none_or(|d| (d - t.secs).abs() < 4.0);
                let mut it = list.into_iter().filter(close).collect::<Vec<_>>();
                it.sort_by_key(|g| g.synced.is_none());
                it.into_iter().next()
            }
        }?;
        if got.instrumental == Some(true) {
            let l = Lyrics { synced: false, lines: vec![], source: "instrumental".into(), ..Default::default() };
            self.save_lyrics(t, &l);
            return Some(l);
        }
        let text = got.synced.filter(|s| !s.trim().is_empty()).or(got.plain)?;
        let l = to_lyrics(&text, "LRCLIB")?;
        self.save_lyrics(t, &l);
        Some(l)
    }

    fn with_cached_translation(&self, t: &Track, mut l: Lyrics) -> Lyrics {
        if let Some(c) = std::fs::read_to_string(self.lyrics_cache(t)).ok().and_then(|s| serde_json::from_str::<Lyrics>(&s).ok()) {
            if c.lines.len() == l.lines.len() {
                l.lang = c.lang;
                l.translation = c.translation;
            }
        }
        l
    }

    // ------------------------------------------------ tradução

    /// Traduz as linhas pra português. Devolve (idioma detectado, linhas traduzidas).
    pub async fn translate(&self, lines: &[String]) -> Option<(String, Vec<String>)> {
        let text = lines.join("\n");
        if text.trim().is_empty() {
            return None;
        }
        let v: serde_json::Value = self
            .http
            .post("https://translate.googleapis.com/translate_a/single")
            .query(&[("client", "gtx"), ("sl", "auto"), ("tl", "pt"), ("dt", "t")])
            .form(&[("q", text.as_str())])
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let lang = v.get(2).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let joined: String = v.get(0)?.as_array()?.iter().filter_map(|seg| seg.get(0)?.as_str()).collect();
        let mut out: Vec<String> = joined.split('\n').map(|s| s.trim().to_string()).collect();
        out.resize(lines.len(), String::new());
        // Linha vazia no original continua vazia (o tradutor às vezes come ou junta).
        for (o, i) in out.iter_mut().zip(lines) {
            if i.trim().is_empty() {
                o.clear();
            }
        }
        Some((lang, out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_e_artista() {
        let l = parse_lrc("[ar:Fulano]\n[00:27.67]Let it happen\n[00:12.00][01:00.50]Refrão\n");
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].text, "Refrão");
        assert!((l[0].t - 12.0).abs() < 1e-9);
        assert!((l[2].t - 60.5).abs() < 1e-9);
        assert_eq!(primary_artist("Joji feat. Clams Casino"), "Joji");
        assert_eq!(primary_artist("Sade Ft Jay-Z"), "Sade");
        assert_eq!(primary_artist("Tyler, The Creator"), "Tyler, The Creator");
    }
}
