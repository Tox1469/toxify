import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type Track = {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  album_key: string;
  track: number;
  disc: number;
  year: number;
  genre: string;
  secs: number;
  rate: number;
  bits: number;
  codec: string;
  cover: boolean;
  added: number;
};

export type PlayerState = {
  track_id: number | null;
  index: number;
  playing: boolean;
  position: number;
  duration: number;
  out_rate: number;
  out_bits: number;
  out_mode: "" | "exclusivo" | "compartilhado";
  device: string;
  src_rate: number;
  src_bits: number;
  resampled: boolean;
  bitperfect: boolean;
  volume: number;
  speed: number;
  pitch: number;
  crossfade: boolean;
  crossfade_secs: number;
  shuffle: boolean;
  repeat: number;
  exclusive: boolean;
  next_id: number | null;
  next_mode: "" | "crossfade" | "emendada" | "troca de taxa";
  error: string | null;
};

export type Lyrics = {
  synced: boolean;
  lines: { t: number; text: string }[];
  source: string;
  lang: string | null;
  translation: string[] | null;
  /** Idioma pra onde a tradução foi feita. */
  to?: string | null;
};

export type Settings = {
  folders: string[];
  prefs: { volume: number; crossfade: boolean; crossfade_secs: number; exclusive: boolean };
  translate: boolean;
  discord: boolean;
  auto_fix: boolean;
};

export type ArtistInfo = { key: string; name: string; albums: string[]; tags: string[] };

export type Playlist = { id: number; name: string; created: number; tracks: number[] };

export type Change = { id: number; field: TagField; value: string };
export type TagField = "title" | "artist" | "album" | "album_artist" | "year" | "track" | "disc" | "genre";

export const api = {
  library: () => invoke<Track[]>("get_library"),
  settings: () => invoke<Settings>("get_settings"),
  setFolders: (folders: string[]) => invoke("set_folders", { folders }),
  rescan: () => invoke("rescan"),
  setTranslate: (on: boolean) => invoke("set_translate", { on }),
  setDiscord: (on: boolean) => invoke("set_discord", { on }),
  /** Gênero escolhido por artista (chave → grupo). */
  genres: () => invoke<Record<string, string>>("get_genres"),
  setGenre: (artist: string, genre: string) => invoke("set_genre", { artist, genre }),
  setAuto: (autoFix: boolean) => invoke("set_auto", { autoFix }),
  isScanning: () => invoke<boolean>("is_scanning"),
  logAuto: (msg: string) => invoke("log_auto", { msg }),
  /** Anota quem está sem gênero (o Claude Code classifica quando o Tox pedir). */
  writePendingGenres: (artists: ArtistInfo[]) => invoke("write_pending_genres", { artists }),
  restore: (ids: number[], index: number, at: number, shuffle: boolean, repeat: number) => invoke("restore", { ids, index, at, shuffle, repeat }),
  /** Títulos mais ouvidos do artista no mundo (Deezer), do mais pro menos popular. */
  artistTop: (name: string) => invoke<string[]>("artist_top", { name }),
  likes: () => invoke<number[]>("likes"),
  setLike: (id: number, on: boolean) => invoke("set_like", { id, on }),
  /** [id, audições, pulos, última audição, audições nos últimos 30 dias] */
  plays: () => invoke<[number, number, number, number, number][]>("plays"),
  playlists: () => invoke<Playlist[]>("playlists"),
  playlistCreate: (name: string, tracks: number[] = []) => invoke<number>("playlist_create", { name, tracks }),
  playlistRename: (id: number, name: string) => invoke("playlist_rename", { id, name }),
  playlistDelete: (id: number) => invoke("playlist_delete", { id }),
  playlistSet: (id: number, tracks: number[]) => invoke("playlist_set", { id, tracks }),

  play: (ids: number[], index = 0) => invoke("play", { ids, index }),
  toggle: () => invoke("toggle"),
  next: () => invoke("next"),
  prev: () => invoke("prev"),
  seek: (secs: number) => invoke("seek", { secs }),
  setShuffle: (on: boolean) => invoke("set_shuffle", { on }),
  setRepeat: (mode: number) => invoke("set_repeat", { mode }),
  enqueue: (ids: number[]) => invoke("enqueue", { ids }),
  playNext: (ids: number[]) => invoke("play_next", { ids }),
  jumpTo: (index: number) => invoke("jump_to", { index }),
  removeAt: (index: number) => invoke("remove_at", { index }),
  setVolume: (v: number) => invoke("set_volume", { v }),
  setCrossfade: (on: boolean, secs: number) => invoke("set_crossfade", { on, secs }),
  setExclusive: (on: boolean) => invoke("set_exclusive", { on }),
  /** 0.5 a 2.0; 1.0 = normal. Não muda o tom. */
  setSpeed: (v: number) => invoke("set_speed", { v }),
  /** Razão do tom: 1.0 = original, 2^(semitons/12). Não muda a velocidade. */
  setPitch: (v: number) => invoke("set_pitch", { v }),

  /** `to`: idioma da tradução ("pt", "en"). */
  lyrics: (id: number, to: string) => invoke<Lyrics | null>("lyrics", { id, to }),
  saveTags: (changes: Change[]) => invoke<string[]>("save_tags", { changes }),
  undoTags: () => invoke<number>("undo_tags"),
  hasUndo: () => invoke<boolean>("has_undo"),
};

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

// No Windows o WebView2 serve protocolo próprio como http://<nome>.localhost
/** `v` muda quando o arquivo muda: a tela não mostra capa velha guardada no cache. */
export const coverUrl = (trackId: number, size = 300, v = "") => `http://cover.localhost/${trackId}?s=${size}${v ? `&v=${v}` : ""}`;
export const artistUrl = (name: string) => `http://artist.localhost/${encodeURIComponent(name)}`;
