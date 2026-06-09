import { create } from "zustand";
import type { Playlist, Settings, Song } from "../lib/types";
import { api } from "../lib/api";
import { loadAll, saveAll } from "../lib/persist";
import { songToItem } from "../lib/playback";
import { usePlayerStore } from "./playerStore";

interface LibraryState {
  songs: Record<string, Song>;
  playlists: Playlist[];
  settings: Settings;
  loaded: boolean;

  load: () => Promise<void>;

  addSong: (song: Song) => void;
  updateSong: (id: string, patch: Partial<Song>) => void;
  deleteSong: (id: string) => Promise<void>;

  createPlaylist: (name: string) => Playlist;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  addToPlaylist: (playlistId: string, songId: string) => void;
  removeFromPlaylist: (playlistId: string, songId: string) => void;
  reorderPlaylist: (playlistId: string, songIds: string[]) => void;

  setSettings: (patch: Partial<Settings>) => void;
}

const DEFAULT_SETTINGS: Settings = {
  libraryDir: null,
  audioFormat: "m4a",
  background: null,
  crossfade: false,
};

export const useLibraryStore = create<LibraryState>((set, get) => {
  const persist = () => {
    const { songs, playlists, settings, loaded } = get();
    // Never write before the on-disk library has been read in — otherwise an
    // empty, un-hydrated store (e.g. fresh after a dev hot reload) would clobber
    // the saved file and wipe the user's songs.
    if (!loaded) return;
    void saveAll({ songs, playlists, settings });
  };

  return {
    songs: {},
    playlists: [],
    settings: DEFAULT_SETTINGS,
    loaded: false,

    load: async () => {
      const data = await loadAll({
        songs: {},
        playlists: [],
        settings: DEFAULT_SETTINGS,
      });
      if (!data.settings.libraryDir) {
        try {
          data.settings.libraryDir = await api.defaultLibraryDir();
        } catch {
          /* keep null; resolved again on first download */
        }
      }
      set({ ...data, loaded: true });
      // Mirror the persisted crossfade preference into the player runtime.
      usePlayerStore.getState().setCrossfade(data.settings.crossfade);
    },

    addSong: (song) => {
      set((s) => ({ songs: { ...s.songs, [song.id]: song } }));
      persist();
    },

    updateSong: (id, patch) => {
      set((s) => {
        const existing = s.songs[id];
        if (!existing) return s;
        return { songs: { ...s.songs, [id]: { ...existing, ...patch } } };
      });
      persist();
    },

    deleteSong: async (id) => {
      const song = get().songs[id];
      set((s) => {
        const songs = { ...s.songs };
        delete songs[id];
        const playlists = s.playlists.map((p) => ({
          ...p,
          songIds: p.songIds.filter((x) => x !== id),
        }));
        return { songs, playlists };
      });
      persist();
      // The file is gone library-wide, so it can't stay in the live queue.
      usePlayerStore.getState().removeSongFromQueue(id);
      if (song?.filePath) {
        try {
          await api.deleteFile(song.filePath);
        } catch {
          /* ignore missing file */
        }
      }
    },

    createPlaylist: (name) => {
      const playlist: Playlist = {
        id: crypto.randomUUID(),
        name: name.trim() || "New Playlist",
        songIds: [],
        createdAt: Date.now(),
      };
      set((s) => ({ playlists: [...s.playlists, playlist] }));
      persist();
      return playlist;
    },

    renamePlaylist: (id, name) => {
      set((s) => ({
        playlists: s.playlists.map((p) =>
          p.id === id ? { ...p, name: name.trim() || p.name } : p,
        ),
      }));
      persist();
    },

    deletePlaylist: (id) => {
      set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) }));
      persist();
    },

    addToPlaylist: (playlistId, songId) => {
      const already = get().playlists.some(
        (p) => p.id === playlistId && p.songIds.includes(songId),
      );
      set((s) => ({
        playlists: s.playlists.map((p) =>
          p.id === playlistId && !p.songIds.includes(songId)
            ? { ...p, songIds: [...p.songIds, songId] }
            : p,
        ),
      }));
      persist();
      // If this playlist is the one currently playing, mirror the new song
      // into the live queue so it shows up without re-hitting Play.
      const player = usePlayerStore.getState();
      const song = get().songs[songId];
      if (!already && song && player.playingPlaylistId === playlistId) {
        player.addToQueue(songToItem(song));
      }
    },

    removeFromPlaylist: (playlistId, songId) => {
      set((s) => ({
        playlists: s.playlists.map((p) =>
          p.id === playlistId
            ? { ...p, songIds: p.songIds.filter((x) => x !== songId) }
            : p,
        ),
      }));
      persist();
      // Mirror the removal into the live queue, but only when this is the
      // playlist that's actually playing.
      if (usePlayerStore.getState().playingPlaylistId === playlistId) {
        usePlayerStore.getState().removeSongFromQueue(songId);
      }
    },

    reorderPlaylist: (playlistId, songIds) => {
      set((s) => ({
        playlists: s.playlists.map((p) =>
          p.id === playlistId ? { ...p, songIds } : p,
        ),
      }));
      persist();
    },

    setSettings: (patch) => {
      set((s) => ({ settings: { ...s.settings, ...patch } }));
      persist();
      if (patch.crossfade !== undefined) {
        usePlayerStore.getState().setCrossfade(patch.crossfade);
      }
    },
  };
});

// A dev hot reload of this module makes a fresh, empty store and the mount-only
// load() in AppShell won't re-run — leaving the UI blank while the disk file is
// intact. Re-read the library on every hot update. Stripped from production.
if (import.meta.hot) {
  void useLibraryStore.getState().load();
}
