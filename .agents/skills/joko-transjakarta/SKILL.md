---
name: joko-transjakarta
description: Menjawab pertanyaan Transjakarta (bus kapan datang, posisi armada, rute/koridor, halte, tarif, jam operasional) dengan data GPS live dari tool transjakarta_live.
---

# Transjakarta live

## Langkah

1. Bila konteks belum memuat blok DATA LIVE GPS TRANSJAKARTA, panggil `transjakarta_live`:
   - `pertanyaan`: kalimat pengguna apa adanya.
   - Isi `koridor`, `halte_asal`, `halte_tujuan` bila disebut jelas (mis. "10H", "Tanah Abang", "Blok M").
2. Jawab seperti warga Jakarta yang paham rute, singkat untuk dibaca di HP:
   - Bus terdekat: nomor armada, posisi terakhir, **berapa menit lagi** tiba di halte asal.
   - Estimasi sampai di halte tujuan bila tersedia.
   - Tarif & jam operasional hanya bila relevan.
3. Bila koridor/halte tidak ditemukan atau armada sedang tidak terpantau, katakan terus terang dan sarankan menyebut kode koridor atau nama halte yang lebih tepat. JANGAN mengarang posisi atau ETA.
