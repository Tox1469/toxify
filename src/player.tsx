import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, Lyrics, Track } from "./api";
import { IClose, ICollapse, IDisc, IExpand, IMic, IMute, IPerson, INext, IPanel, IPause, IPlay, IPrev, IQueue, IRepeat, IShuffle, IVolume } from "./icons";
import { dec, LANG, t } from "./i18n";
import { fmtTime, khz, plural, showArtists } from "./model";
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
        aria-label={t("Posição da música")}
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
    ? t("Boost de +{n}%: o som é amplificado e um limitador segura os picos", { n: Math.round((vol - 1) * 100) })
    : vol === 1
      ? t("Volume 100%: o som sai intocado")
      : t("Abaixo de 100% o volume é digital (o som é recalculado)");
  return (
    <div className={`volume ${boost ? "boost" : ""} ${fx}`} title={title}>
      <button
        className="icon-btn"
        aria-label={vol > 0 ? t("Silenciar") : t("Tirar do mudo")}
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
  const tr = lib.byId.get(player.track_id);
  const converted = player.resampled || player.out_mode === "compartilhado";
  const label = `${tr?.codec ?? ""} ${player.src_bits ? player.src_bits + "/" : ""}${khz(player.src_rate)}`;
  let status: string;
  if (!player.out_rate) status = t("Pausado. Quando tocar, mostra aqui como o som está saindo.");
  else if (player.out_mode === "compartilhado") status = t("Modo compartilhado: o Windows mistura e converte o som.");
  else if (player.resampled) status = t("Convertida de {from} pra {to} kHz pra entrar no crossfade sem pausa.", { from: khz(player.src_rate), to: khz(player.out_rate) });
  else if (player.speed !== 1 || player.pitch !== 1) status = t("Velocidade ou tom alterados: o som é processado. Voltando os dois ao normal, sai intocado.");
  else if (player.volume > 1) status = t("Boost de +{n}%: o som é amplificado e um limitador segura os picos. Em 100% sai intocado.", { n: Math.round((player.volume - 1) * 100) });
  else if (player.volume < 1) status = t("Volume abaixo de 100%: o som é recalculado. Em 100% sai intocado.");
  else status = t("Bit-perfect: sai exatamente como está no arquivo.");
  return (
    <div className="qbadge-wrap" ref={ref}>
      <button className={`qbadge ${converted ? "warn" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title={status}>
        <span className="dot" />
        {label}
        {player.crossfade && <span className="xf">Crossfade {player.crossfade_secs}s</span>}
        {(player.speed !== 1 || player.pitch !== 1) && (
          <span className="xf">
            {player.speed !== 1 ? `${dec(player.speed.toFixed(2))}x` : ""}
            {player.speed !== 1 && player.pitch !== 1 ? " · " : ""}
            {player.pitch !== 1 ? `${t("tom")} ${Math.round(12 * Math.log2(player.pitch)) > 0 ? "+" : ""}${Math.round(12 * Math.log2(player.pitch))}` : ""}
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
  const tr = player.track_id != null ? lib.byId.get(player.track_id) : null;
  return (
    <div className="popover qpop">
      <h3>{t("Som")}</h3>
      <dl>
        <dt>{t("Arquivo")}</dt>
        <dd>
          {tr?.codec} · {player.src_bits ? `${player.src_bits} bit · ` : ""}
          {khz(player.src_rate)} kHz
        </dd>
        <dt>{t("Saída")}</dt>
        <dd>
          {player.out_rate ? `${khz(player.out_rate)} kHz · ${player.out_bits} bit · ${t(player.out_mode)}` : t("pausado")}
        </dd>
        <dt>{t("Placa")}</dt>
        <dd>{player.device || t("Padrão do Windows")}</dd>
      </dl>
      <p className={`qstatus ${player.resampled || player.out_mode === "compartilhado" ? "warn" : ""}`}>{status}</p>
      <label className="row-toggle">
        <span>
          Crossfade
          <small>{t("Mistura uma música na outra ao trocar de álbum. Álbum em ordem emenda sem pausa.")}</small>
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
            aria-label={t("Duração do crossfade")}
            style={{ ["--p" as string]: `${((secs - 1) / 11) * 100}%` }}
          />
          <span>{secs} s</span>
        </div>
      )}
      <SpeedPitch />
      <label className="row-toggle">
        <span>
          {t("Modo exclusivo")}
          <small>{t("O Toxify fala direto com a placa, sem o Windows no meio. Outros apps ficam sem som enquanto toca.")}</small>
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
  const fmtSpeed = (v: number) => `${dec(v.toFixed(2))}x`;
  const fmtSemi = (s: number) =>
    s === 0 ? t("original") : Math.abs(s) === 1 ? t("{n} semitom", { n: s > 0 ? "+1" : "-1" }) : t("{n} semitons", { n: `${s > 0 ? "+" : ""}${s}` });
  return (
    <div className="sp-box">
      <div className="sp-row">
        <span className="sp-label">{t("Velocidade")}</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={curSpeed}
          onChange={(e) => applySpeed(Number(e.target.value))}
          aria-label={t("Velocidade")}
          style={{ ["--p" as string]: `${((curSpeed - 0.5) / 1.5) * 100}%` }}
        />
        <span className="sp-val">{fmtSpeed(curSpeed)}</span>
        <button className="sp-reset" disabled={curSpeed === 1} onClick={() => applySpeed(1)} title={t("Voltar ao normal")}>
          1x
        </button>
      </div>
      <div className="sp-row">
        <span className="sp-label">{t("Tom")}</span>
        <input
          type="range"
          min={-12}
          max={12}
          step={1}
          value={curSemi}
          onChange={(e) => applySemi(Number(e.target.value))}
          aria-label={t("Tom")}
          style={{ ["--p" as string]: `${((curSemi + 12) / 24) * 100}%` }}
        />
        <span className="sp-val">{fmtSemi(curSemi)}</span>
        <button className="sp-reset" disabled={curSemi === 0} onClick={() => applySemi(0)} title={t("Voltar ao tom original")}>
          0
        </button>
      </div>
      {(curSpeed !== 1 || curSemi !== 0) && (
        <small className="sp-note">{t("Com velocidade ou tom mexidos o som é processado. Voltando os dois ao normal, sai intocado de novo.")}</small>
      )}
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
  const tr = p?.track_id != null ? s.lib.byId.get(p.track_id) : undefined;
  const al = tr ? s.lib.albumByKey.get(tr.album_key) : undefined;
  const repeatLabel = [t("Repetir"), t("Repetir a fila"), t("Repetir esta música")][p?.repeat ?? 0];
  return (
    <footer className="playerbar">
      <div className="pb-left">
        {tr ? (
          <>
            <Cover id={tr.id} size={120} className="pb-cover" />
            <div className="pb-text">
              <a className="pb-title" onClick={() => al && s.go({ v: "album", key: al.key })} title={tr.title}>
                {tr.title}
              </a>
              <span className="pb-artist">
                <ArtistLinks text={tr.artist || tr.album_artist} />
              </span>
            </div>
            <LikeButton id={tr.id} />
          </>
        ) : null}
      </div>
      <div className="pb-center">
        <div className="pb-buttons">
          <button className={`icon-btn ${p?.shuffle ? "active" : ""}`} onClick={() => api.setShuffle(!p?.shuffle)} aria-label={t("Aleatório")} title={t("Aleatório")}>
            <IShuffle size={18} />
          </button>
          <button className="icon-btn" onClick={() => api.prev()} aria-label={t("Anterior")} title={t("Anterior")}>
            <IPrev size={18} />
          </button>
          <button className="pb-play" onClick={() => api.toggle()} aria-label={p?.playing ? t("Pausar") : t("Tocar")}>
            {p?.playing ? <IPause size={18} /> : <IPlay size={18} />}
          </button>
          <button className="icon-btn" onClick={() => api.next()} aria-label={t("Próxima")} title={t("Próxima")}>
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
        <button className={`icon-btn ${s.route.v === "lyrics" ? "active" : ""}`} onClick={() => (s.route.v === "lyrics" ? s.back() : s.go({ v: "lyrics" }))} aria-label={t("Letra")} title={t("Letra")}>
          <IMic size={18} />
        </button>
        <button className={`icon-btn ${s.route.v === "queue" ? "active" : ""}`} onClick={() => (s.route.v === "queue" ? s.back() : s.go({ v: "queue" }))} aria-label={t("Fila")} title={t("Fila")}>
          <IQueue size={18} />
        </button>
        <button className={`icon-btn ${s.rightPanel ? "active" : ""}`} onClick={() => s.setRightPanel(!s.rightPanel)} aria-label={t("Tocando agora")} title={t("Painel Tocando agora")}>
          <IPanel size={18} />
        </button>
        <Volume />
        <button className="icon-btn" onClick={() => openStage(s.route.v === "lyrics" ? "letra" : "capa")} aria-label={t("Tela cheia")} title={t("Tela cheia")}>
          <IExpand size={18} />
        </button>
      </div>
      {p?.error && <div className="pb-error">{t("Não deu pra tocar: {error}", { error: p.error })}</div>}
    </footer>
  );
}

// ---------------------------------------------------------------- letra

export function useLyrics(tr: Track | undefined) {
  const [state, setState] = useState<{ id: number; lyrics: Lyrics | null; loading: boolean } | null>(null);
  useEffect(() => {
    if (!tr) return;
    let alive = true;
    setState({ id: tr.id, lyrics: null, loading: true });
    api
      .lyrics(tr.id, LANG)
      .then((l) => alive && setState({ id: tr.id, lyrics: l, loading: false }))
      .catch(() => alive && setState({ id: tr.id, lyrics: null, loading: false }));
    return () => {
      alive = false;
    };
  }, [tr?.id]);
  return state?.id === tr?.id ? state : null;
}

export function LyricsView({ lyrics, big }: { lyrics: Lyrics; big?: boolean }) {
  const pos = usePosition();
  const [showTr, setShowTr] = useState(() => localStorage.getItem("toxify.tr") !== "0");
  const box = useRef<HTMLDivElement>(null);
  const hasTr = !!lyrics.translation && !!lyrics.lang && lyrics.lang !== LANG;
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
  if (!lyrics.lines.length) return <p className="lyr-empty">{lyrics.source === "instrumental" ? t("Instrumental, sem letra.") : t("Sem letra.")}</p>;
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
          {t("Tradução")}
        </button>
      )}
      <div className="lyr-lines" ref={box}>
        {lyrics.lines.map((l, i) => (
          <p
            key={i}
            data-i={i}
            className={i === cur ? "cur" : i < cur ? "past" : ""}
            onClick={() => lyrics.synced && api.seek(l.t)}
            title={lyrics.synced ? t("Ir pra esse trecho") : undefined}
          >
            {l.text || "♪"}
            {hasTr && showTr && lyrics.translation![i] && lyrics.translation![i] !== l.text && <em>{lyrics.translation![i]}</em>}
          </p>
        ))}
        <small className="lyr-src">
          {t("Letra: {source}", { source: t(lyrics.source) })}
          {hasTr ? ` · ${t("Tradução automática")}` : ""}
        </small>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- painel da direita

export function NowPlaying() {
  const s = useStore();
  const p = s.player;
  const tr = p?.track_id != null ? s.lib.byId.get(p.track_id) : undefined;
  const next = p?.next_id != null ? s.lib.byId.get(p.next_id) : undefined;
  const lyr = useLyrics(tr);
  const al = tr ? s.lib.albumByKey.get(tr.album_key) : undefined;
  const artist = al ? s.lib.artistByKey.get(al.artistKey) : undefined;
  if (!tr)
    return (
      <aside className="right panel np-empty">
        <p>{t("Escolhe uma música pra começar.")}</p>
      </aside>
    );
  const mode =
    p?.next_mode === "crossfade"
      ? t("entra com crossfade de {n}s", { n: p.crossfade_secs })
      : p?.next_mode === "emendada"
        ? t("emendada, sem pausa")
        : p?.next_mode === "troca de taxa"
          ? t("a placa troca pra {rate} kHz", { rate: khz(next?.rate ?? 0) })
          : "";
  return (
    <aside className="right panel">
      <div className="np-head">
        <span>{al?.title}</span>
        <button className="icon-btn" onClick={() => s.setRightPanel(false)} aria-label={t("Fechar painel")}>
          <IClose size={18} />
        </button>
      </div>
      <div className="np-scroll">
        <Cover id={tr.id} size={640} className="np-cover" />
        <div className="np-title">
          <div>
            <h3 title={tr.title}>{tr.title}</h3>
            <span>
              <ArtistLinks text={tr.artist || tr.album_artist} />
            </span>
          </div>
          <LikeButton id={tr.id} size={22} />
        </div>

        <section className="np-card np-lyrics">
          <div className="np-card-head">
            <h4>{t("Letra")}</h4>
            <a onClick={() => s.go({ v: "lyrics" })}>{t("Abrir")}</a>
          </div>
          {lyr?.loading ? (
            <p className="lyr-empty">{t("Procurando a letra…")}</p>
          ) : lyr?.lyrics ? (
            <LyricsView lyrics={lyr.lyrics} />
          ) : (
            <p className="lyr-empty">{t("Não achei a letra dessa.")}</p>
          )}
        </section>

        {next && (
          <section className="np-card np-next" onDoubleClick={() => api.next()}>
            <div className="np-card-head">
              <h4>{t("A seguir")}</h4>
              <a onClick={() => s.go({ v: "queue" })}>{t("Abrir fila")}</a>
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
                {t("{albums} · {tracks} na sua biblioteca", {
                  albums: plural(artist.albums.length, t("álbum"), t("álbuns")),
                  tracks: plural(artist.tracks.length, t("música"), t("músicas")),
                })}
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
  const tr = s.player?.track_id != null ? s.lib.byId.get(s.player.track_id) : undefined;
  const al = tr ? s.lib.albumByKey.get(tr.album_key) : undefined;
  const ar = al ? s.lib.artistByKey.get(al.artistKey) : undefined;
  const color = useCoverColor(tr?.id);
  const lyr = useLyrics(mode === "letra" ? tr : undefined);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const modes: [StageMode, string, ReactNode][] = [
    ["capa", t("Capa"), <IDisc size={20} key="c" />],
    ["artista", t("Artista"), <IPerson size={20} key="a" />],
    ["letra", t("Letra"), <IMic size={20} key="l" />],
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
          <button className="stage-btn" onClick={onClose} aria-label={t("Sair da tela cheia")} title={t("Sair da tela cheia (Esc)")}>
            <ICollapse size={20} />
          </button>
        </div>
      </div>
      {!tr ? (
        <div className="stage-empty">{t("Toca uma música pra ver aqui.")}</div>
      ) : mode === "capa" ? (
        <div className="stage-cover" key={tr.id}>
          <Cover id={tr.id} size={1200} className="stage-art" alt={tr.title} />
          <div className="stage-info">
            <h1>{tr.title}</h1>
            <p>
              <ArtistLinks text={tr.artist || tr.album_artist} />
            </p>
          </div>
        </div>
      ) : mode === "letra" ? (
        <div className="stage-lyrics">
          {lyr?.loading ? (
            <p className="lyr-empty big">{t("Procurando a letra…")}</p>
          ) : lyr?.lyrics ? (
            <LyricsView lyrics={lyr.lyrics} big />
          ) : (
            <p className="lyr-empty big">{t("Não achei a letra dessa.")}</p>
          )}
        </div>
      ) : ar ? (
        <div className="stage-artist" key={ar.key}>
          <ArtistImage name={ar.name} className="stage-artist-bg" />
          <div className="stage-artist-shade" />
          <div className="stage-artist-info">
            <h1>{ar.name}</h1>
            <p>
              {t("{albums} · {tracks} na sua biblioteca", {
                albums: plural(ar.albums.length, t("álbum"), t("álbuns")),
                tracks: plural(ar.tracks.length, t("música"), t("músicas")),
              })}
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
        <div className="stage-empty">{t("Sem informações do artista.")}</div>
      )}
    </div>
  );
}
