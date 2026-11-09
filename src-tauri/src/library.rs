//! Biblioteca: varre as pastas, lê as tags e guarda num SQLite local.
//! A tela recebe todas as faixas de uma vez e agrupa álbum/artista sozinha (são ~1000 faixas).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use anyhow::Result;
use lofty::file::FileType;
use lofty::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::engine::QTrack;

pub const AUDIO_EXT: [&str; 9] = ["flac", "mp3", "m4a", "ogg", "oga", "wav", "aiff", "aif", "alac"];

#[derive(Serialize, Clone, Debug, Default)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub album_key: String,
    pub track: u32,
    pub disc: u32,
    pub year: u32,
    pub genre: String,
    pub secs: f64,
    pub rate: u32,
    pub bits: u32,
    pub codec: String,
    pub cover: bool,
    pub added: i64,
}

pub struct Library {
    db: Mutex<Connection>,
}

/// Minúsculo, sem espaço sobrando. "Tyler, the Creator" e "Tyler, The Creator" viram a mesma chave.
pub fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// O álbum fica guardado no primeiro artista ("Kyan; MU540" → Kyan). A tela também mostra ele no MU540.
pub fn album_key(album_artist: &str, artist: &str, album: &str) -> String {
    let who = if album_artist.trim().is_empty() { artist } else { album_artist };
    let first = who.split(';').next().unwrap_or(who);
    format!("{}|{}", norm(first), norm(album))
}

/// Junta vários valores de artista com "; " sem repetir ("Kanye West" duas vezes vira uma).
/// Não quebra na vírgula, senão "Tyler, The Creator" vira dois artistas.
fn join_artists<'a>(values: impl Iterator<Item = &'a str>) -> String {
    let mut out: Vec<String> = Vec::new();
    for v in values.flat_map(|v| v.split(';')) {
        let v = v.trim();
        if !v.is_empty() && !out.iter().any(|o| norm(o) == norm(v)) {
            out.push(v.to_string());
        }
    }
    out.join("; ")
}

impl Library {
    pub fn open(path: &Path) -> Result<Library> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime INTEGER, size INTEGER,
                title TEXT, artist TEXT, album TEXT, album_artist TEXT, album_key TEXT,
                track INTEGER, disc INTEGER, year INTEGER, genre TEXT,
                secs REAL, rate INTEGER, bits INTEGER, codec TEXT, cover INTEGER, added INTEGER);
             CREATE TABLE IF NOT EXISTS likes (track_id INTEGER PRIMARY KEY, at INTEGER);
             CREATE TABLE IF NOT EXISTS plays (track_id INTEGER, at INTEGER);
             CREATE INDEX IF NOT EXISTS plays_at ON plays(at);
             CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created INTEGER);
             CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id INTEGER NOT NULL, pos INTEGER NOT NULL, track_id INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS pl_tracks ON playlist_tracks(playlist_id, pos);",
        )?;
        // Colunas novas em banco antigo. As audições de antes contam como ouvidas inteiras.
        let _ = db.execute("ALTER TABLE plays ADD COLUMN secs REAL DEFAULT 60", []);
        let _ = db.execute("ALTER TABLE plays ADD COLUMN skipped INTEGER DEFAULT 0", []);
        // Versão 2 mudou como os artistas são lidos: força reler tudo (os ids continuam, por causa do caminho).
        let ver: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if ver < 2 {
            db.execute("UPDATE tracks SET mtime = 0", [])?;
            db.execute_batch("PRAGMA user_version = 2")?;
        }
        Ok(Library { db: Mutex::new(db) })
    }

    /// Varre as pastas. Só relê arquivo novo ou alterado. Devolve (lidos, removidos).
    pub fn scan(&self, folders: &[String], mut progress: impl FnMut(usize, usize)) -> Result<(usize, usize)> {
        let known: HashMap<String, (i64, i64)> = {
            let db = self.db.lock().unwrap();
            let mut st = db.prepare("SELECT path, mtime, size FROM tracks")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut files = Vec::new();
        for f in folders {
            for e in walkdir::WalkDir::new(f).follow_links(true).into_iter().filter_map(|e| e.ok()) {
                let p = e.path();
                let ok = p.extension().and_then(|x| x.to_str()).is_some_and(|x| AUDIO_EXT.contains(&x.to_lowercase().as_str()))
                    && !p.to_string_lossy().contains(".toxify-tmp."); // cópia temporária do editor de tags
                if ok && e.file_type().is_file() {
                    files.push(p.to_path_buf());
                }
            }
        }
        let seen: HashSet<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let mut changed = Vec::new();
        for p in &files {
            let key = p.to_string_lossy().into_owned();
            let (mtime, size) = file_stamp(p);
            if known.get(&key) != Some(&(mtime, size)) {
                changed.push((p.clone(), mtime, size));
            }
        }
        let total = changed.len();
        for (i, (p, mtime, size)) in changed.iter().enumerate() {
            match read_track(p) {
                Ok(t) => self.upsert(&t, *mtime, *size)?,
                Err(e) => eprintln!("pulando {}: {e:#}", p.display()),
            }
            if i % 25 == 0 {
                progress(i, total);
            }
        }
        let gone: Vec<String> = known.keys().filter(|k| !seen.contains(*k)).cloned().collect();
        {
            let db = self.db.lock().unwrap();
            for g in &gone {
                db.execute("DELETE FROM tracks WHERE path = ?1", [g])?;
            }
        }
        progress(total, total);
        Ok((total, gone.len()))
    }

    /// Relê arquivos específicos (depois de editar tag).
    pub fn rescan_files(&self, paths: &[PathBuf]) -> Result<()> {
        for p in paths {
            let (mtime, size) = file_stamp(p);
            self.upsert(&read_track(p)?, mtime, size)?;
        }
        Ok(())
    }

    fn upsert(&self, t: &Track, mtime: i64, size: i64) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO tracks (path, mtime, size, title, artist, album, album_artist, album_key, track, disc, year, genre, secs, rate, bits, codec, cover, added)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17, strftime('%s','now'))
             ON CONFLICT(path) DO UPDATE SET mtime=?2, size=?3, title=?4, artist=?5, album=?6, album_artist=?7, album_key=?8,
               track=?9, disc=?10, year=?11, genre=?12, secs=?13, rate=?14, bits=?15, codec=?16, cover=?17",
            params![
                t.path, mtime, size, t.title, t.artist, t.album, t.album_artist, t.album_key, t.track, t.disc, t.year, t.genre,
                t.secs, t.rate, t.bits, t.codec, t.cover
            ],
        )?;
        Ok(())
    }

    pub fn all(&self) -> Result<Vec<Track>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(&format!("SELECT {COLS} FROM tracks ORDER BY album_key, disc, track, title"))?;
        let rows = st.query_map([], row_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get(&self, id: i64) -> Option<Track> {
        let db = self.db.lock().unwrap();
        db.query_row(&format!("SELECT {COLS} FROM tracks WHERE id = ?1"), [id], row_track).ok()
    }

    pub fn path_of(&self, id: i64) -> Option<(String, String)> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT path, album_key FROM tracks WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).ok()
    }

    pub fn qtracks(&self, ids: &[i64]) -> Vec<QTrack> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT path, album_key, disc, track, rate, secs FROM tracks WHERE id = ?1").unwrap();
        ids.iter()
            .filter_map(|&id| {
                st.query_row([id], |r| {
                    Ok(QTrack { id, path: r.get(0)?, album_key: r.get(1)?, disc: r.get(2)?, track: r.get(3)?, rate: r.get(4)?, secs: r.get(5)? })
                })
                .ok()
            })
            .collect()
    }

    pub fn likes(&self) -> Vec<i64> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT track_id FROM likes ORDER BY at DESC").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn set_like(&self, id: i64, on: bool) -> Result<()> {
        let db = self.db.lock().unwrap();
        if on {
            db.execute("INSERT OR REPLACE INTO likes (track_id, at) VALUES (?1, strftime('%s','now'))", [id])?;
        } else {
            db.execute("DELETE FROM likes WHERE track_id = ?1", [id])?;
        }
        Ok(())
    }

    pub fn record_play(&self, id: i64, secs: f64, skipped: bool) -> Result<()> {
        if secs < 1.0 {
            return Ok(()); // passou direto, nem conta
        }
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO plays (track_id, at, secs, skipped) VALUES (?1, strftime('%s','now'), ?2, ?3)",
            params![id, secs, skipped],
        )?;
        Ok(())
    }

    /// Por faixa: [id, audições (ouviu 30 s ou metade), pulos, última audição, audições nos últimos 30 dias].
    pub fn plays(&self) -> Vec<[i64; 5]> {
        let db = self.db.lock().unwrap();
        let mut st = db
            .prepare(
                "SELECT p.track_id,
                    SUM(p.secs >= MIN(30, t.secs * 0.5)),
                    SUM(p.skipped = 1),
                    COALESCE(MAX(CASE WHEN p.secs >= MIN(30, t.secs * 0.5) THEN p.at END), 0),
                    SUM(p.secs >= MIN(30, t.secs * 0.5) AND p.at > strftime('%s','now') - 30 * 86400)
                 FROM plays p JOIN tracks t ON t.id = p.track_id
                 GROUP BY p.track_id",
            )
            .unwrap();
        st.query_map([], |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?])).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Cada audição com `from <= at < to` (segundos unix): (faixa, quando, segundos ouvidos, pulou).
    /// É o que a Retrospectiva soma.
    pub fn play_log(&self, from: i64, to: i64) -> Vec<(i64, i64, f64, bool)> {
        let db = self.db.lock().unwrap();
        let mut st = db
            .prepare("SELECT track_id, at, COALESCE(secs, 0), COALESCE(skipped, 0) FROM plays WHERE at >= ?1 AND at < ?2 ORDER BY at")
            .unwrap();
        st.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    // ------------------------------------------------ playlists

    pub fn playlists(&self) -> Vec<Playlist> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT id, name, created FROM playlists ORDER BY created DESC").unwrap();
        let mut lists: Vec<Playlist> = st
            .query_map([], |r| Ok(Playlist { id: r.get(0)?, name: r.get(1)?, created: r.get(2)?, tracks: Vec::new() }))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        let mut st = db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY pos").unwrap();
        for p in &mut lists {
            p.tracks = st.query_map([p.id], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
        }
        lists
    }

    pub fn playlist_create(&self, name: &str, tracks: &[i64]) -> Result<i64> {
        let id = {
            let db = self.db.lock().unwrap();
            db.execute("INSERT INTO playlists (name, created) VALUES (?1, strftime('%s','now'))", [name.trim()])?;
            db.last_insert_rowid()
        };
        self.playlist_set(id, tracks)?;
        Ok(id)
    }

    pub fn playlist_rename(&self, id: i64, name: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("UPDATE playlists SET name = ?2 WHERE id = ?1", params![id, name.trim()])?;
        Ok(())
    }

    pub fn playlist_delete(&self, id: i64) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", [id])?;
        db.execute("DELETE FROM playlists WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Troca a lista inteira (serve pra tirar, reordenar e adicionar).
    pub fn playlist_set(&self, id: i64, tracks: &[i64]) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", [id])?;
        for (pos, t) in tracks.iter().enumerate() {
            tx.execute("INSERT INTO playlist_tracks (playlist_id, pos, track_id) VALUES (?1, ?2, ?3)", params![id, pos as i64, t])?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[derive(Serialize, Clone)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created: i64,
    pub tracks: Vec<i64>,
}

const COLS: &str = "id, path, title, artist, album, album_artist, album_key, track, disc, year, genre, secs, rate, bits, codec, cover, added";

fn row_track(r: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        id: r.get(0)?,
        path: r.get(1)?,
        title: r.get(2)?,
        artist: r.get(3)?,
        album: r.get(4)?,
        album_artist: r.get(5)?,
        album_key: r.get(6)?,
        track: r.get(7)?,
        disc: r.get(8)?,
        year: r.get(9)?,
        genre: r.get(10)?,
        secs: r.get(11)?,
        rate: r.get(12)?,
        bits: r.get(13)?,
        codec: r.get(14)?,
        cover: r.get(15)?,
        added: r.get(16)?,
    })
}

fn file_stamp(p: &Path) -> (i64, i64) {
    std::fs::metadata(p)
        .map(|m| {
            let mt = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
            (mt, m.len() as i64)
        })
        .unwrap_or((0, 0))
}

fn first_number(s: &str) -> u32 {
    s.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)
}

pub fn read_track(p: &Path) -> Result<Track> {
    let tf = lofty::read_from_path(p)?;
    let props = tf.properties();
    let tag = tf.primary_tag().or_else(|| tf.first_tag());
    let txt = |k: ItemKey| tag.and_then(|t| t.get_string(k)).map(|s| s.trim().to_string()).unwrap_or_default();
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let title = Some(txt(ItemKey::TrackTitle)).filter(|s| !s.is_empty()).unwrap_or(stem);
    let artist = tag.map(|t| join_artists(t.get_strings(ItemKey::TrackArtist))).unwrap_or_default();
    let album = txt(ItemKey::AlbumTitle);
    let album_artist = tag.map(|t| join_artists(t.get_strings(ItemKey::AlbumArtist))).unwrap_or_default();
    let year = tag.and_then(|t| t.date()).map(|d| d.year as u32).filter(|&y| y > 0).unwrap_or_else(|| {
        let y = first_number(&txt(ItemKey::RecordingDate));
        if y > 0 { y } else { first_number(&txt(ItemKey::Year)) }
    });
    let bits = props.bit_depth().unwrap_or(0) as u32;
    let codec = match tf.file_type() {
        FileType::Flac => "FLAC",
        FileType::Mpeg => "MP3",
        FileType::Mp4 => if bits > 0 { "ALAC" } else { "AAC" },
        FileType::Vorbis => "OGG",
        FileType::Opus => "OPUS",
        FileType::Wav => "WAV",
        FileType::Aiff => "AIFF",
        _ => "?",
    };
    let cover = tag.is_some_and(|t| !t.pictures().is_empty()) || folder_image(p).is_some();
    Ok(Track {
        id: 0,
        path: p.to_string_lossy().into_owned(),
        album_key: album_key(&album_artist, &artist, &album),
        title,
        artist,
        album,
        album_artist,
        track: tag.and_then(|t| t.track()).unwrap_or(0),
        disc: tag.and_then(|t| t.disk()).unwrap_or(0),
        year,
        genre: txt(ItemKey::Genre),
        secs: props.duration().as_secs_f64(),
        rate: props.sample_rate().unwrap_or(0),
        bits,
        codec: codec.into(),
        cover,
        added: 0,
    })
}

/// cover.jpg, folder.jpg, front.jpg... ou a primeira imagem da pasta.
pub fn folder_image(track: &Path) -> Option<PathBuf> {
    let dir = track.parent()?;
    let mut imgs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()).is_some_and(|x| matches!(x.to_lowercase().as_str(), "jpg" | "jpeg" | "png")))
        .collect();
    imgs.sort_by_key(|p| {
        let n = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        match n.as_str() {
            "cover" | "folder" | "front" => 0,
            _ if n.contains("cover") || n.contains("front") => 1,
            _ => 2,
        }
    });
    imgs.into_iter().next()
}

/// Bytes da capa: a embutida no arquivo, senão a imagem da pasta.
pub fn cover_bytes(track: &Path) -> Option<Vec<u8>> {
    if let Ok(tf) = lofty::read_from_path(track) {
        let pics: Vec<_> = tf.tags().iter().flat_map(|t| t.pictures().iter()).collect();
        let front = pics.iter().find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront).or(pics.first());
        if let Some(p) = front {
            return Some(p.data().to_vec());
        }
    }
    std::fs::read(folder_image(track)?).ok()
}
