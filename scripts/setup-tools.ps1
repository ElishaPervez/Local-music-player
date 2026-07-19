# Downloads the external tools the app drives, into the paths Tauri expects:
#   src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe   (sidecar; the
#       target-triple suffix is required by Tauri's externalBin)
#   src-tauri/resources/deno.exe                            (bundled JavaScript
#       runtime used by yt-dlp to solve YouTube stream challenges)
#   src-tauri/resources/ffmpeg.exe + ffprobe.exe            (dev-only fallback;
#       installed builds download ffmpeg on first run instead)
#
# These are large (ffmpeg alone is bigger than GitHub's file limit), so they
# are gitignored and fetched here instead. Safe to re-run: existing files are
# skipped. Use -Force to re-download everything (e.g. to update the tools).
# Set LMP_SKIP_FFMPEG=1 to skip the ffmpeg download (CI release builds don't
# bundle it — the app installs it on first run).

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

$deno = Join-Path $resDir "deno.exe"
if ($Force -or -not (Test-Path $deno)) {
    Write-Host "Downloading Deno for YouTube challenge solving..."
    $zip = Join-Path $env:TEMP "lmp-deno.zip"
    $extract = Join-Path $env:TEMP "lmp-deno"
    Invoke-WebRequest -UseBasicParsing `
        "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" `
        -OutFile $zip
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive $zip -DestinationPath $extract
    Copy-Item (Join-Path $extract "deno.exe") $deno -Force
    Remove-Item $zip -Force
    Remove-Item -Recurse -Force $extract
    Write-Host "  -> $deno"
} else {
    Write-Host "Deno already present, skipping (use -Force to re-download)."
}

$ffmpeg = Join-Path $resDir "ffmpeg.exe"
$ffprobe = Join-Path $resDir "ffprobe.exe"
if ($env:LMP_SKIP_FFMPEG -eq "1") {
    Write-Host "LMP_SKIP_FFMPEG=1 - skipping ffmpeg (first-run setup installs it)."
} elseif ($Force -or -not (Test-Path $ffmpeg) -or -not (Test-Path $ffprobe)) {
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

# bgutil-ytdlp-pot-provider: lets yt-dlp attach proof-of-origin (PO) tokens
# to YouTube requests — without one, the CDN refuses (403) stream URLs minted
# under a signed-in session. Two parts, pinned to one release:
#   resources/bgutil/plugin/  — yt-dlp plugin (note the nested folder: yt-dlp
#       treats a --plugin-dirs entry like a "plugins" folder whose CHILDREN
#       each contain a yt_dlp_plugins package)
#   resources/bgutil/server/  — token generator source; the app copies it to
#       its data dir at runtime and serves it with the bundled Deno
$bgutilVersion = "1.3.1"
$bgutilDir = Join-Path $resDir "bgutil"
$versionFile = Join-Path $bgutilDir "VERSION"
$haveVersion = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { "" }
if ($Force -or $haveVersion -ne $bgutilVersion) {
    Write-Host "Downloading bgutil PO-token provider $bgutilVersion..."
    $work = Join-Path $env:TEMP "lmp-bgutil-setup"
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    New-Item -ItemType Directory -Force $work | Out-Null
    Invoke-WebRequest -UseBasicParsing `
        "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/$bgutilVersion/bgutil-ytdlp-pot-provider.zip" `
        -OutFile (Join-Path $work "plugin.zip")
    Invoke-WebRequest -UseBasicParsing `
        "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/$bgutilVersion.zip" `
        -OutFile (Join-Path $work "source.zip")
    Expand-Archive (Join-Path $work "plugin.zip") -DestinationPath (Join-Path $work "plugin")
    Expand-Archive (Join-Path $work "source.zip") -DestinationPath (Join-Path $work "source")
    if (Test-Path $bgutilDir) { Remove-Item -Recurse -Force $bgutilDir }
    $pluginDest = Join-Path $bgutilDir "plugin\bgutil-ytdlp-pot-provider"
    New-Item -ItemType Directory -Force $pluginDest | Out-Null
    Copy-Item -Recurse (Join-Path $work "plugin\yt_dlp_plugins") (Join-Path $pluginDest "yt_dlp_plugins")
    $srcServer = Join-Path $work "source\bgutil-ytdlp-pot-provider-$bgutilVersion\server"
    $serverDest = Join-Path $bgutilDir "server"
    New-Item -ItemType Directory -Force $serverDest | Out-Null
    Copy-Item -Recurse (Join-Path $srcServer "src") (Join-Path $serverDest "src")
    Copy-Item -Recurse (Join-Path $srcServer "types") (Join-Path $serverDest "types")
    foreach ($f in "package.json", "deno.lock", "tsconfig.json") {
        Copy-Item (Join-Path $srcServer $f) $serverDest
    }
    Set-Content -Encoding ascii $versionFile $bgutilVersion
    Remove-Item -Recurse -Force $work
    Write-Host "  -> $bgutilDir"
} else {
    Write-Host "bgutil provider $bgutilVersion already present, skipping."
}

Write-Host "All tools ready."
