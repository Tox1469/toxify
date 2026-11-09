//! Motor de reprodução: fila, transições e saída WASAPI.
//!
//! Regras de transição (combinadas com o Tox):
//! - Álbum tocando em ordem: emenda sem pausa nenhuma (gapless), nunca crossfade.
//! - Troca de álbum, aleatório ou playlist: crossfade com curva de potência constante, começando
//!   onde o som da faixa acaba (ignora o silêncio do fim) e pulando o silêncio do começo da próxima.
//! - Taxas diferentes no crossfade: a que entra é convertida pra taxa da placa (o selo avisa).
//! - Pular faixa na mão: crossfade curtinho se a taxa bate, senão fade rápido e a placa troca de taxa.
//! - Fora das transições, com volume 100%, o que sai é bit a bit o arquivo.

use std::f32::consts::FRAC_PI_2;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use wasapi::{
    calculate_period_100ns, initialize_mta, AudioClient, AudioRenderClient, Device, DeviceEnumerator, DeviceState,
    Direction, Handle, SampleType, StreamMode, WaveFormat,
};

use crate::source::{OpenOpts, Source, CH};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QTrack {
    pub id: i64,
    pub path: String,
    pub album_key: String,
    pub disc: u32,
    pub track: u32,
    pub rate: u32,
    pub secs: f64,
}

pub enum Cmd {
    Play { queue: Vec<QTrack>, index: usize },
    Toggle,
    Next,
    Prev,
    Seek(f64),
    Volume(f32),
    Speed(f32),
    Pitch(f32),
    Crossfade { on: bool, secs: f32 },
    Exclusive(bool),
    Shuffle(bool),
    Repeat(u8),
    Enqueue(Vec<QTrack>),
    PlayNext(Vec<QTrack>),
    JumpTo(usize),
    RemoveAt(usize),
    /// Saída escolhida (id do WASAPI); None = a padrão do Windows.
    Device(Option<String>),
    ReplayGain(u8),
    /// Ao abrir o app: fila e música de antes, pausada no mesmo ponto.
    Restore { queue: Vec<QTrack>, index: usize, at: f64, shuffle: bool, repeat: u8 },
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Prefs {
    pub volume: f32,
    pub crossfade: bool,
    pub crossfade_secs: f32,
    pub exclusive: bool,
    /// 1.0 = normal. Muda a velocidade sem mudar o tom.
    #[serde(default = "one")]
    pub speed: f32,
    /// 1.0 = original, 2.0 = uma oitava acima. Muda o tom sem mudar a velocidade.
    #[serde(default = "one")]
    pub pitch: f32,
    /// ReplayGain das tags: 0 = desligado (bit-perfect), 1 = por faixa, 2 = por álbum.
    #[serde(default)]
    pub replaygain: u8,
}

fn one() -> f32 {
    1.0
}

#[derive(Serialize, Clone, Default)]
pub struct State {
    pub track_id: Option<i64>,
    pub index: usize,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub out_rate: u32,
    pub out_bits: u32,
    pub out_mode: &'static str,
    pub device: String,
    pub src_rate: u32,
    pub src_bits: u32,
    pub resampled: bool,
    pub bitperfect: bool,
    pub volume: f32,
    pub speed: f32,
    pub pitch: f32,
    pub crossfade: bool,
    pub crossfade_secs: f32,
    pub shuffle: bool,
    pub repeat: u8,
    pub exclusive: bool,
    pub next_id: Option<i64>,
    pub next_mode: &'static str,
    pub error: Option<String>,
    /// ReplayGain: modo e ganho aplicado agora na faixa da tela (1.0 = nenhum).
    pub replaygain: u8,
    pub rg_gain: f32,
}

#[derive(Serialize, Clone)]
pub struct QueueMsg {
    pub ids: Vec<i64>,
    pub index: usize,
}

// ---------------------------------------------------------------- saída

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    I32,
    I24,
    I16,
    F32,
}

struct Out {
    client: AudioClient,
    render: AudioRenderClient,
    event: Handle,
    rate: u32,
    kind: Kind,
    valid_bits: u32,
    exclusive: bool,
    device: String,
    started: bool,
}

/// Taxas tentadas quando a placa não aceita a do arquivo (da maior pra menor).
const RATES: [u32; 8] = [384000, 352800, 192000, 176400, 96000, 88200, 48000, 44100];

/// A saída escolhida nas Configurações; sem escolha, ou se ela sumiu (DAC desligado), a padrão do Windows.
fn pick_device(id: Option<&str>) -> Result<Device> {
    let enumerator = DeviceEnumerator::new()?;
    if let Some(d) = id.and_then(|id| enumerator.get_device(id).ok()) {
        if matches!(d.get_state(), Ok(DeviceState::Active)) {
            return Ok(d);
        }
    }
    Ok(enumerator.get_default_device(Direction::Render)?)
}

fn try_exclusive(rate: u32, id: Option<&str>) -> Result<Out> {
    let device = pick_device(id)?;
    let name = device.get_friendlyname().unwrap_or_default();
    let probe = device.get_iaudioclient()?;
    // 24 bit dentro de 32 é o que a maioria dos DACs e placas onboard aceita.
    let candidates = [
        (32, 24, SampleType::Int, Kind::I32),
        (32, 32, SampleType::Int, Kind::I32),
        (24, 24, SampleType::Int, Kind::I24),
        (32, 32, SampleType::Float, Kind::F32),
        (16, 16, SampleType::Int, Kind::I16),
    ];
    for (store, valid, st, kind) in candidates {
        let want = WaveFormat::new(store, valid, st, rate as usize, CH, None);
        let Ok(fmt) = probe.is_supported_exclusive_with_quirks(&want) else { continue };
        let mut client = device.get_iaudioclient()?;
        let (def, _min) = client.get_device_period()?;
        let period = client.calculate_aligned_period_near(def.max(200_000), Some(128), &fmt)?;
        let mut init = client.initialize_client(&fmt, Direction::Render, StreamMode::EventsExclusive { period_hns: period }, None);
        if init.is_err() {
            // Pode ser buffer desalinhado: a doc da Microsoft manda pegar o tamanho e tentar de novo.
            if let Ok(frames) = client.get_buffer_size() {
                if frames > 0 {
                    let p = calculate_period_100ns(frames as i64, rate as i64);
                    client = device.get_iaudioclient()?;
                    init = client.initialize_client(&fmt, Direction::Render, StreamMode::EventsExclusive { period_hns: p }, None);
                }
            }
        }
        if init.is_err() {
            continue;
        }
        let event = client.set_get_eventhandle()?;
        let render = client.get_audiorenderclient()?;
        return Ok(Out { client, render, event, rate, kind, valid_bits: valid as u32, exclusive: true, device: name, started: false });
    }
    Err(anyhow!("a placa não aceitou {rate} Hz no modo exclusivo"))
}

/// Modo compartilhado: abre uma vez na taxa do mixer do Windows e nunca mais reabre.
/// O Toxify converte cada faixa pra essa taxa (melhor que o Windows) e as trocas não têm buraco.
fn try_shared(id: Option<&str>) -> Result<Out> {
    let device = pick_device(id)?;
    let name = device.get_friendlyname().unwrap_or_default();
    let mut client = device.get_iaudioclient()?;
    let rate = client.get_mixformat()?.get_samplespersec();
    let fmt = WaveFormat::new(32, 32, SampleType::Float, rate as usize, CH, None);
    client.initialize_client(&fmt, Direction::Render, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 500_000 }, None)?;
    let event = client.set_get_eventhandle()?;
    let render = client.get_audiorenderclient()?;
    Ok(Out { client, render, event, rate, kind: Kind::F32, valid_bits: 32, exclusive: false, device: name, started: false })
}

fn open_output(rate: u32, exclusive: bool, id: Option<&str>) -> Result<Out> {
    if exclusive {
        if let Ok(o) = try_exclusive(rate, id) {
            return Ok(o);
        }
        // A placa não faz essa taxa: usa a maior que ela aceitar (a faixa vai ser convertida).
        for r in RATES.iter().copied().filter(|&r| r != rate) {
            if let Ok(o) = try_exclusive(r, id) {
                return Ok(o);
            }
        }
    }
    try_shared(id)
}

pub fn f32_to_i32(x: f32) -> i32 {
    (x as f64 * 2_147_483_648.0).round().clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

fn encode(kind: Kind, src: &[f32], dst: &mut Vec<u8>) {
    dst.clear();
    match kind {
        Kind::I32 => src.iter().for_each(|&x| dst.extend_from_slice(&f32_to_i32(x).to_le_bytes())),
        Kind::I24 => src.iter().for_each(|&x| dst.extend_from_slice(&(f32_to_i32(x) >> 8).to_le_bytes()[..3])),
        Kind::I16 => src.iter().for_each(|&x| dst.extend_from_slice(&((f32_to_i32(x) >> 16) as i16).to_le_bytes())),
        Kind::F32 => src.iter().for_each(|&x| dst.extend_from_slice(&x.to_le_bytes())),
    }
}

// ---------------------------------------------------------------- motor

#[derive(Clone, Copy, PartialEq, Debug)]
enum Plan {
    Crossfade,
    /// Mesmo álbum em ordem: crossfade, a não ser que a faixa termine colada na próxima
    /// (aí vira Gapless). Só dá pra saber perto do fim, quando a varredura do som terminou.
    Auto,
    Gapless,
    Reopen,
}

/// Quanto tempo a faixa ficou tocando e se saiu por pulo. É o que ensina os mixes.
#[derive(Serialize, Clone)]
pub struct Heard {
    pub id: i64,
    pub secs: f64,
    pub skipped: bool,
}

struct Deck {
    src: Source,
    qi: usize,
    rg: Rg,
}

/// ReplayGain gravado nas tags: (ganho em dB, pico) da faixa e do álbum. Lido ao abrir a faixa.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct Rg {
    track: Option<(f32, Option<f32>)>,
    album: Option<(f32, Option<f32>)>,
}

impl Rg {
    fn read(path: &str) -> Rg {
        use lofty::prelude::*;
        let Ok(f) = lofty::read_from_path(path) else { return Rg::default() };
        let mut rg = Rg::default();
        for tag in f.tags() {
            let num = |k: ItemKey| tag.get_string(k).and_then(parse_db);
            if rg.track.is_none() {
                rg.track = num(ItemKey::ReplayGainTrackGain).map(|g| (g, num(ItemKey::ReplayGainTrackPeak)));
            }
            if rg.album.is_none() {
                rg.album = num(ItemKey::ReplayGainAlbumGain).map(|g| (g, num(ItemKey::ReplayGainAlbumPeak)));
            }
        }
        rg
    }

    /// Ganho linear pro modo (0 desligado, 1 faixa, 2 álbum). Sem a tag pedida usa a outra; sem
    /// nenhuma, 1.0. Nunca passa do pico (não estoura) e, sem pico conhecido, só abaixa.
    fn gain(&self, mode: u8) -> f32 {
        let pick = match mode {
            1 => self.track.or(self.album),
            2 => self.album.or(self.track),
            _ => None,
        };
        let Some((db, peak)) = pick else { return 1.0 };
        let g = 10f32.powf(db / 20.0);
        match peak {
            Some(p) if p > 0.0 => g.min(1.0 / p),
            _ => g.min(1.0),
        }
    }
}

/// "-7.89 dB" / "+1.2 dB" / "0.988" → número.
fn parse_db(s: &str) -> Option<f32> {
    s.trim().trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace()).parse().ok()
}

struct Fade {
    pos: u64,
    len: u64,
}

/// Rampa curta de volume (pausa, seek, pular faixa), pra não estalar.
struct Ramp {
    from: f32,
    to: f32,
    pos: u64,
    len: u64,
    then: Option<After>,
}

/// Próxima faixa aberta numa thread à parte (abrir arquivo no laço de áudio dá estalo).
struct Prepared {
    generation: u64,
    deck: std::result::Result<Deck, String>,
    plan: Plan,
    manual: bool,
}

#[derive(Clone, Copy)]
enum After {
    Pause,
    Seek(f64),
    Start(usize),
    Stop,
}

pub struct Engine {
    app: AppHandle,
    rx: Receiver<Cmd>,
    queue: Vec<QTrack>,
    original: Vec<QTrack>,
    idx: usize,
    shuffle: bool,
    repeat: u8,
    prefs: Prefs,
    out: Option<Out>,
    cur: Option<Deck>,
    inc: Option<(Deck, Plan)>,
    fade: Option<Fade>,
    ramp: Option<Ramp>,
    after: Option<After>,
    playing: bool,
    gain: f32,
    mix: Vec<f32>,
    a: Vec<f32>,
    b: Vec<f32>,
    bytes: Vec<u8>,
    /// Velocidade/tom: o processador, a fração de frame que sobrou e o buffer de entrada.
    stretch: Option<crate::stretch::Stretch>,
    stretch_acc: f64,
    raw: Vec<f32>,
    last_emit: Instant,
    error: Option<String>,
    rng: u64,
    prep_tx: Sender<Prepared>,
    prep_rx: Receiver<Prepared>,
    generation: u64,
    /// Faixa pedida no "próxima" que ainda está abrindo.
    pending: Option<usize>,
    /// Próxima faixa precisa de outra taxa: abre na hora da troca.
    reopen_next: Option<usize>,
    /// Faixa na tela, segundos ouvidos dela, e se a próxima troca foi pedida na mão.
    heard: Option<(i64, f64)>,
    manual: bool,
    /// Saída escolhida (id do WASAPI); None = a padrão do Windows.
    device: Option<String>,
}

impl Engine {
    pub fn spawn(app: AppHandle, rx: Receiver<Cmd>, prefs: Prefs, device: Option<String>) {
        std::thread::Builder::new()
            .name("engine".into())
            .spawn(move || {
                let _ = initialize_mta();
                let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) | 1;
                let (prep_tx, prep_rx) = channel();
                let mut e = Engine {
                    prep_tx,
                    prep_rx,
                    generation: 0,
                    pending: None,
                    reopen_next: None,
                    heard: None,
                    manual: false,
                    device,
                    app,
                    rx,
                    queue: Vec::new(),
                    original: Vec::new(),
                    idx: 0,
                    shuffle: false,
                    repeat: 0,
                    prefs,
                    out: None,
                    cur: None,
                    inc: None,
                    fade: None,
                    ramp: None,
                    after: None,
                    playing: false,
                    gain: vol_gain(prefs.volume),
                    mix: Vec::new(),
                    a: Vec::new(),
                    b: Vec::new(),
                    bytes: Vec::new(),
                    stretch: None,
                    stretch_acc: 0.0,
                    raw: Vec::new(),
                    last_emit: Instant::now(),
                    error: None,
                    rng: seed,
                };
                e.run();
            })
            .expect("thread do motor");
    }

    fn run(&mut self) {
        loop {
            let active = self.playing && self.out.is_some();
            if !active {
                match self.rx.recv_timeout(Duration::from_millis(150)) {
                    Ok(c) => self.handle(c),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            while let Ok(c) = self.rx.try_recv() {
                self.handle(c);
            }
            while let Ok(p) = self.prep_rx.try_recv() {
                self.on_prepared(p);
            }
            if self.playing && self.out.is_some() {
                if let Err(e) = self.render_once() {
                    self.recover(e);
                }
            }
            if let Some(a) = self.after.take() {
                self.do_after(a);
            }
            if self.last_emit.elapsed() > Duration::from_millis(200) {
                self.emit();
            }
        }
    }

    // ------------------------------------------------ comandos

    fn handle(&mut self, c: Cmd) {
        if matches!(c, Cmd::Play { .. } | Cmd::Next | Cmd::JumpTo(_)) {
            self.manual = true;
        }
        match c {
            Cmd::Play { queue, index } => {
                self.generation += 1;
                self.inc = None;
                self.fade = None;
                self.pending = None;
                self.reopen_next = None;
                self.original = queue.clone();
                self.queue = queue;
                self.idx = index.min(self.queue.len().saturating_sub(1));
                if self.shuffle {
                    self.shuffle_rest();
                }
                self.emit_queue();
                if self.cur.is_some() && self.playing {
                    self.fade_then(0.06, After::Start(self.idx));
                } else {
                    self.start(self.idx, 0.0, true);
                }
            }
            Cmd::Toggle => {
                if self.playing {
                    self.fade_then(0.04, After::Pause);
                } else if self.cur.is_some() {
                    self.resume();
                } else if !self.queue.is_empty() {
                    self.start(self.idx, 0.0, true);
                }
            }
            Cmd::Next => self.manual_next(),
            Cmd::Prev => {
                if self.position() > 3.0 || (self.idx == 0 && self.repeat == 0) {
                    self.seek(0.0);
                } else {
                    self.manual = true;
                    let p = if self.idx == 0 { self.queue.len() - 1 } else { self.idx - 1 };
                    self.jump(p);
                }
            }
            Cmd::Seek(s) => self.seek(s),
            Cmd::Volume(v) => self.prefs.volume = v.clamp(0.0, 2.0),
            Cmd::Speed(v) => self.prefs.speed = if (v - 1.0).abs() < 0.005 { 1.0 } else { v.clamp(0.5, 2.0) },
            Cmd::Pitch(v) => {
                self.prefs.pitch = if (v - 1.0).abs() < 0.002 { 1.0 } else { v.clamp(0.5, 2.0) };
                if let Some(st) = self.stretch.as_mut() {
                    st.set_pitch(self.prefs.pitch);
                }
            }
            Cmd::Crossfade { on, secs } => {
                self.prefs.crossfade = on;
                self.prefs.crossfade_secs = secs.clamp(1.0, 12.0);
                self.prepare_next();
            }
            Cmd::Exclusive(on) => {
                self.prefs.exclusive = on;
                self.reopen_output();
            }
            Cmd::Device(id) => {
                self.device = id;
                self.reopen_output();
            }
            Cmd::ReplayGain(mode) => self.prefs.replaygain = mode.min(2),
            Cmd::Shuffle(on) => {
                self.shuffle = on;
                let cur_id = self.queue.get(self.idx).map(|t| t.id);
                if on {
                    self.shuffle_rest();
                } else {
                    self.queue = self.original.clone();
                    self.idx = cur_id.and_then(|id| self.queue.iter().position(|t| t.id == id)).unwrap_or(0);
                    if let Some(d) = self.cur.as_mut() {
                        d.qi = self.idx;
                    }
                }
                self.emit_queue();
                self.prepare_next();
            }
            Cmd::Repeat(r) => {
                self.repeat = r.min(2);
                self.prepare_next();
            }
            Cmd::Enqueue(ts) => {
                self.original.extend(ts.iter().cloned());
                self.queue.extend(ts);
                self.emit_queue();
                self.prepare_next();
            }
            Cmd::PlayNext(ts) => {
                let at = (self.idx + 1).min(self.queue.len());
                for (i, t) in ts.into_iter().enumerate() {
                    self.queue.insert(at + i, t);
                }
                self.original = self.queue.clone();
                self.emit_queue();
                self.prepare_next();
            }
            Cmd::JumpTo(i) => {
                if i < self.queue.len() {
                    self.jump(i);
                }
            }
            Cmd::Restore { queue, index, at, shuffle, repeat } => {
                // Só se nada estiver tocando (não atropela o que você já deu play).
                if self.cur.is_none() && index < queue.len() {
                    self.original = queue.clone();
                    self.queue = queue;
                    self.idx = index;
                    self.shuffle = shuffle;
                    self.repeat = repeat.min(2);
                    let rate = self.queue[index].rate.max(8000);
                    if let Ok(d) = self.open_deck(index, at.max(0.0), rate, false) {
                        self.heard = Some((self.queue[index].id, 0.0));
                        self.cur = Some(d);
                    }
                    self.playing = false;
                    self.emit_queue();
                }
            }
            Cmd::RemoveAt(i) => {
                if i < self.queue.len() && i != self.idx {
                    let id = self.queue.remove(i).id;
                    if let Some(p) = self.original.iter().position(|t| t.id == id) {
                        self.original.remove(p);
                    }
                    if i < self.idx {
                        self.idx -= 1;
                        if let Some(d) = self.cur.as_mut() {
                            d.qi = self.idx;
                        }
                    }
                    self.emit_queue();
                    self.prepare_next();
                }
            }
        }
        self.emit();
    }

    /// Mudou o modo ou a saída: fecha a placa e, se estava tocando, volta do mesmo ponto na nova.
    fn reopen_output(&mut self) {
        if self.cur.is_some() {
            let pos = self.position();
            self.close_output();
            if self.playing {
                self.after = Some(After::Seek(pos));
            }
        }
    }

    fn shuffle_rest(&mut self) {
        // Fisher-Yates só no que vem depois da faixa atual.
        let start = (self.idx + 1).min(self.queue.len());
        let n = self.queue.len() - start;
        for i in (1..n).rev() {
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            let j = (self.rng % (i as u64 + 1)) as usize;
            self.queue.swap(start + i, start + j);
        }
    }

    fn jump(&mut self, i: usize) {
        if self.playing && self.cur.is_some() {
            self.fade_then(0.06, After::Start(i));
        } else {
            self.start(i, 0.0, true);
        }
    }

    fn manual_next(&mut self) {
        let base = self.pending.unwrap_or(self.idx);
        let Some(n) = self.next_index(base, true) else {
            self.fade_then(0.06, After::Stop);
            return;
        };
        let Some(out_rate) = self.out.as_ref().map(|o| o.rate) else {
            self.start(n, 0.0, true);
            return;
        };
        if !self.playing || self.fade.is_some() {
            self.jump(n);
            return;
        }
        let shared = self.out.as_ref().is_some_and(|o| !o.exclusive);
        if self.queue[n].rate == out_rate || shared {
            // Mesma taxa: crossfade curtinho de meio segundo, assim que a faixa abrir.
            self.pending = Some(n);
            self.request(n, Plan::Crossfade, true);
            return;
        }
        self.fade_then(0.06, After::Start(n));
    }

    /// Abre a faixa `qi` em outra thread; o resultado chega em `on_prepared`.
    fn request(&mut self, qi: usize, plan: Plan, manual: bool) {
        self.generation += 1;
        let generation = self.generation;
        let t = self.queue[qi].clone();
        let rate = self.out_rate();
        let tx = self.prep_tx.clone();
        std::thread::spawn(move || {
            let opts = OpenOpts { start_secs: 0.0, target_rate: Some(rate), skip_lead: plan == Plan::Crossfade && !manual, fallback_secs: t.secs };
            let deck = Source::open(Path::new(&t.path), opts)
                .map(|mut src| {
                    src.wait_ready(Duration::from_secs(2));
                    Deck { src, qi, rg: Rg::read(&t.path) }
                })
                .map_err(|e| format!("{e:#}"));
            let _ = tx.send(Prepared { generation, deck, plan, manual });
        });
    }

    fn on_prepared(&mut self, p: Prepared) {
        if p.generation != self.generation || self.fade.is_some() {
            return; // pedido velho (a fila mudou no meio)
        }
        match p.deck {
            Ok(d) if p.manual => {
                self.pending = None;
                self.idx = d.qi;
                self.fade = Some(Fade { pos: 0, len: (self.out_rate() as f64 * 0.5) as u64 });
                self.inc = Some((d, Plan::Crossfade));
                self.emit_queue();
                self.emit_track();
            }
            Ok(d) => self.inc = Some((d, p.plan)),
            Err(e) => {
                eprintln!("não deu pra abrir a próxima: {e}");
                if p.manual {
                    self.pending = None;
                    self.fade_then(0.06, After::Start(self.next_index(self.idx, true).unwrap_or(self.idx)));
                }
            }
        }
    }

    /// repeat: 0 = desligado, 1 = repetir a fila, 2 = repetir a faixa.
    fn next_index(&self, from: usize, manual: bool) -> Option<usize> {
        if self.queue.is_empty() {
            return None;
        }
        if self.repeat == 2 && !manual {
            return Some(from);
        }
        if from + 1 < self.queue.len() {
            Some(from + 1)
        } else if self.repeat >= 1 {
            Some(0)
        } else {
            None
        }
    }

    fn fade_then(&mut self, secs: f32, then: After) {
        let rate = self.out.as_ref().map(|o| o.rate).unwrap_or(48000);
        if !self.playing || self.out.is_none() {
            self.after = Some(then);
            return;
        }
        let from = self.ramp.as_ref().map(ramp_value).unwrap_or(1.0);
        self.ramp = Some(Ramp { from, to: 0.0, pos: 0, len: (rate as f32 * secs) as u64, then: Some(then) });
    }

    fn do_after(&mut self, a: After) {
        match a {
            After::Pause => {
                self.playing = false;
                self.ramp = None;
                self.close_output();
            }
            After::Stop => {
                self.playing = false;
                self.ramp = None;
                self.fade = None;
                self.inc = None;
                self.cur = None;
                self.close_output();
                self.finish_heard();
            }
            After::Seek(s) => self.seek_now(s),
            After::Start(i) => {
                self.ramp = None;
                self.start(i, 0.0, true);
            }
        }
        self.emit();
    }

    // ------------------------------------------------ início, seek, retomada

    /// Garante a placa aberta perto de `rate`. Devolve a taxa real.
    fn ensure_output(&mut self, rate: u32) -> Result<u32> {
        if let Some(o) = &self.out {
            if o.rate == rate || (!o.exclusive && !self.prefs.exclusive) {
                return Ok(o.rate);
            }
        }
        self.close_output();
        let o = open_output(rate, self.prefs.exclusive, self.device.as_deref())?;
        let r = o.rate;
        self.out = Some(o);
        Ok(r)
    }

    fn close_output(&mut self) {
        if let Some(o) = self.out.take() {
            let _ = o.client.stop_stream();
        }
    }

    fn open_deck(&self, qi: usize, start: f64, out_rate: u32, skip_lead: bool) -> Result<Deck> {
        let t = &self.queue[qi];
        let mut src = Source::open(Path::new(&t.path), OpenOpts { start_secs: start, target_rate: Some(out_rate), skip_lead, fallback_secs: t.secs })?;
        src.wait_ready(Duration::from_secs(2));
        Ok(Deck { src, qi, rg: Rg::read(&t.path) })
    }

    /// `fresh` = música começando agora (conta como nova audição). Seek e recuperação passam `false`.
    fn start(&mut self, qi: usize, at: f64, fresh: bool) {
        self.generation += 1;
        self.fade = None;
        self.inc = None;
        self.ramp = None;
        self.pending = None;
        self.reopen_next = None;
        if qi >= self.queue.len() {
            return;
        }
        // Abrir arquivo bloqueia: para a placa antes, senão ela repete o último buffer (zumbido).
        if let Some(o) = self.out.as_mut() {
            if o.started {
                let _ = o.client.stop_stream();
                let _ = o.client.reset_stream();
                o.started = false;
            }
        }
        let want = self.queue[qi].rate.max(8000);
        let res = self.ensure_output(want).and_then(|rate| self.open_deck(qi, at, rate, false));
        match res {
            Ok(d) => {
                self.cur = Some(d);
                self.idx = qi;
                self.playing = true;
                self.error = None;
                if at > 0.0 {
                    self.ramp = Some(Ramp { from: 0.0, to: 1.0, pos: 0, len: (self.out_rate() as f32 * 0.015) as u64, then: None });
                }
                self.emit_queue();
                if fresh {
                    self.emit_track();
                }
                self.prepare_next();
            }
            Err(e) => self.fail(e),
        }
    }

    fn resume(&mut self) {
        let Some(d) = self.cur.as_ref() else { return };
        let rate = d.src.info.out_rate;
        let pos = self.position();
        match self.ensure_output(rate) {
            Ok(r) if r == rate => {
                self.playing = true;
                self.ramp = Some(Ramp { from: 0.0, to: 1.0, pos: 0, len: (r as f32 * 0.015) as u64, then: None });
                // Se mexeram no crossfade/fila com a música pausada, a próxima ainda não foi preparada.
                if self.inc.is_none() && self.reopen_next.is_none() {
                    self.prepare_next();
                }
            }
            Ok(_) => {
                self.playing = true;
                self.seek_now(pos);
            }
            Err(e) => self.fail(e),
        }
    }

    fn seek(&mut self, s: f64) {
        if self.cur.is_none() {
            return;
        }
        if self.playing {
            self.fade_then(0.015, After::Seek(s));
        } else {
            self.seek_now(s);
        }
    }

    fn seek_now(&mut self, s: f64) {
        // Seek no meio de um crossfade: a faixa que entrava vira a atual.
        if self.fade.take().is_some() {
            if let Some((d, _)) = self.inc.take() {
                self.cur = Some(d);
            }
        }
        let Some(qi) = self.cur.as_ref().map(|d| d.qi) else { return };
        if !self.playing {
            // Pausado: só reposiciona, a placa abre quando der play.
            let rate = self.cur.as_ref().unwrap().src.info.out_rate;
            match self.open_deck(qi, s, rate, false) {
                Ok(d) => self.cur = Some(d),
                Err(e) => self.fail(e),
            }
            return;
        }
        self.start(qi, s, false);
    }

    fn fail(&mut self, e: anyhow::Error) {
        self.error = Some(format!("{e:#}"));
        self.playing = false;
        self.close_output();
        self.emit();
    }

    fn recover(&mut self, e: anyhow::Error) {
        // Placa sumiu, foi tomada por outro app, mudou o padrão do Windows...
        let pos = self.position();
        self.close_output();
        let Some(qi) = self.cur.as_ref().map(|d| d.qi) else { return self.fail(e) };
        let rate = self.queue.get(qi).map(|t| t.rate).unwrap_or(48000);
        match self.ensure_output(rate) {
            Ok(_) => self.start(qi, pos, false),
            Err(_) => self.fail(e),
        }
    }

    // ------------------------------------------------ próxima faixa

    fn prepare_next(&mut self) {
        if self.fade.is_some() || self.pending.is_some() {
            return;
        }
        self.generation += 1;
        self.inc = None;
        self.reopen_next = None;
        let (Some(cur), Some(out)) = (self.cur.as_ref(), self.out.as_ref()) else { return };
        let Some(ni) = self.next_index(cur.qi, false) else { return };
        let ct = &self.queue[cur.qi];
        let nt = &self.queue[ni];
        let in_order = !self.shuffle && nt.album_key == ct.album_key && (nt.disc, nt.track) > (ct.disc, ct.track);
        let same_rate = !out.exclusive || nt.rate == out.rate || nt.rate == cur.src.info.native_rate;
        let plan = if !self.prefs.crossfade {
            if same_rate { Plan::Gapless } else { Plan::Reopen }
        } else if in_order {
            // Igual o Spotify: crossfade dentro do álbum também, menos em faixa colada na próxima.
            if same_rate { Plan::Auto } else { Plan::Reopen }
        } else {
            Plan::Crossfade
        };
        eprintln!("[toxify] próxima: {} ({:?}, {} Hz → placa {} Hz)", nt.path, plan, nt.rate, out.rate);
        if plan == Plan::Reopen {
            // Abre na hora da troca, na taxa da faixa.
            self.reopen_next = Some(ni);
        } else {
            self.request(ni, plan, false);
        }
    }

    fn out_rate(&self) -> u32 {
        self.out.as_ref().map(|o| o.rate).unwrap_or(0)
    }

    fn position(&self) -> f64 {
        let d = match (&self.fade, &self.inc, &self.cur) {
            (Some(_), Some((d, _)), _) => d,
            (_, _, Some(d)) => d,
            _ => return 0.0,
        };
        d.src.position_frames() as f64 / d.src.info.out_rate.max(1) as f64
    }

    // ------------------------------------------------ render

    fn render_once(&mut self) -> Result<()> {
        let out = self.out.as_ref().unwrap();
        if out.started {
            out.event.wait_for_event(1000).map_err(|e| anyhow!("placa parou de responder: {e}"))?;
        }
        let n = self.out.as_ref().unwrap().client.get_available_space_in_frames()? as usize;
        if n == 0 {
            return Ok(());
        }
        self.fill(n);
        let rate = self.out_rate().max(1);
        if let Some(h) = self.heard.as_mut() {
            h.1 += n as f64 / rate as f64;
        }
        let out = self.out.as_mut().unwrap();
        encode(out.kind, &self.mix, &mut self.bytes);
        out.render.write_to_device(&self.bytes, None)?;
        if !out.started {
            out.client.start_stream()?;
            out.started = true;
        }
        Ok(())
    }

    fn stretching(&self) -> bool {
        self.prefs.speed != 1.0 || self.prefs.pitch != 1.0
    }

    /// Enche `n` frames pra placa. Com velocidade/tom em 1.0 é o caminho de sempre (intocado);
    /// senão lê `velocidade × n` frames da música e o Signalsmith entrega exatamente `n`.
    fn fill(&mut self, n: usize) {
        let rate = self.out_rate();
        if !self.stretching() {
            if self.stretch.is_some() {
                self.stretch = None;
                self.stretch_acc = 0.0;
            }
            self.render_src(n);
        } else {
            if self.stretch.as_ref().map(|s| s.rate) != Some(rate) {
                let mut st = crate::stretch::Stretch::new(CH, rate);
                st.set_pitch(self.prefs.pitch);
                self.stretch = Some(st);
                self.stretch_acc = 0.0;
            }
            self.stretch_acc += n as f64 * self.prefs.speed as f64;
            let m = self.stretch_acc.floor() as usize;
            self.stretch_acc -= m as f64;
            self.render_src(m);
            std::mem::swap(&mut self.mix, &mut self.raw);
            self.mix.clear();
            self.mix.resize(n * CH, 0.0);
            if let Some(st) = self.stretch.as_mut() {
                st.process(&self.raw, &mut self.mix);
            }
        }
        self.apply_gain(rate);
    }

    /// Mistura `n` frames das faixas (crossfade, emenda) em `self.mix`, sem volume.
    fn render_src(&mut self, n: usize) {
        self.mix.clear();
        self.mix.resize(n * CH, 0.0);
        let rate = self.out_rate();
        let rg_mode = self.prefs.replaygain;
        let mut w = 0;
        while w < n {
            let Some(cur) = self.cur.as_mut() else { break };

            // Crossfade em andamento.
            if let Some(f) = self.fade.as_mut() {
                let chunk = (n - w).min((f.len - f.pos) as usize);
                self.a.clear();
                self.a.resize(chunk * CH, 0.0);
                self.b.clear();
                self.b.resize(chunk * CH, 0.0);
                cur.src.read(&mut self.a);
                let ra = cur.rg.gain(rg_mode);
                let mut rb = 1.0;
                if let Some((d, _)) = self.inc.as_mut() {
                    d.src.read(&mut self.b);
                    rb = d.rg.gain(rg_mode);
                }
                for i in 0..chunk {
                    let t = (f.pos + i as u64) as f32 / f.len as f32;
                    let (ga, gb) = ((t * FRAC_PI_2).cos() * ra, (t * FRAC_PI_2).sin() * rb);
                    for c in 0..CH {
                        self.mix[(w + i) * CH + c] = self.a[i * CH + c] * ga + self.b[i * CH + c] * gb;
                    }
                }
                f.pos += chunk as u64;
                w += chunk;
                if f.pos >= f.len {
                    self.fade = None;
                    if let Some((d, _)) = self.inc.take() {
                        self.cur = Some(d);
                    }
                    self.prepare_next();
                }
                continue;
            }

            // Hora de começar o crossfade?
            let mut limit = n - w;
            if let Some((_, plan @ (Plan::Crossfade | Plan::Auto))) = &self.inc {
                let xf = (self.prefs.crossfade_secs as f64 * rate as f64) as u64;
                let info = &cur.src.info;
                if *plan == Plan::Auto && info.glued() {
                    // Faixa colada na próxima: deixa emendar sozinha no fim do arquivo.
                    eprintln!("[toxify] faixa termina colada na próxima: emenda sem crossfade");
                    self.inc.as_mut().unwrap().1 = Plan::Gapless;
                    continue;
                }
                let end = if info.end_frame() > info.start_frame { info.end_frame() } else { info.total_frames };
                let start_at = end.saturating_sub(xf);
                let pos = cur.src.position_frames();
                if pos >= start_at {
                    let len = end.saturating_sub(pos).clamp((rate as f64 * 0.5) as u64, xf.max(1));
                    eprintln!(
                        "[toxify] crossfade: {:.1}s, começando em {:.1}s (som acaba em {:.1}s, arquivo em {:.1}s)",
                        len as f64 / rate as f64,
                        pos as f64 / rate as f64,
                        end as f64 / rate as f64,
                        info.total_frames as f64 / rate as f64
                    );
                    self.fade = Some(Fade { pos: 0, len });
                    self.idx = self.inc.as_ref().unwrap().0.qi;
                    self.emit_queue();
                    self.emit_track();
                    continue;
                }
                limit = limit.min((start_at - pos) as usize);
            }

            let got = cur.src.read(&mut self.mix[w * CH..(w + limit) * CH]);
            let g = cur.rg.gain(rg_mode);
            if g != 1.0 {
                self.mix[w * CH..(w + got) * CH].iter_mut().for_each(|x| *x *= g);
            }
            w += got;
            if got < limit {
                if cur.src.drained() {
                    if !self.advance() {
                        break;
                    }
                } else {
                    break; // decodificador atrasou: o resto fica em silêncio
                }
            }
        }
    }

    /// A faixa atual acabou sozinha. `false` = não tem como continuar neste buffer.
    fn advance(&mut self) -> bool {
        match self.inc.take() {
            Some((d, plan)) if d.src.info.out_rate == self.out_rate() && plan != Plan::Reopen => {
                self.idx = d.qi;
                self.cur = Some(d);
                self.emit_queue();
                self.emit_track();
                self.prepare_next();
                true
            }
            _ => {
                match self.reopen_next.take().or_else(|| self.next_index(self.idx, false)) {
                    Some(ni) => self.after = Some(After::Start(ni)),
                    None => self.after = Some(After::Stop),
                }
                false
            }
        }
    }

    fn apply_gain(&mut self, rate: u32) {
        let target = vol_gain(self.prefs.volume);
        let n = self.mix.len() / CH;
        // Volume: rampa linear dentro do buffer pra não "chiar" ao arrastar.
        if self.gain != target || target != 1.0 {
            let from = self.gain;
            for i in 0..n {
                let g = from + (target - from) * (i as f32 / n as f32);
                for c in 0..CH {
                    self.mix[i * CH + c] *= g;
                }
            }
            let boosted = from > 1.0 || target > 1.0;
            self.gain = target;
            if boosted {
                for x in self.mix.iter_mut() {
                    *x = soft_limit(*x);
                }
            }
        }
        if let Some(r) = self.ramp.as_mut() {
            for i in 0..n {
                let g = ramp_value(r);
                for c in 0..CH {
                    self.mix[i * CH + c] *= g;
                }
                if r.pos < r.len {
                    r.pos += 1;
                }
            }
            if r.pos >= r.len {
                let done = self.ramp.take().unwrap();
                if let Some(t) = done.then {
                    // Termina em silêncio e executa a ação no laço principal.
                    self.after = Some(t);
                }
            }
        }
        let _ = rate;
    }

    // ------------------------------------------------ eventos pra tela

    /// Fecha a conta da faixa que saiu (quanto ouviu, se pulou).
    fn finish_heard(&mut self) {
        if let Some((id, secs)) = self.heard.take() {
            let _ = self.app.emit("track-ended", Heard { id, secs, skipped: self.manual && secs < 30.0 });
        }
        self.manual = false;
    }

    fn emit_track(&mut self) {
        self.finish_heard();
        if let Some(t) = self.queue.get(self.idx) {
            self.heard = Some((t.id, 0.0));
            let _ = self.app.emit("track-started", t.id);
        }
    }

    fn emit_queue(&self) {
        let _ = self.app.emit("queue", QueueMsg { ids: self.queue.iter().map(|t| t.id).collect(), index: self.idx });
    }

    fn emit(&mut self) {
        self.last_emit = Instant::now();
        let shown = match (&self.fade, &self.inc, &self.cur) {
            (Some(_), Some((d, _)), _) => Some(d),
            (_, _, Some(d)) => Some(d),
            _ => None,
        };
        let out = self.out.as_ref();
        let (src_rate, src_bits, resampled, duration) = shown
            .map(|d| (d.src.info.native_rate, d.src.info.bits, d.src.info.resampled(), d.src.info.total_frames as f64 / d.src.info.out_rate.max(1) as f64))
            .unwrap_or_default();
        let rg_gain = shown.map(|d| d.rg.gain(self.prefs.replaygain)).unwrap_or(1.0);
        let bitperfect = out.is_some_and(|o| o.exclusive && (o.valid_bits >= src_bits || o.kind == Kind::F32 && src_bits <= 24))
            && shown.is_some()
            && !resampled
            && rg_gain == 1.0
            && self.fade.is_none()
            && self.ramp.is_none()
            && vol_gain(self.prefs.volume) == 1.0
            && !self.stretching();
        let next_id = if self.fade.is_some() { None } else { self.next_index(self.idx, false).and_then(|i| self.queue.get(i)).map(|t| t.id) };
        let glued = self.cur.as_ref().is_some_and(|d| d.src.info.glued());
        let next_mode = match (&self.inc, self.reopen_next) {
            _ if next_id.is_none() => "",
            (Some((_, Plan::Crossfade)), _) => "crossfade",
            (Some((_, Plan::Auto)), _) => {
                if glued { "emendada" } else { "crossfade" }
            }
            (Some((_, Plan::Gapless)), _) => "emendada",
            (_, Some(_)) => "troca de taxa",
            _ => "",
        };
        let st = State {
            track_id: self.queue.get(self.idx).map(|t| t.id).filter(|_| self.cur.is_some()),
            index: self.idx,
            playing: self.playing,
            position: self.position(),
            duration,
            out_rate: out.map(|o| o.rate).unwrap_or(0),
            out_bits: out.map(|o| if o.kind == Kind::F32 { 32 } else { o.valid_bits }).unwrap_or(0),
            out_mode: out.map(|o| if o.exclusive { "exclusivo" } else { "compartilhado" }).unwrap_or(""),
            device: out.map(|o| o.device.clone()).unwrap_or_default(),
            src_rate,
            src_bits,
            resampled,
            bitperfect,
            volume: self.prefs.volume,
            speed: self.prefs.speed,
            pitch: self.prefs.pitch,
            crossfade: self.prefs.crossfade,
            crossfade_secs: self.prefs.crossfade_secs,
            shuffle: self.shuffle,
            repeat: self.repeat,
            exclusive: self.prefs.exclusive,
            next_id,
            next_mode,
            error: self.error.clone(),
            replaygain: self.prefs.replaygain,
            rg_gain,
        };
        let _ = self.app.emit("player", st);
    }
}

fn ramp_value(r: &Ramp) -> f32 {
    if r.len == 0 {
        return r.to;
    }
    r.from + (r.to - r.from) * (r.pos as f32 / r.len as f32)
}

/// Curva perceptiva do volume. 1.0 continua exatamente 1.0 (bit-perfect).
/// Acima de 1 é o "boost": até 2x (+6 dB), com o limitador segurando os picos.
fn vol_gain(v: f32) -> f32 {
    if v == 1.0 {
        1.0
    } else if v > 1.0 {
        v.min(2.0)
    } else {
        v.max(0.0).powi(3)
    }
}

/// Limitador suave pro boost: até 0,9 passa reto; acima, encosta devagar em 1,0 em vez de cortar seco.
fn soft_limit(x: f32) -> f32 {
    const KNEE: f32 = 0.9;
    let a = x.abs();
    if a <= KNEE {
        x
    } else {
        x.signum() * (KNEE + (1.0 - KNEE) * ((a - KNEE) / (1.0 - KNEE)).tanh())
    }
}
