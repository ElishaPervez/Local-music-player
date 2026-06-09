import { load, type Store } from "@tauri-apps/plugin-store";
import type { Settings, Playlist, Song } from "./types";

let storeP: Promise<Store> | null = null;

function store(): Promise<Store> {
  if (!storeP) storeP = load("library.json", { defaults: {}, autoSave: false });
  return storeP;
}

export interface PersistedShape {
  songs: Record<string, Song>;
  playlists: Playlist[];
  settings: Settings;
}

export async function loadAll(defaults: PersistedShape): Promise<PersistedShape> {
  const s = await store();
  const [songs, playlists, settings] = await Promise.all([
    s.get<Record<string, Song>>("songs"),
    s.get<Playlist[]>("playlists"),
    s.get<Settings>("settings"),
  ]);
  return {
    songs: songs ?? defaults.songs,
    playlists: playlists ?? defaults.playlists,
    settings: { ...defaults.settings, ...(settings ?? {}) },
  };
}

export async function saveAll(data: PersistedShape): Promise<void> {
  const s = await store();
  await s.set("songs", data.songs);
  await s.set("playlists", data.playlists);
  await s.set("settings", data.settings);
  await s.save();
}
