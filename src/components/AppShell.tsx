import { useEffect } from "react";
import { useUIStore } from "../stores/uiStore";
import { useLibraryStore } from "../stores/libraryStore";
import { initPlayer } from "../stores/playerStore";
import { initDownloads } from "../lib/downloadService";
import { initDiscordPresence } from "../lib/discordPresence";
import Sidebar from "./Sidebar";
import TitleBar from "./TitleBar";
import ResizeHandles from "./ResizeHandles";
import BackgroundLayer from "./BackgroundLayer";
import NowPlayingBar from "./NowPlayingBar";
import FinderView from "../views/FinderView";
import PlaylistsView from "../views/PlaylistsView";
import SettingsView from "../views/SettingsView";
import "./AppShell.css";

export default function AppShell() {
  const view = useUIStore((s) => s.view);
  const hasBg = useLibraryStore((s) => !!s.settings.background);

  useEffect(() => {
    initPlayer();
    initDownloads();
    initDiscordPresence();
    void useLibraryStore.getState().load();
  }, []);

  return (
    <div className={`app-shell ${hasBg ? "has-bg" : ""}`}>
      <BackgroundLayer />
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">
          {view === "finder" && <FinderView />}
          {view === "playlists" && <PlaylistsView />}
          {view === "settings" && <SettingsView />}
        </main>
      </div>
      <NowPlayingBar />
      <ResizeHandles />
    </div>
  );
}
