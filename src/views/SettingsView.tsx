import { useEffect, useState } from "react";
import {
  Folder,
  Music2,
  RefreshCw,
  Library,
  FolderOpen,
  Image as ImageIcon,
  Blend,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, fileSrc } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import type { AudioFormat } from "../lib/types";
import BackgroundModal from "../components/BackgroundModal";
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

  useEffect(() => {
    api
      .ytdlpVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
  }, []);

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
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "jfif"],
        },
      ],
    });
    if (typeof picked === "string") setBgModal({ src: picked, imported: false });
  }

  async function applyBackground(blur: number, opacity: number) {
    if (!bgModal) return;
    setBgBusy(true);
    try {
      let path = bgModal.src;
      if (!bgModal.imported) {
        const ext = (bgModal.src.split(".").pop() || "jpg").toLowerCase();
        path = await api.importBackground(
          bgModal.src,
          `${crypto.randomUUID()}.${ext}`,
        );
      }
      setSettings({ background: { path, blur, opacity } });
      setBgModal(null);
    } catch (e) {
      console.error("background import failed", e);
    } finally {
      setBgBusy(false);
    }
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
              <ImageIcon size={18} />
              <div>
                <strong>Background</strong>
                <p>Custom image behind the app, with blur &amp; opacity</p>
              </div>
            </div>
            <div className="setting-actions">
              {settings.background ? (
                <>
                  <div
                    className="bg-thumb"
                    style={{
                      backgroundImage: `url("${fileSrc(settings.background.path)}")`,
                    }}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      settings.background &&
                      setBgModal({ src: settings.background.path, imported: true })
                    }
                  >
                    Adjust
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => setSettings({ background: null })}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <button className="btn-secondary" onClick={pickBackground}>
                  Add image…
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
          </div>
        </div>
      </div>

      {bgModal && (
        <BackgroundModal
          previewSrc={fileSrc(bgModal.src)}
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
