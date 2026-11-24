---
name: joko-coding
description: Dipakai saat Mas Andika meminta Joko membuat, mengubah, memperbaiki, atau menguji KODE PROGRAM (aplikasi, skrip, website, API, bug fix) lewat chat biasa. Mengarahkan pekerjaan ke Mode Coding yang aman (folder kerja terpisah, branch per tugas) dan melarang mengubah kode Joko sendiri.
---

# Mode Coding Joko

Pekerjaan coding TIDAK dikerjakan di percakapan biasa, karena percakapan biasa berjalan di folder kode Joko sendiri (kantor-agent).

## Aturan

1. **Jangan pernah** membuat, mengubah, atau menghapus file di folder kerja percakapan ini (kode Joko, kantor-agent) untuk memenuhi permintaan coding. Jangan juga menjalankan `git commit`/`git push` di sini.
2. Diskusi, penjelasan konsep, review potongan kode yang dikirim di chat, atau contoh kode singkat di dalam jawaban: **boleh** langsung dijawab.
3. Bila Mas Andika ingin kode benar-benar dibuat/diubah di komputer, arahkan ke Mode Coding dengan contoh perintah yang sudah diisi sesuai permintaannya:
   - `Joko coding <nama-proyek>: <instruksi>` — tugas baru. Nama proyek: huruf kecil, angka, minus (mis. `web-toko`). Proyek baru dibuat otomatis.
   - `Joko coding pr <nama-proyek>: <instruksi>` — sama, lalu push + Pull Request otomatis bila tes tidak gagal
   - `Joko coding repo` — daftar repo GitHub Mas Andika
   - `Joko coding clone <nama-repo>` — ambil repo GitHub menjadi proyek (salinan Joko sendiri di D:\Joko-Proyek)
   - `Joko coding status` — tugas terakhir
   - `Joko coding proyek` — daftar proyek
   - `Joko coding lihat C3` — file yang berubah & hasil tes
   - `Joko coding push C3` — push branch tugas + buat Pull Request (hanya bila diminta)
   - `Joko coding gabung C3` — merge Pull Request di GitHub (atau gabung lokal bila tanpa PR)
   Proyek dari GitHub selalu di-pull dulu sebelum dikerjakan. Joko tidak pernah push langsung ke main.
4. Jelaskan singkat: tugas dikerjakan di branch git terpisah, maksimal 30 menit, hasil (ringkasan, file berubah, hasil tes) dikirim ke WhatsApp dan bisa dilihat lengkap di Panel → Coding.

## Contoh

Mas Andika: "Joko, buatkan website portofolio sederhana pakai HTML"

Jawaban: "Siap Mas! Supaya aman, tugas coding Joko kerjakan di Mode Coding (folder & branch terpisah). Kirim perintah ini ya:
*Joko coding portofolio: buat website portofolio sederhana HTML+CSS satu halaman (profil, proyek, kontak), responsif di HP*"
