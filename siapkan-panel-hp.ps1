# Siapkan akses panel Joko dari HP lewat Tailscale (jaringan pribadi antar-perangkat Anda).
# Jalankan lewat siapkan-panel-hp.bat. Langkah:
#   1. Pasang Tailscale (installer resmi) bila belum ada  -> klik "Ya" pada jendela izin Windows.
#   2. Login Tailscale (browser terbuka)                  -> login dengan akun Anda.
#   3. Bagikan panel: https://<laptop>.<tailnet>.ts.net/  -> hanya perangkat di akun Tailscale Anda.
# Server Joko tetap hanya mendengarkan di 127.0.0.1:8795; Tailscale yang meneruskan.

$ErrorActionPreference = 'Stop'
$Port = 8795
$Exe = 'C:\Program Files\Tailscale\tailscale.exe'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Get-TsStatus {
  try { return (& $Exe status --json 2>$null | Out-String | ConvertFrom-Json) } catch { return $null }
}

Say '=== Panel Joko di HP (Tailscale) ===' 'Cyan'

# 1. Pasang Tailscale
if (-not (Test-Path $Exe)) {
  Say '1/3  Tailscale belum terpasang. Mengunduh installer resmi...' 'Yellow'
  $installer = Join-Path $env:TEMP 'tailscale-setup-latest.exe'
  Invoke-WebRequest -UseBasicParsing 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe' -OutFile $installer
  $sig = Get-AuthenticodeSignature $installer
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Tailscale') {
    Say "X Tanda tangan installer tidak valid ($($sig.Status)). Dibatalkan demi keamanan." 'Red'; exit 1
  }
  Say '     Installer terverifikasi (ditandatangani Tailscale Inc.). Klik "Ya" pada jendela izin Windows...'
  Start-Process -FilePath $installer -ArgumentList '/quiet' -Verb RunAs -Wait
  Remove-Item $installer -ErrorAction SilentlyContinue
  if (-not (Test-Path $Exe)) { Say 'X Instalasi Tailscale belum selesai. Jalankan file ini lagi.' 'Red'; exit 1 }
  Start-Sleep -Seconds 3
}
Say 'OK   Tailscale terpasang' 'Green'

# 2. Login
$st = Get-TsStatus
if (-not $st -or $st.BackendState -ne 'Running') {
  Say '2/3  Login Tailscale: browser akan terbuka, login dengan akun Anda (Google/Microsoft/GitHub)...' 'Yellow'
  Start-Process -FilePath $Exe -ArgumentList 'up' -WindowStyle Hidden
  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Seconds 3
    $st = Get-TsStatus
    if ($st -and $st.BackendState -eq 'NeedsLogin' -and $st.AuthURL -and -not $opened) { Start-Process $st.AuthURL; $opened = $true }
  } while ((-not $st -or $st.BackendState -ne 'Running') -and (Get-Date) -lt $deadline)
  if (-not $st -or $st.BackendState -ne 'Running') { Say 'X Login belum selesai. Jalankan file ini lagi setelah login.' 'Red'; exit 1 }
}
$name = ($st.Self.DNSName).TrimEnd('.')
Say "OK   Tailscale aktif sebagai $name" 'Green'

# 3. Bagikan panel di jaringan Tailscale (HTTPS)
Say '3/3  Membagikan panel Joko ke jaringan Tailscale Anda...' 'Yellow'
Say '     (Bila diminta mengaktifkan "Serve"/HTTPS, buka tautan yang muncul lalu klik Enable.)'
& $Exe serve --bg $Port
$serve = (& $Exe serve status --json 2>$null | Out-String)
if ($serve -notmatch "(127\.0\.0\.1|localhost):$Port") { Say 'X Panel belum terbagikan. Ikuti petunjuk di atas lalu jalankan file ini lagi.' 'Red'; exit 1 }

Say ''
Say "SELESAI. Panel Joko bisa dibuka dari HP di:" 'Green'
Say "   https://$name/admin" 'Cyan'
Say ''
Say 'Langkah di HP:'
Say '  1. Pasang aplikasi Tailscale (Play Store / App Store), login dengan akun yang SAMA, nyalakan.'
Say '  2. Di laptop buka panel Joko -> Beranda -> tombol "Buka di HP" -> pindai QR dengan kamera HP.'
Say '  3. Di browser HP: menu -> "Tambahkan ke layar utama" agar mudah dibuka lagi.'
Say ''
Say 'Pengaturan ini tetap aktif setelah laptop dinyalakan ulang. Untuk mematikan: tailscale serve reset'
