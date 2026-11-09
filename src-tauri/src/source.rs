//! Decodifica um arquivo numa thread própria e entrega amostras f32 intercaladas em estéreo.
//!
//! Qualidade: FLAC/ALAC chegam do symphonia como i32 alinhado à esquerda. A conversão pra f32
//! (divisão por 2^31) é exata para 16 e 24 bit, e a volta pra inteiro no `engine` também é.
//! Ou seja: sem reamostragem, sem fade e com volume 100%, o que sai é bit a bit o arquivo.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

pub const CH: usize = 2;
/// Abaixo disso conta como silêncio (~ -50 dBFS).
const SILENCE: f32 = 0.003;
/// Quanto do fim do arquivo é varrido atrás de silêncio.
const TAIL_SCAN_SECS: f64 = 25.0;
/// Limite de silêncio inicial que o crossfade pula.
const MAX_LEAD_SKIP_SECS: f64 = 8.0;

#[derive(Clone, Debug)]
pub struct Info {
    pub native_rate: u32,
    pub bits: u32,
    pub out_rate: u32,
    /// Frames (na taxa de saída) onde o arquivo acaba.
    pub total_frames: u64,
    /// Frames (na taxa de saída) onde o som de fato acaba, sem o silêncio do fim.
    /// Começa igual ao total e é refinado em segundo plano (varrer o fim leva um tempinho).
    end: Arc<AtomicU64>,
    /// Frame (na taxa de saída) da primeira amostra entregue (seek ou silêncio pulado).
    pub start_frame: u64,
}

impl Info {
    pub fn resampled(&self) -> bool {
        self.native_rate != self.out_rate
    }
    /// Onde o som acaba (enquanto a varredura não termina, vale o fim do arquivo).
    pub fn end_frame(&self) -> u64 {
        match self.end.load(Ordering::Relaxed) {
            u64::MAX => self.total_frames,
            e => e,
        }
    }
    pub fn end_known(&self) -> bool {
        self.end.load(Ordering::Relaxed) != u64::MAX
    }
    /// Som vai até o finzinho do arquivo: a faixa foi gravada emendada na próxima
    /// (disco ao vivo, álbum em que uma entra na outra). Aí não tem crossfade.
    pub fn glued(&self) -> bool {
        self.end_known() && self.end_frame() + (self.out_rate as u64 * 3 / 10) >= self.total_frames
    }
}

/// Fim do som por arquivo (taxa original). Seek e repetição não varrem de novo.
static SOUND_END: LazyLock<Mutex<HashMap<PathBuf, u64>>> = LazyLock::new(Default::default);

#[derive(Clone, Copy, Default)]
pub struct OpenOpts {
    pub start_secs: f64,
    /// Taxa da placa. `None` = taxa original do arquivo.
    pub target_rate: Option<u32>,
    /// Pular silêncio do começo (só em crossfade).
    pub skip_lead: bool,
    /// Duração vinda da biblioteca, pra quando o arquivo não informa.
    pub fallback_secs: f64,
}

pub struct Source {
    rx: Receiver<Vec<f32>>,
    buf: Vec<f32>,
    pos: usize,
    pub info: Info,
    /// Frames entregues até agora.
    pub played: u64,
    pub eof: bool,
}

impl Source {
    pub fn open(path: &Path, opts: OpenOpts) -> Result<Source> {
        let (info_tx, info_rx) = sync_channel::<std::result::Result<Info, String>>(1);
        // ~16 blocos de 4096 frames: uns 1,5 s a 44,1 kHz de folga.
        let (tx, rx) = sync_channel::<Vec<f32>>(16);
        let path: PathBuf = path.to_owned();
        thread::Builder::new().name("decoder".into()).spawn(move || {
            if let Err(e) = run(&path, opts, &info_tx, &tx) {
                let _ = info_tx.try_send(Err(format!("{e:#}")));
            }
        })?;
        let info = info_rx
            .recv()
            .map_err(|_| anyhow!("o decodificador fechou sem responder"))?
            .map_err(|e| anyhow!(e))?;
        Ok(Source { rx, buf: Vec::new(), pos: 0, info, played: 0, eof: false })
    }

    /// Espera o primeiro bloco chegar, pra música não começar com buraco.
    pub fn wait_ready(&mut self, timeout: Duration) {
        if self.pos < self.buf.len() {
            return;
        }
        match self.rx.recv_timeout(timeout) {
            Ok(b) => {
                self.buf = b;
                self.pos = 0;
            }
            Err(RecvTimeoutError::Disconnected) => self.eof = true,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }

    /// Preenche `out` (estéreo intercalado). Não bloqueia: devolve menos se o dado ainda não chegou.
    /// Retorna quantos frames escreveu.
    pub fn read(&mut self, out: &mut [f32]) -> usize {
        let mut w = 0;
        while w < out.len() {
            if self.pos >= self.buf.len() {
                match self.rx.try_recv() {
                    Ok(b) => {
                        self.buf = b;
                        self.pos = 0;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        self.eof = true;
                        break;
                    }
                }
            }
            let n = (self.buf.len() - self.pos).min(out.len() - w);
            out[w..w + n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            w += n;
        }
        let frames = w / CH;
        self.played += frames as u64;
        frames
    }

    pub fn position_frames(&self) -> u64 {
        self.info.start_frame + self.played
    }

    /// Acabou de verdade: thread terminou e não sobrou nada no buffer.
    pub fn drained(&self) -> bool {
        self.eof && self.pos >= self.buf.len()
    }
}

struct Reader {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    rate: u32,
    bits: u32,
    frames: Option<u64>,
}

fn open_reader(path: &Path) -> Result<Reader> {
    let file = File::open(path).with_context(|| format!("abrindo {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let format = symphonia::default::get_probe().probe(
        &hint,
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| anyhow!("arquivo sem faixa de áudio"))?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("codec sem parâmetros de áudio"))?
        .clone();
    let rate = params.sample_rate.ok_or_else(|| anyhow!("taxa de amostragem desconhecida"))?;
    let bits = params.bits_per_sample.unwrap_or(0);
    let track_id = track.id;
    let frames = track.num_frames;
    let decoder = symphonia::default::get_codecs().make_audio_decoder(&params, &AudioDecoderOptions::default())?;
    Ok(Reader { format, decoder, track_id, rate, bits, frames })
}

impl Reader {
    /// Vai pra `secs`. Retorna quantos frames ainda precisam ser descartados pra cair no ponto exato.
    fn seek(&mut self, secs: f64) -> Result<u64> {
        if secs <= 0.0 {
            return Ok(0);
        }
        let to = SeekTo::Time { time: Time::from_millis((secs * 1000.0) as i64), track_id: Some(self.track_id) };
        let s = self.format.seek(SeekMode::Accurate, to)?;
        self.decoder.reset();
        // ponytail: assume time base = 1/taxa (vale pra FLAC, ALAC, MP3 e Vorbis no symphonia).
        Ok((s.required_ts.get() - s.actual_ts.get()).max(0) as u64)
    }

    /// Próximo pacote decodificado em estéreo intercalado. `None` = fim.
    fn next(&mut self, out: &mut Vec<f32>) -> Result<Option<()>> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(None),
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(SymError::ResetRequired) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(buf) => {
                    let ch = buf.spec().channels().count().max(1);
                    let frames = buf.frames();
                    let mut tmp = vec![0f32; frames * ch];
                    buf.copy_to_slice_interleaved(&mut tmp);
                    out.clear();
                    out.reserve(frames * CH);
                    for f in tmp.chunks_exact(ch) {
                        // Mono vira estéreo duplicando (exato). Mais de 2 canais: fica com os 2 primeiros.
                        let (l, r) = if ch == 1 { (f[0], f[0]) } else { (f[0], f[1]) };
                        out.push(l);
                        out.push(r);
                    }
                    return Ok(Some(()));
                }
                Err(SymError::DecodeError(_)) | Err(SymError::IoError(_)) => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
}

/// Confere que o arquivo abre e decodifica (usado depois de editar tag).
pub fn verify(path: &Path) -> Result<()> {
    let mut r = open_reader(path)?;
    let mut buf = Vec::new();
    for _ in 0..8 {
        if r.next(&mut buf)?.is_none() {
            break;
        }
    }
    Ok(())
}

/// Último frame (taxa original) com som, olhando só o fim do arquivo.
fn find_sound_end(path: &Path, total: u64, rate: u32) -> Option<u64> {
    let mut r = open_reader(path).ok()?;
    let start_secs = (total as f64 / rate as f64 - TAIL_SCAN_SECS).max(0.0);
    let skip = r.seek(start_secs).ok()?;
    let mut pos = (start_secs * rate as f64) as u64;
    let mut to_skip = skip;
    let mut last_sound = None;
    let mut buf = Vec::new();
    while let Ok(Some(())) = r.next(&mut buf) {
        for f in buf.chunks_exact(CH) {
            if to_skip > 0 {
                to_skip -= 1;
                continue;
            }
            if f[0].abs() > SILENCE || f[1].abs() > SILENCE {
                last_sound = Some(pos);
            }
            pos += 1;
        }
    }
    // Sem som nenhum no trecho final: o arquivo acaba "no silêncio" mesmo, usa o fim.
    Some(last_sound.map(|p| p + 1).unwrap_or(total).min(total))
}

fn run(
    path: &Path,
    opts: OpenOpts,
    info_tx: &SyncSender<std::result::Result<Info, String>>,
    tx: &SyncSender<Vec<f32>>,
) -> Result<()> {
    let mut r = open_reader(path)?;
    let native = r.rate;
    let out_rate = opts.target_rate.unwrap_or(native);
    let ratio = out_rate as f64 / native as f64;
    let total_native = r.frames.unwrap_or((opts.fallback_secs * native as f64) as u64);
    let to_out = move |f: u64| (f as f64 * ratio).round() as u64;

    // Fim do som: do cache, ou varrido numa thread à parte (não atrasa o play nem o seek).
    let end = Arc::new(AtomicU64::new(u64::MAX));
    let cached = SOUND_END.lock().unwrap().get(path).copied();
    match cached {
        Some(e) => end.store(to_out(e), Ordering::Relaxed),
        None if total_native > 0 => {
            let (end, path) = (end.clone(), path.to_owned());
            thread::spawn(move || {
                if let Some(e) = find_sound_end(&path, total_native, native) {
                    end.store(to_out(e), Ordering::Relaxed);
                    SOUND_END.lock().unwrap().insert(path, e);
                }
            });
        }
        None => {}
    }

    let mut skip = r.seek(opts.start_secs)?;
    let start_native = (opts.start_secs.max(0.0) * native as f64) as u64;

    // Silêncio inicial: decodifica e joga fora até aparecer som (só quando pedido).
    let mut first: Vec<f32> = Vec::new();
    let mut lead_skipped = 0u64;
    let mut buf = Vec::new();
    if opts.skip_lead {
        let max = (MAX_LEAD_SKIP_SECS * native as f64) as u64;
        'outer: while let Some(()) = r.next(&mut buf)? {
            for (i, f) in buf.chunks_exact(CH).enumerate() {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                if f[0].abs() > SILENCE || f[1].abs() > SILENCE || lead_skipped >= max {
                    first.extend_from_slice(&buf[i * CH..]);
                    break 'outer;
                }
                lead_skipped += 1;
            }
        }
    }

    info_tx
        .send(Ok(Info {
            native_rate: native,
            bits: r.bits,
            out_rate,
            total_frames: to_out(total_native),
            end,
            start_frame: to_out(start_native + lead_skipped),
        }))
        .ok();

    let mut out = Pump::new(native, out_rate, tx)?;
    if !first.is_empty() && !out.push(&first)? {
        return Ok(());
    }
    while let Some(()) = r.next(&mut buf)? {
        let mut data = &buf[..];
        if skip > 0 {
            let n = (skip as usize).min(data.len() / CH);
            data = &data[n * CH..];
            skip -= n as u64;
        }
        if !data.is_empty() && !out.push(data)? {
            return Ok(()); // quem ouvia largou a fonte (pulou faixa, seek...)
        }
    }
    out.finish()
}

/// Junta amostras em blocos, reamostra se precisar, e manda pro canal.
struct Pump<'a> {
    tx: &'a SyncSender<Vec<f32>>,
    pending: Vec<f32>,
    rs: Option<Fft<f32>>,
    delay: usize,
    produced: u64,
    consumed: u64,
    ratio: f64,
}

const BLOCK: usize = 4096;

impl<'a> Pump<'a> {
    fn new(native: u32, out_rate: u32, tx: &'a SyncSender<Vec<f32>>) -> Result<Self> {
        let rs = if native != out_rate {
            Some(Fft::<f32>::new(native as usize, out_rate as usize, 1024, CH, FixedSync::Input)?)
        } else {
            None
        };
        let delay = rs.as_ref().map(|r| r.output_delay()).unwrap_or(0);
        Ok(Pump {
            tx,
            pending: Vec::with_capacity(BLOCK * CH * 2),
            rs,
            delay,
            produced: 0,
            consumed: 0,
            ratio: out_rate as f64 / native as f64,
        })
    }

    /// Manda pro canal. `false` quando o receptor foi embora (pulou faixa, seek...).
    fn emit(&mut self, mut frames: Vec<f32>, cap: Option<u64>) -> bool {
        if let Some(cap) = cap {
            frames.truncate(cap.saturating_sub(self.produced) as usize * CH);
        }
        self.produced += (frames.len() / CH) as u64;
        frames.is_empty() || self.tx.send(frames).is_ok()
    }

    /// Passa `take` frames do pendente pelo reamostrador (completa com silêncio se faltar).
    fn run_rs(&mut self, take: usize) -> Result<Vec<f32>> {
        let rs = self.rs.as_mut().expect("run_rs sem reamostrador");
        let need = rs.input_frames_next();
        let mut input: Vec<f32> = self.pending.drain(..take * CH).collect();
        input.resize(need * CH, 0.0);
        let out_frames = rs.output_frames_next();
        let mut output = vec![0f32; out_frames * CH];
        let inp = InterleavedSlice::new(&input[..], CH, need)?;
        let mut outp = InterleavedSlice::new_mut(&mut output[..], CH, out_frames)?;
        let idx = Indexing {
            input_offset: 0,
            output_offset: 0,
            partial_len: (take < need).then_some(take),
            active_channels_mask: None,
        };
        let (_, written) = rs.process_into_buffer(&inp, &mut outp, Some(&idx))?;
        self.consumed += take as u64;
        output.truncate(written * CH);
        let d = self.delay.min(written);
        self.delay -= d;
        output.drain(..d * CH);
        Ok(output)
    }

    fn push(&mut self, data: &[f32]) -> Result<bool> {
        self.pending.extend_from_slice(data);
        if self.rs.is_none() {
            if self.pending.len() >= BLOCK * CH {
                let block = std::mem::replace(&mut self.pending, Vec::with_capacity(BLOCK * CH * 2));
                return Ok(self.emit(block, None));
            }
            return Ok(true);
        }
        let mut block = Vec::new();
        while self.pending.len() / CH >= self.rs.as_ref().unwrap().input_frames_next() {
            let need = self.rs.as_ref().unwrap().input_frames_next();
            block.extend(self.run_rs(need)?);
        }
        Ok(self.emit(block, None))
    }

    fn finish(mut self) -> Result<()> {
        if self.rs.is_none() {
            let rest = std::mem::take(&mut self.pending);
            self.emit(rest, None);
            return Ok(());
        }
        let mut tail = Vec::new();
        let left = self.pending.len() / CH;
        if left > 0 {
            tail.extend(self.run_rs(left)?);
        }
        // O reamostrador segura um pedaço lá dentro; empurra silêncio até sair tudo que é da música.
        let expected = (self.consumed as f64 * self.ratio).round() as u64;
        let mut rounds = 0;
        while (self.produced + (tail.len() / CH) as u64) < expected && rounds < 32 {
            tail.extend(self.run_rs(0)?);
            rounds += 1;
        }
        self.emit(tail, Some(expected));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decodifica um FLAC real e confere bit a bit contra o ffmpeg (s32le).
    /// Rode com: TOXIFY_TEST_FLAC="D:\\Music\\...flac" cargo test bit_perfect -- --nocapture
    #[test]
    fn bit_perfect() {
        let Ok(path) = std::env::var("TOXIFY_TEST_FLAC") else {
            eprintln!("pulando: defina TOXIFY_TEST_FLAC");
            return;
        };
        let mut src = Source::open(Path::new(&path), OpenOpts::default()).unwrap();
        let mut ours: Vec<i32> = Vec::new();
        let mut buf = vec![0f32; 4096 * CH];
        loop {
            src.wait_ready(Duration::from_secs(2));
            let n = src.read(&mut buf);
            if n == 0 && src.drained() {
                break;
            }
            ours.extend(buf[..n * CH].iter().map(|&x| crate::engine::f32_to_i32(x)));
        }
        let ff = std::process::Command::new("ffmpeg")
            .args(["-v", "quiet", "-i", &path, "-f", "s32le", "-ac", "2", "-"])
            .output()
            .unwrap()
            .stdout;
        let theirs: Vec<i32> = ff.chunks_exact(4).map(|b| i32::from_le_bytes(b.try_into().unwrap())).collect();
        assert_eq!(ours.len(), theirs.len(), "quantidade de amostras diferente");
        let diff = ours.iter().zip(&theirs).filter(|(a, b)| a != b).count();
        assert_eq!(diff, 0, "{diff} amostras diferentes");
        eprintln!("ok: {} amostras idênticas ao ffmpeg, {} Hz {} bit", ours.len(), src.info.native_rate, src.info.bits);
    }
}
