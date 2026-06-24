# Panduan Penggunaan Dropbox CLI (Dockerized) & Fitur Login Fallback

Refactor telah selesai dilakukan! Aplikasi Anda sekarang berbentuk antarmuka murni *Command Line* (CLI) yang dioptimalkan untuk berjalan di dalam Docker Linux secara mandiri, dengan dukungan pengujian lokal langsung di Windows.

## Fitur Baru & Perbaikan:

1. **Alur Deteksi & Login Otomatis (Login Fallback)**:
   - Jika Anda mencoba mendaftarkan email yang **sudah terdaftar**, skrip secara otomatis mendeteksi status ini di Langkah 2 (setelah tombol Continue diklik).
   - Skrip akan mencetak log `[Browser] ⚠️ Akun sudah terdaftar. Mencoba masuk (Log in) dengan email & password...` dan mengalihkan alur untuk masuk (log in) menggunakan kredensial pendaftaran yang diberikan.
   - Setelah masuk dengan sukses, skrip menandai proses pendaftaran berhasil dan melanjutkan ke langkah verifikasi/penghubungan device daemon.
   - Jika halaman verifikasi CLI Link dialihkan oleh Dropbox ke halaman login, browser secara otomatis melakukan login ulang dan kembali menavigasi ke halaman verifikasi untuk menekan tombol **Connect**.

2. **Dukungan Jalur Chrome Lintas Platform**:
   - Skrip mendeteksi sistem operasi Anda secara dinamis.
   - Pada host **Windows**, skrip menggunakan `channel: 'chrome'` untuk memanfaatkan instalasi Chrome Resmi lokal Anda.
   - Pada **Linux/Docker**, skrip tetap menggunakan berkas eksekusi resmi `/usr/bin/google-chrome`.

3. **Alur Form Bertahap**:
   - **Langkah 1**: Menunggu dan mengisi field email, lalu mencari tombol "Continue" untuk masuk ke *screen* kedua.
   - **Langkah 2**: Menunggu field nama pendaftaran (untuk akun baru) ATAU field password login (untuk akun yang sudah terdaftar), lalu melakukan pengisian field yang sesuai.

---

## Struktur File Utama:
- `register.js`: Skrip eksekusi utama CLI. Skrip ini mem-parsing argumen CLI, mengelola rotasi User Agent, mengelola *looping* email, serta menginisiasi *instance* Playwright Chrome resmi dengan penundaan mirip manusia (*human-like delay*).
- `Dockerfile`: Menggunakan *base image* `node:20-bookworm`, menginstal dependensi khusus *Google Chrome Desktop* resmi untuk menghindari deteksi Playwright, serta menyertakan logika ekstraksi `dropbox.tar.gz`.
- `docker-compose.yml`: Mempermudah proses eksekusi dan *volume mounting*. Data history tersimpan secara persisten di lokal dalam direktori `data/`.
- `run.sh`: *Wrapper script* *bash* sederhana untuk mempermudah eksekusi `docker-compose run`.

---

## Cara Menggunakan di Lokal Windows

Untuk menjalankan pengetesan langsung di Windows:
1. Jalankan instalasi dependensi lokal:
   ```bash
   npm install
   npx playwright install chromium chrome
   ```
2. Jalankan perintah registrasi/login menggunakan email Anda:
   ```bash
   node register.js --emails="email_anda@domain.com" --password-mode="fixed" --fixed-password="PasswordAnda" --browser=chrome --headless=false
   ```

*Catatan: Saat dijalankan langsung di Windows, daemon `dropboxd` (yang merupakan binary Linux) tidak akan berhasil berjalan, tetapi alur login/signup di browser Chrome akan berjalan 100% secara otomatis hingga halaman verifikasi.*
