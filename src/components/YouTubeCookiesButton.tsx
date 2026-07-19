import { useEffect, useRef, useState } from "react";
import {
  Cookie,
  Eye,
  EyeOff,
  FileUp,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCookieStore } from "../stores/cookieStore";

function statusText(state: string | undefined, verifying: boolean) {
  if (verifying) return "Verifying…";
  if (state === "verified") return "Verified";
  if (state === "rejected") return "Rejected";
  if (state === "unverified") return "Not verified";
  if (state === "expired") return "Expired";
  if (state === "invalid") return "Invalid";
  return "Not stored";
}

function relativeUpdated(value: number | null | undefined) {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function YouTubeCookiesButton() {
  const status = useCookieStore((s) => s.status);
  const loading = useCookieStore((s) => s.loading);
  const busy = useCookieStore((s) => s.busy);
  const verifying = useCookieStore((s) => s.verifying);
  const message = useCookieStore((s) => s.message);
  const openRequest = useCookieStore((s) => s.openRequest);
  const refresh = useCookieStore((s) => s.refresh);
  const pickAndImport = useCookieStore((s) => s.pickAndImport);
  const importText = useCookieStore((s) => s.importText);
  const verify = useCookieStore((s) => s.verify);
  const remove = useCookieStore((s) => s.remove);
  const clearMessage = useCookieStore((s) => s.clearMessage);
  const [open, setOpen] = useState(false);
  const [hasPaste, setHasPaste] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const firstOpenRequest = useRef(true);

  const clearPaste = () => {
    if (textareaRef.current) textareaRef.current.value = "";
    setHasPaste(false);
    setRevealed(false);
  };

  const closePopover = () => {
    clearPaste();
    setOpen(false);
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (firstOpenRequest.current) {
      firstOpenRequest.current = false;
      return;
    }
    clearMessage();
    clearPaste();
    setOpen(true);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover();
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (textareaRef.current) textareaRef.current.value = "";
    },
    [],
  );

  const submitPaste = async () => {
    const text = textareaRef.current?.value ?? "";
    if (!text.trim() || busy) return;
    try {
      await importText(text);
    } finally {
      clearPaste();
    }
  };

  const chooseFile = async () => {
    clearPaste();
    await pickAndImport();
  };

  const state = status?.state ?? "notConfigured";
  const stored = state !== "notConfigured";
  const canVerify = state === "verified" || state === "rejected" || state === "unverified";
  const verified = state === "verified" && !verifying;
  const warning = state === "rejected" || state === "expired" || state === "invalid";
  const title = verifying
    ? "Verifying YouTube cookies"
    : verified
      ? "YouTube cookies verified"
      : stored
        ? "YouTube cookies need verification"
        : "Import YouTube cookies";

  return (
    <div className="cookie-control" ref={rootRef}>
      <button
        className={`tb-btn tb-cookie ${verified ? "verified" : ""} ${state === "unverified" ? "unverified" : ""} ${warning ? "warning" : ""}`}
        onClick={() => {
          if (open) closePopover();
          else {
            clearMessage();
            setOpen(true);
            window.setTimeout(() => textareaRef.current?.focus(), 0);
          }
        }}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {loading || busy || verifying ? <Loader2 size={15} className="spin" /> : <Cookie size={15} />}
        <span className="cookie-status-dot" />
      </button>

      {open && (
        <div className="cookie-popover" role="dialog" aria-label="YouTube cookies">
          <div className="cookie-popover-head">
            <span className={`cookie-popover-icon ${warning ? "warning" : verified ? "ok" : state === "unverified" ? "unverified" : ""}`}>
              {verifying ? (
                <Loader2 size={17} className="spin" />
              ) : warning ? (
                <ShieldAlert size={17} />
              ) : verified ? (
                <ShieldCheck size={17} />
              ) : (
                <Shield size={17} />
              )}
            </span>
            <div>
              <strong>YouTube access</strong>
              <span>{statusText(state, verifying)}</span>
            </div>
          </div>

          {status?.updatedAt && (
            <p className="cookie-updated">Updated {relativeUpdated(status.updatedAt)}</p>
          )}
          {status?.checkedAt && (
            <p className="cookie-updated">Last checked {relativeUpdated(status.checkedAt)}</p>
          )}
          {canVerify && !verifying && (
            <button className="btn-secondary cookie-retry" disabled={busy || verifying} onClick={() => void verify()}>
              Retry verification
            </button>
          )}

          <label className="cookie-paste-label" htmlFor="youtube-cookie-paste">
            Paste Cookie-Editor JSON or Netscape cookies text
          </label>
          <div className="cookie-paste-wrap">
            <textarea
              id="youtube-cookie-paste"
              ref={textareaRef}
              className={`cookie-paste ${revealed ? "revealed" : "masked"}`}
              placeholder="Paste the exported cookies here…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setHasPaste(Boolean(event.currentTarget.value.trim()))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submitPaste();
                }
              }}
            />
            <button
              className="cookie-reveal"
              onClick={() => setRevealed((value) => !value)}
              title={revealed ? "Hide pasted cookies" : "Show pasted cookies"}
              aria-label={revealed ? "Hide pasted cookies" : "Show pasted cookies"}
              aria-pressed={revealed}
            >
              {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <p className="cookie-paste-hint">Press Ctrl+Enter to submit. The pasted text is cleared after every attempt.</p>

          <button
            className="btn-primary cookie-submit"
            disabled={busy || verifying || !hasPaste}
            onClick={() => void submitPaste()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Cookie size={14} />}
            {stored ? "Update with pasted cookies" : "Import pasted cookies"}
          </button>

          <div className="cookie-divider"><span>or</span></div>

          <div className="cookie-actions">
            <button className="btn-secondary" disabled={busy || verifying} onClick={() => void chooseFile()}>
              <FileUp size={14} /> Choose file instead…
            </button>
            {stored && (
              <button className="btn-secondary cookie-remove" disabled={busy || verifying} onClick={() => void remove()}>
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>

          {message && <p className="cookie-message">{message}</p>}
          <p className="cookie-security">
            These cookies are an active Google session. Never paste them into chat. The masked field only prevents casual on-screen exposure; the app still receives the text locally to install it.
          </p>
        </div>
      )}
    </div>
  );
}
