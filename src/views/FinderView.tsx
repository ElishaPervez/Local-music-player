import { useState, type FormEvent } from "react";
import { Search, Loader2 } from "lucide-react";
import type { SearchResult } from "../lib/types";
import { api } from "../lib/api";
import QueuePanel from "../components/QueuePanel";
import ResultRow from "./finder/ResultRow";
import "./views.css";
import "./FinderView.css";

export default function FinderView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      setResults(await api.search(q));
    } catch (err) {
      setError(String(err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="view">
      <div className="view-content finder-content">
        <form className="search-bar" onSubmit={runSearch}>
          <Search size={18} className="search-icon" />
          <input
            placeholder="Paste a YouTube URL or search a song…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <Loader2 size={18} className="spin search-icon" />}
        </form>

        <div className="finder-results">
          {loading && results.length === 0 ? (
            <div className="empty-state">
              <Loader2 size={36} className="spin" />
              <p>Searching…</p>
            </div>
          ) : error ? (
            <div className="empty-state">
              <p>Search failed</p>
              <span className="error-text">{error}</span>
            </div>
          ) : results.length > 0 ? (
            <div className="result-list">
              {results.map((r) => (
                <ResultRow key={r.videoId} result={r} />
              ))}
            </div>
          ) : searched ? (
            <div className="empty-state">
              <Search size={42} strokeWidth={1.5} />
              <p>No results</p>
              <span>Try a different search</span>
            </div>
          ) : (
            <div className="empty-state">
              <Search size={42} strokeWidth={1.5} />
              <p>Search for a song to get started</p>
              <span>
                Press Enter to search. Play a result directly, or download it
                into a playlist.
              </span>
            </div>
          )}
        </div>
      </div>

      <QueuePanel />
    </div>
  );
}
