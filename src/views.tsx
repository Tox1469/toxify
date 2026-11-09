import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Change, Playlist, TagField, Track } from "./api";
import { IClose, IFolder, IHeart, IPause, IPlay, IShuffle, IUndo, IWand } from "./icons";
import { LANG, LOCALE, setLang, t } from "./i18n";
import { Album, fmtLong, fmtTime, fold, genreLabel, GENRE_TREE, isHiRes, khz, Mix, plural, quality, showArtists, Suggestion, suggestions } from "./model";
import { LyricsView, Switch, useLyrics } from "./player";
import { askAddToPlaylist, usePosition, useStore } from "./store";
import { AlbumCard, ArtistCard, ArtistImage, ArtistLinks, Cover, MixArt, Modal, Mosaic, MoreButton, PlayButton, QualityTag, Shelf, TrackList, useCoverColor } from "./ui";

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? t("Boa madrugada") : h < 12 ? t("Bom dia") : h < 18 ? t("Boa tarde") : t("Boa noite");
};

/** "3 músicas" no idioma da tela. */
const songs = (n: number) => plural(n, t("música"), t("músicas"));

// ---------------------------------------------------------------- início

export function Home() {
  const s = useStore();
  const { lib, plays } = s;
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: Album[] = [];
    [...plays.entries()]
      .sort((a, b) => b[1].last - a[1].last)
      .forEach(([id]) => {
        const t = lib.byId.get(id);
        const al = t && lib.albumByKey.get(t.album_key);
        if (al && !seen.has(al.key)) {
          seen.add(al.key);
          out.push(al);
        }
      });
    return out.slice(0, 12);
  }, [plays, lib]);
  const added = useMemo(() => [...lib.albums].sort((a, b) => b.added - a.added || b.year - a.year).slice(0, 12), [lib]);
  const hires = useMemo(() => lib.albums.filter((a) => isHiRes(a.bits, a.rate)).sort((a, b) => b.rate - a.rate), [lib]);
  const topArtists = useMemo(() => {
    const score = new Map<string, number>();
    for (const [id, p] of plays) {
      const t = lib.byId.get(id);
      const al = t && lib.albumByKey.get(t.album_key);
      if (al) score.set(al.artistKey, (score.get(al.artistKey) ?? 0) + p.count);
    }
    return [...lib.artists].sort((a, b) => (score.get(b.key) ?? 0) - (score.get(a.key) ?? 0) || b.tracks.length - a.tracks.length).slice(0, 12);
  }, [plays, lib]);
  const quick = (recent.length >= 4 ? recent : added).slice(0, 8);
  const color = useCoverColor(quick[0]?.coverId);

  if (s.ready && !lib.tracks.length) return <EmptyLibrary />;
  return (
    <div className="page home" style={{ ["--hero" as string]: color }}>
      <div className="home-glow" />
      <h1 className="home-hello">{greeting()}</h1>
      <div className="quick-grid">
        {quick.map((al) => (
          <div key={al.key} className="quick" onClick={() => s.go({ v: "album", key: al.key })}>
            <Cover id={al.coverId} size={120} />
            <span>{al.title}</span>
            <button
              className="quick-play"
              aria-label={t("Tocar {name}", { name: al.title })}
              onClick={(e) => {
                e.stopPropagation();
                s.playTracks(al.tracks, 0, `album:${al.key}`);
              }}
            >
              <IPlay size={18} />
            </button>
          </div>
        ))}
      </div>
      {s.mixes.length > 0 && (
        <Shelf title={t("Feito pra você")} onMore={() => s.go({ v: "mixes" })}>
          {s.mixes.map((m) => (
            <MixCard key={m.id} mix={m} />
          ))}
        </Shelf>
      )}
      {s.playlists.length > 0 && (
        <Shelf title={t("Suas playlists")}>
          {s.playlists.map((p) => (
            <PlaylistCard key={p.id} pl={p} />
          ))}
        </Shelf>
      )}
      {recent.length > 0 && (
        <Shelf title={t("Tocadas recentemente")}>
          {recent.map((a) => (
            <AlbumCard key={a.key} album={a} />
          ))}
        </Shelf>
      )}
      <Shelf title={t("Seus artistas")} onMore={() => s.go({ v: "artists" })}>
        {topArtists.map((a) => (
          <ArtistCard key={a.key} artist={a} />
        ))}
      </Shelf>
      {hires.length > 0 && (
        <Shelf title={t("Em alta resolução")} onMore={() => s.go({ v: "albums", filter: "hires" })}>
          {hires.slice(0, 12).map((a) => (
            <AlbumCard key={a.key} album={a} sub={`${quality(a.bits, a.rate)} · ${a.artist}`} />
          ))}
        </Shelf>
      )}
      <Shelf title={t("Adicionados por último")} onMore={() => s.go({ v: "albums" })}>
        {added.map((a) => (
          <AlbumCard key={a.key} album={a} />
        ))}
      </Shelf>
    </div>
  );
}

function EmptyLibrary() {
  const s = useStore();
  return (
    <div className="page empty-lib">
      <h1>{t("Nenhuma música por aqui ainda")}</h1>
      <p>
        {s.scan
          ? t("Lendo sua biblioteca: {done} de {total} arquivos…", { done: s.scan.done, total: s.scan.total })
          : t("Escolhe a pasta onde ficam suas músicas.")}
      </p>
      {!s.scan && (
        <button className="btn primary" onClick={() => s.go({ v: "settings" })}>
          {t("Escolher pasta")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- álbum

export function AlbumPage({ albumKey }: { albumKey: string }) {
  const s = useStore();
  const al = s.lib.albumByKey.get(albumKey);
  const color = useCoverColor(al?.coverId);
  if (!al) return <NotFound what={t("Esse álbum não está mais na biblioteca.")} />;
  const isCur = al.tracks.some((t) => t.id === s.player?.track_id);
  const artist = s.lib.artistByKey.get(al.artistKey);
  const more = artist?.albums.filter((a) => a.key !== al.key) ?? [];
  return (
    <div className="page" style={{ ["--hero" as string]: color }}>
      <header className="hero">
        <Cover id={al.coverId} size={600} className="hero-cover" alt={al.title} />
        <div className="hero-text">
          <span className="hero-kind">{t("Álbum")}</span>
          <h1 className={al.title.length > 28 ? "long" : ""}>{al.title}</h1>
          <div className="hero-meta">
            <ArtistImage name={al.artist} className="hero-artist-img" />
            <a className="strong" onClick={() => s.go({ v: "artist", key: al.artistKey })}>
              {al.artist}
            </a>
            {al.year > 0 && <span>{al.year}</span>}
            <span>
              {songs(al.tracks.length)}, {fmtLong(al.secs)}
            </span>
            <QualityTag bits={al.bits} rate={al.rate} codec={al.codec} />
          </div>
        </div>
      </header>
      <div className="actions">
        <PlayButton playing={isCur && s.player?.playing} onClick={() => (isCur ? api.toggle() : s.playTracks(al.tracks, 0, `album:${al.key}`))} />
        <button
          className="icon-btn big"
          aria-label={t("Tocar no aleatório")}
          title={t("Tocar no aleatório")}
          onClick={() => {
            api.setShuffle(true);
            s.playTracks(al.tracks, Math.floor(Math.random() * al.tracks.length), `album:${al.key}`);
          }}
        >
          <IShuffle size={26} />
        </button>
        <MoreButton
          items={() => [
            { label: t("Adicionar à fila"), onClick: () => api.enqueue(al.tracks.map((x) => x.id)).then(() => s.showToast({ text: t("Álbum adicionado à fila") })) },
            { label: t("Tocar a seguir"), onClick: () => api.playNext(al.tracks.map((x) => x.id)).then(() => s.showToast({ text: t("Vai tocar a seguir") })) },
            { label: t("Adicionar à playlist"), onClick: () => askAddToPlaylist(al.tracks.map((x) => x.id)) },
            "sep",
            { label: t("Editar informações"), onClick: () => window.dispatchEvent(new CustomEvent("toxify:edit-album", { detail: al.key })) },
          ]}
        />
      </div>
      <div className="page-body">
        <TrackList tracks={al.tracks} showAlbum={false} showCover={false} numbers="track" discs ctx={`album:${al.key}`} />
        <p className="album-foot">
          {al.year > 0 && <>{al.year} · </>}
          {al.tracks[0].genre && <>{al.tracks[0].genre} · </>}
          {al.codec} {al.bits ? `${al.bits} bit` : ""} {khz(al.rate)} kHz
        </p>
        {more.length > 0 && (
          <Shelf title={t("Mais de {name}", { name: al.artist })} onMore={() => s.go({ v: "artist", key: al.artistKey })}>
            {more.map((a) => (
              <AlbumCard key={a.key} album={a} sub={`${a.year || ""}`} />
            ))}
          </Shelf>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- artista

export function ArtistPage({ artistKey }: { artistKey: string }) {
  const s = useStore();
  const ar = s.lib.artistByKey.get(artistKey);
  const [renaming, setRenaming] = useState(false);
  const [all, setAll] = useState(false);
  // "Populares" de verdade: o que o mundo mais ouve desse artista (Deezer), cruzado com o que você tem.
  const [top, setTop] = useState<string[]>([]);
  useEffect(() => {
    if (!ar) return;
    let alive = true;
    api
      .artistTop(ar.name)
      .then((t) => alive && setTop(t))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ar?.name]);
  const popular = useMemo(() => {
    if (!ar) return [];
    // "Smooth Operator (Remastered 2011) - Single Version" e "Smooth Operator" são a mesma.
    const clean = (x: string) =>
      fold(x)
        .replace(/\s*[([][^)\]]*[)\]]/g, "")
        .replace(/\s+-\s+.*$/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const rankOf = new Map<string, number>();
    top.forEach((title, i) => {
      const k = clean(title);
      if (!rankOf.has(k)) rankOf.set(k, i);
    });
    const rank = (t: Track) => rankOf.get(clean(t.title)) ?? Infinity;
    const sorted = [...ar.tracks].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (s.plays.get(b.id)?.count ?? 0) - (s.plays.get(a.id)?.count ?? 0) ||
        b.bits - a.bits ||
        b.rate - a.rate ||
        b.year - a.year,
    );
    // A mesma música em dois álbuns (deluxe, coletânea) aparece uma vez só, na melhor qualidade.
    const seen = new Set<string>();
    return sorted.filter((t) => {
      const k = clean(t.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [ar, s.plays, top]);
  if (!ar) return <NotFound what={t("Esse artista não está mais na biblioteca.")} />;
  const isCur = ar.tracks.some((t) => t.id === s.player?.track_id);
  return (
    <div className="page artist-page">
      <header className="artist-hero">
        <ArtistImage name={ar.name} className="artist-hero-img" />
        <div className="artist-hero-shade" />
        <div className="artist-hero-text">
          <h1 className={ar.name.length > 22 ? "long" : ""}>{ar.name}</h1>
          <span>
            {t("{albums} · {tracks} na sua biblioteca", { albums: plural(ar.albums.length, t("álbum"), t("álbuns")), tracks: songs(ar.tracks.length) })}
          </span>
        </div>
      </header>
      <div className="actions">
        <PlayButton playing={isCur && s.player?.playing} onClick={() => (isCur ? api.toggle() : s.playTracks(popular, 0, `artist:${ar.key}`))} />
        <button
          className="icon-btn big"
          aria-label={t("Tocar no aleatório")}
          title={t("Tocar no aleatório")}
          onClick={() => {
            api.setShuffle(true);
            s.playTracks(ar.tracks, Math.floor(Math.random() * ar.tracks.length), `artist:${ar.key}`);
          }}
        >
          <IShuffle size={26} />
        </button>
        <button className="genre-pill" onClick={() => askGenre(ar.key)} title={t("Muda em qual mix esse artista entra")}>
          {genreLabel(artistGenre(s, ar.key) ?? "") || t("Sem gênero")}
        </button>
        <MoreButton
          items={() => [
            { label: t("Adicionar tudo à fila"), onClick: () => api.enqueue(ar.tracks.map((x) => x.id)) },
            { label: t("Mudar o gênero"), onClick: () => askGenre(ar.key) },
            "sep",
            { label: t("Renomear artista"), onClick: () => setRenaming(true) },
          ]}
        />
      </div>
      <div className="page-body">
        <h2 className="sec">{t("Populares")}</h2>
        <TrackList tracks={popular.slice(0, all ? 10 : 5)} showAlbum ctx={`artist:${ar.key}`} />
        {popular.length > 5 && (
          <button className="link-btn" onClick={() => setAll(!all)}>
            {all ? t("Mostrar menos") : t("Ver mais")}
          </button>
        )}
        <h2 className="sec">{t("Discografia")}</h2>
        <div className="grid">
          {ar.albums.map((a) => (
            <AlbumCard key={a.key} album={a} sub={`${a.year || ""}${a.year ? " · " : ""}${t("Álbum")}`} />
          ))}
        </div>
        {ar.appearsOn.length > 0 && (
          <>
            <h2 className="sec">{t("Aparece em")}</h2>
            <div className="grid">
              {ar.appearsOn.map((a) => (
                <AlbumCard key={a.key} album={a} />
              ))}
            </div>
          </>
        )}
      </div>
      {renaming && <RenameArtist name={ar.name} tracks={ar.tracks} onClose={() => setRenaming(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- gênero do artista

export const askGenre = (artistKey: string) => window.dispatchEvent(new CustomEvent("toxify:genre", { detail: artistKey }));

/** O gênero que vale pro artista: o escolhido, senão o mais comum das faixas dele. */
export function artistGenre(s: ReturnType<typeof useStore>, key: string): string | null {
  if (s.genres[key]) return s.genres[key];
  const ar = s.lib.artistByKey.get(key);
  if (!ar) return null;
  const c = new Map<string, number>();
  for (const t of ar.tracks) {
    const g = s.lib.genreOf.get(t.id);
    if (g) c.set(g, (c.get(g) ?? 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** `target` = chave do artista, ou "#<id>" pra uma música só. */
export function GenrePicker({ artistKey: target, onClose }: { artistKey: string; onClose: () => void }) {
  const s = useStore();
  const track = target.startsWith("#") ? s.lib.byId.get(Number(target.slice(1))) : undefined;
  const ar = track ? undefined : s.lib.artistByKey.get(target);
  const name = track ? `"${track.title}"` : ar?.name;
  const cur = track ? (s.lib.genreOf.get(track.id) ?? null) : artistGenre(s, target);
  const [custom, setCustom] = useState("");
  if (!name) return null;
  const artistKey = target;
  const pick = (g: string) => {
    s.setGenre(target, g);
    onClose();
    s.showToast({
      text: g
        ? t('{name} agora entra no "{mix}"', { name, mix: t("Mix {g}", { g: genreLabel(g) }) })
        : track
          ? t("{name} volta a usar o gênero do artista", { name })
          : t("{name} volta a usar o gênero dos arquivos", { name }),
    });
  };
  return (
    <Modal title={t("Gênero de {name}", { name })} onClose={onClose}>
      <p className="muted">
        {track
          ? t("Só pra essa música, vale mais que o gênero do artista. Não mexe no arquivo.")
          : t('É o que decide em qual mix "Feito pra você" ele entra. Não mexe nos arquivos.')}
      </p>
      <input className="genre-search" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t("Buscar ou criar: emo rap, phonk, pagodão...")} autoFocus />
      <div className="genre-tree">
        {GENRE_TREE.map(([g, subs]) => {
          const q = fold(custom.trim());
          const vis = [g, ...subs].filter((x) => !q || fold(x).includes(q) || fold(genreLabel(x)).includes(q));
          if (!vis.length) return null;
          return (
            <div key={g} className="genre-group">
              <button className={`chip main ${cur === g ? "on" : ""}`} onClick={() => pick(g)} title={t("{g} (tudo de {g})", { g: genreLabel(g) })}>
                {genreLabel(g)}
              </button>
              {subs
                .filter((x) => vis.includes(x))
                .map((x) => (
                  <button key={x} className={`chip ${cur === x ? "on" : ""}`} onClick={() => pick(x)}>
                    {genreLabel(x)}
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      <label className="field" hidden>
        {t("Outro")}
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t("Ex.: Boom bap, Phonk, Pagodão")} onKeyDown={(e) => e.key === "Enter" && custom.trim() && pick(custom.trim())} />
      </label>
      <div className="modal-btns">
        {s.genres[artistKey] && (
          <button className="btn ghost" onClick={() => pick("")}>
            {track ? t("Usar o do artista") : t("Usar o dos arquivos")}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>
          {t("Cancelar")}
        </button>
        <button className="btn primary" disabled={!custom.trim()} onClick={() => pick(custom.trim())}>
          {t('Usar "{name}"', { name: custom.trim() || "…" })}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- listas

export function AlbumsPage({ filter }: { filter?: "hires" }) {
  const s = useStore();
  const [sort, setSort] = useState(() => localStorage.getItem("toxify.albumsort") ?? "recent");
  const list = useMemo(() => {
    const a = s.lib.albums.filter((x) => filter !== "hires" || isHiRes(x.bits, x.rate));
    if (sort === "recent") a.sort((x, y) => y.added - x.added);
    if (sort === "az") a.sort((x, y) => x.title.localeCompare(y.title, LOCALE));
    if (sort === "artist") a.sort((x, y) => x.artist.localeCompare(y.artist, LOCALE) || y.year - x.year);
    if (sort === "year") a.sort((x, y) => y.year - x.year);
    if (sort === "quality") a.sort((x, y) => y.bits - x.bits || y.rate - x.rate);
    return a;
  }, [s.lib, sort, filter]);
  return (
    <div className="page list-page">
      <div className="list-head">
        <h1>
          {filter === "hires" ? t("Em alta resolução") : t("Álbuns")}
          <span className="h-count">{plural(list.length, t("álbum"), t("álbuns"))}</span>
        </h1>
        <label className="sort">
          {t("Ordenar por")}
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              localStorage.setItem("toxify.albumsort", e.target.value);
            }}
          >
            <option value="recent">{t("Adicionados por último")}</option>
            <option value="az">{t("Nome")}</option>
            <option value="artist">{t("Artista")}</option>
            <option value="year">{t("Ano")}</option>
            <option value="quality">{t("Qualidade")}</option>
          </select>
        </label>
      </div>
      <div className="grid">
        {list.map((a) => (
          <AlbumCard key={a.key} album={a} />
        ))}
      </div>
    </div>
  );
}

export function ArtistsPage() {
  const s = useStore();
  return (
    <div className="page list-page">
      <div className="list-head">
        <h1>{t("Artistas")}</h1>
      </div>
      <div className="grid">
        {s.lib.artists.map((a) => (
          <ArtistCard key={a.key} artist={a} />
        ))}
      </div>
    </div>
  );
}

export function LikedPage() {
  const s = useStore();
  const tracks = [...s.likes].map((id) => s.lib.byId.get(id)).filter((t): t is Track => !!t);
  return (
    <div className="page" style={{ ["--hero" as string]: "rgb(72, 56, 150)" }}>
      <header className="hero">
        <div className="hero-cover liked-cover">
          <IHeart size={80} />
        </div>
        <div className="hero-text">
          <span className="hero-kind">{t("Playlist")}</span>
          <h1>{t("Músicas Curtidas")}</h1>
          <div className="hero-meta">
            <span>{songs(tracks.length)}</span>
          </div>
        </div>
      </header>
      <div className="actions">
        <PlayButton onClick={() => s.playTracks(tracks, 0, "liked")} />
      </div>
      <div className="page-body">
        {tracks.length ? <TrackList tracks={tracks} ctx="liked" /> : <p className="muted">{t("Toca no coração de uma música pra ela aparecer aqui.")}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- playlists e mixes

export function MixCard({ mix }: { mix: Mix }) {
  const s = useStore();
  const isCur = s.playCtx === `mix:${mix.id}`;
  return (
    <div className="card" onClick={() => s.go({ v: "mix", id: mix.id })}>
      <div className="card-art">
        <MixArt tracks={mix.tracks} face={mix.face} title={mix.title} color={mix.color} className="card-mosaic" />
        <button
          className={`card-play ${isCur ? "on" : ""}`}
          aria-label={t("Tocar {name}", { name: mix.title })}
          onClick={(e) => {
            e.stopPropagation();
            if (isCur) api.toggle();
            else s.playTracks(mix.tracks, 0, `mix:${mix.id}`);
          }}
        >
          {isCur && s.player?.playing ? <IPause size={22} /> : <IPlay size={22} />}
        </button>
      </div>
      <div className="card-title">{mix.title}</div>
      <div className="card-sub">{mix.subtitle}</div>
    </div>
  );
}

export function PlaylistCard({ pl }: { pl: Playlist }) {
  const s = useStore();
  const tracks = pl.tracks.map((id) => s.lib.byId.get(id)).filter((t): t is Track => !!t);
  return (
    <div className="card" onClick={() => s.go({ v: "playlist", id: pl.id })}>
      <div className="card-art">
        <Mosaic tracks={tracks} className="card-mosaic" />
        {tracks.length > 0 && (
          <button
            className="card-play"
            aria-label={t("Tocar {name}", { name: pl.name })}
            onClick={(e) => {
              e.stopPropagation();
              s.playTracks(tracks, 0, `playlist:${pl.id}`);
            }}
          >
            <IPlay size={22} />
          </button>
        )}
      </div>
      <div className="card-title">{pl.name}</div>
      <div className="card-sub">
        {t("Playlist")} · {songs(tracks.length)}
      </div>
    </div>
  );
}

export function MixesPage() {
  const s = useStore();
  return (
    <div className="page list-page">
      <div className="list-head">
        <h1>{t("Feito pra você")}</h1>
      </div>
      <p className="muted">{t("Montados com o que você ouve, curte e pula. Mudam todo dia e vão ficando mais a sua cara.")}</p>
      <div className="grid">
        {s.mixes.map((m) => (
          <MixCard key={m.id} mix={m} />
        ))}
      </div>
    </div>
  );
}

export function MixPage({ id }: { id: string }) {
  const s = useStore();
  const mix = s.mixes.find((m) => m.id === id);
  const color = mix?.color ?? "rgb(70,70,80)";
  if (!mix) return <NotFound what={t("Esse mix não existe mais (eles mudam conforme você ouve).")} />;
  const ctx = `mix:${mix.id}`;
  const isCur = s.playCtx === ctx;
  return (
    <div className="page" style={{ ["--hero" as string]: color }}>
      <header className="hero">
        <MixArt tracks={mix.tracks} face={mix.face} title={mix.title} color={mix.color} className="hero-cover" />
        <div className="hero-text">
          <span className="hero-kind">{t("Feito pra você")}</span>
          <h1 className={mix.title.length > 24 ? "long" : ""}>{mix.title}</h1>
          <div className="hero-meta">
            <span className="first">{mix.subtitle}</span>
            <span>
              {songs(mix.tracks.length)}, {fmtLong(mix.tracks.reduce((a, x) => a + x.secs, 0))}
            </span>
          </div>
        </div>
      </header>
      <div className="actions">
        <PlayButton playing={isCur && s.player?.playing} onClick={() => (isCur ? api.toggle() : s.playTracks(mix.tracks, 0, ctx))} />
        <button
          className="icon-btn big"
          aria-label={t("Tocar no aleatório")}
          title={t("Tocar no aleatório")}
          onClick={() => {
            api.setShuffle(true);
            s.playTracks(mix.tracks, Math.floor(Math.random() * mix.tracks.length), ctx);
          }}
        >
          <IShuffle size={26} />
        </button>
        <button
          className="btn"
          onClick={async () => {
            const pid = await api.playlistCreate(mix.title, mix.tracks.map((x) => x.id));
            await s.reloadPlaylists();
            s.showToast({ text: t('Salvo como playlist "{name}"', { name: mix.title }), action: { label: t("Abrir"), onClick: () => s.go({ v: "playlist", id: pid }) } });
          }}
        >
          {t("Salvar como playlist")}
        </button>
      </div>
      <div className="page-body">
        <TrackList tracks={mix.tracks} ctx={ctx} />
      </div>
    </div>
  );
}

export function PlaylistPage({ id }: { id: number }) {
  const s = useStore();
  const pl = s.playlists.find((p) => p.id === id);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const tracks = useMemo(() => (pl?.tracks ?? []).map((tid) => s.lib.byId.get(tid)).filter((t): t is Track => !!t), [pl, s.lib]);
  const color = useCoverColor(tracks[0]?.id);
  if (!pl) return <NotFound what={t("Essa playlist não existe mais.")} />;
  const ctx = `playlist:${pl.id}`;
  const isCur = s.playCtx === ctx;
  const save = async (ids: number[]) => {
    await api.playlistSet(pl.id, ids);
    await s.reloadPlaylists();
  };
  const ids = tracks.map((t) => t.id);
  return (
    <div className="page" style={{ ["--hero" as string]: color }}>
      <header className="hero">
        <Mosaic tracks={tracks} className="hero-cover" />
        <div className="hero-text">
          <span className="hero-kind">{t("Playlist")}</span>
          <h1 className={`clickable ${pl.name.length > 24 ? "long" : ""}`} onClick={() => setRenaming(true)} title={t("Renomear")}>
            {pl.name}
          </h1>
          <div className="hero-meta">
            <span className="first">{songs(tracks.length)}</span>
            {tracks.length > 0 && <span>{fmtLong(tracks.reduce((a, t) => a + t.secs, 0))}</span>}
          </div>
        </div>
      </header>
      <div className="actions">
        {tracks.length > 0 && (
          <>
            <PlayButton playing={isCur && s.player?.playing} onClick={() => (isCur ? api.toggle() : s.playTracks(tracks, 0, ctx))} />
            <button
              className="icon-btn big"
              aria-label={t("Tocar no aleatório")}
              title={t("Tocar no aleatório")}
              onClick={() => {
                api.setShuffle(true);
                s.playTracks(tracks, Math.floor(Math.random() * tracks.length), ctx);
              }}
            >
              <IShuffle size={26} />
            </button>
          </>
        )}
        <MoreButton
          items={() => [
            { label: t("Renomear"), onClick: () => setRenaming(true) },
            ...(tracks.length ? [{ label: t("Adicionar à fila"), onClick: () => api.enqueue(ids).then(() => s.showToast({ text: t("Playlist adicionada à fila") })) }] : []),
            "sep",
            { label: t("Apagar playlist"), danger: true, onClick: () => setDeleting(true) },
          ]}
        />
      </div>
      <div className="page-body">
        {tracks.length ? (
          <TrackList
            tracks={tracks}
            ctx={ctx}
            onReorder={(from, to) => {
              const next = [...ids];
              const [m] = next.splice(from, 1);
              next.splice(to, 0, m);
              save(next);
            }}
            onRemove={(i) => {
              const removed = ids[i];
              save(ids.filter((_, k) => k !== i));
              s.showToast({ text: t("Tirada da playlist"), action: { label: t("Desfazer"), onClick: () => save(ids.slice(0, i).concat(removed, ids.slice(i))) } });
            }}
          />
        ) : (
          <div className="pl-empty">
            <p>{t("Essa playlist está vazia.")}</p>
            <p className="muted">{t('Arraste músicas até ela na lateral, ou clique com o botão direito numa música e escolha "Adicionar à playlist".')}</p>
          </div>
        )}
      </div>
      {renaming && (
        <NameModal
          title={t("Renomear playlist")}
          initial={pl.name}
          action={t("Salvar")}
          onClose={() => setRenaming(false)}
          onSave={async (name) => {
            await api.playlistRename(pl.id, name);
            await s.reloadPlaylists();
            setRenaming(false);
          }}
        />
      )}
      {deleting && (
        <Modal title={t("Apagar playlist?")} onClose={() => setDeleting(false)}>
          <p>{t('A playlist "{name}" some do Toxify. As músicas continuam na sua biblioteca.', { name: pl.name })}</p>
          <div className="modal-btns">
            <button className="btn ghost" onClick={() => setDeleting(false)}>
              {t("Cancelar")}
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                await api.playlistDelete(pl.id);
                await s.reloadPlaylists();
                setDeleting(false);
                s.go({ v: "home" });
                s.showToast({ text: t('Playlist "{name}" apagada', { name: pl.name }) });
              }}
            >
              {t("Apagar")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function NameModal({ title, initial = "", action, onClose, onSave }: { title: string; initial?: string; action: string; onClose: () => void; onSave: (name: string) => void }) {
  const [v, setV] = useState(initial);
  const ok = v.trim().length > 0;
  return (
    <Modal title={title} onClose={onClose}>
      <label className="field">
        {t("Nome")}
        <input value={v} onChange={(e) => setV(e.target.value)} autoFocus maxLength={100} onKeyDown={(e) => e.key === "Enter" && ok && onSave(v.trim())} />
      </label>
      <div className="modal-btns">
        <button className="btn ghost" onClick={onClose}>
          {t("Cancelar")}
        </button>
        <button className="btn primary" disabled={!ok} onClick={() => onSave(v.trim())}>
          {action}
        </button>
      </div>
    </Modal>
  );
}

/** "Adicionar à playlist": escolhe uma existente ou cria uma nova já com as músicas. */
export function AddToPlaylist({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const s = useStore();
  const [creating, setCreating] = useState(false);
  if (creating)
    return (
      <NameModal
        title={t("Nova playlist")}
        initial={t("Minha playlist nº {n}", { n: s.playlists.length + 1 })}
        action={t("Criar")}
        onClose={onClose}
        onSave={async (name) => {
          const pid = await api.playlistCreate(name, ids);
          await s.reloadPlaylists();
          onClose();
          s.showToast({ text: t('Criada "{name}"', { name }), action: { label: t("Abrir"), onClick: () => s.go({ v: "playlist", id: pid }) } });
        }}
      />
    );
  return (
    <Modal title={ids.length > 1 ? t("Adicionar {n} músicas", { n: ids.length }) : t("Adicionar à playlist")} onClose={onClose}>
      <div className="pl-pick">
        <button className="pl-pick-row new" onClick={() => setCreating(true)}>
          <span className="pl-pick-plus">+</span>
          {t("Nova playlist")}
        </button>
        {s.playlists.map((p) => {
          const ts = p.tracks.map((id) => s.lib.byId.get(id)).filter((t): t is Track => !!t);
          const has = ids.every((id) => p.tracks.includes(id));
          return (
            <button
              key={p.id}
              className="pl-pick-row"
              onClick={async () => {
                await s.addToPlaylist(p.id, ids);
                onClose();
              }}
            >
              <Mosaic tracks={ts} className="pl-pick-art" />
              <span className="pl-pick-text">
                <b>{p.name}</b>
                <small>{has ? t("Já está aqui") : songs(ts.length)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- busca

export function SearchPage({ q }: { q: string }) {
  const s = useStore();
  const res = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const hit = (txt: string) => {
      const f = fold(txt);
      return words.every((w) => f.includes(w));
    };
    return {
      tracks: s.lib.tracks.filter((t) => hit(`${t.title} ${t.artist} ${t.album_artist} ${t.album}`)).slice(0, 50),
      albums: s.lib.albums.filter((a) => hit(`${a.title} ${a.artist}`)),
      artists: s.lib.artists.filter((a) => hit(a.name)),
    };
  }, [q, s.lib]);
  if (!res)
    return (
      <div className="page list-page">
        <h1>{t("Buscar")}</h1>
        <p className="muted">{t("Digita o nome de uma música, álbum ou artista lá em cima.")}</p>
        <h2 className="sec">{t("Navegar")}</h2>
        <div className="grid">
          {s.lib.artists.slice(0, 12).map((a) => (
            <ArtistCard key={a.key} artist={a} />
          ))}
        </div>
      </div>
    );
  const nothing = !res.tracks.length && !res.albums.length && !res.artists.length;
  const top = res.artists[0] ?? null;
  return (
    <div className="page list-page">
      {nothing && <p className="muted big">{t('Nada encontrado pra "{q}".', { q })}</p>}
      {!nothing && (
        <div className="search-top">
          {top ? (
            <section className="top-result" onClick={() => s.go({ v: "artist", key: top.key })}>
              <h2 className="sec">{t("Melhor resultado")}</h2>
              <div className="top-card">
                <ArtistImage name={top.name} className="top-img round" />
                <h3>{top.name}</h3>
                <span className="pill">{t("Artista")}</span>
              </div>
            </section>
          ) : res.albums[0] ? (
            <section className="top-result" onClick={() => s.go({ v: "album", key: res.albums[0].key })}>
              <h2 className="sec">{t("Melhor resultado")}</h2>
              <div className="top-card">
                <Cover id={res.albums[0].coverId} size={200} className="top-img" />
                <h3>{res.albums[0].title}</h3>
                <span className="pill">
                  {t("Álbum")} · {res.albums[0].artist}
                </span>
              </div>
            </section>
          ) : null}
          {res.tracks.length > 0 && (
            <section className="top-tracks">
              <h2 className="sec">{t("Músicas")}</h2>
              <TrackList tracks={res.tracks.slice(0, 4)} showAlbum={false} />
            </section>
          )}
        </div>
      )}
      {res.artists.length > 0 && (
        <Shelf title={t("Artistas")}>
          {res.artists.map((a) => (
            <ArtistCard key={a.key} artist={a} />
          ))}
        </Shelf>
      )}
      {res.albums.length > 0 && (
        <Shelf title={t("Álbuns")}>
          {res.albums.map((a) => (
            <AlbumCard key={a.key} album={a} />
          ))}
        </Shelf>
      )}
      {res.tracks.length > 4 && (
        <>
          <h2 className="sec">{t("Todas as músicas")}</h2>
          <TrackList tracks={res.tracks} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- fila

export function QueuePage() {
  const s = useStore();
  const { ids, index } = s.queue;
  const cur = s.lib.byId.get(ids[index]);
  const upcoming = ids.slice(index + 1).map((id, k) => ({ tr: s.lib.byId.get(id), i: index + 1 + k })).filter((x) => x.tr);
  return (
    <div className="page list-page">
      <h1>{t("Fila")}</h1>
      {!cur && <p className="muted">{t("A fila está vazia. Toca um álbum ou uma música pra começar.")}</p>}
      {cur && (
        <>
          <h2 className="sec">{t("Tocando agora")}</h2>
          <TrackList tracks={[cur]} />
          <h2 className="sec">{s.player?.shuffle ? t("A seguir (aleatório)") : t("A seguir")}</h2>
          <div className="queue-list">
            {upcoming.map(({ tr, i }, k) => [
              // Onde começam as que entraram sozinhas.
              s.autoIds.has(tr!.id) && (k === 0 || !s.autoIds.has(upcoming[k - 1].tr!.id)) ? (
                <div key={`auto-${i}`} className="q-auto">
                  <b>{t("Reprodução automática")}</b>
                  <span>{t("Músicas parecidas com o que você estava ouvindo")}</span>
                </div>
              ) : null,
              <div key={`${tr!.id}-${i}`} className="q-row" onDoubleClick={() => api.jumpTo(i)}>
                <span className="q-n">{k + 1}</span>
                <Cover id={tr!.id} size={80} className="tl-cover" />
                <span className="tl-text">
                  <span className="tl-name">{tr!.title}</span>
                  <span className="tl-artist">{showArtists(tr!.artist || tr!.album_artist)}</span>
                </span>
                <QualityTag bits={tr!.bits} rate={tr!.rate} codec={tr!.codec} />
                <span className="d">{fmtTime(tr!.secs)}</span>
                <button className="icon-btn" aria-label={t("Tirar da fila")} title={t("Tirar da fila")} onClick={() => api.removeAt(i)}>
                  <IClose size={16} />
                </button>
              </div>,
            ])}
            {!upcoming.length && <p className="muted">{t("Nada depois dessa.")}</p>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- letra em tela cheia

export function LyricsPage() {
  const s = useStore();
  const tr = s.player?.track_id != null ? s.lib.byId.get(s.player.track_id) : undefined;
  const lyr = useLyrics(tr);
  const color = useCoverColor(tr?.id);
  usePosition();
  if (!tr) return <NotFound what={t("Toca uma música pra ver a letra.")} />;
  return (
    <div className="page lyrics-page" style={{ ["--hero" as string]: color }}>
      <div className="lyrics-page-head">
        <Cover id={tr.id} size={200} className="lp-cover" />
        <div>
          <h2>{tr.title}</h2>
          <span>
            <ArtistLinks text={tr.artist || tr.album_artist} />
          </span>
        </div>
      </div>
      {lyr?.loading ? (
        <p className="lyr-empty big">{t("Procurando a letra…")}</p>
      ) : lyr?.lyrics ? (
        <LyricsView lyrics={lyr.lyrics} big />
      ) : (
        <p className="lyr-empty big">{t("Não achei a letra dessa.")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- configurações

export function SettingsPage() {
  const s = useStore();
  const st = s.settings;
  if (!st) return null;
  const save = (folders: string[]) => {
    s.setSettings({ ...st, folders });
    api.setFolders(folders);
  };
  return (
    <div className="page list-page settings">
      <h1>{t("Configurações")}</h1>
      <section>
        {/* Bilíngue de propósito: quem caiu no idioma errado acha onde trocar. */}
        <h2 className="sec">Idioma / Language</h2>
        <label className="row-toggle">
          <span>
            {t("Idioma do Toxify")}
            <small>{t("Muda os textos do app e o idioma da tradução das letras. A tela recarrega.")}</small>
          </span>
          <select value={LANG} onChange={(e) => setLang(e.target.value as "pt" | "en")} aria-label="Idioma / Language">
            <option value="pt">Português</option>
            <option value="en">English</option>
          </select>
        </label>
      </section>
      <section>
        <h2 className="sec">{t("Biblioteca")}</h2>
        <p className="muted">{t("Pastas onde o Toxify procura música. Subpastas entram também.")}</p>
        <div className="folders">
          {st.folders.map((f) => (
            <div key={f} className="folder">
              <IFolder size={18} />
              <span>{f}</span>
              <button className="icon-btn" aria-label={t("Tirar {folder}", { folder: f })} onClick={() => save(st.folders.filter((x) => x !== f))}>
                <IClose size={16} />
              </button>
            </div>
          ))}
        </div>
        <div className="row-btns">
          <button
            className="btn"
            onClick={async () => {
              const dir = await open({ directory: true, title: t("Escolha a pasta de músicas") });
              if (typeof dir === "string" && !st.folders.includes(dir)) save([...st.folders, dir]);
            }}
          >
            {t("Adicionar pasta")}
          </button>
          <button className="btn" onClick={() => api.rescan()} disabled={!!s.scan}>
            {s.scan ? t("Lendo… {done} de {total}", { done: s.scan.done, total: s.scan.total }) : t("Ler a biblioteca de novo")}
          </button>
        </div>
        <p className="muted small">
          {songs(s.lib.tracks.length)} · {plural(s.lib.albums.length, t("álbum"), t("álbuns"))} · {plural(s.lib.artists.length, t("artista"), t("artistas"))}
        </p>
      </section>
      <section>
        <h2 className="sec">{t("Som")}</h2>
        <label className="row-toggle">
          <span>
            {t("Modo exclusivo")}
            <small>{t("O Toxify fala direto com a placa de som e troca a taxa a cada música. É o que garante o som intocado. Enquanto toca, outros apps ficam sem som.")}</small>
          </span>
          <Switch on={s.player?.exclusive ?? st.prefs.exclusive} onChange={(on) => api.setExclusive(on)} />
        </label>
        <label className="row-toggle">
          <span>
            Crossfade
            <small>{t("Mistura uma música na outra quando muda de álbum ou está no aleatório. Álbum tocando em ordem sempre emenda sem pausa.")}</small>
          </span>
          <Switch on={s.player?.crossfade ?? st.prefs.crossfade} onChange={(on) => api.setCrossfade(on, s.player?.crossfade_secs ?? st.prefs.crossfade_secs)} />
        </label>
        <label className="row-toggle">
          <span>
            {t("Reprodução automática")}
            <small>{t("Quando a fila ou a playlist acaba, continua tocando músicas do mesmo estilo que você curte.")}</small>
          </span>
          <Switch on={s.autoplay} onChange={(on) => s.setAutoplay(on)} />
        </label>
        <div className="xf-slider wide">
          <span>{t("Duração")}</span>
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            defaultValue={s.player?.crossfade_secs ?? st.prefs.crossfade_secs}
            onChange={(e) => api.setCrossfade(true, Number(e.target.value))}
            aria-label={t("Duração do crossfade")}
          />
          <span>{s.player?.crossfade_secs ?? st.prefs.crossfade_secs} s</span>
        </div>
      </section>
      <section>
        <h2 className="sec">{t("Automático")}</h2>
        <label className="row-toggle">
          <span>
            {t("Arrumar a biblioteca sozinho")}
            <small>
              {t('Toda vez que ler suas músicas, aplica as correções do "Arrumar biblioteca" (artista escrito errado, lixo de site no nome, CDs separados). Avisa o que fez e dá pra desfazer.')}
            </small>
          </span>
          <Switch
            on={st.auto_fix}
            onChange={(on) => {
              s.setSettings({ ...st, auto_fix: on });
              api.setAuto(on);
            }}
          />
        </label>
        <p className="muted small">
          {t("O gênero de cada artista vem das tags das músicas. Se estiver errado, troque na página do artista: os mixes passam a usar a sua escolha.")}
        </p>
      </section>
      <section>
        <h2 className="sec">Discord</h2>
        <label className="row-toggle">
          <span>
            {t("Mostrar o que estou ouvindo")}
            <small>{t('Aparece "Ouvindo Toxify" no seu perfil, com a música, o artista, a capa e o tempo. Some quando você pausa.')}</small>
          </span>
          <Switch
            on={st.discord}
            onChange={(on) => {
              s.setSettings({ ...st, discord: on });
              api.setDiscord(on);
            }}
          />
        </label>
      </section>
      <section>
        <h2 className="sec">{t("Letras")}</h2>
        <label className="row-toggle">
          <span>
            {t("Traduzir letras pra português")}
            <small>{t("Usa o Google Tradutor. A tradução aparece embaixo de cada linha e fica guardada no PC.")}</small>
          </span>
          <Switch
            on={st.translate}
            onChange={(on) => {
              s.setSettings({ ...st, translate: on });
              api.setTranslate(on);
            }}
          />
        </label>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- arrumar biblioteca

export function FixPage() {
  const s = useStore();
  const list = useMemo(() => suggestions(s.lib), [s.lib]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Suggestion[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [undo, setUndo] = useState(false);
  useEffect(() => {
    api.hasUndo().then(setUndo);
  }, [s.lib]);
  const pending = list.filter((x) => !done.has(x.id));
  return (
    <div className="page list-page fix">
      <div className="list-head">
        <h1>{t("Arrumar biblioteca")}</h1>
        {undo && (
          <button className="btn" onClick={() => applyUndo(s)}>
            <IUndo size={16} /> {t("Desfazer a última alteração")}
          </button>
        )}
      </div>
      <p className="muted">
        {t("Coisas que achei nas tags das suas músicas. Nada muda sem você mandar. Antes de gravar, cada arquivo é copiado, editado na cópia e conferido; e dá pra desfazer depois.")}
      </p>
      {pending.length === 0 && <p className="fix-ok">{t("Tudo certo por aqui. Nenhuma tag torta encontrada.")}</p>}
      {pending.length > 1 && (
        <button className="btn primary" onClick={() => setConfirm(pending)}>
          {t("Aplicar todas ({n})", { n: pending.length })}
        </button>
      )}
      <div className="fix-list">
        {pending.map((x) => (
          <div key={x.id} className="fix-item">
            <div className="fix-main">
              <IWand size={20} />
              <div>
                <h3>{x.title}</h3>
                <p>{x.detail}</p>
                <a onClick={() => setOpen(open === x.id ? null : x.id)}>
                  {open === x.id ? t("Esconder") : t("Ver o que muda ({n})", { n: plural(new Set(x.changes.map((c) => c.id)).size, t("faixa"), t("faixas")) })}
                </a>
                {open === x.id && (
                  <table className="fix-preview">
                    <tbody>
                      {x.preview.map((p, i) => (
                        <tr key={i}>
                          <td>{p.label}</td>
                          <td className="from">{p.from}</td>
                          <td>→</td>
                          <td className="to">{p.to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="fix-btns">
              <button
                className="btn ghost"
                onClick={() => {
                  setDone(new Set([...done, x.id]));
                  // Ignorou: o "arrumar sozinho" também não aplica mais essa.
                  const ign: string[] = JSON.parse(localStorage.getItem("toxify.fix.ignored") ?? "[]");
                  localStorage.setItem("toxify.fix.ignored", JSON.stringify([...ign, x.id]));
                }}
              >
                {t("Ignorar")}
              </button>
              <button className="btn primary" onClick={() => setConfirm([x])}>
                {t("Aplicar")}
              </button>
            </div>
          </div>
        ))}
      </div>
      {confirm && (
        <ApplyChanges
          title={confirm.length === 1 ? confirm[0].title : t("Aplicar {n} correções", { n: confirm.length })}
          changes={confirm.flatMap((c) => c.changes)}
          onClose={() => setConfirm(null)}
          onDone={() => setDone(new Set([...done, ...confirm.map((c) => c.id)]))}
        />
      )}
    </div>
  );
}

async function applyUndo(s: ReturnType<typeof useStore>) {
  const n = await api.undoTags();
  await s.reload();
  s.showToast({
    text: !n
      ? t("Nada pra desfazer.")
      : n === 1
        ? t("Pronto, 1 arquivo voltou como estava.")
        : t("Pronto, {n} arquivos voltaram como estavam.", { n: n.toLocaleString(LOCALE) }),
  });
}

/** Janela que grava as tags, com progresso e resultado. */
function ApplyChanges({ title, changes, onClose, onDone }: { title: string; changes: Change[]; onClose: () => void; onDone?: () => void }) {
  const s = useStore();
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [errors, setErrors] = useState<string[]>([]);
  const files = new Set(changes.map((c) => c.id)).size;
  const playingTouched = s.player?.playing && changes.some((c) => c.id === s.player?.track_id);
  useEffect(() => {
    let un: (() => void) | undefined;
    import("./api").then(({ on }) => on<[number, number]>("tag-progress", setProgress).then((u) => (un = u)));
    return () => un?.();
  }, []);
  const run = async () => {
    setState("busy");
    try {
      const errs = await api.saveTags(changes);
      setErrors(errs);
      await s.reload();
      setState("done");
      onDone?.();
      if (!errs.length) {
        onClose();
        s.showToast({
          text: t("Pronto, {files}.", { files: plural(files, t("arquivo atualizado"), t("arquivos atualizados")) }),
          action: { label: t("Desfazer"), onClick: () => applyUndo(s) },
        });
      }
    } catch (e) {
      setErrors([String(e)]);
      setState("done");
    }
  };
  return (
    <Modal title={title} onClose={state === "busy" ? () => {} : onClose}>
      {state === "ask" && (
        <>
          <p>
            {t("Vou gravar nas tags de {files}. A música em si não é tocada: só o nome, artista, álbum e afins.", {
              files: plural(files, t("arquivo"), t("arquivos")),
            })}
          </p>
          {playingTouched && <p className="warn-text">{t("Uma delas está tocando agora. Se o Windows não deixar trocar o arquivo, pausa e tenta de novo.")}</p>}
          <div className="modal-btns">
            <button className="btn ghost" onClick={onClose}>
              {t("Cancelar")}
            </button>
            <button className="btn primary" onClick={run}>
              {t("Gravar")}
            </button>
          </div>
        </>
      )}
      {state === "busy" && (
        <>
          <p>{t("Gravando… {done} de {total}", { done: progress[0], total: progress[1] || files })}</p>
          <div className="bar">
            <i style={{ width: `${progress[1] ? (progress[0] / progress[1]) * 100 : 0}%` }} />
          </div>
        </>
      )}
      {state === "done" && errors.length > 0 && (
        <>
          <p>{t("Alguns arquivos não foram alterados (os originais ficaram intactos):")}</p>
          <ul className="errors">
            {errors.slice(0, 8).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <div className="modal-btns">
            <button className="btn primary" onClick={onClose}>
              {t("Fechar")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- editar álbum e renomear artista

export function EditAlbum({ albumKey, onClose }: { albumKey: string; onClose: () => void }) {
  const s = useStore();
  const al = s.lib.albumByKey.get(albumKey);
  const [head, setHead] = useState(() => ({
    album: al?.title ?? "",
    album_artist: al?.tracks[0].album_artist ?? "",
    year: al?.year ? String(al.year) : "",
    genre: al?.tracks[0].genre ?? "",
  }));
  const [rows, setRows] = useState(() => al?.tracks.map((t) => ({ id: t.id, track: t.track ? String(t.track) : "", title: t.title, artist: t.artist })) ?? []);
  const [saving, setSaving] = useState<Change[] | null>(null);
  if (!al) return null;
  const build = (): Change[] => {
    const ch: Change[] = [];
    for (const t of al.tracks) {
      const r = rows.find((x) => x.id === t.id)!;
      const cmp: [TagField, string, string][] = [
        ["album", head.album, t.album],
        ["album_artist", head.album_artist, t.album_artist],
        ["year", head.year, t.year ? String(t.year) : ""],
        ["genre", head.genre, t.genre],
        ["track", r.track, t.track ? String(t.track) : ""],
        ["title", r.title, t.title],
        ["artist", r.artist, t.artist],
      ];
      for (const [f, v, old] of cmp) if (v.trim() !== old.trim()) ch.push({ id: t.id, field: f, value: v.trim() });
    }
    return ch;
  };
  if (saving) return <ApplyChanges title={t('Salvar "{album}"', { album: head.album })} changes={saving} onClose={onClose} />;
  return (
    <Modal title={t("Editar informações")} onClose={onClose} wide>
      <div className="edit-head">
        <Cover id={al.coverId} size={300} className="edit-cover" />
        <div className="edit-fields">
          <label>
            {t("Nome do álbum")}
            <input value={head.album} onChange={(e) => setHead({ ...head, album: e.target.value })} />
          </label>
          <label>
            {t("Artista do álbum")}
            <input value={head.album_artist} onChange={(e) => setHead({ ...head, album_artist: e.target.value })} placeholder={t("Quem aparece como dono do álbum")} />
          </label>
          <div className="two">
            <label>
              {t("Ano")}
              <input value={head.year} inputMode="numeric" onChange={(e) => setHead({ ...head, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
            </label>
            <label>
              {t("Gênero")}
              <input value={head.genre} onChange={(e) => setHead({ ...head, genre: e.target.value })} />
            </label>
          </div>
        </div>
      </div>
      <div className="edit-tracks">
        <div className="edit-row head">
          <span>{t("Nº")}</span>
          <span>{t("Título")}</span>
          <span>{t("Artista da faixa")}</span>
        </div>
        {rows.map((r, i) => (
          <div key={r.id} className="edit-row">
            <input value={r.track} inputMode="numeric" onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, track: e.target.value.replace(/\D/g, "") } : x)))} aria-label={t("Número")} />
            <input value={r.title} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} aria-label={t("Título")} />
            <input value={r.artist} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, artist: e.target.value } : x)))} aria-label={t("Artista")} />
          </div>
        ))}
      </div>
      <div className="modal-btns">
        <button className="btn ghost" onClick={onClose}>
          {t("Cancelar")}
        </button>
        <button
          className="btn primary"
          onClick={() => {
            const ch = build();
            if (!ch.length) onClose();
            else setSaving(ch);
          }}
        >
          {t("Salvar")}
        </button>
      </div>
    </Modal>
  );
}

function RenameArtist({ name, tracks, onClose }: { name: string; tracks: Track[]; onClose: () => void }) {
  const [v, setV] = useState(name);
  const [go, setGo] = useState(false);
  const s = useStore();
  if (go)
    return (
      <ApplyChanges
        title={t('Renomear pra "{name}"', { name: v })}
        changes={tracks.map((x) => ({ id: x.id, field: "album_artist", value: v.trim() }))}
        onClose={onClose}
        onDone={() => {
          const k = v.trim().toLowerCase().split(/\s+/).join(" ");
          s.go({ v: "artist", key: k });
        }}
      />
    );
  return (
    <Modal title={t("Renomear artista")} onClose={onClose}>
      <p className="muted">
        {t('Muda o "artista do álbum" em {tracks}. Se já existir um artista com esse nome, os dois viram um só (bom pra juntar "Ye" com "Kanye West").', {
          tracks: plural(tracks.length, t("faixa"), t("faixas")),
        })}
      </p>
      <label className="field">
        {t("Nome")}
        <input value={v} onChange={(e) => setV(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && v.trim() && v !== name && setGo(true)} />
      </label>
      <div className="modal-btns">
        <button className="btn ghost" onClick={onClose}>
          {t("Cancelar")}
        </button>
        <button className="btn primary" disabled={!v.trim() || v === name} onClick={() => setGo(true)}>
          {t("Renomear")}
        </button>
      </div>
    </Modal>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="page empty-lib">
      <p className="muted big">{what}</p>
    </div>
  );
}

