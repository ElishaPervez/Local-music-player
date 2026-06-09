import { useEffect, useState, type ReactNode } from "react";
import { Check, Download, AlertTriangle, Loader2 } from "lucide-react";
import { api, onSetupProgress, type SetupProgress } from "../lib/api";
import TitleBar from "./TitleBar";
import ResizeHandles from "./ResizeHandles";
import "./SetupGate.css";

type Phase = "checking" | "ready" | "needed" | "installing" | "error";

/** First-run gate: blocks the app until FFmpeg is installed. yt-dlp ships
 *  inside the installer as a sidecar, but FFmpeg is too big to bundle, so the
 *  first launch downloads it into the per-user tools dir. */
export default function SetupGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [step, setStep] = useState<SetupProgress["step"]>("downloading");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .toolsStatus()
      .then((s) => setPhase(s.ffmpegInstalled ? "ready" : "needed"))
      .catch(() => setPhase("needed"));
  }, []);

  useEffect(() => {
    if (phase !== "installing") return;
    let unlisten: (() => void) | undefined;
    void onSetupProgress((p) => {
      setStep(p.step);
      setPercent(p.percent);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [phase]);

  async function install() {
    setPhase("installing");
    setStep("downloading");
    setPercent(0);
    setError("");
    try {
      await api.installFfmpeg();
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  if (phase === "ready") return <>{children}</>;

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="setup-screen">
        {phase !== "checking" && (
          <div className="setup-card">
            <h1>Almost ready 🎵</h1>
            <p className="setup-sub">
              One quick step before the music starts — the app needs an audio
              converter to download songs.
            </p>

            <div className="setup-checklist">
              <div className="setup-item done">
                <span className="setup-item-icon">
                  <Check size={16} />
                </span>
                <div className="setup-item-text">
                  <strong>yt-dlp</strong>
                  <p>Search &amp; download engine — bundled with the app</p>
                </div>
              </div>

              <div
                className={`setup-item ${phase === "error" ? "failed" : ""}`}
              >
                <span className="setup-item-icon">
                  {phase === "installing" ? (
                    <Loader2 size={16} className="spin" />
                  ) : phase === "error" ? (
                    <AlertTriangle size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                </span>
                <div className="setup-item-text">
                  <strong>FFmpeg</strong>
                  {phase === "installing" ? (
                    <p>
                      {step === "downloading"
                        ? `Downloading… ${Math.floor(percent)}%`
                        : "Extracting…"}
                    </p>
                  ) : phase === "error" ? (
                    <p className="setup-error">{error}</p>
                  ) : (
                    <p>Audio converter — one-time ~90 MB download</p>
                  )}
                </div>
              </div>
            </div>

            {phase === "installing" ? (
              <div className="setup-progress">
                <div
                  className={`setup-progress-fill ${step !== "downloading" ? "pulse" : ""}`}
                  style={{
                    width:
                      step === "downloading" ? `${percent}%` : "100%",
                  }}
                />
              </div>
            ) : (
              <button
                className="btn-primary setup-install-btn"
                onClick={() => void install()}
              >
                {phase === "error" ? "Try again" : "Download & install"}
              </button>
            )}
          </div>
        )}
      </div>
      <ResizeHandles />
    </div>
  );
}
