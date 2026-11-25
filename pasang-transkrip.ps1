# Pasang mesin transkripsi Joko (sekali saja): ffmpeg + whisper.cpp + model Whisper large-v3-turbo.
# Semua diunduh dari sumber resmi dan diverifikasi SHA-256 sebelum dipasang.
# Lokasi: %LOCALAPPDATA%\Programs\ffmpeg  dan  %LOCALAPPDATA%\Programs\whisper  (tanpa hak admin).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$P = Join-Path $env:LOCALAPPDATA 'Programs'
$tmp = Join-Path $env:TEMP 'joko-transkrip-unduh'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Get-Verified([string]$url, [string]$out, [string]$sha, [string]$label) {
  if ((Test-Path $out) -and (Get-FileHash $out -Algorithm SHA256).Hash.ToLower() -eq $sha) { Write-Host "  $label sudah ada (checksum cocok)."; return }
  Write-Host "  Mengunduh $label ..."
  Invoke-WebRequest -UseBasicParsing $url -OutFile $out
  $actual = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $sha) { Remove-Item $out -Force; throw "Checksum $label TIDAK COCOK. Unduhan dibatalkan demi keamanan." }
  Write-Host "  $label OK (checksum cocok)." -ForegroundColor Green
}

Write-Host '=== Pasang mesin transkripsi Joko ===' -ForegroundColor Cyan
Write-Host 'Total unduhan sekitar 730 MB. Mohon tunggu.'
Write-Host ''

# 1) ffmpeg 8.1 (cabang stabil, build LGPL dari BtbN/FFmpeg-Builds) - untuk mengambil suara dari video
Get-Verified 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip' `
  "$tmp\ffmpeg.zip" '373ed50c0bf2afcdd2d9f11487eaa5c3c00869f2eb2ac974bb74fb8f8118f00b' 'ffmpeg 8.1 (163 MB)'
$fdir = Join-Path $P 'ffmpeg'
if (Test-Path $fdir) { Remove-Item -Recurse -Force $fdir }
Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffx" -Force
Move-Item (Get-ChildItem "$tmp\ffx" -Directory | Select-Object -First 1).FullName $fdir
Remove-Item -Recurse -Force "$tmp\ffx"

# 2) whisper.cpp v1.9.5 (build b5454, varian OpenBLAS x64 - tercepat untuk CPU)
Get-Verified 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip' `
  "$tmp\whisper.zip" 'b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3' 'whisper.cpp v1.9.5 (21 MB)'
$wdir = Join-Path $P 'whisper'
New-Item -ItemType Directory -Force "$wdir\models" | Out-Null
Get-ChildItem $wdir -File | Remove-Item -Force
Expand-Archive "$tmp\whisper.zip" "$tmp\wx" -Force
$cli = Get-ChildItem "$tmp\wx" -Recurse -Filter whisper-cli.exe | Select-Object -First 1
Copy-Item (Join-Path $cli.DirectoryName '*') $wdir -Recurse -Force
Remove-Item -Recurse -Force "$tmp\wx"

# 3) Model Whisper large-v3-turbo (kuantisasi q5_0, ~1 GB RAM) dari huggingface.co/ggerganov/whisper.cpp
Get-Verified 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' `
  "$wdir\models\ggml-large-v3-turbo-q5_0.bin" '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' 'model large-v3-turbo (547 MB)'

Remove-Item "$tmp\ffmpeg.zip", "$tmp\whisper.zip" -Force -ErrorAction SilentlyContinue
Write-Host ''
& "$fdir\bin\ffmpeg.exe" -hide_banner -version | Select-Object -First 1
if (-not (Test-Path "$wdir\whisper-cli.exe")) { throw 'whisper-cli.exe tidak ditemukan setelah ekstrak.' }
Write-Host ''
Write-Host 'Selesai! Mesin transkripsi siap. Joko tidak perlu dimulai ulang.' -ForegroundColor Green
Write-Host 'Kirim file MP3/MP4 ke Joko lewat WhatsApp untuk mencoba.'
Read-Host 'Tekan Enter untuk menutup'
