import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, artistUrl, coverUrl, Track } from "./api";
import { IClock, IHeart, IHeartLine, IMore, INote, IPause, IPlay } from "./icons";
import { Album, Artist, fmtTime, isHiRes, norm, quality, splitArtists } from "./model";
import { askAddToPlaylist, MenuItem, PlayCtx, useStore } from "./store";

/** Tipo do arrasto de músicas (pra soltar numa playlist da lateral). */
export const DRAG_TRACKS = "application/x-toxify-tracks";

// ---------------------------------------------------------------- imagens

/** Hash curtinho do caminho+álbum: se o número da faixa for reaproveitado por outro arquivo, o endereço muda. */
const ver = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

export function Cover({ id, size = 300, className = "", alt = "" }: { id: number | null | undefined; size?: number; className?: string; alt?: string }) {
  const [bad, setBad] = useState(false);
  const { lib } = useStore();
  const t = id != null ? lib.byId.get(id) : undefined;
  const v = t ? ver(`${t.path}|${t.album_key}`) : "";
  useEffect(() => setBad(false), [id, v]);
  if (id == null || bad)
    return (
      <div className={`cover cover-empty ${className}`} aria-label={alt}>
        <INote size={28} />
      </div>
    );
  return <img className={`cover ${className}`} src={coverUrl(id, size, v)} alt={alt} draggable={false} onError={() => setBad(true)} loading="lazy" />;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function ArtistImage({ name, className = "" }: { name: string; className?: string }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [name]);
  if (bad || !name)
    return (
      <div className={`artist-img artist-empty ${className}`} style={{ background: `hsl(${hue(name)} 28% 30%)` }}>
        <span>{initials(name)}</span>
      </div>
    );
  return <img className={`artist-img ${className}`} src={artistUrl(name)} alt="" draggable={false} onError={() => setBad(true)} loading="lazy" />;
}

/** Cor dominante da capa, pra pintar o topo da página igual o Spotify faz. */
export function useCoverColor(id: number | null | undefined) {
  const [color, setColor] = useState("rgb(60, 60, 70)");
  useEffect(() => {
    if (id == null) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = coverUrl(id, 300);
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 24;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let best = [60, 60, 70];
        let bestScore = -1;
        // Pega o pixel mais "colorido" que não seja estourado nem escuro demais.
        for (let i = 0; i < d.length; i += 4) {
          const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, gg, b);
          const min = Math.min(r, gg, b);
          const sat = max ? (max - min) / max : 0;
          const score = sat * (max > 40 && max < 245 ? 1 : 0.2);
          if (score > bestScore) {
            bestScore = score;
            best = [r, gg, b];
          }
        }
        // Escurece pra texto branco continuar legível em cima.
        const k = 0.62;
        setColor(`rgb(${Math.round(best[0] * k)}, ${Math.round(best[1] * k)}, ${Math.round(best[2] * k)})`);
      } catch {
        /* imagem sem CORS: fica a cor padrão */
      }
    };
  }, [id]);
  return color;
}

// ---------------------------------------------------------------- pedacinhos

export function Equalizer({ paused }: { paused?: boolean }) {
  return (
    <span className={`eq ${paused ? "eq-paused" : ""}`} aria-label="Tocando">
      <i />
      <i />
      <i />
    </span>
  );
}

export function QualityTag({ bits, rate, codec }: { bits: number; rate: number; codec?: string }) {
  if (!rate) return null;
  const hi = isHiRes(bits, rate);
  return (
    <span className={`qtag ${hi ? "qtag-hi" : ""}`} title={`${codec ?? ""} ${bits ? bits + " bit, " : ""}${rate / 1000} kHz`}>
      {codec && codec !== "FLAC" ? `${codec} ` : ""}
      {quality(bits, rate)}
    </span>
  );
}

export function PlayButton({ playing, onClick, size = 56, label }: { playing?: boolean; onClick: () => void; size?: number; label?: string }) {
  return (
    <button className="play-big" style={{ width: size, height: size }} onClick={onClick} aria-label={label ?? (playing ? "Pausar" : "Tocar")}>
      {playing ? <IPause size={size * 0.42} /> : <IPlay size={size * 0.42} />}
    </button>
  );
}

export function LikeButton({ id, size = 18 }: { id: number; size?: number }) {
  const { likes, toggleLike } = useStore();
  const liked = likes.has(id);
  return (
    <button
      className={`icon-btn like ${liked ? "liked" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleLike(id);
      }}
      aria-label={liked ? "Tirar das Curtidas" : "Curtir"}
      title={liked ? "Tirar das Curtidas" : "Curtir"}
    >
      {liked ? <IHeart size={size} /> : <IHeartLine size={size} />}
    </button>
  );
}

// ---------------------------------------------------------------- menus

export function useTrackMenu() {
  const s = useStore();
  return (t: Track, extra: MenuItem[] = []): MenuItem[] => {
    const al = s.lib.albumByKey.get(t.album_key);
    return [
      { label: "Tocar a seguir", onClick: () => api.playNext([t.id]).then(() => s.showToast({ text: "Vai tocar a seguir" })) },
      { label: "Adicionar à fila", onClick: () => api.enqueue([t.id]).then(() => s.showToast({ text: "Adicionada à fila" })) },
      "sep",
      { label: "Adicionar à playlist", onClick: () => askAddToPlaylist([t.id]) },
      { label: s.likes.has(t.id) ? "Tirar das Curtidas" : "Curtir", onClick: () => s.toggleLike(t.id) },
      ...extra,
      "sep",
      ...(al ? [{ label: "Ir para o álbum", onClick: () => s.go({ v: "album", key: al.key }) }] : []),
      ...(al ? [{ label: "Ir para o artista", onClick: () => s.go({ v: "artist", key: al.artistKey }) }] : []),
      { label: "Mudar o gênero desta música", onClick: () => window.dispatchEvent(new CustomEvent("toxify:genre", { detail: `#${t.id}` })) },
      ...(al ? [{ label: `Mudar o gênero de ${al.artists[0] ?? al.artist}`, onClick: () => window.dispatchEvent(new CustomEvent("toxify:genre", { detail: al.artistKey })) }] : []),
      ...(al ? [{ label: "Editar informações", onClick: () => window.dispatchEvent(new CustomEvent("toxify:edit-album", { detail: al.key })) }] : []),
    ];
  };
}

export function ContextMenu() {
  const { menu, closeMenu } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 8), y: Math.min(menu.y, window.innerHeight - r.height - 8) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    const key = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
    };
  }, [menu, closeMenu]);
  if (!menu) return null;
  return (
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? "danger" : ""}
            onClick={() => {
              closeMenu();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function MoreButton({ items, label = "Mais opções" }: { items: () => MenuItem[]; label?: string }) {
  const { openMenu } = useStore();
  return (
    <button
      className="icon-btn more"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu({ clientX: r.left, clientY: r.bottom + 6 }, items());
      }}
    >
      <IMore size={22} />
    </button>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ToastView() {
  const { toast, showToast } = useStore();
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick();
            showToast(null);
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- lista de faixas

export function TrackList({
  tracks,
  showAlbum = true,
  showCover = true,
  numbers = "index",
  discs = false,
  ctx = null,
  onReorder,
  onRemove,
}: {
  tracks: Track[];
  showAlbum?: boolean;
  showCover?: boolean;
  numbers?: "index" | "track";
  discs?: boolean;
  /** De onde é a lista (pra lateral saber o que está tocando). */
  ctx?: PlayCtx;
  /** Playlist: arrastar pra reordenar. */
  onReorder?: (from: number, to: number) => void;
  /** Playlist: "Tirar desta playlist". */
  onRemove?: (index: number) => void;
}) {
  const s = useStore();
  const menuFor = useTrackMenu();
  const [sel, setSel] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const current = s.player?.track_id;
  const playing = s.player?.playing;
  const multiDisc = discs && new Set(tracks.map((t) => t.disc)).size > 1;
  const menuOf = (t: Track, i: number) => menuFor(t, onRemove ? [{ label: "Tirar desta playlist", onClick: () => onRemove(i) }] : []);
  let lastDisc = -1;
  return (
    <div className={`tracklist ${showAlbum ? "" : "no-album"}`} role="grid">
      <div className="tl-head" role="row">
        <span>#</span>
        <span>Título</span>
        {showAlbum && <span>Álbum</span>}
        <span>Qualidade</span>
        <span className="tl-dur" aria-label="Duração">
          <IClock size={16} />
        </span>
      </div>
      {tracks.map((t, i) => {
        const isCur = t.id === current;
        const header =
          multiDisc && t.disc !== lastDisc ? (
            <div className="tl-disc" key={`d${t.disc}`}>
              Disco {t.disc || 1}
            </div>
          ) : null;
        lastDisc = t.disc;
        const al = s.lib.albumByKey.get(t.album_key);
        return [
          header,
          <div
            key={`${t.id}-${i}`}
            role="row"
            tabIndex={0}
            draggable
            className={`tl-row ${isCur ? "current" : ""} ${sel === t.id ? "selected" : ""} ${dragOver === i && dragFrom !== null && dragFrom !== i ? (dragFrom < i ? "drop-below" : "drop-above") : ""}`}
            onClick={() => setSel(t.id)}
            onDoubleClick={() => s.playTracks(tracks, i, ctx)}
            onKeyDown={(e) => e.key === "Enter" && s.playTracks(tracks, i, ctx)}
            onContextMenu={(e) => {
              e.preventDefault();
              setSel(t.id);
              s.openMenu(e, menuOf(t, i));
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TRACKS, JSON.stringify([t.id]));
              e.dataTransfer.setData("text/plain", `${t.title} · ${t.artist}`);
              e.dataTransfer.effectAllowed = "copyMove";
              if (onReorder) setDragFrom(i);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragOver={(e) => {
              if (!onReorder || dragFrom === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOver(i);
            }}
            onDrop={(e) => {
              if (!onReorder || dragFrom === null) return;
              e.preventDefault();
              if (dragFrom !== i) onReorder(dragFrom, i);
              setDragFrom(null);
              setDragOver(null);
            }}
          >
            <span className="tl-num">
              {isCur ? <Equalizer paused={!playing} /> : <span className="n">{numbers === "track" ? t.track || i + 1 : i + 1}</span>}
              <button
                className="tl-play"
                aria-label={isCur && playing ? "Pausar" : `Tocar ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isCur) api.toggle();
                  else s.playTracks(tracks, i, ctx);
                }}
              >
                {isCur && playing ? <IPause size={16} /> : <IPlay size={16} />}
              </button>
            </span>
            <span className="tl-title">
              {showCover && <Cover id={t.id} size={80} className="tl-cover" />}
              <span className="tl-text">
                <span className="tl-name">{t.title}</span>
                <span className="tl-artist">
                  <ArtistLinks text={t.artist || t.album_artist} />
                </span>
              </span>
            </span>
            {showAlbum && (
              <span className="tl-album">
                {al ? (
                  <a
                    onClick={(e) => {
                      e.stopPropagation();
                      s.go({ v: "album", key: al.key });
                    }}
                  >
                    {al.title}
                  </a>
                ) : (
                  t.album
                )}
              </span>
            )}
            <span className="tl-q">
              <QualityTag bits={t.bits} rate={t.rate} codec={t.codec} />
            </span>
            <span className="tl-dur">
              <LikeButton id={t.id} size={16} />
              <span className="d">{fmtTime(t.secs)}</span>
              <MoreButton items={() => menuOf(t, i)} />
            </span>
          </div>,
        ];
      })}
    </div>
  );
}

/** Nome do artista clicável quando ele existe na biblioteca. */
export function ArtistLinks({ text }: { text: string }) {
  const s = useStore();
  const link = (name: string, key: string) => {
    const a = s.lib.artistByKey.get(norm(name));
    return a ? (
      <a
        key={key}
        onClick={(e) => {
          e.stopPropagation();
          s.go({ v: "artist", key: a.key });
        }}
      >
        {name}
      </a>
    ) : null;
  };
  // "Kyan; MU540" vira dois nomes. Dentro de cada um, "Fulano feat. Ciclano" linka quem for conhecido.
  return (
    <>
      {splitArtists(text).map((name, n) => (
        <span key={n}>
          {n > 0 && ", "}
          {link(name, "x") ??
            name.split(/(,\s+|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+)/i).map((p, i) => link(p, String(i)) ?? <span key={i}>{p}</span>)}
        </span>
      ))}
    </>
  );
}

/** Capa do mix: foto do artista principal com a faixa colorida e o nome (sem foto, vira mosaico). */
export function MixArt({ tracks, face, title, color, className = "" }: { tracks: Track[]; face: string | null; title: string; color: string; className?: string }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [face]);
  if (!face || bad) return <Mosaic tracks={tracks} label={title} color={color} className={className} />;
  return (
    <div className={`mosaic mix-face ${className}`} style={{ ["--mix" as string]: color }}>
      <img className="cover" src={artistUrl(face)} alt="" draggable={false} onError={() => setBad(true)} loading="lazy" />
      <span className="mosaic-label">{title}</span>
    </div>
  );
}

/** Capa de playlist/mix: mosaico de 4 capas de álbuns diferentes (ou uma só, se tiver menos). */
export function Mosaic({ tracks, className = "", label, color }: { tracks: Track[]; className?: string; label?: string; color?: string }) {
  const seen = new Set<string>();
  const ids: number[] = [];
  for (const t of tracks) {
    if (seen.has(t.album_key)) continue;
    seen.add(t.album_key);
    ids.push(t.id);
    if (ids.length === 4) break;
  }
  return (
    <div className={`mosaic ${className} ${ids.length >= 4 ? "four" : ""}`} style={color ? { ["--mix" as string]: color } : undefined}>
      {ids.length === 0 ? (
        <div className="cover cover-empty">
          <INote size={36} />
        </div>
      ) : ids.length >= 4 ? (
        ids.map((id) => <Cover key={id} id={id} size={200} />)
      ) : (
        <Cover id={ids[0]} size={400} />
      )}
      {label && <span className="mosaic-label">{label}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- cartões

export function AlbumCard({ album, sub }: { album: Album; sub?: string }) {
  const s = useStore();
  const isCur = s.player?.track_id != null && album.tracks.some((t) => t.id === s.player!.track_id);
  return (
    <div
      className="card"
      onClick={() => s.go({ v: "album", key: album.key })}
      onContextMenu={(e) => {
        e.preventDefault();
        s.openMenu(e, [
          { label: "Tocar", onClick: () => s.playTracks(album.tracks, 0, `album:${album.key}`) },
          { label: "Adicionar à fila", onClick: () => api.enqueue(album.tracks.map((t) => t.id)).then(() => s.showToast({ text: "Álbum adicionado à fila" })) },
          { label: "Adicionar à playlist", onClick: () => askAddToPlaylist(album.tracks.map((t) => t.id)) },
          "sep",
          { label: "Ir para o artista", onClick: () => s.go({ v: "artist", key: album.artistKey }) },
          { label: "Editar informações", onClick: () => window.dispatchEvent(new CustomEvent("toxify:edit-album", { detail: album.key })) },
        ]);
      }}
    >
      <div className="card-art">
        <Cover id={album.coverId} size={300} alt={album.title} />
        <button
          className={`card-play ${isCur ? "on" : ""}`}
          aria-label={`Tocar ${album.title}`}
          onClick={(e) => {
            e.stopPropagation();
            if (isCur) api.toggle();
            else s.playTracks(album.tracks, 0, `album:${album.key}`);
          }}
        >
          {isCur && s.player?.playing ? <IPause size={22} /> : <IPlay size={22} />}
        </button>
        {isHiRes(album.bits, album.rate) && <span className="card-hires">Hi-Res</span>}
      </div>
      <div className="card-title" title={album.title}>
        {album.title}
      </div>
      <div className="card-sub">{sub ?? `${album.year ? album.year + " · " : ""}${album.artist}`}</div>
    </div>
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  const s = useStore();
  return (
    <div className="card artist-card" onClick={() => s.go({ v: "artist", key: artist.key })}>
      <div className="card-art round">
        <ArtistImage name={artist.name} />
        <button
          className="card-play"
          aria-label={`Tocar ${artist.name}`}
          onClick={(e) => {
            e.stopPropagation();
            s.playTracks(artist.tracks, 0, `artist:${artist.key}`);
          }}
        >
          <IPlay size={22} />
        </button>
      </div>
      <div className="card-title">{artist.name}</div>
      <div className="card-sub">Artista</div>
    </div>
  );
}

export function Shelf({ title, children, onMore }: { title: string; children: ReactNode; onMore?: () => void }) {
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2>{onMore ? <a onClick={onMore}>{title}</a> : title}</h2>
        {onMore && (
          <a className="shelf-more" onClick={onMore}>
            Mostrar tudo
          </a>
        )}
      </div>
      <div className="shelf-row">{children}</div>
    </section>
  );
}
