# Downloads the external tools the app drives, into the paths Tauri expects:
#   src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe   (sidecar; the
#       target-triple suffix is required by Tauri's externalBin)
#   src-tauri/resources/ffmpeg.exe + ffprobe.exe            (bundled resources)
#
# These are large (ffmpeg alone is bigger than GitHub's file limit), so they
# are gitignored and fetched here instead. Safe to re-run: existing files are
# skipped. Use -Force to re-download everything (e.g. to update ffmpeg).

param([switch]$Force)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # progress bar makes downloads ~10x slower

$root = Split-Path $PSScriptRoot -Parent
$binDir = Join-Path $root "src-tauri\binaries"
$resDir = Join-Path $root "src-tauri\resources"
New-Item -ItemType Directory -Force $binDir | Out-Null
New-Item -ItemType Directory -Force $resDir | Out-Null

$ytDlp = Join-Path $binDir "yt-dlp-x86_64-pc-windows-msvc.exe"
if ($Force -or -not (Test-Path $ytDlp)) {
    Write-Host "Downloading yt-dlp..."
    Invoke-WebRequest -UseBasicParsing `
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
        -OutFile $ytDlp
    Write-Host "  -> $ytDlp"
} else {
    Write-Host "yt-dlp already present, skipping (use -Force to re-download)."
}

$ffmpeg = Join-Path $resDir "ffmpeg.exe"
$ffprobe = Join-Path $resDir "ffprobe.exe"
if ($Force -or -not (Test-Path $ffmpeg) -or -not (Test-Path $ffprobe)) {
    Write-Host "Downloading ffmpeg essentials build (~90 MB, one-time)..."
    $zip = Join-Path $env:TEMP "lmp-ffmpeg.zip"
    $extract = Join-Path $env:TEMP "lmp-ffmpeg"
    Invoke-WebRequest -UseBasicParsing `
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" `
        -OutFile $zip
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive $zip -DestinationPath $extract
    # The zip contains a single versioned folder (ffmpeg-N.N-essentials_build/bin/...)
    $bin = Join-Path (Get-ChildItem $extract -Directory | Select-Object -First 1).FullName "bin"
    Copy-Item (Join-Path $bin "ffmpeg.exe") $ffmpeg -Force
    Copy-Item (Join-Path $bin "ffprobe.exe") $ffprobe -Force
    Remove-Item $zip -Force
    Remove-Item -Recurse -Force $extract
    Write-Host "  -> $ffmpeg"
    Write-Host "  -> $ffprobe"
} else {
    Write-Host "ffmpeg/ffprobe already present, skipping (use -Force to re-download)."
}

Write-Host "All tools ready."
