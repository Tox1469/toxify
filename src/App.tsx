import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, Track } from "./api";
import { IBack, IDownload, IForward, IHeart, IHome, ILibrary, ISearch, ISettings, IWand } from "./icons";
import { plural, showArtists, suggestions } from "./model";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LOCALE, t } from "./i18n";
import { NowPlaying, PlayerBar, Stage, StageMode } from "./player";
import { StoreProvider, useStore } from "./store";
import { ArtistImage, ContextMenu, Cover, DRAG_TRACKS, Equalizer, Mosaic, ToastView } from "./ui";
import {
  AddToPlaylist,
  AlbumPage,
  AlbumsPage,
  ArtistPage,
  ArtistsPage,
  EditAlbum,
  FixPage,
  GenrePicker,
  Home,
  LikedPage,
  LyricsPage,
  MixesPage,
  MixPage,
  NameModal,
  PlaylistPage,
  QueuePage,
  SearchPage,
  SettingsPage,
  importPlaylist,
} from "./views";

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const s = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<number[] | null>(null);
  const [genreFor, setGenreFor] = useState<string | null>(null);
  const [stage, setStage] = useState<StageMode | null>(null);
  // Tela cheia de verdade: a janela inteira, não só a área do app.
  useEffect(() => {
    getCurrentWindow().setFullscreen(!!stage).catch(() => {});
  }, [!!stage]);
  const closeStage = () => setStage(null);

  useEffect(() => {
    const edit = (e: Event) => setEditing((e as CustomEvent<string>).detail);
    const add = (e: Event) => setAdding((e as CustomEvent<number[]>).detail);
    const genre = (e: Event) => setGenreFor((e as CustomEvent<string>).detail);
    const stg = (e: Event) => setStage((e as CustomEvent<StageMode>).detail);
    window.addEventListener("toxify:edit-album", edit);
    window.addEventListener("toxify:add-to-playlist", add);
    window.addEventListener("toxify:genre", genre);
    window.addEventListener("toxify:stage", stg);
    return () => {
      window.removeEventListener("toxify:edit-album", edit);
      window.removeEventListener("toxify:add-to-playlist", add);
      window.removeEventListener("toxify:genre", genre);
      window.removeEventListener("toxify:stage", stg);
    };
  }, []);

  // Atalhos: espaço toca/pausa, Ctrl+setas troca de faixa, Alt+setas volta/avança página.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]");
      if (typing) return;
      if (e.code === "Space") {
        e.preventDefault();
        api.toggle();
      } else if (e.ctrlKey && e.key === "ArrowRight") api.next();
      else if (e.ctrlKey && e.key === "ArrowLeft") api.prev();
      else if (e.altKey && e.key === "ArrowLeft") s.back();
      else if (e.altKey && e.key === "ArrowRight") s.forward();
      else if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
      }
    };
    const mouse = (e: MouseEvent) => {
      if (e.button === 3) s.back();
      if (e.button === 4) s.forward();
    };
    window.addEventListener("keydown", k);
    window.addEventListener("mouseup", mouse);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("mouseup", mouse);
    };
  }, [s]);

  // Título da janela acompanha a música, igual o Spotify.
  const cur = s.player?.track_id != null ? s.lib.byId.get(s.player.track_id) : undefined;
  useEffect(() => {
    document.title = cur && s.player?.playing ? `${cur.title} · ${showArtists(cur.artist || cur.album_artist)}` : "Toxify";
  }, [cur, s.player?.playing]);

  return (
    <div className={`app ${s.rightPanel ? "with-right" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      <Sidebar />
      <main className="panel main">
        <TopBar />
        <div className="main-scroll">
          <Route />
        </div>
      </main>
      {s.rightPanel && <NowPlaying />}
      <PlayerBar />
      <ContextMenu />
      <ToastView />
      {editing && <EditAlbum albumKey={editing} onClose={() => setEditing(null)} />}
      {adding && <AddToPlaylist ids={adding} onClose={() => setAdding(null)} />}
      {genreFor && <GenrePicker artistKey={genreFor} onClose={() => setGenreFor(null)} />}
      {stage && <Stage mode={stage} setMode={setStage} onClose={closeStage} />}
    </div>
  );
}

function Route() {
  const { route } = useStore();
  switch (route.v) {
    case "home":
      return <Home />;
    case "album":
      return <AlbumPage key={route.key} albumKey={route.key} />;
    case "artist":
      return <ArtistPage key={route.key} artistKey={route.key} />;
    case "albums":
      return <AlbumsPage key={route.filter ?? "all"} filter={route.filter} />;
    case "playlist":
      return <PlaylistPage key={route.id} id={route.id} />;
    case "mix":
      return <MixPage key={route.id} id={route.id} />;
    case "mixes":
      return <MixesPage />;
    case "artists":
      return <ArtistsPage />;
    case "liked":
      return <LikedPage />;
    case "search":
      return <SearchPage q={route.q} />;
    case "queue":
      return <QueuePage />;
    case "lyrics":
      return <LyricsPage />;
    case "settings":
      return <SettingsPage />;
    case "fix":
      return <FixPage />;
  }
}

function TopBar() {
  const s = useStore();
  const [q, setQ] = useState(s.route.v === "search" ? s.route.q : "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.route.v !== "search") setQ("");
  }, [s.route]);
  return (
    <div className="topbar">
      <div className="nav-btns">
        <button className="round-btn" onClick={s.back} disabled={!s.canBack} aria-label={t("Voltar")} title={t("Voltar")}>
          <IBack size={18} />
        </button>
        <button className="round-btn" onClick={s.forward} disabled={!s.canForward} aria-label={t("Avançar")} title={t("Avançar")}>
          <IForward size={18} />
        </button>
      </div>
      <div className="top-center">
        <button className={`round-btn home-btn ${s.route.v === "home" ? "on" : ""}`} onClick={() => s.go({ v: "home" })} aria-label={t("Início")} title={t("Início")}>
          <IHome size={22} />
        </button>
        <label className="search" onClick={() => input.current?.focus()}>
          <ISearch size={20} />
          <input
            ref={input}
            value={q}
            placeholder={t("O que você quer ouvir?")}
            onChange={(e) => {
              setQ(e.target.value);
              s.go({ v: "search", q: e.target.value });
            }}
            onFocus={() => s.route.v !== "search" && s.go({ v: "search", q })}
            onKeyDown={(e) => e.key === "Escape" && (setQ(""), input.current?.blur())}
            aria-label={t("Buscar")}
          />
          <kbd>Ctrl K</kbd>
        </label>
      </div>
      <div className="top-right">
        <UpdateButton />
      </div>
    </div>
  );
}

/** Versão nova no GitHub: um clique baixa, confere, instala e reabre o Toxify. */
function UpdateButton() {
  const s = useStore();
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = () => api.checkUpdate().then((u) => setVersion(u?.version ?? null)).catch(() => {});
    check();
    // App que fica dias aberto também fica sabendo.
    const id = window.setInterval(check, 6 * 3600 * 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!version) return null;
  return (
    <button
      className="btn primary update-btn"
      disabled={busy}
      title={t("Toxify {v} disponível. Baixa, instala e abre de novo sozinho; playlists e curtidas continuam.", { v: version })}
      onClick={async () => {
        setBusy(true);
        try {
          await api.installUpdate();
        } catch (e) {
          setBusy(false);
          s.showToast({ text: t("Não deu pra atualizar: {e}", { e: String(e) }) });
        }
      }}
    >
      <IDownload size={16} />
      {busy ? t("Baixando…") : t("Atualizar")}
    </button>
  );
}

type SbItem =
  | { kind: "artist"; key: string; name: string; sub: string; at: number }
  | { kind: "album"; key: string; name: string; sub: string; at: number; cover: number }
  | { kind: "playlist"; key: string; id: number; name: string; sub: string; at: number; tracks: Track[] };

function Sidebar() {
  const s = useStore();
  const [filter, setFilter] = useState<"all" | "playlists" | "albums" | "artists">(() => (localStorage.getItem("toxify.filter") as "all") ?? "all");
  const [creating, setCreating] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const fixCount = useMemo(() => suggestions(s.lib).length, [s.lib]);

  // Marca só a fonte do que está tocando (o álbum, OU o artista, OU a playlist), não tudo junto.
  const curTrack = s.player?.track_id != null ? s.lib.byId.get(s.player.track_id) : undefined;
  const playingCtx = s.playCtx ?? (curTrack ? `album:${curTrack.album_key}` : null);

  // Igual o Spotify: o que tocou por último sobe.
  const items = useMemo(() => {
    const last = new Map<string, number>();
    for (const [id, p] of s.plays) {
      const t = s.lib.byId.get(id);
      const al = t && s.lib.albumByKey.get(t.album_key);
      if (!al) continue;
      last.set("album:" + al.key, Math.max(last.get("album:" + al.key) ?? 0, p.last));
      last.set("artist:" + al.artistKey, Math.max(last.get("artist:" + al.artistKey) ?? 0, p.last));
    }
    const list: SbItem[] = [];
    if (filter === "all" || filter === "playlists")
      for (const p of s.playlists) {
        const tracks = p.tracks.map((id) => s.lib.byId.get(id)).filter((t): t is Track => !!t);
        const at = Math.max(p.created, ...tracks.map((t) => s.plays.get(t.id)?.last ?? 0));
        list.push({ kind: "playlist", key: String(p.id), id: p.id, name: p.name, sub: `${t("Playlist")} · ${plural(tracks.length, t("música"), t("músicas"))}`, at, tracks });
      }
    if (filter === "all" || filter === "artists")
      for (const a of s.lib.artists) list.push({ kind: "artist", key: a.key, name: a.name, sub: t("Artista"), at: last.get("artist:" + a.key) ?? 0 });
    if (filter === "all" || filter === "albums")
      for (const a of s.lib.albums) list.push({ kind: "album", key: a.key, name: a.title, sub: `${t("Álbum")} · ${a.artist}`, at: last.get("album:" + a.key) ?? 0, cover: a.coverId });
    return list.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name, LOCALE));
  }, [s.lib, s.plays, s.playlists, filter]);

  const setF = (f: typeof filter) => {
    const v = filter === f ? "all" : f;
    setFilter(v);
    localStorage.setItem("toxify.filter", v);
  };

  // Soltar música arrastada em cima de uma playlist adiciona nela.
  const dropProps = (id: number, key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TRACKS)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropOn(key);
    },
    onDragLeave: () => setDropOn((k) => (k === key ? null : k)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      try {
        const ids = JSON.parse(e.dataTransfer.getData(DRAG_TRACKS)) as number[];
        s.addToPlaylist(id, ids);
      } catch {
        /* arrasto de outra coisa */
      }
    },
  });

  const routeKey = s.route.v === "album" || s.route.v === "artist" ? `${s.route.v}:${s.route.key}` : s.route.v === "playlist" ? `playlist:${s.route.id}` : s.route.v;

  return (
    <nav className="panel sidebar">
      <div className="sb-head">
        <button className="sb-title" onClick={() => s.go({ v: filter === "artists" ? "artists" : "albums" })}>
          <ILibrary size={22} />
          {t("Sua biblioteca")}
        </button>
        <button
          className="sb-new"
          onClick={(e) =>
            s.openMenu(e, [
              { label: t("Nova playlist"), onClick: () => setCreating(true) },
              { label: t("Importar playlist (.m3u)"), onClick: () => importPlaylist(s) },
            ])
          }
          aria-label={t("Criar playlist")}
          title={t("Criar playlist")}
        >
          +
        </button>
      </div>
      <div className="chips">
        {(["playlists", "albums", "artists"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setF(f)}>
            {{ playlists: t("Playlists"), albums: t("Álbuns"), artists: t("Artistas") }[f]}
          </button>
        ))}
      </div>
      <div className="sb-list">
        <div className={`sb-item ${routeKey === "liked" ? "on" : ""}`} onClick={() => s.go({ v: "liked" })}>
          <div className="sb-art liked-cover">
            <IHeart size={18} />
          </div>
          <div className="sb-text">
            <span className={`sb-name ${playingCtx === "liked" ? "accent" : ""}`}>{t("Músicas Curtidas")}</span>
            <span className="sb-sub">
              {t("Playlist")} · {plural(s.likes.size, t("música"), t("músicas"))}
            </span>
          </div>
          {playingCtx === "liked" && s.player?.playing && <Equalizer />}
        </div>
        {items.map((it) => {
          const key = `${it.kind}:${it.key}`;
          const playing = playingCtx === key;
          const go = () => (it.kind === "playlist" ? s.go({ v: "playlist", id: it.id }) : s.go({ v: it.kind, key: it.key }));
          return (
            <div
              key={key}
              className={`sb-item ${routeKey === key ? "on" : ""} ${dropOn === key ? "drop" : ""}`}
              onClick={go}
              {...(it.kind === "playlist" ? dropProps(it.id, key) : {})}
            >
              {it.kind === "artist" ? (
                <ArtistImage name={it.name} className="sb-art round" />
              ) : it.kind === "album" ? (
                <Cover id={it.cover} size={96} className="sb-art" />
              ) : (
                <Mosaic tracks={it.tracks} className="sb-art" />
              )}
              <div className="sb-text">
                <span className={`sb-name ${playing ? "accent" : ""}`}>{it.name}</span>
                <span className="sb-sub">{it.sub}</span>
              </div>
              {playing && s.player?.playing && <Equalizer />}
            </div>
          );
        })}
      </div>
      <div className="sb-foot">
        {s.scan && (
          <div className="sb-scan">
            {t("Lendo biblioteca… {done} de {total}", { done: s.scan.done, total: s.scan.total })}
            <div className="bar">
              <i style={{ width: `${s.scan.total ? (s.scan.done / s.scan.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        <button className={`sb-link ${s.route.v === "fix" ? "on" : ""}`} onClick={() => s.go({ v: "fix" })}>
          <IWand size={18} />
          {t("Arrumar biblioteca")}
          {fixCount > 0 && <span className="count">{fixCount}</span>}
        </button>
        <button className={`sb-link ${s.route.v === "settings" ? "on" : ""}`} onClick={() => s.go({ v: "settings" })}>
          <ISettings size={18} />
          {t("Configurações")}
        </button>
      </div>
      {creating && (
        <NameModal
          title={t("Nova playlist")}
          initial={t("Minha playlist nº {n}", { n: s.playlists.length + 1 })}
          action={t("Criar")}
          onClose={() => setCreating(false)}
          onSave={async (name) => {
            const id = await api.playlistCreate(name);
            await s.reloadPlaylists();
            setCreating(false);
            s.go({ v: "playlist", id });
          }}
        />
      )}
    </nav>
  );
}
