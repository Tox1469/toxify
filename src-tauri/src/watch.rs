//! Vigia as pastas da biblioteca pelo próprio Windows (ReadDirectoryChangesW): música que entra, sai
//! ou muda dispara uma leitura nova, depois de 4 s sem mexer em nada (download ou cópia em andamento
//! espera terminar). A leitura é incremental, então disparar a mais não custa quase nada.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

use windows::core::HSTRING;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};

use crate::library::AUDIO_EXT;

pub struct Watcher {
    generation: Arc<AtomicU64>,
    tx: Sender<()>,
}

impl Watcher {
    /// `on_change` roda numa thread à parte, uma vez por leva de mudanças.
    pub fn new(on_change: impl Fn() + Send + 'static) -> Watcher {
        let (tx, rx) = channel::<()>();
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                loop {
                    match rx.recv_timeout(Duration::from_secs(4)) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                on_change();
            }
        });
        Watcher { generation: Arc::new(AtomicU64::new(0)), tx }
    }

    /// Passa a vigiar estas pastas. As threads das pastas de antes saem no próximo evento delas.
    // ponytail: pasta tirada da lista segura uma thread parada até mexerem nela; CancelSynchronousIo se incomodar.
    pub fn watch(&self, folders: &[String]) {
        let mine = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        for dir in folders {
            let (dir, generation, tx) = (dir.clone(), self.generation.clone(), self.tx.clone());
            let _ = std::thread::Builder::new().name("vigia-pasta".into()).spawn(move || {
                if let Err(e) = watch_dir(&dir, || generation.load(Ordering::SeqCst) == mine, &tx) {
                    eprintln!("[toxify] não deu pra vigiar {dir}: {e}");
                }
            });
        }
    }
}

fn watch_dir(dir: &str, alive: impl Fn() -> bool, tx: &Sender<()>) -> windows::core::Result<()> {
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE;
    // u32 pra ficar alinhado em 4 bytes, como o Windows exige.
    let mut buf = vec![0u32; 16 * 1024];
    unsafe {
        let h = CreateFileW(
            &HSTRING::from(dir),
            FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )?;
        loop {
            let mut got = 0u32;
            let r = ReadDirectoryChangesW(h, buf.as_mut_ptr() as _, (buf.len() * 4) as u32, true, filter, Some(&mut got as *mut u32), None, None);
            if r.is_err() || !alive() {
                let _ = CloseHandle(h);
                return r;
            }
            let bytes = std::slice::from_raw_parts(buf.as_ptr() as *const u8, got as usize);
            // got == 0: mudou tanta coisa que o Windows não coube no buffer; relê tudo.
            if got == 0 || names(bytes).iter().any(|n| relevant(n)) {
                let _ = tx.send(());
            }
        }
    }
}

/// Nomes (relativos à pasta) dentro de uma lista de FILE_NOTIFY_INFORMATION.
fn names(bytes: &[u8]) -> Vec<String> {
    let u32_at = |i: usize| bytes.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let mut out = Vec::new();
    let mut off = 0;
    while let (Some(next), Some(len)) = (u32_at(off), u32_at(off + 8)) {
        let name = bytes.get(off + 12..off + 12 + len).unwrap_or_default();
        let wide: Vec<u16> = name.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        out.push(String::from_utf16_lossy(&wide));
        if next == 0 {
            break;
        }
        off += next;
    }
    out
}

/// Arquivo de música ou pasta (sem extensão). Capa, .lrc e a cópia temporária do editor de tags não contam.
fn relevant(name: &str) -> bool {
    let n = name.to_lowercase();
    if n.contains(".toxify-tmp.") {
        return false;
    }
    let file = n.rsplit('\\').next().unwrap_or(&n);
    match file.rsplit_once('.') {
        Some((_, ext)) => AUDIO_EXT.contains(&ext),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filtra_e_le_os_nomes() {
        assert!(relevant(r"Sade\Diamond Life\01 Smooth.FLAC"));
        assert!(relevant(r"Nova Pasta"));
        assert!(!relevant(r"Sade\cover.jpg"));
        assert!(!relevant(r"Sade\01.toxify-tmp.flac"));
        // Dois registros: "a.flac" e "b".
        let mut b = Vec::new();
        for (next, name) in [(24u32, "a.flac"), (0, "b")] {
            let w: Vec<u8> = name.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
            b.extend_from_slice(&next.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes());
            b.extend_from_slice(&(w.len() as u32).to_le_bytes());
            b.extend_from_slice(&w);
            b.resize(if next == 0 { b.len() } else { next as usize }, 0);
        }
        assert_eq!(names(&b), vec!["a.flac", "b"]);
    }
}
