# Panduan Penggunaan Dropbox CLI (Dockerized)

Refactor telah selesai dilakukan! Aplikasi Anda sekarang berbentuk antarmuka murni *Command Line* (CLI) yang dioptimalkan untuk berjalan di dalam Docker Linux secara mandiri tanpa memerlukan Warp, Proxy, dan Box64.

## Struktur File Baru
- `register.js`: Telah dirombak total dan sekarang berfungsi sebagai skrip eksekusi utama CLI. Skrip ini secara otomatis mem-parsing argumen CLI yang Anda kirimkan, mengelola *looping* email, serta menginisiasi *instance* Playwright Chromium lokal dan mengeksekusi `dropboxd`.
- `Dockerfile`: Resep Docker yang menggunakan *base image* `node:20-bookworm`, menginstal dependensi khusus *Chromium*, serta menyertakan logika ekstraksi `dropbox.tar.gz` untuk menghindari error *symlink* di Windows.
- `docker-compose.yml`: File ini mempermudah proses eksekusi dan *volume mounting*. Data history Anda akan tersimpan secara persisten di lokal dalam direktori `data/`.
- `run.sh`: *Wrapper script* *bash* sederhana untuk mempermudah eksekusi `docker-compose run` dari terminal tanpa perlu mengingat argumen docker-compose.

## Cara Menggunakan

### 1. Persiapan File
> [!IMPORTANT]
> Pastikan Anda telah menaruh file kompresi Dropbox dengan nama **`dropbox.tar.gz`** ke dalam sub-direktori `app/` sebelum melakukan proses *build*. *Script* instalasi akan membongkar file ini langsung di Linux untuk menjaga *symlink* bawaan.

### 2. Membangun (Build) Docker Image
Buka terminal Anda (di dalam root folder project) lalu jalankan perintah berikut:
```bash
docker-compose build
```
Proses ini mungkin membutuhkan waktu karena mengunduh instalasi sistem Ubuntu dan instalasi inti Chromium sebesar ~150MB+.

### 3. Eksekusi Pendaftaran
Setelah proses *build* selesai, jalankan bot dengan menggunakan skrip pembantu yang telah disediakan:

**Contoh: Mode Auto-Generate (10 Email)**
```bash
./run.sh --alias "Worker-Auto" --url "https://www.dropbox.com/register" --source auto --domain "kywa.uk" --count 10 --timeout 120 --retry 3 --devices "desktop,mobile"
```

**Contoh: Mode Manual Input**
```bash
./run.sh --alias "Worker-Manual" --url "https://www.dropbox.com/register" --source manual --emails "satu@kywa.uk; dua@kywa.uk" --timeout 120 --retry 3 --devices "desktop"
```

**Contoh: Mode Password Tetap**
```bash
./run.sh --alias "Fixed-Pass" --source auto --domain "kywa.uk" --count 5 --password-mode "fixed" --fixed-password "SuperRahasia123!"
```

### Parameter Referensi
- `--alias`: Memberikan nama sesi (Default: `CLI-Default`)
- `--url`: Link referal Dropbox pendaftaran
- `--source`: Mode email (`auto` atau `manual`)
- `--domain`: Domain tujuan untuk *Generate* acak (`auto`)
- `--count`: Jumlah email yang ingin dibuat (`auto`)
- `--emails`: Daftar email yang dipisahkan titik koma (`;`) (jika `manual`)
- `--password-mode`: `random` (diacak aman) atau `fixed` (tetap)
- `--fixed-password`: Teks password bila mode `fixed`
- `--timeout`: Waktu habis per interaksi UI Browser (Detik)
- `--retry`: Percobaan maksimal per tab browser jika gagal / *crash*
- `--devices`: Pemilihan variasi User Agent (`desktop,mobile,tablet` dsb)

## Melihat Riwayat Log
Riwayat kesuksesan setiap alamat email akan tercatat di file `./data/history.json`. Karena file ini sudah di *mount* menggunakan sistem *Volume*, Anda dapat membuka dan mengecek file JSON ini dengan teks editor apa pun pada sistem lokal Windows Anda.
