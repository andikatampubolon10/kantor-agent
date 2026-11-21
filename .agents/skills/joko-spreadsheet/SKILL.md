---
name: joko-spreadsheet
description: Menyusun file Excel (xlsx) yang rapi, benar, dan siap diolah untuk Mas Andika — rekap, anggaran, daftar, tabel data, lembar isian. Pakai setiap kali diminta Excel/spreadsheet/tabel untuk diolah (bersama joko-dokumen untuk spesifikasi buat_file).
---

# Spreadsheet yang benar & siap pakai

## Prinsip

- **Ikuti permintaan secara harfiah**: nama sheet, judul kolom, dan isi persis seperti yang diminta.
- **Rumus, bukan angka jadi**: total (`"total": true`) dan porsi (`{"hitung": "porsi"}`) dibuat mesin
  sebagai rumus Excel, sehingga tetap benar bila Mas Andika mengubah angka. Jangan menghitung sendiri
  lalu mengetik hasilnya.
- **Satu baris = satu catatan**, satu kolom = satu jenis data. Tanggal di kolom `tanggal`, uang di
  kolom `rupiah` — jangan digabung ("16 Nov - Rp 45.000").
- **Tulis asumsi & sumber** di `catatan` sheet ("Sumber: mutasi BCA 1–21 Nov", "Asumsi: kurs Rp 16.000",
  "Data contoh untuk demonstrasi").

## Struktur

- **Data sedikit** (≤ 30 baris, satu topik): satu sheet dengan judul, tabel, total.
- **Data banyak / perlu ringkasan**: sheet pertama **Ringkasan** (per kategori/bulan + total + porsi +
  grafik), sheet berikutnya **Data** (rincian lengkap, urut tanggal). Nama sheet singkat, tanpa simbol.
- **Lembar isian / template** (mis. anggaran yang akan diisi): satu baris contoh berisi nilai realistis
  dan `catatan` berisi petunjuk singkat kolom mana yang diisi.
- Urutan baris bermakna: kronologis untuk transaksi, terbesar → terkecil untuk ringkasan kategori.

## Rubrik (yang **wajib** harus lolos)

| # | Kriteria | |
|---|---|---|
| 1 | Judul kolom & nama sheet sesuai permintaan | wajib |
| 2 | Kolom uang/angka/tanggal memakai format yang tepat (bukan teks) | wajib |
| 3 | Total & porsi berupa rumus (lewat `total` / `hitung: "porsi"`) | wajib |
| 4 | Sumber/asumsi/data contoh dicatat di `catatan` | wajib |
| 5 | Ringkasan di sheet pertama bila data > 30 baris | sebaiknya |
| 6 | Grafik ringkasan bila membantu (kategori/tren) | sebaiknya |

Periksa ringkasan hasil tool (jumlah baris/kolom, kolom porsi, total) terhadap data Anda — Excel
tidak punya pratinjau gambar.

Sebagian panduan diadaptasi dari skill open source Anthropic `xlsx` (Apache-2.0) — lihat `../SUMBER.md`.
