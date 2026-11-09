import type { Change, Track } from "./api";
import { dec, LOCALE, t } from "./i18n";

export type Album = {
  key: string;
  title: string;
  /** Nome pra mostrar ("Kyan, MU540"). */
  artist: string;
  /** Artista principal (onde o álbum "mora"). */
  artistKey: string;
  /** Todos os artistas do álbum, já separados. Álbum conjunto aparece na página de cada um. */
  artists: string[];
  year: number;
  tracks: Track[];
  coverId: number;
  secs: number;
  rate: number;
  bits: number;
  codec: string;
  added: number;
  genre: string | null;
};

export type Artist = {
  key: string;
  name: string;
  albums: Album[];
  appearsOn: Album[];
  tracks: Track[];
};

export type Plays = Map<number, { count: number; skips: number; last: number; recent: number }>;

export type Library = {
  tracks: Track[];
  byId: Map<number, Track>;
  albums: Album[];
  albumByKey: Map<string, Album>;
  artists: Artist[];
  artistByKey: Map<string, Artist>;
  /** Gênero agrupado de cada faixa (tag, ou o do artista quando a faixa não tem). */
  genreOf: Map<number, string | null>;
};

export const norm = (s: string) => s.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** Pra busca: sem acento, minúsculo. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** "Kyan; MU540" → ["Kyan", "MU540"]; "Kanye West, Kanye West" → ["Kanye West"]. Nunca quebra "Tyler, The Creator". */
export function splitArtists(s: string): string[] {
  const out: string[] = [];
  for (let part of s.split(/\s*;\s*/)) {
    part = part.trim();
    if (!part) continue;
    const commas = part.split(/,\s+/);
    if (commas.length > 1 && commas.every((c) => norm(c) === norm(commas[0]))) part = commas[0];
    if (!out.some((o) => norm(o) === norm(part))) out.push(part);
  }
  return out;
}

export const showArtists = (s: string) => splitArtists(s).join(", ");

const mostCommon = (xs: string[]) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

// ---------------------------------------------------------------- gêneros

/**
 * Gênero → subgêneros. Cada música tem um nome só (pode ser o gênero ou um subgênero);
 * o subgênero sabe quem é o pai, e o mix do pai junta tudo dele.
 */
export const GENRE_TREE: [string, string[]][] = [
  ["Rap", ["Trap", "Emo rap", "Boom bap", "Drill", "Rage", "Cloud rap", "Plugg", "Rap alternativo", "Rap consciente", "Phonk"]],
  ["Rap Brasil", ["Trap BR", "Drill BR", "Boom bap BR", "Rap consciente BR", "Emo rap BR"]],
  ["Funk", ["Funk mandelão", "Funk melody", "Funk consciente", "Funk 150", "Brega funk", "Funk de BH"]],
  ["R&B", ["R&B alternativo", "Neo soul", "Soul", "Funk e Disco", "Quiet storm"]],
  ["Pop", ["Synth-pop", "Dream pop", "Indie pop", "Hyperpop", "K-pop", "Pop latino", "Pop punk"]],
  ["Rock", ["Emo", "Hard rock", "Grunge", "Punk", "Indie rock", "Rock alternativo", "Rock progressivo", "Psicodélico", "Classic rock", "New wave", "Rock nacional", "Shoegaze"]],
  ["Metal", ["Heavy metal", "Thrash", "Nu metal", "Metalcore", "Doom"]],
  ["MPB", ["Samba", "Pagode", "Bossa nova", "Axé", "Brega", "Choro"]],
  ["Sertanejo", ["Sertanejo universitário", "Modão", "Forró", "Piseiro", "Arrocha"]],
  ["Eletrônica", ["House", "French house", "Techno", "Drum and bass", "Dubstep", "Lo-fi", "Ambient", "Trance"]],
  ["Jazz", ["Jazz fusion", "City pop", "Smooth jazz", "Bebop", "Blues"]],
  ["Reggae", ["Dancehall", "Reggaeton", "Dub"]],
  ["Gospel", []],
  ["Clássica", ["Trilha sonora"]],
  ["World", ["Afrobeats", "Latina"]],
];

export const GENRE_CHOICES = GENRE_TREE.flatMap(([g, subs]) => [g, ...subs]);

export const GENRE_PARENT: Record<string, string> = Object.fromEntries(GENRE_TREE.flatMap(([g, subs]) => subs.map((s) => [s, g])));

/** "Trap" → "Rap"; gênero principal (ou nome inventado por você) → ele mesmo. */
export const mainGenre = (g: string) => GENRE_PARENT[g] ?? g;

/**
 * Tags de gênero vêm de todo jeito ("Hip-Hop/ Rap", "Alternatif et Indé"...). Traduz pra árvore.
 * A ordem importa: o mais específico vem antes ("trap br" antes de "trap", "hard rock" antes de "rock").
 */
const GENRES: [RegExp, string][] = [
  [/brega ?funk/i, "Brega funk"],
  [/funk (carioca|brasileiro|br\b|paulista)|baile funk|mandel|funk 150/i, "Funk"],
  [/trap (br|brasil|nacional)/i, "Trap BR"],
  [/rap (nacional|br\b|brasil)|hip.?hop (nacional|br\b|brasil)/i, "Rap Brasil"],
  [/emo rap|sad rap/i, "Emo rap"],
  [/phonk/i, "Phonk"],
  [/drill/i, "Drill"],
  [/cloud rap/i, "Cloud rap"],
  [/boom.?bap/i, "Boom bap"],
  [/trap/i, "Trap"],
  [/hip.?hop|\brap\b|grime/i, "Rap"],
  [/k-?pop/i, "K-pop"],
  [/reggaeton/i, "Reggaeton"],
  [/latin|latino|cumbia|bachata/i, "Latina"],
  [/forr[oó]/i, "Forró"],
  [/piseiro|pisadinha/i, "Piseiro"],
  [/sertanej/i, "Sertanejo"],
  [/pagode/i, "Pagode"],
  [/samba/i, "Samba"],
  [/bossa/i, "Bossa nova"],
  [/ax[eé]/i, "Axé"],
  [/brega/i, "Brega"],
  [/mpb|brasil|brazil/i, "MPB"],
  [/gospel|worship|louvor|cristã/i, "Gospel"],
  [/dancehall/i, "Dancehall"],
  [/reggae|\bdub\b|ska\b/i, "Reggae"],
  [/nu.?metal/i, "Nu metal"],
  [/metalcore/i, "Metalcore"],
  [/thrash/i, "Thrash"],
  [/heavy metal/i, "Heavy metal"],
  [/metal/i, "Metal"],
  [/pop.?punk/i, "Pop punk"],
  [/emo\b|emocore/i, "Emo"],
  [/hard rock/i, "Hard rock"],
  [/grunge/i, "Grunge"],
  [/punk/i, "Punk"],
  [/shoegaze/i, "Shoegaze"],
  [/progressive|progressivo/i, "Rock progressivo"],
  [/psych|psicod/i, "Psicodélico"],
  [/new wave|post.?punk/i, "New wave"],
  [/rock nacional|rock br/i, "Rock nacional"],
  [/classic rock/i, "Classic rock"],
  [/indie rock/i, "Indie rock"],
  [/rock/i, "Rock"],
  [/indie|altern/i, "Rock alternativo"],
  [/neo.?soul/i, "Neo soul"],
  [/r&b|rnb|contemporary r/i, "R&B"],
  [/disco|funk|motown/i, "Funk e Disco"],
  [/soul/i, "Soul"],
  [/city ?pop/i, "City pop"],
  [/fusion/i, "Jazz fusion"],
  [/smooth jazz/i, "Smooth jazz"],
  [/jazz|bebop/i, "Jazz"],
  [/blues/i, "Blues"],
  [/lo-?fi|chillhop/i, "Lo-fi"],
  [/french house|french touch/i, "French house"],
  [/house/i, "House"],
  [/techno/i, "Techno"],
  [/trance/i, "Trance"],
  [/drum.?(and|&|n).?bass|dnb/i, "Drum and bass"],
  [/dubstep/i, "Dubstep"],
  [/ambient/i, "Ambient"],
  [/electr|eletr|dance|edm/i, "Eletrônica"],
  [/synth.?pop/i, "Synth-pop"],
  [/dream pop/i, "Dream pop"],
  [/hyperpop/i, "Hyperpop"],
  [/soundtrack|trilha|score|film/i, "Trilha sonora"],
  [/classic|cl[aá]ssic|orchestr|piano|opera/i, "Clássica"],
  [/pop/i, "Pop"],
  [/afrobeat/i, "Afrobeats"],
  [/world|afro/i, "World"],
];

export function genreGroup(tag: string): string | null {
  if (!tag.trim() || /^(dj|other|outros|unknown|desconhecido|misc)$/i.test(tag.trim())) return null;
  for (const [re, g] of GENRES) if (re.test(tag)) return g;
  return null;
}

// ---------------------------------------------------------------- montar a biblioteca

export function buildLibrary(tracks: Track[], genreOverrides: Record<string, string> = {}): Library {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const groups = new Map<string, Track[]>();
  for (const t of tracks) {
    const g = groups.get(t.album_key);
    if (g) g.push(t);
    else groups.set(t.album_key, [t]);
  }

  const albums: Album[] = [];
  for (const [key, ts] of groups) {
    ts.sort((a, b) => a.disc - b.disc || a.track - b.track || a.title.localeCompare(b.title));
    const who = mostCommon(ts.map((t) => t.album_artist || t.artist));
    const artists = splitArtists(who);
    const best = ts.reduce((m, t) => (t.bits > m.bits || (t.bits === m.bits && t.rate > m.rate) ? t : m), ts[0]);
    albums.push({
      key,
      title: mostCommon(ts.map((t) => t.album)) || t("Sem álbum"),
      artist: artists.join(", ") || t("Artista desconhecido"),
      artistKey: key.split("|")[0],
      artists,
      year: Math.max(...ts.map((t) => t.year)),
      tracks: ts,
      coverId: (ts.find((t) => t.cover) ?? ts[0]).id,
      secs: ts.reduce((s, t) => s + t.secs, 0),
      rate: best.rate,
      bits: best.bits,
      codec: mostCommon(ts.map((t) => t.codec)),
      added: Math.max(...ts.map((t) => t.added)),
      genre: null,
    });
  }
  albums.sort((a, b) => a.title.localeCompare(b.title, LOCALE));
  const albumByKey = new Map(albums.map((a) => [a.key, a]));

  const artistMap = new Map<string, Artist>();
  const artistFor = (key: string, name: string) => {
    let ar = artistMap.get(key);
    if (!ar) {
      ar = { key, name, albums: [], appearsOn: [], tracks: [] };
      artistMap.set(key, ar);
    }
    return ar;
  };
  for (const al of albums) {
    const keys = new Set<string>([al.artistKey]);
    artistFor(al.artistKey, al.artists[0] ?? al.artist);
    for (const name of al.artists.slice(1)) {
      const k = norm(name);
      keys.add(k);
      artistFor(k, name);
    }
    for (const k of keys) {
      const ar = artistMap.get(k)!;
      ar.albums.push(al);
      ar.tracks.push(...al.tracks);
    }
  }
  for (const ar of artistMap.values()) {
    const spellings = ar.albums.flatMap((a) => a.artists.filter((n) => norm(n) === ar.key));
    ar.name = mostCommon(spellings) || ar.name;
    ar.albums.sort((a, b) => b.year - a.year);
  }

  // "Aparece em": participação numa faixa de álbum de outro artista.
  for (const al of albums) {
    const seen = new Set<string>();
    for (const t of al.tracks) {
      const names = splitArtists(t.artist).flatMap((n) => n.split(/\s+(?:feat\.?|ft\.?|featuring|part\.)\s+|,\s+|\s+&\s+/i));
      for (const n of names) {
        const ar = artistMap.get(norm(n));
        if (!ar || seen.has(ar.key) || ar.albums.includes(al)) continue;
        ar.appearsOn.push(al);
        seen.add(ar.key);
      }
    }
  }

  // Gênero: o que você escolheu pro artista vale mais; senão a tag; se a faixa não tem tag,
  // o mais comum do artista dela.
  const genreOf = new Map<number, string | null>();
  for (const t of tracks) genreOf.set(t.id, genreGroup(t.genre));
  for (const ar of artistMap.values()) {
    const g = mostCommon(ar.tracks.map((t) => genreOf.get(t.id)).filter((x): x is string => !!x));
    if (!g) continue;
    for (const t of ar.tracks) if (!genreOf.get(t.id)) genreOf.set(t.id, g);
  }
  for (const al of albums) {
    const chosen = genreOverrides[al.artistKey];
    if (chosen) for (const t of al.tracks) genreOf.set(t.id, chosen);
  }
  // Música escolhida uma a uma ("#123") vale mais que o artista.
  for (const t of tracks) {
    const chosen = genreOverrides[`#${t.id}`];
    if (chosen) genreOf.set(t.id, chosen);
  }
  for (const al of albums) al.genre = mostCommon(al.tracks.map((t) => genreOf.get(t.id)).filter((x): x is string => !!x)) || null;

  const artists = [...artistMap.values()].sort((a, b) => a.name.localeCompare(b.name, LOCALE));
  return { tracks, byId, albums, albumByKey, artists, artistByKey: artistMap, genreOf };
}

// ---------------------------------------------------------------- formatação

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const fmtLong = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

export const khz = (rate: number) => {
  const k = rate / 1000;
  return Number.isInteger(k) ? `${k}` : dec(k.toFixed(1));
};

/** "24/96", "16/44,1". */
export const quality = (bits: number, rate: number) => (bits ? `${bits}/${khz(rate)}` : `${khz(rate)} kHz`);

export const isHiRes = (bits: number, rate: number) => bits >= 24 && rate > 48000;

/** plural(3, t("música"), t("músicas")) → "3 músicas" */
export const plural = (n: number, um: string, varios: string) => `${n.toLocaleString(LOCALE)} ${n === 1 ? um : varios}`;

/** Rótulo do gênero na tela. A chave salva (genres.json, mixes) continua sendo o nome em português. */
export const genreLabel = (g: string) => t(g);

// ---------------------------------------------------------------- mixes (feitos pra você)

export type Mix = {
  id: string;
  title: string;
  /** "Kanye West, Playboi Carti, Travis Scott e mais" */
  subtitle: string;
  tracks: Track[];
  color: string;
  /** Artista principal: a foto dele vira a capa (igual o Spotify faz). */
  face: string | null;
};

const PALETTE = ["#8b7cf6", "#d98c4a", "#4fa383", "#cf5f5a", "#4a87c9", "#b86aa6", "#7f9f47", "#c9a23e", "#5d9fae", "#9a6fd1"];
const colorFor = (s: string) => PALETTE[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

/** Sorteio que muda uma vez por dia (o mix não fica mudando a cada clique). */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Quanto você gosta da faixa. Ouvir até o fim e curtir sobe; pular desce.
 * Faixa nunca tocada começa em 1, então no começo o mix segue a sua biblioteca e vai se moldando.
 */
export function affinity(t: Track, plays: Plays, likes: Set<number>) {
  const p = plays.get(t.id);
  let s = 1;
  if (p) s += p.count * 1.5 + p.recent - p.skips * 1.2;
  if (likes.has(t.id)) s += 5;
  return Math.max(0.15, s);
}

const artistOf = (t: Track) => t.album_key.split("|")[0];

/**
 * Monta a lista:
 * 1. sorteio com peso (quem você curte mais tem mais chance), com teto por álbum e por artista;
 * 2. ordem com ritmo: favoritas na frente, intercaladas com as menos ouvidas;
 * 3. nunca o mesmo artista a menos de 3 músicas de distância.
 */
function pickMix(pool: Track[], weight: (t: Track) => number, n: number, seed: string, perAlbum = 2, perArtist = 4) {
  const r = rng(seed);
  const keyed = pool.map((t) => ({ t, w: weight(t), k: Math.pow(r(), 1 / Math.max(weight(t), 0.01)) })).sort((a, b) => b.k - a.k);
  const perAl = new Map<string, number>();
  const perAr = new Map<string, number>();
  const picked: { t: Track; w: number }[] = [];
  const taken = new Set<number>();
  // Primeiro com o teto por álbum/artista (variedade); se não chegar no tamanho, vai soltando o teto.
  for (const loosen of [1, 2, 4, Infinity]) {
    for (const x of keyed) {
      if (picked.length >= n) break;
      if (taken.has(x.t.id)) continue;
      const al = perAl.get(x.t.album_key) ?? 0;
      const ar = perAr.get(artistOf(x.t)) ?? 0;
      if (al >= perAlbum * loosen || ar >= perArtist * loosen) continue;
      perAl.set(x.t.album_key, al + 1);
      perAr.set(artistOf(x.t), ar + 1);
      picked.push(x);
      taken.add(x.t.id);
    }
    if (picked.length >= n) break;
  }
  // Favoritas e descobertas, intercaladas (2 pra 1), começando forte.
  const byW = [...picked].sort((a, b) => b.w - a.w);
  const cut = Math.ceil(byW.length * 0.6);
  const fav = byW.slice(0, cut).map((x) => x.t);
  const rest = byW.slice(cut).map((x) => x.t);
  const woven: Track[] = [];
  while (fav.length || rest.length) {
    if (fav.length) woven.push(fav.shift()!);
    if (fav.length) woven.push(fav.shift()!);
    if (rest.length) woven.push(rest.shift()!);
  }
  // Espaça os artistas.
  const out: Track[] = [];
  const left = [...woven];
  while (left.length) {
    const recent = out.slice(-3).map(artistOf);
    const i = left.findIndex((t) => !recent.includes(artistOf(t)));
    out.push(left.splice(i >= 0 ? i : 0, 1)[0]);
  }
  return out;
}

function topArtists(lib: Library, ts: Track[]) {
  const c = new Map<string, number>();
  for (const t of ts) {
    const al = lib.albumByKey.get(t.album_key);
    const name = al?.artists[0] ?? al?.artist;
    if (name) c.set(name, (c.get(name) ?? 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

function line(names: string[]) {
  return names.length > 3 ? t("{names} e mais", { names: names.slice(0, 3).join(", ") }) : names.join(", ");
}

export function buildMixes(lib: Library, plays: Plays, likes: Set<number>, day = new Date().toISOString().slice(0, 10)): Mix[] {
  const out: Mix[] = [];
  const score = (t: Track) => affinity(t, plays, likes);
  const add = (id: string, title: string, tracks: Track[], subtitle?: string, face?: string | null) => {
    if (tracks.length < 8) return;
    const names = topArtists(lib, tracks);
    out.push({ id, title, tracks, subtitle: subtitle ?? line(names), color: colorFor(id), face: face === undefined ? (names[0] ?? null) : face });
  };

  // Dois níveis: o gênero junta tudo dele (Rap = rap + trap + emo rap...), e o subgênero
  // ganha mix próprio quando tem material (15 músicas de 3 artistas), senão fica só no do pai.
  const byMain = new Map<string, Track[]>();
  const bySub = new Map<string, Track[]>();
  for (const t of lib.tracks) {
    const g = lib.genreOf.get(t.id);
    if (!g) continue;
    const main = mainGenre(g);
    byMain.set(main, [...(byMain.get(main) ?? []), t]);
    if (g !== main) bySub.set(g, [...(bySub.get(g) ?? []), t]);
  }
  const artistsIn = (ts: Track[]) => new Set(ts.map(artistOf)).size;
  const rank = (m: Map<string, Track[]>, minArtists: number) =>
    [...m.entries()]
      .filter(([, ts]) => ts.length >= 15 && artistsIn(ts) >= minArtists)
      .map(([g, ts]) => ({ g, ts, s: ts.reduce((s, t) => s + score(t), 0) }))
      .sort((a, b) => b.s - a.s);
  const genreRank = rank(byMain, 2);
  const subRank = rank(bySub, 3).filter(({ g, ts }) => ts.length < (byMain.get(mainGenre(g))?.length ?? 0) * 0.85);

  // 1. Um mix por tipo de música (e pelos subtipos que você mais ouve), na ordem do que você mais curte.
  const mixGenre = ({ g, ts }: { g: string; ts: Track[] }) => {
    const cap = Math.max(6, Math.ceil(60 / artistsIn(ts)) + 2);
    add(`genero:${g}`, t("Mix {g}", { g: genreLabel(g) }), pickMix(ts, score, 60, `${day}:${g}`, 3, cap));
  };
  genreRank.slice(0, 7).forEach(mixGenre);
  subRank.slice(0, 5).forEach(mixGenre);

  // 2. Mais tocadas de sempre e do último mês.
  const played = lib.tracks.filter((t) => (plays.get(t.id)?.count ?? 0) > 0);
  if (played.length >= 8) {
    const top = [...played].sort((a, b) => plays.get(b.id)!.count - plays.get(a.id)!.count || plays.get(b.id)!.last - plays.get(a.id)!.last).slice(0, 50);
    add("top", t("Suas mais tocadas"), top, t("As que você mais ouviu desde sempre"), null);
  }
  const recent = lib.tracks.filter((t) => (plays.get(t.id)?.recent ?? 0) > 0);
  if (recent.length >= 8) {
    add("repeat", t("Na repetição"), [...recent].sort((a, b) => plays.get(b.id)!.recent - plays.get(a.id)!.recent).slice(0, 30), t("O que você mais ouviu no último mês"));
  }

  // 3. Mix de artista: ele e quem é do mesmo tipo e da mesma época.
  const artistRank = lib.artists
    .filter((a) => a.tracks.length >= 6)
    .map((a) => ({ a, s: a.tracks.reduce((s, t) => s + score(t), 0) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, 4);
  for (const { a } of artistRank) {
    const g = lib.genreOf.get(a.tracks[0].id);
    const years = a.tracks.map((t) => t.year).filter((y) => y > 0);
    const era = years.length ? years.reduce((s, y) => s + y, 0) / years.length : 0;
    const own = pickMix(a.tracks, score, 20, `${day}:a:${a.key}`, 4, 20);
    const near = (t: Track) => score(t) * (era && t.year && Math.abs(t.year - era) <= 10 ? 2 : 1);
    const others = pickMix((byMain.get(mainGenre(g ?? "")) ?? []).filter((t) => artistOf(t) !== a.key), near, 40, `${day}:ag:${a.key}`, 2, 4);
    const mixed: Track[] = [];
    for (let i = 0; i < Math.max(own.length, others.length); i++) {
      if (own[i]) mixed.push(own[i]);
      if (others[2 * i]) mixed.push(others[2 * i]);
      if (others[2 * i + 1]) mixed.push(others[2 * i + 1]);
    }
    add(`artista:${a.key}`, t("Mix de {name}", { name: a.name }), mixed, t("{names} e parecidos", { names: [a.name, ...topArtists(lib, others).slice(0, 2)].join(", ") }), a.name);
  }

  // 4. Coisa sua que você ainda nem ouviu, puxando pros tipos que você mais curte.
  const genreWeight = new Map(genreRank.map(({ g, s, ts }) => [g, s / ts.length]));
  const unheard = lib.tracks.filter((t) => !plays.has(t.id));
  if (unheard.length >= 10 && played.length >= 8) {
    add("nunca", t("Ainda não ouviu"), pickMix(unheard, (t) => genreWeight.get(mainGenre(lib.genreOf.get(t.id) ?? "")) ?? 0.5, 50, `${day}:nunca`), t("Da sua biblioteca, do jeito que você curte"));
  }

  // 5. Pra redescobrir: curtia, mas faz tempo que não toca.
  const now = Date.now() / 1000;
  const old = lib.tracks.filter((t) => {
    const p = plays.get(t.id);
    return (p && p.count >= 2 && now - p.last > 60 * 86400) || (likes.has(t.id) && (!p || now - p.last > 60 * 86400));
  });
  if (old.length >= 8) add("redescobrir", t("Pra redescobrir"), pickMix(old, score, 50, `${day}:old`), t("Você curtia, faz tempo que não toca"));

  // 6. Por década.
  const decades = new Map<number, Track[]>();
  for (const t of lib.tracks) if (t.year > 1900) decades.set(Math.floor(t.year / 10) * 10, [...(decades.get(Math.floor(t.year / 10) * 10) ?? []), t]);
  for (const [d, ts] of [...decades.entries()].sort((a, b) => a[0] - b[0])) {
    if (ts.length < 20) continue;
    add(`decada:${d}`, t("Anos {d}", { d: d >= 2000 ? d : String(d).slice(2) }), pickMix(ts, score, 60, `${day}:${d}`, 2, 4));
  }

  // 7. Alta resolução.
  const hires = lib.tracks.filter((t) => isHiRes(t.bits, t.rate));
  if (hires.length >= 15) add("hires", t("Hi-Res de verdade"), pickMix(hires, score, 60, `${day}:hires`, 2, 5), t("Só 24 bit acima de 48 kHz"), null);

  return out;
}

/**
 * Reprodução automática: a fila acabou, continua com músicas parecidas com a última.
 * Mesmo subgênero pesa mais, mesmo gênero pesa um pouco, o resto quase nada; seu gosto multiplica tudo.
 * Fica de fora o que já está na fila e o que tocou nas últimas 3 horas.
 */
export function similarTracks(lib: Library, seed: Track, plays: Plays, likes: Set<number>, exclude: Set<number>, n = 20): Track[] {
  const g = lib.genreOf.get(seed.id) ?? null;
  const main = g ? mainGenre(g) : null;
  const now = Date.now() / 1000;
  const seedArtist = artistOf(seed);
  const pool = lib.tracks.filter((t) => !exclude.has(t.id) && t.id !== seed.id && now - (plays.get(t.id)?.last ?? 0) > 3 * 3600);
  const weight = (t: Track) => {
    const tg = lib.genreOf.get(t.id) ?? null;
    let w = 0.05;
    if (g && tg === g) w = 3;
    else if (main && tg && mainGenre(tg) === main) w = 1.2;
    if (artistOf(t) === seedArtist) w *= 1.3;
    return w * affinity(t, plays, likes);
  };
  return pickMix(pool, weight, n, `auto:${seed.id}:${Date.now()}`, 2, 3);
}

// ---------------------------------------------------------------- arrumar biblioteca

export type Suggestion = {
  id: string;
  title: string;
  detail: string;
  changes: Change[];
  preview: { label: string; from: string; to: string }[];
};

const JUNK_ARTIST = /posted.?by|www\.|\.com\b|\.net\b|download|baixar|\/\//i;
const DISC = /\s*[([]?\s*(?:cd|disc|disco)\s*(\d{1,2})\s*[)\]]?/i;

/** Primeiro artista "de verdade": tira feat., e corta na vírgula só se o primeiro nome já é artista conhecido. */
export function primaryArtist(a: string, known: Set<string>) {
  a = splitArtists(a)[0] ?? "";
  const cut = a.search(/\s+(feat\.?|ft\.?|featuring|part\.)\s+|\s+\(feat/i);
  const base = (cut >= 0 ? a.slice(0, cut) : a).trim();
  const first = base.split(/,\s+|\s+&\s+/)[0].trim();
  return first !== base && known.has(norm(first)) ? first : base;
}

const titleCaseScore = (s: string) => s.split(/\s+/).filter((w) => /^[A-ZÀ-Ý0-9$]/.test(w)).length;

export function suggestions(lib: Library): Suggestion[] {
  const out: Suggestion[] = [];
  const knownArtists = new Set(lib.artists.map((a) => a.key));

  // 1. Mesmo artista escrito de jeitos diferentes.
  const spellings = new Map<string, Map<string, Track[]>>();
  for (const t of lib.tracks) {
    if (!t.album_artist) continue;
    const k = norm(t.album_artist);
    const m = spellings.get(k) ?? new Map<string, Track[]>();
    m.set(t.album_artist, [...(m.get(t.album_artist) ?? []), t]);
    spellings.set(k, m);
  }
  for (const [k, m] of spellings) {
    if (m.size < 2) continue;
    const variants = [...m.entries()].sort((a, b) => titleCaseScore(b[0]) - titleCaseScore(a[0]) || b[1].length - a[1].length);
    const to = variants[0][0];
    const wrong = variants.slice(1).flatMap(([, ts]) => ts);
    out.push({
      id: `grafia:${k}`,
      title: t('Juntar as grafias de "{name}"', { name: to }),
      detail: t('O artista aparece escrito de {n} jeitos: {list}. Deixa tudo como "{name}".', {
        n: m.size,
        list: variants.map(([s, ts]) => `"${s}" (${ts.length})`).join(", "),
        name: to,
      }),
      changes: wrong.map((t) => ({ id: t.id, field: "album_artist", value: to })),
      preview: variants.slice(1).map(([s, ts]) => ({ label: plural(ts.length, t("faixa"), t("faixas")), from: s, to })),
    });
  }

  for (const al of lib.albums) {
    const first = al.tracks[0];
    const aa = first.album_artist;
    const trackArtist = primaryArtist(
      (() => {
        const c = new Map<string, number>();
        al.tracks.forEach((t) => t.artist && c.set(t.artist, (c.get(t.artist) ?? 0) + 1));
        return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      })(),
      knownArtists,
    );

    // 2. Artista do álbum com lixo de site/download, vazio, ou igual ao nome do álbum.
    const junk = JUNK_ARTIST.test(aa) || (!aa && trackArtist) || (aa && norm(aa) === norm(al.title) && trackArtist && norm(trackArtist) !== norm(aa));
    if (junk && trackArtist) {
      out.push({
        id: `lixo:${al.key}`,
        title: t('Corrigir o artista de "{album}"', { album: al.title }),
        detail: aa
          ? t('Está como "{wrong}", que não é artista. As faixas são de "{artist}".', { wrong: aa, artist: trackArtist })
          : t('O álbum está sem artista. As faixas são de "{artist}".', { artist: trackArtist }),
        changes: al.tracks.map((t) => ({ id: t.id, field: "album_artist", value: trackArtist })),
        preview: [{ label: plural(al.tracks.length, t("faixa"), t("faixas")), from: aa || t("(vazio)"), to: trackArtist }],
      });
    } else if (aa && !aa.includes(";") && /,\s+/.test(aa)) {
      // 3. Vários nomes numa tag só ("Madvillain, Madlib, MF DOOM"): vira lista separada,
      //    e o álbum aparece na página de cada um.
      const parts = aa.split(/,\s+/).map((s) => s.trim());
      const headIsArtist = knownArtists.has(norm(parts[0])) && norm(parts[0]) !== al.artistKey;
      if (parts.length >= 2 && (headIsArtist || norm(parts[0]) === norm(trackArtist))) {
        const to = parts.join("; ");
        out.push({
          id: `varios:${al.key}`,
          title: t('Separar os artistas de "{album}"', { album: al.title }),
          detail: t('O artista do álbum está como "{wrong}", tudo junto. Separando, o álbum aparece na página de {names}.', {
            wrong: aa,
            names: parts.join(", ").replace(/, ([^,]*)$/, ` ${t("e")} $1`),
          }),
          changes: al.tracks.map((t) => ({ id: t.id, field: "album_artist", value: to })),
          preview: [{ label: plural(al.tracks.length, t("faixa"), t("faixas")), from: aa, to: parts.join(" · ") }],
        });
      }
    }

    // 4. Título de álbum sujo: "(CD1) [Ukraine - CDC] // RCA".
    const dirty = /\/\/|\[[^\]]*\]/.test(al.title) || DISC.test(al.title);
    if (dirty) {
      const disc = al.title.match(DISC)?.[1];
      const clean = al.title.replace(/\s*\/\/.*$/, "").replace(/\s*\[[^\]]*\]/g, "").replace(DISC, "").trim();
      if (clean && clean !== al.title) {
        const changes: Change[] = al.tracks.map((t) => ({ id: t.id, field: "album", value: clean }));
        if (disc) al.tracks.forEach((t) => changes.push({ id: t.id, field: "disc", value: disc }));
        out.push({
          id: `titulo:${al.key}`,
          title: t('Limpar o nome do álbum "{album}"', { album: clean }),
          detail: disc
            ? t('O nome tem lixo do arquivo baixado e o número do CD. Fica "{album}", disco {disc}, e os CDs viram um álbum só.', { album: clean, disc })
            : t('O nome tem lixo do arquivo baixado. Fica só "{album}".', { album: clean }),
          changes,
          preview: [{ label: plural(al.tracks.length, t("faixa"), t("faixas")), from: al.title, to: disc ? t("{album} (disco {disc})", { album: clean, disc }) : clean }],
        });
      }
    }
  }
  return out;
}
