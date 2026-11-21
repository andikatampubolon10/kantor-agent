# Sumber & atribusi skill Joko

Skill dokumen Joko (`joko-dokumen`, `joko-laporan`, `joko-presentasi`, `joko-spreadsheet`,
`joko-surat`) dan tema di `document-builder.mjs` sebagian **diadaptasi** dari skill open source
milik Anthropic:

- Repositori: https://github.com/anthropics/skills (diambil 21 November 2026)
- Lisensi: Apache License 2.0 — salinan lengkap di [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt)

| Skill sumber | Yang diadaptasi |
|---|---|
| `skills/pptx` | Alur presentasi (piramida, satu pesan per slide), ide tata letak (angka besar, perbandingan, linimasa), skala huruf, daftar kesalahan umum, daftar periksa visual, palet warna tema |
| `skills/xlsx` | Rumus bukan angka jadi, asumsi & sumber ditulis, persen sebagai pecahan, nol tampil "-", legenda untuk lembar isian |
| `skills/docx` | Catatan teknis pustaka `docx` (heading `keepNext`, bullet asli, tabel) |
| `skills/internal-comms` | Laporan ringkas "Progress, Plans, Problems"; informasi terpenting di depan; padat data |
| `skills/theme-factory` | Konsep beberapa tema warna yang dipilih sesuai topik |
| `skills/frontend-design` | Daftar ciri desain "buatan AI" yang dihindari, satu elemen menonjol, kritik diri sebelum selesai |

**Perubahan yang dilakukan:** diterjemahkan dan ditulis ulang ke Bahasa Indonesia, digabung dan
diringkas, disesuaikan dengan mesin `buat_file` Joko (Node + Chrome, tanpa Python/LibreOffice),
ditambah konvensi Indonesia (Rupiah, tanggal, surat resmi), rubrik penilaian, dan aturan keamanan
Joko. Skrip dari repositori sumber **tidak** disalin maupun dijalankan.

Ide "uji pembaca" (memperkirakan pertanyaan pembaca lalu memeriksa dokumen menjawabnya) terinspirasi
dari skill `doc-coauthoring` di repositori yang sama; tidak ada teks yang disalin darinya.
