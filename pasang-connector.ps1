# Pasang connector Joko: Google (Gmail, Drive, Calendar), Canva, Perplexity, GitHub (baca saja).
# Jalankan lewat pasang-connector.bat. Kunci rahasia diketik di sini (tersembunyi), tidak lewat chat.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$agy = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'

function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Invoke-Setup([string[]]$argList) {
  & node setup-connectors.mjs @argList
  if ($LASTEXITCODE -ne 0) { throw 'Pemasangan gagal (lihat pesan di atas).' }
}
function Show-Login([string]$names) {
  Write-Host ''
  Write-Host "LANGKAH LOGIN ($names):" -ForegroundColor Yellow
  Write-Host '  1. Jendela Antigravity CLI akan terbuka.'
  Write-Host '  2. Ketik  /mcp  lalu Enter, pilih server di atas, dan login di browser yang terbuka.'
  Write-Host '  3. Setelah semua tersambung, ketik  /quit  untuk keluar.'
  Write-Host ''
  Read-Host 'Tekan Enter untuk membuka Antigravity CLI'
  & $agy
}

Write-Host '=== Pasang connector Joko ===' -ForegroundColor Cyan
& node setup-connectors.mjs list
Write-Host ''
Write-Host '  1. Google (Gmail, Drive, Calendar)'
Write-Host '  2. Canva'
Write-Host '  3. Perplexity'
Write-Host '  4. Login ulang / sambungkan (buka Antigravity CLI)'
Write-Host '  5. Hapus connector'
Write-Host '  6. GitHub (baca saja: repo, issue, PR, status CI)'
$pick = Read-Host 'Pilih nomor'

switch ($pick) {
  '1' {
    Write-Host ''
    Write-Host 'Siapkan dulu di Google Cloud Console (sekali saja):' -ForegroundColor Yellow
    Write-Host '  a. Daftar Google Workspace Developer Preview Program (MCP Workspace masih preview).'
    Write-Host '  b. Buat project, aktifkan API: gmail, drive, calendar-json, people + gmailmcp, drivemcp, calendarmcp.'
    Write-Host '  c. OAuth consent screen: External, tambahkan email Anda sebagai test user.'
    Write-Host '  d. Credentials > OAuth client ID > Web application, centang "Use this client for an AI-powered agent",'
    Write-Host '     Authorized redirect URI: https://antigravity.google/oauth-callback'
    Write-Host '  Panduan: https://developers.google.com/workspace/guides/configure-mcp-servers'
    Write-Host ''
    $env:JOKO_GOOGLE_CLIENT_ID = (Read-Host 'Client ID').Trim()
    $env:JOKO_GOOGLE_CLIENT_SECRET = Read-Secret 'Client secret (tidak terlihat saat diketik)'
    try { Invoke-Setup @('add', 'google') } finally { Remove-Item Env:JOKO_GOOGLE_CLIENT_SECRET, Env:JOKO_GOOGLE_CLIENT_ID -ErrorAction SilentlyContinue }
    Show-Login 'gmail, drive, calendar'
  }
  '2' {
    Write-Host ''
    Write-Host 'Siapkan dulu di https://www.canva.com/developers/apps (sekali saja):' -ForegroundColor Yellow
    Write-Host '  a. Create an app > Outside Canva > Start integrating.'
    Write-Host '  b. Configuration > Integration methods: nyalakan "Canva MCP".'
    Write-Host '  c. Redirect URLs: https://antigravity.google/oauth-callback'
    Write-Host '  d. Credentials: salin Client ID, klik Generate secret (hanya tampil sekali).'
    Write-Host ''
    $env:JOKO_CANVA_CLIENT_ID = (Read-Host 'Canva Client ID').Trim()
    $env:JOKO_CANVA_CLIENT_SECRET = Read-Secret 'Canva client secret (tidak terlihat saat diketik)'
    try { Invoke-Setup @('add', 'canva') } finally { Remove-Item Env:JOKO_CANVA_CLIENT_SECRET, Env:JOKO_CANVA_CLIENT_ID -ErrorAction SilentlyContinue }
    Show-Login 'canva'
  }
  '3' {
    Write-Host 'Buat API key di https://www.perplexity.ai/account/api (perlu saldo/kredit API).' -ForegroundColor Yellow
    $env:JOKO_PERPLEXITY_API_KEY = Read-Secret 'Perplexity API key (tidak terlihat saat diketik)'
    try { Invoke-Setup @('add', 'perplexity') } finally { Remove-Item Env:JOKO_PERPLEXITY_API_KEY -ErrorAction SilentlyContinue }
    Write-Host 'Mengunduh paket server Perplexity (sekali saja)...'
    & npm cache add '@perplexity-ai/mcp-server@1.3.0' | Out-Null
    Show-Login 'perplexity'
  }
  '4' { Show-Login 'server yang belum tersambung' }
  '5' {
    $t = Read-Host 'Hapus yang mana? (google / canva / perplexity / github)'
    Invoke-Setup @('remove', $t.Trim().ToLower())
  }
  '6' {
    $bin = Join-Path $env:LOCALAPPDATA 'Programs\github-mcp-server\github-mcp-server.exe'
    if (-not (Test-Path $bin)) { throw "Server GitHub MCP belum terpasang di $bin" }
    Write-Host ''
    Write-Host 'Buat token fine-grained BACA SAJA (sekali saja):' -ForegroundColor Yellow
    Write-Host '  a. Buka https://github.com/settings/personal-access-tokens/new'
    Write-Host '  b. Token name: Joko baca saja   Expiration: 90 hari (atau sesuai selera)'
    Write-Host '  c. Repository access: All repositories (atau pilih repo tertentu)'
    Write-Host '  d. Permissions > Repositories, set ke "Read-only":'
    Write-Host '       Contents, Issues, Pull requests, Actions, Commit statuses  (Metadata otomatis Read-only)'
    Write-Host '     JANGAN beri izin "Read and write" apa pun.'
    Write-Host '  e. Generate token, salin (diawali github_pat_).'
    Write-Host ''
    $env:JOKO_GITHUB_TOKEN = Read-Secret 'Token GitHub (tidak terlihat saat diketik)'
    try { Invoke-Setup @('add', 'github') } finally { Remove-Item Env:JOKO_GITHUB_TOKEN -ErrorAction SilentlyContinue }
    Write-Host 'GitHub tidak perlu login tambahan: token sudah dipakai langsung oleh server.' -ForegroundColor Green
  }
  default { Write-Host 'Batal.' }
}
Write-Host ''
& node setup-connectors.mjs list
Write-Host ''
Write-Host 'Selesai. Izinkan connector untuk Joko di Panel > Tools & MCP.' -ForegroundColor Green
Read-Host 'Tekan Enter untuk menutup'
