//! Playlists em M3U/M3U8: exportar pra levar pra outro player e importar as de lá
//! (foobar2000, MusicBee, AIMP, VLC...).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::library::Track;

/// Texto .m3u8 (UTF-8) com o caminho completo de cada faixa.
pub fn write(tracks: &[Track]) -> String {
    let mut s = String::from("#EXTM3U\n");
    for t in tracks {
        let artist = if t.artist.is_empty() { &t.album_artist } else { &t.artist };
        s += &format!("#EXTINF:{},{} - {}\n{}\n", t.secs.round() as i64, artist, t.title, t.path);
    }
    s
}

/// Caminhos de uma .m3u/.m3u8, resolvidos em relação à pasta da playlist.
pub fn read(file: &Path) -> std::io::Result<Vec<PathBuf>> {
    let bytes = std::fs::read(file)?;
    // .m3u antiga costuma vir em Windows-1252: sem UTF-8 válido, lê como Latin-1 (os acentos batem).
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    };
    let base = file.parent().unwrap_or(Path::new(""));
    Ok(text
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let l = l.strip_prefix("file:///").map(percent_decode).unwrap_or_else(|| l.to_string());
            let p = PathBuf::from(l.replace('/', "\\"));
            if p.is_absolute() { p } else { base.join(p) }
        })
        .collect())
}

/// "Meu%20Disco" → "Meu Disco" (playlists que gravam o caminho como URL file:///).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
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

/// Últimos `n` pedaços do caminho, sem diferenciar maiúscula: "artista\álbum\faixa.flac".
fn tail(p: &str, n: usize) -> String {
    let parts: Vec<&str> = p.split(['\\', '/']).filter(|x| !x.is_empty()).collect();
    parts[parts.len().saturating_sub(n)..].join("\\").to_lowercase()
}

/// Acha cada caminho na biblioteca. Primeiro o caminho igual; senão pelo fim dele (artista\álbum\arquivo,
/// depois álbum\arquivo), que sobrevive a outra letra de unidade ou outra pasta raiz.
/// Devolve os ids na ordem da playlist e quantos não foram achados.
pub fn match_tracks(paths: &[PathBuf], lib: &[Track]) -> (Vec<i64>, usize) {
    let by = |n: usize| -> HashMap<String, i64> { lib.iter().map(|t| (tail(&t.path, n), t.id)).collect() };
    let (full, t3, t2) = (by(usize::MAX), by(3), by(2));
    let mut ids = Vec::new();
    let mut missing = 0;
    for p in paths {
        let s = p.to_string_lossy();
        match full.get(&tail(&s, usize::MAX)).or_else(|| t3.get(&tail(&s, 3))).or_else(|| t2.get(&tail(&s, 2))) {
            Some(&id) => ids.push(id),
            None => missing += 1,
        }
    }
    (ids, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(id: i64, path: &str) -> Track {
        Track { id, path: path.into(), title: "T".into(), artist: "A".into(), secs: 61.4, ..Default::default() }
    }

    #[test]
    fn acha_por_caminho_e_pelo_fim() {
        let lib = [tr(1, r"D:\Music\Sade\Diamond Life\01 Smooth.flac"), tr(2, r"D:\Music\Joji\Ballads 1\02 Slow.flac")];
        let paths = [
            PathBuf::from(r"d:\music\sade\diamond life\01 smooth.flac"),
            PathBuf::from(r"E:\Outra\Joji\Ballads 1\02 Slow.flac"),
            PathBuf::from(r"C:\x\nao existe.flac"),
        ];
        assert_eq!(match_tracks(&paths, &lib), (vec![1, 2], 1));
        assert_eq!(percent_decode("Meu%20Disco/%C3%A1.flac"), "Meu Disco/á.flac");
        assert!(write(&lib[..1]).contains("#EXTINF:61,A - T\nD:\\Music\\Sade"));
    }
}
