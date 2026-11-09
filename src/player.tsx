import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, Lyrics, Track } from "./api";
import { IClose, ICollapse, IDisc, IExpand, IMic, IMute, IPerson, INext, IPanel, IPause, IPlay, IPrev, IQueue, IRepeat, IShuffle, IVolume } from "./icons";
import { fmtTime, khz, showArtists } from "./model";
import { usePosition, useStore } from "./store";
import { ArtistImage, ArtistLinks, Cover, LikeButton, useCoverColor } from "./ui";

// ---------------------------------------------------------------- barra de baixo

function Progress() {
  const { player } = useStore();
  const pos = usePosition();
  const [drag, setDrag] = useState<number | null>(null);
  // Depois de soltar, mostra o ponto escolhido até o motor chegar lá (senão a barra volta e pula).
  const [target, setTarget] = useState<{ t: number; at: number } | null>(null);
  const dragging = useRef(false);
  const bar = useRef<HTMLDivElement>(null);
  const dur = player?.duration ?? 0;
  useEffect(() => {
    if (target && (Math.abs(pos - target.t) < 1.2 || performance.now() - target.at > 2500)) setTarget(null);
  }, [pos, target]);
  useEffect(() => setTarget(null), [player?.track_id]);
  const shown = drag ?? target?.t ?? pos;
  const pct = dur ? Math.min(100, (shown / dur) * 100) : 0;
  const at = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur;
  };
  const seekTo = (t: number) => {
    setTarget({ t, at: performance.now() });
    api.seek(t);
  };
  return (
    <div className="progress">
      <span className="time">{fmtTime(shown)}</span>
      <div
        className={`slider ${drag != null ? "dragging" : ""}`}
        ref={bar}
        onPointerDown={(e) => {
          if (!dur || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          setDrag(at(e.clientX));
        }}
        onPointerMove={(e) => dragging.current && setDrag(at(e.clientX))}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          setDrag(null);
          seekTo(at(e.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setDrag(null);
        }}
        role="slider"
        aria-label="Posição da música"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(shown)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") seekTo(Math.min(dur, shown + 5));
          if (e.key === "ArrowLeft") seekTo(Math.max(0, shown - 5));
        }}
      >
        <div className="slider-track">
          <div className="slider-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="slider-thumb" style={{ left: `${pct}%` }} />
      </div>
      <span className="time">{fmtTime(dur)}</span>
    </div>
  );
}

function Volume() {
  const { player } = useStore();
  const [v, setV] = useState<number | null>(null);
  const vol = v ?? player?.volume ?? 1;
  const last = useRef(1);
  // A "parede" dos 100%: quebra quando passa dela, se reconstrói quando volta.
  const [fx, setFx] = useState<"" | "break" | "fix">("");
  const prev = useRef(vol);
  useEffect(() => {
    const was = prev.current;
    prev.current = vol;
    if (was <= 1 && vol > 1) setFx("break");
    else if (was > 1 && vol <= 1) setFx("fix");
  }, [vol]);
  useEffect(() => {
    if (!fx) return;
    const t = window.setTimeout(() => setFx(""), 750);
    return () => window.clearTimeout(t);
  }, [fx]);
  const set = (x: number) => {
    // Os 100% "grudam": é onde o som sai intocado.
    if (Math.abs(x - 1) < 0.04) x = 1;
    setV(x);
    api.setVolume(x);
  };
  useEffect(() => {
    if (v != null && player && Math.abs(player.volume - v) < 0.001) setV(null);
  }, [player, v]);
  const boost = vol > 1;
  const title = boost
    ? `Boost de +${Math.round((vol - 1) * 100)}%: o som é amplificado e um limitador segura os picos`
    : vol === 1
      ? "Volume 100%: o som sai intocado"
      : "Abaixo de 100% o volume é digital (o som é recalculado)";
  return (
    <div className={`volume ${boost ? "boost" : ""} ${fx}`} title={title}>
      <button
        className="icon-btn"
        aria-label={vol > 0 ? "Silenciar" : "Tirar do mudo"}
        onClick={() => {
          if (vol > 0) {
            last.current = vol;
            set(0);
          } else set(last.current || 1);
        }}
      >
        {vol > 0 ? <IVolume size={18} /> : <IMute size={18} />}
      </button>
      <div className="vol-track">
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={vol}
          onChange={(e) => set(Number(e.target.value))}
          aria-label="Volume"
          aria-valuetext={`${Math.round(vol * 100)}%`}
          style={{ ["--p" as string]: `${(vol / 2) * 100}%` }}
        />
        <span className="vol-wall" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <span className="vol-boost" aria-hidden={!boost}>
        +{Math.round((vol - 1) * 100)}%
      </span>
    </div>
  );
}

function QualityBadge() {
  const { player, lib } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (!player || player.track_id == null) return null;
  const t = lib.byId.get(player.track_id);
  const converted = player.resampled || player.out_mode === "compartilhado";
  const label = `${t?.codec ?? ""} ${player.src_bits ? player.src_bits + "/" : ""}${khz(player.src_rate)}`;
  let status: string;
  if (!player.out_rate) status = "Pausado. Quando tocar, mostra aqui como o som está saindo.";
  else if (player.out_mode === "compartilhado") status = "Modo compartilhado: o Windows mistura e converte o som.";
  else if (player.resampled) status = `Convertida de ${khz(player.src_rate)} pra ${khz(player.out_rate)} kHz pra entrar no crossfade sem pausa.`;
  else if (player.speed !== 1 || player.pitch !== 1) status = "Velocidade ou tom alterados: o som é processado. Voltando os dois ao normal, sai intocado.";
  else if (player.volume > 1) status = `Boost de +${Math.round((player.volume - 1) * 100)}%: o som é amplificado e um limitador segura os picos. Em 100% sai intocado.`;
  else if (player.volume < 1) status = "Volume abaixo de 100%: o som é recalculado. Em 100% sai intocado.";
  else status = "Bit-perfect: sai exatamente como está no arquivo.";
  return (
    <div className="qbadge-wrap" ref={ref}>
      <button className={`qbadge ${converted ? "warn" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title={status}>
        <span className="dot" />
        {label}
        {player.crossfade && <span className="xf">Crossfade {player.crossfade_secs}s</span>}
        {(player.speed !== 1 || player.pitch !== 1) && (
          <span className="xf">
            {player.speed !== 1 ? `${player.speed.toFixed(2).replace(".", ",")}x` : ""}
            {player.speed !== 1 && player.pitch !== 1 ? " · " : ""}
            {player.pitch !== 1 ? `tom ${Math.round(12 * Math.log2(player.pitch)) > 0 ? "+" : ""}${Math.round(12 * Math.log2(player.pitch))}` : ""}
          </span>
        )}
      </button>
      {open && <QualityPopover status={status} />}
    </div>
  );
}

function QualityPopover({ status }: { status: string }) {
  const { player, lib } = useStore();
  const [secs, setSecs] = useState(player?.crossfade_secs ?? 6);
  if (!player) return null;
  const t = player.track_id != null ? lib.byId.get(player.track_id) : null;
  return (
    <div className="popover qpop">
      <h3>Som</h3>
      <dl>
        <dt>Arquivo</dt>
        <dd>
          {t?.codec} · {player.src_bits ? `${player.src_bits} bit · ` : ""}
          {khz(player.src_rate)} kHz
        </dd>
        <dt>Saída</dt>
        <dd>
          {player.out_rate ? `${khz(player.out_rate)} kHz · ${player.out_bits} bit · ${player.out_mode}` : "pausado"}
        </dd>
        <dt>Placa</dt>
        <dd>{player.device || "Padrão do Windows"}</dd>
      </dl>
      <p className={`qstatus ${player.resampled || player.out_mode === "compartilhado" ? "warn" : ""}`}>{status}</p>
      <label className="row-toggle">
        <span>
          Crossfade
          <small>Mistura uma música na outra ao trocar de álbum. Álbum em ordem emenda sem pausa.</small>
        </span>
        <Switch on={player.crossfade} onChange={(on) => api.setCrossfade(on, secs)} />
      </label>
      {player.crossfade && (
        <div className="xf-slider">
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={secs}
            onChange={(e) => setSecs(Number(e.target.value))}
            onPointerUp={() => api.setCrossfade(true, secs)}
            onKeyUp={() => api.setCrossfade(true, secs)}
            aria-label="Duração do crossfade"
            style={{ ["--p" as string]: `${((secs - 1) / 11) * 100}%` }}
          />
          <span>{secs} s</span>
        </div>
      )}
      <SpeedPitch />
      <label className="row-toggle">
        <span>
          Modo exclusivo
          <small>O Toxify fala direto com a placa, sem o Windows no meio. Outros apps ficam sem som enquanto toca.</small>
        </span>
        <Switch on={player.exclusive} onChange={(on) => api.setExclusive(on)} />
      </label>
    </div>
  );
}

/** Velocidade (sem mudar o tom) e tom em semitons (sem mudar a velocidade). Em "normal" o som sai intocado. */
function SpeedPitch() {
  const { player } = useStore();
  const [speed, setSpeed] = useState<number | null>(null);
  const [semi, setSemi] = useState<number | null>(null);
  const curSpeed = speed ?? player?.speed ?? 1;
  const curSemi = semi ?? Math.round(12 * Math.log2(player?.pitch || 1));
  const applySpeed = (v: number) => {
    setSpeed(v);
    api.setSpeed(v);
  };
  const applySemi = (s: number) => {
    setSemi(s);
    api.setPitch(Math.pow(2, s / 12));
  };
  useEffect(() => {
    if (speed != null && player && Math.abs(player.speed - speed) < 0.001) setSpeed(null);
    if (semi != null && player && Math.round(12 * Math.log2(player.pitch || 1)) === semi) setSemi(null);
  }, [player, speed, semi]);
  const fmtSpeed = (v: number) => `${v.toFixed(2).replace(".", ",")}x`;
  const fmtSemi = (s: number) => (s === 0 ? "original" : `${s > 0 ? "+" : ""}${s} semitom${Math.abs(s) === 1 ? "" : "s"}`);
  return (
    <div className="sp-box">
      <div className="sp-row">
        <span className="sp-label">Velocidade</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={curSpeed}
          onChange={(e) => applySpeed(Number(e.target.value))}
          aria-label="Velocidade"
          style={{ ["--p" as string]: `${((curSpeed - 0.5) / 1.5) * 100}%` }}
        />
        <span className="sp-val">{fmtSpeed(curSpeed)}</span>
        <button className="sp-reset" disabled={curSpeed === 1} onClick={() => applySpeed(1)} title="Voltar ao normal">
          1x
        </button>
      </div>
      <div className="sp-row">
        <span className="sp-label">Tom</span>
        <input
          type="range"
          min={-12}
          max={12}
          step={1}
          value={curSemi}
          onChange={(e) => applySemi(Number(e.target.value))}
          aria-label="Tom"
          style={{ ["--p" as string]: `${((curSemi + 12) / 24) * 100}%` }}
        />
        <span className="sp-val">{fmtSemi(curSemi)}</span>
        <button className="sp-reset" disabled={curSemi === 0} onClick={() => applySemi(0)} title="Voltar ao tom original">
          0
        </button>
      </div>
      {(curSpeed !== 1 || curSemi !== 0) && <small className="sp-note">Com velocidade ou tom mexidos o som é processado. Voltando os dois ao normal, sai intocado de novo.</small>}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={(e) => (e.preventDefault(), onChange(!on))}>
      <i />
    </button>
  );
}

export function PlayerBar() {
  const s = useStore();
  const p = s.player;
  const t = p?.track_id != null ? s.lib.byId.get(p.track_id) : undefined;
  const al = t ? s.lib.albumByKey.get(t.album_key) : undefined;
  const repeatLabel = ["Repetir", "Repetir a fila", "Repetir esta música"][p?.repeat ?? 0];
  return (
    <footer className="playerbar">
      <div className="pb-left">
        {t ? (
          <>
            <Cover id={t.id} size={120} className="pb-cover" />
            <div className="pb-text">
              <a className="pb-title" onClick={() => al && s.go({ v: "album", key: al.key })} title={t.title}>
                {t.title}
              </a>
              <span className="pb-artist">
                <ArtistLinks text={t.artist || t.album_artist} />
              </span>
            </div>
            <LikeButton id={t.id} />
          </>
        ) : null}
      </div>
      <div className="pb-center">
        <div className="pb-buttons">
          <button className={`icon-btn ${p?.shuffle ? "active" : ""}`} onClick={() => api.setShuffle(!p?.shuffle)} aria-label="Aleatório" title="Aleatório">
            <IShuffle size={18} />
          </button>
          <button className="icon-btn" onClick={() => api.prev()} aria-label="Anterior" title="Anterior">
            <IPrev size={18} />
          </button>
          <button className="pb-play" onClick={() => api.toggle()} aria-label={p?.playing ? "Pausar" : "Tocar"}>
            {p?.playing ? <IPause size={18} /> : <IPlay size={18} />}
          </button>
          <button className="icon-btn" onClick={() => api.next()} aria-label="Próxima" title="Próxima">
            <INext size={18} />
          </button>
          <button
            className={`icon-btn ${p?.repeat ? "active" : ""} ${p?.repeat === 2 ? "one" : ""}`}
            onClick={() => api.setRepeat(((p?.repeat ?? 0) + 1) % 3)}
            aria-label={repeatLabel}
            title={repeatLabel}
          >
            <IRepeat size={18} />
          </button>
        </div>
        <Progress />
      </div>
      <div className="pb-right">
        <QualityBadge />
        <button className={`icon-btn ${s.route.v === "lyrics" ? "active" : ""}`} onClick={() => (s.route.v === "lyrics" ? s.back() : s.go({ v: "lyrics" }))} aria-label="Letra" title="Letra">
          <IMic size={18} />
        </button>
        <button className={`icon-btn ${s.route.v === "queue" ? "active" : ""}`} onClick={() => (s.route.v === "queue" ? s.back() : s.go({ v: "queue" }))} aria-label="Fila" title="Fila">
          <IQueue size={18} />
        </button>
        <button className={`icon-btn ${s.rightPanel ? "active" : ""}`} onClick={() => s.setRightPanel(!s.rightPanel)} aria-label="Tocando agora" title="Painel Tocando agora">
          <IPanel size={18} />
        </button>
        <Volume />
        <button className="icon-btn" onClick={() => openStage(s.route.v === "lyrics" ? "letra" : "capa")} aria-label="Tela cheia" title="Tela cheia">
          <IExpand size={18} />
        </button>
      </div>
      {p?.error && <div className="pb-error">Não deu pra tocar: {p.error}</div>}
    </footer>
  );
}

// ---------------------------------------------------------------- letra

export function useLyrics(t: Track | undefined) {
  const [state, setState] = useState<{ id: number; lyrics: Lyrics | null; loading: boolean } | null>(null);
  useEffect(() => {
    if (!t) return;
    let alive = true;
    setState({ id: t.id, lyrics: null, loading: true });
    api
      .lyrics(t.id)
      .then((l) => alive && setState({ id: t.id, lyrics: l, loading: false }))
      .catch(() => alive && setState({ id: t.id, lyrics: null, loading: false }));
    return () => {
      alive = false;
    };
  }, [t?.id]);
  return state?.id === t?.id ? state : null;
}

export function LyricsView({ lyrics, big }: { lyrics: Lyrics; big?: boolean }) {
  const pos = usePosition();
  const [showTr, setShowTr] = useState(() => localStorage.getItem("toxify.tr") !== "0");
  const box = useRef<HTMLDivElement>(null);
  const hasTr = !!lyrics.translation && !!lyrics.lang && lyrics.lang !== "pt";
  // A letra entra uns 0,3 s antes pra dar tempo de ler.
  const cur = useMemo(() => {
    if (!lyrics.synced) return -1;
    let i = -1;
    for (let k = 0; k < lyrics.lines.length; k++) if (lyrics.lines[k].t <= pos + 0.3) i = k;
    return i;
  }, [pos, lyrics]);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`);
    if (el && box.current) {
      const b = box.current;
      b.scrollTo({ top: el.offsetTop - b.clientHeight * (big ? 0.35 : 0.3), behavior: "smooth" });
    }
  }, [cur, big]);
  if (!lyrics.lines.length) return <p className="lyr-empty">{lyrics.source === "instrumental" ? "Instrumental, sem letra." : "Sem letra."}</p>;
  return (
    <div className={`lyrics ${big ? "lyrics-big" : ""} ${lyrics.synced ? "" : "unsynced"}`}>
      {hasTr && (
        <button
          className={`lyr-tr-toggle ${showTr ? "on" : ""}`}
          onClick={() => {
            setShowTr(!showTr);
            localStorage.setItem("toxify.tr", showTr ? "0" : "1");
          }}
        >
          Tradução
        </button>
      )}
      <div className="lyr-lines" ref={box}>
        {lyrics.lines.map((l, i) => (
          <p
            key={i}
            data-i={i}
            className={i === cur ? "cur" : i < cur ? "past" : ""}
            onClick={() => lyrics.synced && api.seek(l.t)}
            title={lyrics.synced ? "Ir pra esse trecho" : undefined}
          >
            {l.text || "♪"}
            {hasTr && showTr && lyrics.translation![i] && lyrics.translation![i] !== l.text && <em>{lyrics.translation![i]}</em>}
          </p>
        ))}
        <small className="lyr-src">Letra: {lyrics.source}{hasTr ? " · Tradução automática" : ""}</small>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- painel da direita

export function NowPlaying() {
  const s = useStore();
  const p = s.player;
  const t = p?.track_id != null ? s.lib.byId.get(p.track_id) : undefined;
  const next = p?.next_id != null ? s.lib.byId.get(p.next_id) : undefined;
  const lyr = useLyrics(t);
  const al = t ? s.lib.albumByKey.get(t.album_key) : undefined;
  const artist = al ? s.lib.artistByKey.get(al.artistKey) : undefined;
  if (!t)
    return (
      <aside className="right panel np-empty">
        <p>Escolhe uma música pra começar.</p>
      </aside>
    );
  const mode =
    p?.next_mode === "crossfade"
      ? `entra com crossfade de ${p.crossfade_secs}s`
      : p?.next_mode === "emendada"
        ? "emendada, sem pausa"
        : p?.next_mode === "troca de taxa"
          ? `a placa troca pra ${khz(next?.rate ?? 0)} kHz`
          : "";
  return (
    <aside className="right panel">
      <div className="np-head">
        <span>{al?.title}</span>
        <button className="icon-btn" onClick={() => s.setRightPanel(false)} aria-label="Fechar painel">
          <IClose size={18} />
        </button>
      </div>
      <div className="np-scroll">
        <Cover id={t.id} size={640} className="np-cover" />
        <div className="np-title">
          <div>
            <h3 title={t.title}>{t.title}</h3>
            <span>
              <ArtistLinks text={t.artist || t.album_artist} />
            </span>
          </div>
          <LikeButton id={t.id} size={22} />
        </div>

        <section className="np-card np-lyrics">
          <div className="np-card-head">
            <h4>Letra</h4>
            <a onClick={() => s.go({ v: "lyrics" })}>Abrir</a>
          </div>
          {lyr?.loading ? <p className="lyr-empty">Procurando a letra…</p> : lyr?.lyrics ? <LyricsView lyrics={lyr.lyrics} /> : <p className="lyr-empty">Não achei a letra dessa.</p>}
        </section>

        {next && (
          <section className="np-card np-next" onDoubleClick={() => api.next()}>
            <div className="np-card-head">
              <h4>A seguir</h4>
              <a onClick={() => s.go({ v: "queue" })}>Abrir fila</a>
            </div>
            <div className="np-next-row">
              <Cover id={next.id} size={80} className="np-next-cover" />
              <div>
                <b>{next.title}</b>
                <span>{showArtists(next.artist || next.album_artist)}</span>
                {mode && <small>{mode}</small>}
              </div>
            </div>
          </section>
        )}

        {artist && (
          <section className="np-card np-artist" onClick={() => s.go({ v: "artist", key: artist.key })}>
            <ArtistImage name={artist.name} className="np-artist-img" />
            <div className="np-artist-text">
              <h4>{artist.name}</h4>
              <span>
                {artist.albums.length} {artist.albums.length === 1 ? "álbum" : "álbuns"} · {artist.tracks.length} músicas na sua biblioteca
              </span>
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- tela cheia (igual a do Spotify)

export type StageMode = "capa" | "letra" | "artista";

export const openStage = (mode: StageMode = "capa") => window.dispatchEvent(new CustomEvent("toxify:stage", { detail: mode }));

export function Stage({ mode, setMode, onClose }: { mode: StageMode; setMode: (m: StageMode) => void; onClose: () => void }) {
  const s = useStore();
  const t = s.player?.track_id != null ? s.lib.byId.get(s.player.track_id) : undefined;
  const al = t ? s.lib.albumByKey.get(t.album_key) : undefined;
  const ar = al ? s.lib.artistByKey.get(al.artistKey) : undefined;
  const color = useCoverColor(t?.id);
  const lyr = useLyrics(mode === "letra" ? t : undefined);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const modes: [StageMode, string, ReactNode][] = [
    ["capa", "Capa", <IDisc size={20} key="c" />],
    ["artista", "Artista", <IPerson size={20} key="a" />],
    ["letra", "Letra", <IMic size={20} key="l" />],
  ];
  return (
    <div className={`stage stage-${mode}`} style={{ ["--hero" as string]: color }}>
      <div className="stage-top">
        <span className="stage-title">{al?.title ?? "Toxify"}</span>
        <div className="stage-btns">
          {modes.map(([m, label, icon]) => (
            <button key={m} className={`stage-btn ${mode === m ? "on" : ""}`} onClick={() => setMode(m)} aria-label={label} title={label}>
              {icon}
            </button>
          ))}
          <span className="stage-sep" />
          <button className="stage-btn" onClick={onClose} aria-label="Sair da tela cheia" title="Sair da tela cheia (Esc)">
            <ICollapse size={20} />
          </button>
        </div>
      </div>
      {!t ? (
        <div className="stage-empty">Toca uma música pra ver aqui.</div>
      ) : mode === "capa" ? (
        <div className="stage-cover" key={t.id}>
          <Cover id={t.id} size={1200} className="stage-art" alt={t.title} />
          <div className="stage-info">
            <h1>{t.title}</h1>
            <p>
              <ArtistLinks text={t.artist || t.album_artist} />
            </p>
          </div>
        </div>
      ) : mode === "letra" ? (
        <div className="stage-lyrics">
          {lyr?.loading ? (
            <p className="lyr-empty big">Procurando a letra…</p>
          ) : lyr?.lyrics ? (
            <LyricsView lyrics={lyr.lyrics} big />
          ) : (
            <p className="lyr-empty big">Não achei a letra dessa.</p>
          )}
        </div>
      ) : ar ? (
        <div className="stage-artist" key={ar.key}>
          <ArtistImage name={ar.name} className="stage-artist-bg" />
          <div className="stage-artist-shade" />
          <div className="stage-artist-info">
            <h1>{ar.name}</h1>
            <p>
              {ar.albums.length} {ar.albums.length === 1 ? "álbum" : "álbuns"} · {ar.tracks.length} músicas na sua biblioteca
            </p>
            <div className="stage-albums">
              {ar.albums.slice(0, 6).map((a) => (
                <button
                  key={a.key}
                  className="stage-album"
                  onClick={() => {
                    onClose();
                    s.go({ v: "album", key: a.key });
                  }}
                >
                  <Cover id={a.coverId} size={300} />
                  <span>{a.title}</span>
                  <small>{a.year || ""}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="stage-empty">Sem informações do artista.</div>
      )}
    </div>
  );
}
