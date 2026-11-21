---
name: joko-surat
description: Menyusun surat dan dokumen resmi berbahasa Indonesia yang benar formatnya — surat dinas/izin/permohonan/pengantar/kuasa/pernyataan, undangan, proposal, notulen rapat, memo. Pakai setiap kali diminta membuat surat atau dokumen resmi (bersama joko-dokumen; format pdf/docx dengan gaya "surat").
---

# Surat & dokumen resmi

Pakai `"gaya": "surat"` (hitam-putih, Times New Roman, tanpa judul berwarna). Default `docx` bila
surat perlu diedit/ditandatangani dulu; `pdf` bila siap kirim. Jangan mengarang data pribadi (NIK,
alamat, nomor surat) — pakai yang diberikan, atau tanda kurung siku yang jelas: `[nomor surat]`, lalu
sebutkan di jawaban bagian mana yang perlu dilengkapi.

## Surat resmi (urutan blok)

1. `kop` — hanya bila atas nama instansi/perusahaan (nama + alamat + kontak).
2. `info` — `Nomor`, `Lampiran`, `Perihal` (perihal **tebal**). Untuk surat pribadi cukup tanggal +
   perihal, atau lewati.
3. `paragraf` — tujuan: "Yth. …\n[jabatan/instansi]\ndi tempat" (atau alamat).
4. `paragraf` — salam pembuka: "Dengan hormat,".
5. `paragraf` (`"rata": "rata"`) — isi: maksud surat di paragraf pertama; rincian (waktu, tempat,
   alasan) memakai blok `info` atau daftar bila banyak; paragraf penutup ("Demikian …, atas perhatian
   … kami ucapkan terima kasih.").
6. `tanda_tangan` — "Kota, tanggal" + "Hormat saya,"/jabatan + nama (+ jabatan/NIP di `keterangan`).

**Jangan menambah fakta** yang tidak disebut Mas Andika (mis. "atas anjuran dokter", "terlampir
surat dokter", alasan rinci, nama atasan). Tulis seperlunya; bila hal itu lazim diperlukan, sebutkan
di jawaban sebagai saran ("Bila ada surat dokter, bisa dilampirkan").

**Cek tanggal & hari**: hitung hari dari tanggal (mis. "besok"). Bila jatuh pada Sabtu/Minggu atau
hari libur nasional, tetap buat suratnya tapi beri tahu di jawaban ("Besok hari Minggu — apakah
maksudnya Senin, 23 November?").

Tanda tangan surat pribadi: `"jabatan": "Hormat saya,"` agar tidak ada ruang kosong di atas nama.

Bahasa: baku (PUEBI/EYD), sopan, ringkas; "Bapak/Ibu" dengan huruf kapital; tanggal ditulis lengkap
("21 November 2026"); tanpa singkatan informal.

## Jenis lain

- **Undangan**: info acara (hari/tanggal, waktu, tempat, acara) dengan blok `info`.
- **Notulen rapat**: `info` (hari/tanggal, waktu, tempat, pimpinan, peserta) → judul "Pembahasan" →
  daftar bernomor per agenda → judul "Keputusan & Tindak Lanjut" → `tabel` (Tindakan · PIC · Tenggat).
- **Proposal**: gaya laporan biasa (bukan surat) — Latar belakang · Tujuan · Rencana kegiatan
  (tabel jadwal) · Anggaran (tabel `rupiah` + `total`) · Penutup. Ikuti juga joko-laporan.
- **Memo internal**: `info` (Kepada, Dari, Tanggal, Perihal) → isi singkat → tindakan yang diminta.

## Rubrik (yang **wajib** harus lolos)

| # | Kriteria | |
|---|---|---|
| 1 | Unsur surat lengkap sesuai jenis (tujuan, salam, isi, penutup, tanda tangan) | wajib |
| 2 | Data yang tidak diketahui ditandai `[...]`; tidak ada fakta tambahan karangan | wajib |
| 2b | Hari/tanggal dicek; akhir pekan/libur diberitahukan di jawaban | wajib |
| 3 | Bahasa baku & sopan, tanpa salah ketik | wajib |
| 4 | Label Nomor/Lampiran/Perihal sejajar (blok `info`), tanda tangan di kanan | wajib |
| 5 | Muat 1 halaman untuk surat biasa | sebaiknya |

Sebagian panduan diadaptasi dari skill open source Anthropic (Apache-2.0) — lihat `../SUMBER.md`.
