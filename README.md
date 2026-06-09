# Local Music Player

A Windows desktop music player built with **Tauri 2 + React + TypeScript**. Search YouTube, stream a song instantly, or download it into always-offline playlists — powered by a bundled `yt-dlp` (standalone, embeds its own Python) plus `ffmpeg`, no system installs needed.

## Features

- **Finder** — paste a YouTube URL (video or playlist) or search by name; play results directly (streamed) or download them into a playlist
- **Playlists** — fully offline; one global song library, playlists are ordered references (same song in many lists, removing ≠ deleting), drag to reorder
- **Queue** — live "Playing playlist" panel (drag rows to reorder from anywhere, resizable width), Spotify-style fixed-order shuffle, repeat one/all
- **Player** — crossfade ("fade to next song"), seek/volume, animated transport bar
- **Looks** — custom background image with blur/opacity, collapsible sidebar, frameless window

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable, MSVC toolchain)

## Getting started

```powershell
npm install
npm run tauri dev
```

That's it — the first run automatically downloads the external tools
(`yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, ~120 MB total) into the right spots
via `scripts/setup-tools.ps1`. They're too big for git, so the repo ships
without them. You can also run the download step yourself:

```powershell
npm run setup           # fetch tools if missing
npm run setup -- -Force # re-download (e.g. to update ffmpeg)
```

(yt-dlp itself can be updated anytime from the app's Settings page.)

## Building a release

```powershell
npm run tauri build
```

The NSIS installer (`Local Music Player_x.y.z_x64-setup.exe`) lands in
`src-tauri/target/release/bundle/nsis/`. It bundles yt-dlp but **not** ffmpeg —
the app shows a one-time setup screen on first launch that downloads ffmpeg
(~90 MB) into the user's app-data `tools` folder. That keeps the installer
small (~25 MB) and needs no admin rights.

### Publishing via GitHub Actions

Pushing a version tag builds the installer on CI and attaches it to a GitHub
Release automatically (`.github/workflows/release.yml`):

```powershell
# bump "version" in src-tauri/tauri.conf.json + package.json first
git tag v0.1.0
git push origin v0.1.0
```

A manual run from the Actions tab builds the installer as a downloadable
workflow artifact without creating a release.

## Tool layout

| File | Why it's there |
| --- | --- |
| `src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe` | Tauri sidecar (`externalBin`), bundled into the installer; the target-triple suffix is required |
| `src-tauri/resources/ffmpeg.exe`, `ffprobe.exe` | Dev-only fallback; passed to yt-dlp via `--ffmpeg-location` for audio extraction/conversion |
| `%APPDATA%/com.localmusicplayer.app/tools/ffmpeg.exe`, `ffprobe.exe` | Installed by the first-run setup screen in packaged builds (checked first) |
