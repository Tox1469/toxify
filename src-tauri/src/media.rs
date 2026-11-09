//! Controle de mídia do Windows: as teclas de play/pause/próxima do teclado funcionam até
//! dentro do jogo, e o painel de volume do Windows mostra a música com a capa.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;

use windows::core::{factory, Ref, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{ISystemMediaTransportControlsInterop, RoInitialize, RO_INIT_MULTITHREADED};

use crate::engine::Cmd;

pub enum Msg {
    Track { title: String, artist: String, album: String, path: PathBuf },
    Playing(bool),
}

pub fn spawn(hwnd: isize, cmds: Sender<Cmd>, rx: Receiver<Msg>) {
    std::thread::Builder::new()
        .name("midia".into())
        .spawn(move || {
            if let Err(e) = run(hwnd, cmds, rx) {
                eprintln!("controle de mídia do Windows não abriu: {e}");
            }
        })
        .expect("thread de mídia");
}

fn run(hwnd: isize, cmds: Sender<Cmd>, rx: Receiver<Msg>) -> windows::core::Result<()> {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
    let smtc: SystemMediaTransportControls = unsafe { interop.GetForWindow(HWND(hwnd as _))? };
    smtc.SetIsEnabled(true)?;
    smtc.SetIsPlayEnabled(true)?;
    smtc.SetIsPauseEnabled(true)?;
    smtc.SetIsNextEnabled(true)?;
    smtc.SetIsPreviousEnabled(true)?;

    let playing = Arc::new(AtomicBool::new(false));
    let p = playing.clone();
    smtc.ButtonPressed(&TypedEventHandler::new(
        move |_: Ref<SystemMediaTransportControls>, args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(a) = args.as_ref() {
                let is_playing = p.load(Ordering::Relaxed);
                let cmd = match a.Button()? {
                    SystemMediaTransportControlsButton::Play if !is_playing => Some(Cmd::Toggle),
                    SystemMediaTransportControlsButton::Pause if is_playing => Some(Cmd::Toggle),
                    SystemMediaTransportControlsButton::Next => Some(Cmd::Next),
                    SystemMediaTransportControlsButton::Previous => Some(Cmd::Prev),
                    _ => None,
                };
                if let Some(c) = cmd {
                    let _ = cmds.send(c);
                }
            }
            Ok(())
        },
    ))?;

    let up = smtc.DisplayUpdater()?;
    while let Ok(m) = rx.recv() {
        let r: windows::core::Result<()> = (|| {
            match m {
                Msg::Track { title, artist, album, path } => {
                    up.SetType(MediaPlaybackType::Music)?;
                    let mp = up.MusicProperties()?;
                    mp.SetTitle(&HSTRING::from(title))?;
                    mp.SetArtist(&HSTRING::from(artist.as_str()))?;
                    mp.SetAlbumArtist(&HSTRING::from(artist.as_str()))?;
                    mp.SetAlbumTitle(&HSTRING::from(album))?;
                    if let Some(bytes) = crate::library::cover_bytes(&path) {
                        if let Ok(t) = thumbnail(&bytes) {
                            up.SetThumbnail(&t)?;
                        }
                    }
                    up.Update()?;
                }
                Msg::Playing(on) => {
                    playing.store(on, Ordering::Relaxed);
                    smtc.SetPlaybackStatus(if on { MediaPlaybackStatus::Playing } else { MediaPlaybackStatus::Paused })?;
                }
            }
            Ok(())
        })();
        if let Err(e) = r {
            eprintln!("controle de mídia: {e}");
        }
    }
    Ok(())
}

fn thumbnail(bytes: &[u8]) -> windows::core::Result<RandomAccessStreamReference> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(bytes)?;
    writer.StoreAsync()?.join()?;
    writer.FlushAsync()?.join()?;
    writer.DetachStream()?;
    stream.Seek(0)?;
    RandomAccessStreamReference::CreateFromStream(&stream)
}
