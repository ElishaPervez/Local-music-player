import { useEffect, useState } from "react";
import {
  Folder,
  Music2,
  RefreshCw,
  Library,
  FolderOpen,
  Image as ImageIcon,
  Blend,
  Wrench,
  Radio,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, fileSrc, type ToolsStatus } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import type { AudioFormat } from "../lib/types";
import {
  IMAGE_EXTS,
  VIDEO_EXTS,
  extOf,
  bgKind,
  bgKindFromPath,
} from "../lib/background";
import BackgroundModal from "../components/BackgroundModal";
import LibraryPanel from "./settings/LibraryPanel";
import "./views.css";
import "./SettingsView.css";

const FORMATS: AudioFormat[] = ["m4a", "mp3", "opus"];

export default function SettingsView() {
  const settings = useLibraryStore((s) => s.settings);
  const setSettings = useLibraryStore((s) => s.setSettings);
  const songCount = useLibraryStore((s) => Object.keys(s.songs).length);
  const playlistCount = useLibraryStore((s) => s.playlists.length);

  const [version, setVersion] = useState<string>("…");
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string>("");

  const [bgModal, setBgModal] = useState<{ src: string; imported: boolean } | null>(
    null,
  );
  const [bgBusy, setBgBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [ffmpegBusy, setFfmpegBusy] = useState(false);
  const [ffmpegMsg, setFfmpegMsg] = useState("");

  useEffect(() => {
    api
      .ytdlpVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
    api
      .toolsStatus()
      .then(setTools)
      .catch(() => {});
  }, []);

  async function reinstallFfmpeg() {
    setFfmpegBusy(true);
    setFfmpegMsg("");
    try {
      await api.installFfmpeg();
      setTools(await api.toolsStatus());
      setFfmpegMsg("Installed.");
    } catch (e) {
      setFfmpegMsg(String(e));
    } finally {
      setFfmpegBusy(false);
    }
  }

  async function changeFolder() {
    const picked = await open({
      directory: true,
      defaultPath: settings.libraryDir ?? undefined,
    });
    if (typeof picked === "string") setSettings({ libraryDir: picked });
  }

  async function runUpdate() {
    setUpdating(true);
    setUpdateMsg("");
    try {
      const msg = await api.updateYtdlp();
      setUpdateMsg(msg || "Up to date.");
      setVersion(await api.ytdlpVersion());
    } catch (e) {
      setUpdateMsg(String(e));
    } finally {
      setUpdating(false);
    }
  }

  async function pickBackground() {
    const picked = await open({
      filters: [
        {
          name: "Images & live wallpapers",
          extensions: [...IMAGE_EXTS, ...VIDEO_EXTS],
        },
        { name: "Live wallpapers (video)", extensions: VIDEO_EXTS },
        { name: "Images", extensions: IMAGE_EXTS },
      ],
    });
    if (typeof picked === "string") setBgModal({ src: picked, imported: false });
  }

  async function applyBackground(blur: number, opacity: number) {
    if (!bgModal) return;
    setBgBusy(true);
    try {
      const prevPath = settings.background?.path;
      let path = bgModal.src;
      if (!bgModal.imported) {
        const ext = extOf(bgModal.src) || "jpg";
        path = await api.importBackground(
          bgModal.src,
          `${crypto.randomUUID()}.${ext}`,
        );
        // Drop the previous copy from appdata so replaced wallpapers (videos
        // can be hundreds of MB) don't pile up. Only when it actually changed.
        if (prevPath && prevPath !== path) {
          await api.deleteFile(prevPath).catch(() => {});
        }
      }
      setSettings({
        background: { path, kind: bgKindFromPath(path), blur, opacity },
      });
      setBgModal(null);
    } catch (e) {
      console.error("background import failed", e);
    } finally {
      setBgBusy(false);
    }
  }

  async function removeBackground() {
    const path = settings.background?.path;
    setSettings({ background: null });
    if (path) await api.deleteFile(path).catch(() => {});
  }

  return (
    <div className="view">
      <div className="view-content">
        <div className="view-header">
          <h2>Settings</h2>
        </div>

        <div className="settings-body">
          <div className="setting-row">
            <div className="setting-info">
              <Folder size={18} />
              <div>
                <strong>Library folder</strong>
                <p className="mono">{settings.libraryDir ?? "Not set"}</p>
              </div>
            </div>
            <div className="setting-actions">
              {settings.libraryDir && (
                <button
                  className="btn-secondary"
                  onClick={() =>
                    void openPath(settings.libraryDir!).catch(() => {})
                  }
                  title="Open in file explorer"
                >
                  <FolderOpen size={16} />
                </button>
              )}
              <button className="btn-secondary" onClick={changeFolder}>
                Change…
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <Music2 size={18} />
              <div>
                <strong>Audio format</strong>
                <p>Format used for downloaded tracks</p>
              </div>
            </div>
            <div className="format-toggle">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  className={`format-opt ${settings.audioFormat === f ? "active" : ""}`}
                  onClick={() => setSettings({ audioFormat: f })}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <Blend size={18} />
              <div>
                <strong>Fade to next song</strong>
                <p>Crossfade the last 5s of a track into the next one</p>
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.crossfade}
              className={`switch ${settings.crossfade ? "on" : ""}`}
              onClick={() => setSettings({ crossfade: !settings.crossfade })}
              title="Toggle crossfade"
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <Radio size={18} />
              <div>
                <strong>Discord presence</strong>
                <p>
                  Show the song you're playing on your Discord profile (needs the
                  desktop Discord app running)
                </p>
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.discordPresence}
              className={`switch ${settings.discordPresence ? "on" : ""}`}
              onClick={() =>
                setSettings({ discordPresence: !settings.discordPresence })
              }
              title="Toggle Discord presence"
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <Radio size={18} />
              <div>
                <strong>Auto-play radio</strong>
                <p>
                  When the queue runs low, automatically stream similar songs
                  (not downloaded)
                </p>
              </div>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoPlay}
              className={`switch ${settings.autoPlay ? "on" : ""}`}
              onClick={() => setSettings({ autoPlay: !settings.autoPlay })}
              title="Toggle auto-play radio"
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <ImageIcon size={18} />
              <div>
                <strong>Background</strong>
                <p>
                  Image or live wallpaper (video) behind the app, with blur
                  &amp; opacity
                </p>
              </div>
            </div>
            <div className="setting-actions">
              {settings.background ? (
                <>
                  {bgKind(settings.background) === "video" ? (
                    <video
                      className="bg-thumb"
                      src={fileSrc(settings.background.path)}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <div
                      className="bg-thumb"
                      style={{
                        backgroundImage: `url("${fileSrc(settings.background.path)}")`,
                      }}
                    />
                  )}
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      settings.background &&
                      setBgModal({ src: settings.background.path, imported: true })
                    }
                  >
                    Adjust
                  </button>
                  <button className="btn-secondary" onClick={removeBackground}>
                    Remove
                  </button>
                </>
              ) : (
                <button className="btn-secondary" onClick={pickBackground}>
                  Add…
                </button>
              )}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <RefreshCw size={18} />
              <div>
                <strong>yt-dlp</strong>
                <p>
                  Version <span className="mono">{version}</span>
                  {updateMsg && (
                    <>
                      {" — "}
                      <span className="update-msg">{updateMsg}</span>
                    </>
                  )}
                </p>
              </div>
            </div>
            <button
              className="btn-secondary"
              onClick={runUpdate}
              disabled={updating}
            >
              {updating ? "Updating…" : "Update"}
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <Wrench size={18} />
              <div>
                <strong>FFmpeg</strong>
                <p>
                  {tools === null
                    ? "Checking…"
                    : tools.ffmpegInstalled
                      ? "Installed"
                      : "Not installed — downloads need it"}
                  {tools?.ffmpegPath && (
                    <>
                      {" — "}
                      <span className="mono">{tools.ffmpegPath}</span>
                    </>
                  )}
                  {ffmpegMsg && (
                    <>
                      {" — "}
                      <span className="update-msg">{ffmpegMsg}</span>
                    </>
                  )}
                </p>
              </div>
            </div>
            <button
              className="btn-secondary"
              onClick={() => void reinstallFfmpeg()}
              disabled={ffmpegBusy}
            >
              {ffmpegBusy
                ? "Installing…"
                : tools?.ffmpegInstalled
                  ? "Reinstall"
                  : "Install"}
            </button>
          </div>

          <div className="setting-row expandable">
            <div className="setting-row-main">
              <div className="setting-info">
                <Library size={18} />
                <div>
                  <strong>Library</strong>
                  <p>
                    {songCount} {songCount === 1 ? "song" : "songs"} ·{" "}
                    {playlistCount}{" "}
                    {playlistCount === 1 ? "playlist" : "playlists"}
                  </p>
                </div>
              </div>
              <button
                className="btn-secondary"
                onClick={() => setManageOpen((v) => !v)}
              >
                {manageOpen ? "Hide" : "Manage…"}
              </button>
            </div>
            {manageOpen && <LibraryPanel />}
          </div>
        </div>
      </div>

      {bgModal && (
        <BackgroundModal
          previewSrc={fileSrc(bgModal.src)}
          kind={bgKindFromPath(bgModal.src)}
          initBlur={settings.background?.blur ?? 6}
          initOpacity={settings.background?.opacity ?? 0.45}
          busy={bgBusy}
          onApply={applyBackground}
          onCancel={() => setBgModal(null)}
        />
      )}
    </div>
  );
}
