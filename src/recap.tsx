// Retrospectiva do ano: soma o histórico de audições (tabela plays) e mostra em telas cheias, uma por vez.
// Tudo calculado no computador; nada sai dele. No fim, um cartão 1080x1920 pra salvar como imagem.
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, coverUrl, artistUrl, Track } from "./api";
import { IBack, IClose, IDownload, IForward } from "./icons";
import { LOCALE, t } from "./i18n";
import { Album, Artist, fmtLong, genreLabel, Library, showArtists } from "./model";
import { useStore } from "./store";
import { ArtistImage, Cover } from "./ui";

type Log = [number, number, number, boolean][];

type Part = "madrugada" | "manhã" | "tarde" | "noite";

export type Recap = {
  year: number;
  /** Dezembro/janeiro: a retrospectiva "de verdade". No resto do ano: "até agora". */
  final: boolean;
  /** Primeira audição do ano, quando o histórico começou depois de janeiro ("desde 8 de novembro"). */
  since: number | null;
  secs: number;
  bestDay: { at: number; secs: number } | null;
  tracks: { track: Track; plays: number }[];
  artists: { artist: Artist; secs: number }[];
  album: { album: Album; secs: number } | null;
  genres: { genre: string; share: number }[];
  part: { key: Part; share: number } | null;
  /** Artistas ouvidos pela primeira vez no ano. `allNew` = o histórico começou este ano (todos seriam "novos"). */
  newArtists: Artist[];
  allNew: boolean;
  distinct: number;
  skipped: { track: Track; n: number } | null;
  /** Fração do tempo em arquivos acima da qualidade de CD (mais de 16 bits ou acima de 48 kHz). */
  hires: number;
};

/** Ano mostrado: em janeiro ainda é o do ano que passou; dezembro e janeiro = retrospectiva final. */
export function recapPeriod(now = new Date()) {
  const m = now.getMonth();
  const year = m === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return { year, final: m === 11 || m === 0 };
}

const PARTS: [Part, number, number][] = [
  ["madrugada", 0, 6],
  ["manhã", 6, 12],
  ["tarde", 12, 18],
  ["noite", 18, 24],
];

export function buildRecap(log: Log, lib: Library, year: number, final: boolean): Recap {
  const from = new Date(year, 0, 1).getTime() / 1000;
  const to = new Date(year + 1, 0, 1).getTime() / 1000;
  const artistOf = (tr: Track) => {
    const al = lib.albumByKey.get(tr.album_key);
    return al ? lib.artistByKey.get(al.artistKey) : undefined;
  };
  const firstSeen = new Map<string, number>();
  const days = new Map<string, { at: number; secs: number }>();
  const plays = new Map<number, number>();
  const trackSecs = new Map<number, number>();
  const artistSecs = new Map<Artist, number>();
  const albumSecs = new Map<Album, number>();
  const genreSecs = new Map<string, number>();
  const skips = new Map<number, number>();
  const hours = new Array(24).fill(0);
  let secs = 0;
  let hires = 0;
  let firstAt: number | null = null;
  const firstEver = log.length ? log[0][1] : to;

  // O log vem em ordem de tempo: a primeira vez que um artista aparece é a primeira audição dele.
  for (const [id, at, s, skipped] of log) {
    const tr = lib.byId.get(id);
    if (!tr) continue;
    const ar = artistOf(tr);
    if (ar && !firstSeen.has(ar.key)) firstSeen.set(ar.key, at);
    if (at < from || at >= to) continue;
    if (skipped) skips.set(id, (skips.get(id) ?? 0) + 1);
    if (!(s > 0)) continue;
    firstAt ??= at;
    secs += s;
    const d = new Date(at * 1000);
    const dk = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const day = days.get(dk) ?? { at, secs: 0 };
    day.secs += s;
    days.set(dk, day);
    hours[d.getHours()] += s;
    if (s >= Math.min(30, tr.secs * 0.5)) plays.set(id, (plays.get(id) ?? 0) + 1);
    trackSecs.set(id, (trackSecs.get(id) ?? 0) + s);
    if (ar) artistSecs.set(ar, (artistSecs.get(ar) ?? 0) + s);
    const al = lib.albumByKey.get(tr.album_key);
    if (al) albumSecs.set(al, (albumSecs.get(al) ?? 0) + s);
    const g = lib.genreOf.get(id);
    if (g) genreSecs.set(g, (genreSecs.get(g) ?? 0) + s);
    if (tr.bits > 16 || tr.rate > 48000) hires += s;
  }

  const byDesc = <K,>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const genreTotal = [...genreSecs.values()].reduce((a, b) => a + b, 0);
  const partSecs = PARTS.map(([key, a, b]) => ({ key, secs: hours.slice(a, b).reduce((x, y) => x + y, 0) })).sort((a, b) => b.secs - a.secs);
  const artists = byDesc(artistSecs).map(([artist, secs]) => ({ artist, secs }));
  const topSkip = byDesc(skips)[0];
  return {
    year,
    final,
    since: firstAt != null && firstAt > from + 31 * 86400 ? firstAt : null,
    secs,
    bestDay: [...days.values()].sort((a, b) => b.secs - a.secs)[0] ?? null,
    tracks: [...trackSecs.keys()]
      .sort((a, b) => (plays.get(b) ?? 0) - (plays.get(a) ?? 0) || trackSecs.get(b)! - trackSecs.get(a)!)
      .slice(0, 5)
      .map((id) => ({ track: lib.byId.get(id)!, plays: plays.get(id) ?? 0 })),
    artists: artists.slice(0, 5),
    album: byDesc(albumSecs).map(([album, secs]) => ({ album, secs }))[0] ?? null,
    genres: genreTotal ? byDesc(genreSecs).slice(0, 4).map(([genre, s]) => ({ genre, share: s / genreTotal })) : [],
    part: secs ? { key: partSecs[0].key, share: partSecs[0].secs / secs } : null,
    newArtists: artists.filter((a) => (firstSeen.get(a.artist.key) ?? 0) >= from).map((a) => a.artist),
    allNew: firstEver >= from,
    distinct: artistSecs.size,
    skipped: topSkip && topSkip[1] >= 2 ? { track: lib.byId.get(topSkip[0])!, n: topSkip[1] } : null,
    hires: secs ? hires / secs : 0,
  };
}

// ---------------------------------------------------------------- textos

const num = (n: number) => Math.round(n).toLocaleString(LOCALE);
const dayName = (at: number) => new Date(at * 1000).toLocaleDateString(LOCALE, { day: "numeric", month: "long" });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const recapTitle = (r: Recap) => (r.final ? t("Retrospectiva {year}", { year: r.year }) : t("Seu {year} até agora", { year: r.year }));

const PART_TEXT: Record<Part, [string, string]> = {
  madrugada: [t("Você é da madrugada"), t("entre meia-noite e 6 da manhã")],
  manhã: [t("Você é da manhã"), t("entre 6 da manhã e meio-dia")],
  tarde: [t("Você é da tarde"), t("entre meio-dia e 6 da tarde")],
  noite: [t("Você é da noite"), t("entre 6 da tarde e meia-noite")],
};

// ---------------------------------------------------------------- entrada na Home

/** Faixa discreta na Home. Só aparece com pelo menos 30 minutos ouvidos no período. */
export function RecapBanner() {
  const { lib } = useStore();
  const [log, setLog] = useState<Log | null>(null);
  const [open, setOpen] = useState(false);
  const { year, final } = recapPeriod();
  useEffect(() => {
    // Tudo até o fim do período: o que veio antes do ano diz quem é artista "novo".
    const end = Math.min(Date.now(), new Date(year + 1, 0, 1).getTime()) / 1000;
    api
      .playLog(0, Math.ceil(end) + 1)
      .then(setLog)
      .catch(() => setLog([]));
  }, [year]);
  const recap = useMemo(() => (log && lib.tracks.length ? buildRecap(log, lib, year, final) : null), [log, lib, year, final]);
  if (!recap || recap.secs < 1800) return null;
  return (
    <>
      <button className="recap-banner" onClick={() => setOpen(true)}>
        <Curves className="recap-banner-curves" />
        <span className="recap-banner-text">
          <b>{final ? t("Sua Retrospectiva {year}", { year }) : t("Seu {year} até agora", { year })}</b>
          <span>{t("{time} de música, seus artistas e seus horários", { time: fmtLong(recap.secs) })}</span>
        </span>
        <span className="recap-banner-go">{t("Ver")}</span>
      </button>
      {open && createPortal(<RecapView recap={recap} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** As duas curvas do logo: uma música saindo, outra entrando. */
function Curves({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 600 260" aria-hidden="true" preserveAspectRatio="none">
      <path className="out" d="M20 40 C 240 40, 360 220, 580 220" />
      <path d="M20 220 C 240 220, 360 40, 580 40" />
    </svg>
  );
}

// ---------------------------------------------------------------- telas

function RecapView({ recap: r, onClose }: { recap: Recap; onClose: () => void }) {
  const slides = useMemo(() => buildSlides(r), [r]);
  const [i, setI] = useState(0);
  const last = slides.length - 1;
  const go = (n: number) => setI(Math.max(0, Math.min(last, n)));
  useEffect(() => {
    getCurrentWindow().setFullscreen(true).catch(() => {});
    return () => void getCurrentWindow().setFullscreen(false).catch(() => {});
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.target as HTMLElement)?.closest("button")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") setI((x) => Math.min(last, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [last, onClose]);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className={`recap recap-${i % 3}`} onClick={() => go(i + 1)} role="dialog" aria-label={recapTitle(r)}>
      <Curves className="recap-curves" />
      <div className="recap-progress" onClick={stop}>
        {slides.map((_, n) => (
          <button key={n} className={n < i ? "done" : n === i ? "on" : ""} onClick={() => go(n)} aria-label={t("Tela {n}", { n: n + 1 })} />
        ))}
      </div>
      <div className="recap-top" onClick={stop}>
        <span className="recap-brand">{recapTitle(r)}</span>
        <button className="stage-btn" onClick={onClose} aria-label={t("Fechar")} title={t("Fechar (Esc)")}>
          <IClose size={20} />
        </button>
      </div>
      <div className="recap-slide" key={i}>
        {slides[i]}
      </div>
      <div className="recap-nav" onClick={stop}>
        <button className="stage-btn" onClick={() => go(i - 1)} disabled={i === 0} aria-label={t("Voltar")}>
          <IBack size={20} />
        </button>
        <button className="stage-btn" onClick={() => go(i + 1)} disabled={i === last} aria-label={t("Próxima")}>
          <IForward size={20} />
        </button>
      </div>
    </div>
  );
}

function buildSlides(r: Recap): ReactNode[] {
  const out: ReactNode[] = [];
  out.push(
    <div className="rs rs-intro">
      <span className="rs-kicker">{r.final ? t("Sua Retrospectiva") : t("Seu ano até agora")}</span>
      <h1 className="rs-year">{r.year}</h1>
      <p className="rs-sub">
        {r.since
          ? t("Desde {date}, quando o Toxify começou a contar.", { date: dayName(r.since) })
          : t("Tudo o que tocou no Toxify em {year}.", { year: r.year })}
      </p>
      <p className="rs-hint">{t("Clique ou use as setas")}</p>
    </div>,
  );
  out.push(
    <div className="rs">
      <span className="rs-kicker">{t("Você ouviu")}</span>
      <h1 className="rs-huge">{num(r.secs / 60)}</h1>
      <h2 className="rs-title">{t("minutos de música")}</h2>
      {r.bestDay && (
        <p className="rs-sub">{t("O dia em que você mais ouviu foi {date}: {min} minutos.", { date: dayName(r.bestDay.at), min: num(r.bestDay.secs / 60) })}</p>
      )}
    </div>,
  );
  if (r.artists.length) {
    const [top, ...rest] = r.artists;
    out.push(
      <div className="rs rs-split">
        <ArtistImage name={top.artist.name} className="rs-hero-img round" />
        <div>
          <span className="rs-kicker">{t("Seu artista número 1")}</span>
          <h1 className="rs-big">{top.artist.name}</h1>
          <p className="rs-sub">{t("{min} minutos juntos", { min: num(top.secs / 60) })}</p>
          {rest.length > 0 && (
            <ol className="rs-list" start={2}>
              {rest.map((a) => (
                <li key={a.artist.key}>
                  <ArtistImage name={a.artist.name} className="rs-thumb round" />
                  <span className="rs-name">{a.artist.name}</span>
                  <span className="rs-meta">{t("{min} min", { min: num(a.secs / 60) })}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>,
    );
  }
  if (r.tracks.length) {
    out.push(
      <div className="rs">
        <span className="rs-kicker">{t("Suas músicas mais tocadas")}</span>
        <ol className="rs-list rs-list-big">
          {r.tracks.map(({ track, plays }) => (
            <li key={track.id}>
              <Cover id={track.id} size={120} className="rs-thumb" />
              <span className="rs-name">
                {track.title}
                <small>{showArtists(track.artist || track.album_artist)}</small>
              </span>
              <span className="rs-meta">{plays === 1 ? t("1 vez") : t("{n} vezes", { n: plays })}</span>
            </li>
          ))}
        </ol>
      </div>,
    );
  }
  if (r.album) {
    out.push(
      <div className="rs rs-split">
        <Cover id={r.album.album.coverId} size={600} className="rs-hero-img" />
        <div>
          <span className="rs-kicker">{t("Seu álbum mais ouvido")}</span>
          <h1 className="rs-big">{r.album.album.title}</h1>
          <p className="rs-sub">{r.album.album.artist}</p>
          <p className="rs-sub">{t("{min} minutos", { min: num(r.album.secs / 60) })}</p>
        </div>
      </div>,
    );
  }
  if (r.genres.length) {
    out.push(
      <div className="rs">
        <span className="rs-kicker">{t("Seus gêneros")}</span>
        <h1 className="rs-big">{genreLabel(r.genres[0].genre)}</h1>
        <ul className="rs-bars">
          {r.genres.map((g) => (
            <li key={g.genre}>
              <span className="rs-name">{genreLabel(g.genre)}</span>
              <span className="rs-bar">
                <i style={{ width: pct(g.share) }} />
              </span>
              <span className="rs-meta">{pct(g.share)}</span>
            </li>
          ))}
        </ul>
      </div>,
    );
  }
  if (r.part) {
    const [head, when] = PART_TEXT[r.part.key];
    out.push(
      <div className="rs">
        <span className="rs-kicker">{t("Seu horário")}</span>
        <h1 className="rs-big">{head}</h1>
        <p className="rs-sub">{t("{pct} do que você ouviu foi {when}.", { pct: pct(r.part.share), when })}</p>
      </div>,
    );
  }
  if (r.distinct > 0) {
    const names = (r.allNew ? r.artists.map((a) => a.artist) : r.newArtists).slice(0, 3).map((a) => a.name);
    const n = r.allNew ? r.distinct : r.newArtists.length;
    if (n > 0)
      out.push(
        <div className="rs">
          <span className="rs-kicker">{r.allNew ? t("Pelos seus fones passaram") : t("Você descobriu")}</span>
          <h1 className="rs-huge">{num(n)}</h1>
          <h2 className="rs-title">
            {r.allNew ? (n === 1 ? t("artista") : t("artistas diferentes")) : n === 1 ? t("artista novo") : t("artistas novos")}
          </h2>
          {names.length > 0 && <p className="rs-sub">{t("Entre eles: {names}.", { names: names.join(", ") })}</p>}
        </div>,
      );
  }
  if (r.skipped) {
    out.push(
      <div className="rs rs-split">
        <Cover id={r.skipped.track.id} size={600} className="rs-hero-img" />
        <div>
          <span className="rs-kicker">{t("A que você mais pulou")}</span>
          <h1 className="rs-big">{r.skipped.track.title}</h1>
          <p className="rs-sub">{t("{n} vezes. Mesmo assim, ela continua na sua biblioteca.", { n: r.skipped.n })}</p>
        </div>
      </div>,
    );
  }
  if (r.hires > 0) {
    out.push(
      <div className="rs">
        <span className="rs-kicker">{t("Qualidade")}</span>
        <h1 className="rs-huge">{pct(r.hires)}</h1>
        <h2 className="rs-title">{t("do seu tempo foi acima da qualidade de CD")}</h2>
        <p className="rs-sub">{t("Arquivos com mais de 16 bits ou acima de 48 kHz, tocados sem perda.")}</p>
      </div>,
    );
  }
  out.push(<Summary r={r} />);
  return out;
}

// ---------------------------------------------------------------- cartão pra salvar

function Summary({ r }: { r: Recap }) {
  const s = useStore();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [img, setImg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    drawCard(r).then((c) => {
      if (!alive) return;
      canvas.current = c;
      setImg(c.toDataURL("image/png"));
    });
    return () => {
      alive = false;
    };
  }, [r]);
  const saveImage = async () => {
    const c = canvas.current;
    if (!c) return;
    setBusy(true);
    try {
      const path = await save({ defaultPath: `Toxify ${recapTitle(r)}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
      if (!path) return;
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
      if (!blob) throw new Error("png");
      await api.saveFile(path, Array.from(new Uint8Array(await blob.arrayBuffer())));
      s.showToast({ text: t("Imagem salva") });
    } catch (e) {
      s.showToast({ text: t("Não deu pra salvar a imagem: {e}", { e: String(e) }) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rs rs-split rs-summary">
      {img ? <img className="rs-card" src={img} alt={recapTitle(r)} /> : <div className="rs-card" />}
      <div>
        <span className="rs-kicker">{t("Pra guardar")}</span>
        <h1 className="rs-big">{t("Seu ano num cartão")}</h1>
        <p className="rs-sub">{t("Salve a imagem e mostre pra quem quiser.")}</p>
        <button
          className="btn primary rs-save"
          disabled={!img || busy}
          onClick={(e) => {
            e.stopPropagation();
            saveImage();
          }}
        >
          <IDownload size={18} />
          {t("Salvar imagem")}
        </button>
      </div>
    </div>
  );
}

const W = 1080;
const H = 1920;
const DISPLAY = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((ok) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => ok(null), 4000);
    img.onload = () => (window.clearTimeout(timer), ok(img));
    img.onerror = () => (window.clearTimeout(timer), ok(null));
    img.src = src;
  });
}

/** Corta o texto com "…" pra caber na largura. */
function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

async function drawCard(r: Recap): Promise<HTMLCanvasElement> {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8b7cf6";

  g.fillStyle = "#0b0b0c";
  g.fillRect(0, 0, W, H);
  // As curvas do logo atravessando o topo.
  g.lineCap = "round";
  g.lineWidth = 22;
  g.strokeStyle = accent;
  g.globalAlpha = 0.28;
  g.beginPath();
  g.moveTo(-40, 200);
  g.bezierCurveTo(380, 200, 640, 560, 1120, 560);
  g.stroke();
  g.globalAlpha = 1;
  g.beginPath();
  g.moveTo(-40, 560);
  g.bezierCurveTo(380, 560, 640, 200, 1120, 200);
  g.stroke();

  const text = (s: string, x: number, y: number, size: number, weight: number, color: string, max = W - 2 * x) => {
    g.font = `${weight} ${size}px ${DISPLAY}`;
    g.fillStyle = color;
    g.fillText(fit(g, s, max), x, y);
  };
  const X = 88;
  text("Toxify", X, 120, 44, 700, "#b3b3b3");
  text(recapTitle(r), X, 690, 84, 800, "#ffffff");
  if (r.since) text(t("desde {date}", { date: dayName(r.since) }), X, 750, 38, 500, "#b3b3b3");

  text(num(r.secs / 60), X, 960, 190, 800, accent);
  text(t("minutos de música"), X, 1030, 46, 600, "#ffffff");

  const col = (title: string, rows: string[], x: number) => {
    text(title, x, 1170, 34, 700, "#b3b3b3", 420);
    rows.forEach((row, n) => {
      text(`${n + 1}`, x, 1240 + n * 64, 40, 800, accent, 40);
      text(row, x + 48, 1240 + n * 64, 40, 600, "#ffffff", 400);
    });
  };
  col(t("Artistas"), r.artists.map((a) => a.artist.name), X);
  col(t("Músicas"), r.tracks.map((x) => x.track.title), 560);

  let y = 1620;
  if (r.album) {
    const img = await loadImage(coverUrl(r.album.album.coverId, 600));
    const size = 200;
    if (img) {
      g.save();
      g.beginPath();
      g.roundRect(X, y - 150, size, size, 16);
      g.clip();
      g.drawImage(img, X, y - 150, size, size);
      g.restore();
    }
    const tx = img ? X + size + 36 : X;
    text(t("Álbum mais ouvido"), tx, y - 90, 32, 700, "#b3b3b3", W - tx - X);
    text(r.album.album.title, tx, y - 36, 44, 700, "#ffffff", W - tx - X);
    text(r.album.album.artist, tx, y + 14, 34, 500, "#b3b3b3", W - tx - X);
    y += 130;
  }
  const facts = [
    r.genres[0] ? `${t("Gênero")}: ${genreLabel(r.genres[0].genre)}` : "",
    r.hires > 0 ? `${pct(r.hires)} ${t("acima da qualidade de CD")}` : "",
  ].filter(Boolean);
  text(facts.join("  ·  "), X, y, 34, 600, "#ffffff");
  text("toxify-player.vercel.app", X, H - 80, 30, 500, "#8a8a8f");
  // Foto do artista número 1 no canto, se carregar.
  if (r.artists[0]) {
    const img = await loadImage(artistUrl(r.artists[0].artist.name));
    if (img) {
      const s = 150;
      g.save();
      g.beginPath();
      g.arc(W - X - s / 2, 120 - 14, s / 2, 0, Math.PI * 2);
      g.clip();
      const k = Math.max(s / img.width, s / img.height);
      g.drawImage(img, W - X - s / 2 - (img.width * k) / 2, 106 - (img.height * k) / 2, img.width * k, img.height * k);
      g.restore();
    }
  }
  return c;
}
