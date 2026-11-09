import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, on, PlayerState, Playlist, Settings, Track } from "./api";
import { buildLibrary, buildMixes, Library, Mix, Plays, similarTracks, suggestions } from "./model";

export type Route =
  | { v: "home" }
  | { v: "album"; key: string }
  | { v: "artist"; key: string }
  | { v: "albums"; filter?: "hires" }
  | { v: "artists" }
  | { v: "liked" }
  | { v: "playlist"; id: number }
  | { v: "mix"; id: string }
  | { v: "mixes" }
  | { v: "search"; q: string }
  | { v: "queue" }
  | { v: "lyrics" }
  | { v: "settings" }
  | { v: "fix" };

export type MenuItem = { label: string; onClick: () => void; danger?: boolean } | "sep";
export type MenuState = { x: number; y: number; items: MenuItem[] } | null;
export type Toast = { text: string; action?: { label: string; onClick: () => void } } | null;

/** De onde a música está tocando: "album:<chave>", "artist:<chave>", "playlist:<id>", "mix:<id>", "liked". */
export type PlayCtx = string | null;

type Store = {
  lib: Library;
  ready: boolean;
  scan: { done: number; total: number } | null;
  reload: () => Promise<void>;
  settings: Settings | null;
  setSettings: (s: Settings) => void;
  likes: Set<number>;
  toggleLike: (id: number) => void;
  plays: Plays;
  mixes: Mix[];
  genres: Record<string, string>;
  setGenre: (artistKey: string, genre: string) => void;
  playlists: Playlist[];
  reloadPlaylists: () => Promise<void>;
  addToPlaylist: (id: number, tracks: number[]) => Promise<void>;
  player: PlayerState | null;
  queue: { ids: number[]; index: number };
  playCtx: PlayCtx;
  route: Route;
  go: (r: Route) => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
  playTracks: (tracks: Track[], index?: number, ctx?: PlayCtx) => void;
  menu: MenuState;
  openMenu: (e: { clientX: number; clientY: number }, items: MenuItem[]) => void;
  closeMenu: () => void;
  toast: Toast;
  showToast: (t: Toast) => void;
  rightPanel: boolean;
  setRightPanel: (on: boolean) => void;
  autoplay: boolean;
  setAutoplay: (on: boolean) => void;
  /** Músicas que entraram na fila pela reprodução automática. */
  autoIds: Set<number>;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

/** Abre a janelinha "Adicionar à playlist" de qualquer lugar. */
export const askAddToPlaylist = (ids: number[]) => window.dispatchEvent(new CustomEvent("toxify:add-to-playlist", { detail: ids }));

export function StoreProvider({ children }: { children: ReactNode }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [ready, setReady] = useState(false);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [likes, setLikes] = useState<Set<number>>(new Set());
  const [plays, setPlays] = useState<Plays>(new Map());
  const [genres, setGenres] = useState<Record<string, string>>({});
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [queue, setQueue] = useState<{ ids: number[]; index: number }>({ ids: [], index: 0 });
  const [playCtx, setPlayCtx] = useState<PlayCtx>(null);
  const [hist, setHist] = useState<{ stack: Route[]; i: number }>({ stack: [{ v: "home" }], i: 0 });
  const [menu, setMenu] = useState<MenuState>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [rightPanel, setRightPanelState] = useState(() => localStorage.getItem("toxify.right") !== "0");
  const toastTimer = useRef<number>(0);
  const lastReload = useRef(0);
  const runAutoRef = useRef<(() => Promise<void>) | null>(null);

  const lib = useMemo(() => buildLibrary(tracks, genres), [tracks, genres]);
  // Os mixes mudam uma vez por dia e conforme você ouve; não a cada clique.
  const mixes = useMemo(() => buildMixes(lib, plays, likes), [lib, plays, likes]);

  const loadPlays = useCallback(async () => {
    const p = await api.plays().catch(() => []);
    setPlays(new Map(p.map(([id, count, skips, last, recent]) => [id, { count, skips, last, recent }])));
  }, []);

  const reloadPlaylists = useCallback(async () => {
    setPlaylists(await api.playlists().catch(() => []));
  }, []);

  const reload = useCallback(async () => {
    lastReload.current = Date.now();
    const [t, l] = await Promise.all([api.library(), api.likes()]);
    setTracks(t);
    setLikes(new Set(l));
    await Promise.all([loadPlays(), reloadPlaylists()]);
    setReady(true);
  }, [loadPlays, reloadPlaylists]);

  useEffect(() => {
    reload();
    api.settings().then(setSettings);
    api.genres().then(setGenres).catch(() => {});
    let playsTimer = 0;
    const subs = [
      on<PlayerState>("player", setPlayer),
      on<{ ids: number[]; index: number }>("queue", setQueue),
      // Acabou uma faixa: o histórico mudou, os mixes se ajustam.
      on("track-ended", () => {
        window.clearTimeout(playsTimer);
        playsTimer = window.setTimeout(loadPlays, 800);
      }),
      on<{ done: number; total: number; finished: boolean }>("scan", (s) => {
        if (s.finished) {
          setScan(null);
          // Leu a biblioteca de novo (música nova?): arruma de novo.
          reload().then(() => runAutoRef.current?.());
        } else {
          setScan({ done: s.done, total: s.total });
          if (Date.now() - lastReload.current > 4000) reload();
        }
      }),
    ];
    return () => subs.forEach((p) => p.then((u) => u()));
  }, [reload, loadPlays]);

  // ------------------------------------------------ lembrar o que estava tocando

  const lastSave = useRef(0);
  const restored = useRef(false);
  useEffect(() => {
    if (!player || !restored.current || !queue.ids.length || player.track_id == null) return;
    const now = Date.now();
    if (now - lastSave.current < 4000 && player.playing) return;
    lastSave.current = now;
    try {
      localStorage.setItem(
        "toxify.session",
        JSON.stringify({ ids: queue.ids, index: queue.index, ctx: playCtx, at: player.position, shuffle: player.shuffle, repeat: player.repeat }),
      );
    } catch {
      /* sem espaço: tudo bem, só não lembra */
    }
  }, [player, queue, playCtx]);

  // Ao abrir: volta a música de antes, pausada no mesmo ponto (se nada estiver tocando).
  useEffect(() => {
    if (restored.current || !ready || !player) return;
    restored.current = true;
    if (player.track_id != null) return;
    try {
      const s = JSON.parse(localStorage.getItem("toxify.session") ?? "null");
      if (s?.ids?.length && tracks.some((t) => t.id === s.ids[s.index])) {
        setPlayCtx(s.ctx ?? null);
        api.restore(s.ids, s.index, Math.max(0, (s.at ?? 0) - 2), !!s.shuffle, s.repeat ?? 0);
      }
    } catch {
      /* sessão corrompida: começa do zero */
    }
  }, [ready, player, tracks]);

  // ------------------------------------------------ reprodução automática (a fila acabou, continua no mesmo estilo)

  const [autoplay, setAutoplayState] = useState(() => localStorage.getItem("toxify.autoplay") !== "0");
  const [autoIds, setAutoIds] = useState<Set<number>>(new Set());
  const autoFor = useRef<number | null>(null);
  useEffect(() => {
    if (!autoplay || !player || player.track_id == null || player.repeat !== 0) return;
    // Só quando a música atual é a última da fila (assim a próxima já entra com crossfade).
    if (!queue.ids.length || queue.index < queue.ids.length - 1) return;
    if (autoFor.current === player.track_id) return;
    const seed = lib.byId.get(player.track_id);
    if (!seed) return;
    autoFor.current = player.track_id;
    const more = similarTracks(lib, seed, plays, likes, new Set(queue.ids), 20);
    if (!more.length) return;
    setAutoIds((s) => new Set([...s, ...more.map((t) => t.id)]));
    api.enqueue(more.map((t) => t.id));
  }, [autoplay, player?.track_id, player?.repeat, queue, lib, plays, likes]);

  const go = useCallback((r: Route) => {
    setHist((h) => {
      const cur = h.stack[h.i];
      if (JSON.stringify(cur) === JSON.stringify(r)) return h;
      // Busca digitando não empilha uma entrada por letra.
      if (cur.v === "search" && r.v === "search") {
        const stack = [...h.stack];
        stack[h.i] = r;
        return { stack, i: h.i };
      }
      const stack = [...h.stack.slice(0, h.i + 1), r];
      return { stack, i: stack.length - 1 };
    });
    document.querySelector(".main-scroll")?.scrollTo({ top: 0 });
  }, []);

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    if (t) toastTimer.current = window.setTimeout(() => setToast(null), t.action ? 8000 : 3500);
  }, []);

  // ------------------------------------------------ arrumar sozinho (sempre depois de ler a biblioteca)

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const genresRef = useRef(genres);
  genresRef.current = genres;
  const autoBusy = useRef(false);
  const runAuto = useCallback(async () => {
    if (autoBusy.current) return;
    autoBusy.current = true;
    try {
      const st = settingsRef.current ?? (await api.settings());
      const L = buildLibrary(await api.library(), genresRef.current);
      // Quem está sem gênero vai pra uma lista; o Claude Code classifica quando você pedir.
      const missing = L.artists.filter((a) => !genresRef.current[a.key] && a.albums.length);
      await api
        .writePendingGenres(
          missing.map((a) => ({
            key: a.key,
            name: a.name,
            albums: a.albums.map((al) => al.title),
            tags: [...new Set(a.tracks.map((t) => t.genre).filter(Boolean))],
          })),
        )
        .catch(() => {});
      if (!st.auto_fix) return;
      // O que você desfez ou ignorou uma vez não volta sozinho.
      const ignored: string[] = JSON.parse(localStorage.getItem("toxify.fix.ignored") ?? "[]");
      const sug = suggestions(L).filter((x) => !ignored.includes(x.id));
      if (!sug.length) {
        api.logAuto("arrumar: nada a fazer");
        return;
      }
      const changes = sug.flatMap((x) => x.changes);
      const files = new Set(changes.map((c) => c.id)).size;
      const errs = await api.saveTags(changes).catch((e) => [String(e)]);
      api.logAuto(`arrumar: ${sug.length} correções, ${files} arquivos, ${errs.length} erros${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
      await reload();
      if (errs.length < files)
        showToast({
          text: `Arrumei ${sug.length} coisa${sug.length > 1 ? "s" : ""} na sua biblioteca`,
          action: {
            label: "Desfazer",
            onClick: () => {
              localStorage.setItem("toxify.fix.ignored", JSON.stringify([...ignored, ...sug.map((x) => x.id)]));
              api.undoTags().then(() => reload());
            },
          },
        });
    } catch (e) {
      api.logAuto(`arrumar: falhou: ${e}`);
    } finally {
      autoBusy.current = false;
    }
  }, [reload, showToast]);
  runAutoRef.current = runAuto;

  // Ao abrir: espera o motor terminar de ler o disco e arruma.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    (async () => {
      for (let i = 0; i < 180 && !stop; i++) {
        if (!(await api.isScanning().catch(() => false))) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!stop) runAutoRef.current?.();
    })();
    return () => {
      stop = true;
    };
  }, [ready]);

  const addToPlaylist = useCallback(
    async (id: number, ids: number[]) => {
      const pl = playlists.find((p) => p.id === id);
      if (!pl) return;
      const fresh = ids.filter((x) => !pl.tracks.includes(x));
      if (!fresh.length) {
        showToast({ text: `Já está em "${pl.name}"` });
        return;
      }
      await api.playlistSet(id, [...pl.tracks, ...fresh]);
      await reloadPlaylists();
      showToast({ text: `Adicionada${fresh.length > 1 ? "s" : ""} em "${pl.name}"` });
    },
    [playlists, reloadPlaylists, showToast],
  );

  const store: Store = {
    lib,
    ready,
    scan,
    reload,
    settings,
    setSettings,
    likes,
    toggleLike: (id) => {
      const on = !likes.has(id);
      setLikes((s) => {
        const n = new Set(s);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });
      api.setLike(id, on);
      showToast({ text: on ? "Adicionada às Curtidas" : "Removida das Curtidas" });
    },
    plays,
    mixes,
    genres,
    setGenre: (artistKey, genre) => {
      setGenres((g) => {
        const n = { ...g };
        if (genre) n[artistKey] = genre;
        else delete n[artistKey];
        return n;
      });
      api.setGenre(artistKey, genre);
    },
    playlists,
    reloadPlaylists,
    addToPlaylist,
    player,
    queue,
    playCtx,
    route: hist.stack[hist.i],
    go,
    back: () => setHist((h) => ({ ...h, i: Math.max(0, h.i - 1) })),
    forward: () => setHist((h) => ({ ...h, i: Math.min(h.stack.length - 1, h.i + 1) })),
    canBack: hist.i > 0,
    canForward: hist.i < hist.stack.length - 1,
    playTracks: (ts, index = 0, ctx = null) => {
      if (!ts.length) return;
      setPlayCtx(ctx);
      api.play(
        ts.map((t) => t.id),
        index,
      );
    },
    menu,
    openMenu: (e, items) => setMenu({ x: e.clientX, y: e.clientY, items }),
    closeMenu: () => setMenu(null),
    toast,
    showToast,
    rightPanel,
    setRightPanel: (v) => {
      setRightPanelState(v);
      localStorage.setItem("toxify.right", v ? "1" : "0");
    },
    autoplay,
    setAutoplay: (v) => {
      setAutoplayState(v);
      localStorage.setItem("toxify.autoplay", v ? "1" : "0");
    },
    autoIds,
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** Posição suave: o motor manda a cada 200 ms, a tela anda entre um e outro. */
export function usePosition() {
  const { player } = useStore();
  const [pos, setPos] = useState(0);
  const base = useRef({ at: 0, pos: 0, playing: false, id: null as number | null, speed: 1 });
  useEffect(() => {
    if (!player) return;
    const now = performance.now();
    const b = base.current;
    const interp = b.playing ? b.pos + ((now - b.at) / 1000) * b.speed : b.pos;
    const diff = player.position - interp;
    // Diferença pequena = só o ritmo das mensagens: corrige devagar, sem a barra tremer pra trás.
    const smooth = b.id === player.track_id && player.playing && b.playing && Math.abs(diff) < 0.5;
    const p = smooth ? interp + diff * 0.2 : player.position;
    base.current = { at: now, pos: p, playing: player.playing, id: player.track_id, speed: player.speed || 1 };
    setPos(p);
  }, [player]);
  useEffect(() => {
    // 10 vezes por segundo basta (a barra anda ~3 px por segundo); 60 gastava CPU à toa durante jogo.
    const id = window.setInterval(() => {
      const b = base.current;
      if (b.playing && !document.hidden) setPos(b.pos + ((performance.now() - b.at) / 1000) * b.speed);
    }, 100);
    return () => window.clearInterval(id);
  }, []);
  return Math.min(pos, player?.duration || pos);
}
