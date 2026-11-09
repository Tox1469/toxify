//! Editor de tag. Nunca escreve direto no arquivo original:
//! copia → grava a tag na cópia → confere se a cópia ainda toca → troca pela original.
//! Cada mudança vai pra um histórico (tag-history.jsonl), e dá pra desfazer o último lote.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use lofty::config::WriteOptions;
use lofty::prelude::*;
use lofty::tag::Tag;
use serde::{Deserialize, Serialize};

use crate::library::Library;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Change {
    pub id: i64,
    pub field: String,
    pub value: String,
}

#[derive(Serialize, Deserialize)]
struct LogEntry {
    batch: u64,
    path: String,
    field: String,
    old: String,
    new: String,
}

fn key_of(field: &str) -> Result<ItemKey> {
    Ok(match field {
        "title" => ItemKey::TrackTitle,
        "artist" => ItemKey::TrackArtist,
        "album" => ItemKey::AlbumTitle,
        "album_artist" => ItemKey::AlbumArtist,
        "year" => ItemKey::RecordingDate,
        "track" => ItemKey::TrackNumber,
        "disc" => ItemKey::DiscNumber,
        "genre" => ItemKey::Genre,
        _ => return Err(anyhow!("campo desconhecido: {field}")),
    })
}

/// Grava `fields` no arquivo. Devolve (campo, valor antigo, valor novo).
fn write_file(path: &Path, fields: &[(String, String)]) -> Result<Vec<(String, String, String)>> {
    // A cópia mantém a extensão real no fim ("x.toxify-tmp.flac"): o lofty descobre o formato por ela.
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    let tmp = path.with_extension(format!("toxify-tmp.{ext}"));
    fs::copy(path, &tmp).with_context(|| format!("copiando {}", path.display()))?;
    let res = (|| -> Result<Vec<(String, String, String)>> {
        // A cópia termina em ".toxify-tmp": o formato tem que vir do conteúdo, não da extensão.
        let mut tf = lofty::probe::Probe::open(&tmp)?.guess_file_type()?.read()?;
        if tf.primary_tag().is_none() {
            tf.insert_tag(Tag::new(tf.primary_tag_type()));
        }
        let tag = tf.primary_tag_mut().ok_or_else(|| anyhow!("arquivo sem tag"))?;
        let mut done = Vec::new();
        for (field, value) in fields {
            let key = key_of(field)?;
            let mut old = tag.get_strings(key).collect::<Vec<_>>().join(", ");
            if field == "year" && old.is_empty() {
                old = tag.get_string(ItemKey::Year).unwrap_or_default().to_string();
            }
            tag.remove_key(key);
            if field == "year" {
                tag.remove_key(ItemKey::Year);
            }
            let v = value.trim();
            if !v.is_empty() {
                tag.insert_text(key, v.to_string());
            }
            done.push((field.clone(), old, v.to_string()));
        }
        tag.save_to_path(&tmp, WriteOptions::default())?;
        crate::source::verify(&tmp).context("a cópia editada não tocou, original mantido")?;
        Ok(done)
    })();
    match res {
        Ok(done) => {
            fs::rename(&tmp, path).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                anyhow!("não deu pra substituir o arquivo (está tocando ou aberto em outro programa?): {e}")
            })?;
            Ok(done)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Aplica as mudanças. Devolve a lista de erros (vazia = deu tudo certo).
pub fn apply(lib: &Library, log: &Path, changes: &[Change], mut progress: impl FnMut(usize, usize)) -> Result<Vec<String>> {
    let mut by_id: BTreeMap<i64, Vec<(String, String)>> = BTreeMap::new();
    for c in changes {
        by_id.entry(c.id).or_default().push((c.field.clone(), c.value.clone()));
    }
    let batch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
    let mut errors = Vec::new();
    let mut logf = fs::OpenOptions::new().create(true).append(true).open(log)?;
    let total = by_id.len();
    for (i, (id, fields)) in by_id.into_iter().enumerate() {
        progress(i, total);
        let Some((path, _)) = lib.path_of(id) else { continue };
        let p = PathBuf::from(&path);
        match write_file(&p, &fields) {
            Ok(done) => {
                for (field, old, new) in done {
                    let e = LogEntry { batch, path: path.clone(), field, old, new };
                    writeln!(logf, "{}", serde_json::to_string(&e)?)?;
                }
                let _ = lib.rescan_files(&[p]);
            }
            Err(e) => errors.push(format!("{}: {e:#}", p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())),
        }
    }
    progress(total, total);
    Ok(errors)
}

/// Desfaz o último lote. Devolve quantos arquivos voltaram.
pub fn undo(lib: &Library, log: &Path) -> Result<usize> {
    let text = fs::read_to_string(log).unwrap_or_default();
    let entries: Vec<LogEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let Some(last) = entries.iter().map(|e| e.batch).max() else { return Ok(0) };
    let mut by_path: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for e in entries.iter().filter(|e| e.batch == last) {
        by_path.entry(e.path.clone()).or_default().push((e.field.clone(), e.old.clone()));
    }
    let mut n = 0;
    for (path, fields) in &by_path {
        let p = PathBuf::from(path);
        write_file(&p, fields)?;
        let _ = lib.rescan_files(&[p]);
        n += 1;
    }
    let rest: Vec<String> = text
        .lines()
        .filter(|l| serde_json::from_str::<LogEntry>(l).map(|e| e.batch != last).unwrap_or(true))
        .map(String::from)
        .collect();
    fs::write(log, rest.join("\n") + if rest.is_empty() { "" } else { "\n" })?;
    Ok(n)
}

pub fn has_undo(log: &Path) -> bool {
    fs::read_to_string(log).map(|t| t.lines().any(|l| !l.trim().is_empty())).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio_md5(p: &Path) -> Vec<u8> {
        std::process::Command::new("ffmpeg")
            .args(["-v", "quiet", "-i"])
            .arg(p)
            .args(["-map", "0:a", "-f", "md5", "-"])
            .output()
            .unwrap()
            .stdout
    }

    /// Grava tag numa CÓPIA de um arquivo real e confere: tag mudou, áudio idêntico.
    /// TOXIFY_TEST_TAG="a.flac;b.mp3" cargo test --release --lib grava_tag -- --nocapture
    #[test]
    fn grava_tag() {
        let Ok(list) = std::env::var("TOXIFY_TEST_TAG") else {
            eprintln!("pulando: defina TOXIFY_TEST_TAG");
            return;
        };
        let dir = std::env::temp_dir().join("toxify-tag-test");
        fs::create_dir_all(&dir).unwrap();
        for src in list.split(';').filter(|s| !s.is_empty()) {
            let src = Path::new(src);
            let dst = dir.join(src.file_name().unwrap());
            fs::copy(src, &dst).unwrap();
            let before = audio_md5(&dst);
            let done = write_file(&dst, &[("album_artist".into(), "Teste Toxify".into()), ("year".into(), "1999".into())]).unwrap();
            let tf = lofty::read_from_path(&dst).unwrap();
            let tag = tf.primary_tag().unwrap();
            assert_eq!(tag.get_string(ItemKey::AlbumArtist), Some("Teste Toxify"), "{}", src.display());
            assert_eq!(before, audio_md5(&dst), "áudio mudou em {}", src.display());
            assert!(!dst.with_extension(format!("toxify-tmp.{}", dst.extension().unwrap().to_str().unwrap())).exists(), "sobrou temporário");
            eprintln!("ok: {} (antes: {:?})", src.display(), done);
            fs::remove_file(&dst).unwrap();
        }
    }
}
