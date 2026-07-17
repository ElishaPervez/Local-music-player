import type { CSSProperties } from "react";
import { Music, Play, Search, History } from "lucide-react";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useHistoryStore, type PlayedEntry } from "../stores/historyStore";
import { useUIStore } from "../stores/uiStore";
import { songToItem, resultToStreamItem } from "../lib/playback";
import "./views.css";
import "./HomeView.css";

export default function HomeView() {
  const current = usePlayerStore((s) =>
    s.index >= 0 && s.index < s.queue.length ? s.queue[s.index] : null,
  );
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const playNow = usePlayerStore((s) => s.playNow);
  const plays = useHistoryStore((s) => s.plays);
  const searches = useHistoryStore((s) => s.searches);
  const clearPlays = useHistoryStore((s) => s.clearPlays);
  const clearSearches = useHistoryStore((s) => s.clearSearches);
  const setView = useUIStore((s) => s.setView);
  const setPendingSearch = useUIStore((s) => s.setPendingSearch);

  function playEntry(entry: PlayedEntry) {
    // Downloaded copy wins — plays offline from disk; otherwise stream it.
    const songs = useLibraryStore.getState().songs;
    const song =
      (entry.songId ? songs[entry.songId] : undefined) ?? songs[entry.videoId];
    void playNow(
      song
        ? songToItem(song)
        : resultToStreamItem({
            videoId: entry.videoId,
            title: entry.title,
            artist: entry.artist,
            durationSec: entry.durationSec,
            thumbnail: entry.thumbnail,
            url: `https://www.youtube.com/watch?v=${entry.videoId}`,
          }),
    );
  }

  function searchAgain(query: string) {
    setPendingSearch(query);
    setView("finder");
  }

  return (
    <div className="view">
      <div className="view-content home-scroll">
        <div className="home-content">
          {/* ——— Hero: the record ——— */}
          <section
            className={`home-hero ${isPlaying ? "playing" : ""} ${
              current ? "" : "idle"
            }`}
          >
            <div className="disc-stage">
              <div className="disc-glow" />
              <button
                className="disc"
                onClick={() => (current ? togglePlay() : setView("finder"))}
                title={
                  !current
                    ? "Nothing playing — go find a song"
                    : isPlaying
                      ? "Pause"
                      : "Play"
                }
              >
                <div className="disc-spin">
                  <div className="disc-grooves" />
                  <div className="disc-label">
                    {current?.thumbnail ? (
                      <img src={current.thumbnail} alt="" draggable={false} />
                    ) : (
                      <Music size={30} />
                    )}
                  </div>
                  <div className="disc-hole" />
                </div>
                <div className="disc-sheen" />
              </button>
              <div className="tonearm">
                <div className="tonearm-pivot" />
                <div className="tonearm-rod">
                  <div className="tonearm-head" />
                </div>
              </div>
            </div>
            <div className="hero-meta">
              <h1 className="hero-title" title={current?.title}>
                {current ? current.title : "Nothing playing"}
              </h1>
              <p className="hero-artist">
                {current
                  ? current.artist || "Unknown artist"
                  : "Drop the needle — find a song or replay one below"}
              </p>
            </div>
          </section>

          {/* ——— Recently played ——— */}
          {plays.length > 0 ? (
            <section className="home-section">
              <div className="section-head">
                <span className="section-eyebrow">
                  <History size={13} /> Recently played
                </span>
                <button className="section-clear" onClick={clearPlays}>
                  Clear
                </button>
              </div>
              <div className="played-shelf">
                {plays.map((p, i) => (
                  <button
                    key={p.videoId}
                    className="played-card"
                    style={{ "--i": Math.min(i, 12) } as CSSProperties}
                    onClick={() => playEntry(p)}
                    title={`${p.title} — play now`}
                  >
                    <div className="played-thumb">
                      {p.thumbnail ? (
                        <img src={p.thumbnail} alt="" loading="lazy" draggable={false} />
                      ) : (
                        <Music size={28} />
                      )}
                      <span className="played-play">
                        <Play size={16} fill="currentColor" />
                      </span>
                    </div>
                    <span className="played-title">{p.title}</span>
                    <span className="played-artist">
                      {p.artist || "Unknown"}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="home-section">
              <div className="section-head">
                <span className="section-eyebrow">
                  <History size={13} /> Recently played
                </span>
              </div>
              <p className="section-hint">
                Songs you play will land here, newest first.
              </p>
            </section>
          )}

          {/* ——— Recently searched ——— */}
          {searches.length > 0 && (
            <section className="home-section">
              <div className="section-head">
                <span className="section-eyebrow">
                  <Search size={13} /> Recently searched
                </span>
                <button className="section-clear" onClick={clearSearches}>
                  Clear
                </button>
              </div>
              <div className="search-chips">
                {searches.map((s, i) => (
                  <button
                    key={s.query}
                    className="search-chip"
                    style={{ "--i": Math.min(i, 12) } as CSSProperties}
                    onClick={() => searchAgain(s.query)}
                    title="Search this again"
                  >
                    <Search size={13} />
                    {s.query}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
