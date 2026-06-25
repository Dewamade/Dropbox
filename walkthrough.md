# Panduan Lengkap Dropbox CLI (Headless Firefox & Native VPS Optimized)

Aplikasi ini adalah bot pendaftaran akun Dropbox otomatis berbasis **Playwright Firefox** yang dirancang untuk berjalan secara langsung (*native*) di lingkungan **Linux VPS (Ubuntu/Debian)**, **WSL**, maupun **Windows lokal**. Dropbox daemon (`dropboxd`) diluncurkan secara otomatis menggunakan container Docker untuk menjaga kebersihan dan isolasi sistem.

---

## 🚀 Fitur Utama & Pembaruan
1. **Alur Deteksi & Login Otomatis (Login Fallback)**:
   - Jika mendeteksi email pendaftaran sudah terdaftar, skrip otomatis mengalihkan alur untuk masuk (log in) menggunakan kredensial pendaftaran yang diberikan.
2. **Penyederhanaan Tautan CLI Link**:
   - URL verifikasi `cli_link` dibuka langsung pada tab/halaman aktif (`page`) saat ini (mensimulasikan aksi copy-paste) tanpa membuka tab baru yang berlebih.
   - Skrip fokus mendeteksi tombol **Connect** secara langsung pada halaman tersebut hingga batas waktu (timeout) tercapai.
3. **Restorasi Verifikasi Email & Modal Konfirmasi**:
   - Setelah sukses terhubung, skrip menavigasi ke halaman `/account`.
   - Menunggu tombol "Verify email" / "Verifikasi email" muncul (timeout 60 detik), mengkliknya.
   - Menunggu modal terbuka, lalu mengklik tombol konfirmasi primary **"Send email"** / **"Kirim email"** dengan selector khusus (`button.js-email-modal-button.dig-Button--primary`) untuk menghindari klik pada tombol "Cancel" yang memiliki kelas modal yang sama.
   - Menunggu pembaruan teks konfirmasi sukses terkirim (misalnya, `"sent a verification email"`, `"check your inbox"`, dll.) muncul di modal, serta menambahkan penundaan 3 detik untuk memastikan request HTTP terkirim seutuhnya sebelum browser dimatikan.
   - Melacak status pengiriman email (`emailSent`) secara dinamis untuk menentukan status akhir (`VERIF` jika sukses terkirim, `success` jika hanya sukses registrasi & link daemon tanpa verifikasi email).
4. **Optimasi Mode Headless (Anti-Detection)**:
   - Jika berjalan dalam mode `headless: true`, skrip meluncurkan browser Firefox dengan optimasi parameter headless terbaru untuk menghindari deteksi bot oleh Dropbox.
5. **Dukungan Lintas Platform (Windows & Linux VPS / WSL)**:
   - Berjalan secara native menggunakan browser Firefox pada Windows maupun Linux VPS dengan instalasi dependensi otomatis yang disiapkan oleh Playwright.
6. **Injeksi Parameter Lokalisasi & Zona Waktu**:
   - Skrip secara eksplisit menginjeksikan `locale: 'en-US'` dan `timezoneId: 'America/New_York'` pada pengaturan browser context. Ini mereplikasi behavior browser desktop normal dan meniadakan indikasi ketidaksesuaian/inkonsistensi profile di server VPS (yang secara default tidak memiliki zona waktu atau bermarkas di luar target pasar), sehingga secara signifikan mengurangi kemunculan CAPTCHA pendaftaran.
7. **Pembersihan Profil & Script Evasion (Penyamaran)**:
   - Sebelum browser diluncurkan, bot mematikan instansi browser lama dan menghapus direktori profil Firefox (`./data/firefox-profile`) secara keseluruhan untuk memastikan alur dimulai dari profil bersih tanpa cache/cookies/status lama.
   - Menyisipkan kembali script penyamaran `addInitScript` untuk menyembunyikan properti `navigator.webdriver`, memalsukan list plugins tiruan, dan me-override izin notifikasi API.
8. **Rotasi User Agent per Launch & Fallback**:
   - Skrip memutar User Agent pada setiap peluncuran browser (termasuk pada percobaan ulang/retry untuk email yang sama).
   - Menyediakan fallback pemilihan User Agent secara otomatis di dalam `registerSingleEmail` jika tidak ada User Agent yang diberikan oleh pemanggil.
9. **Eksekusi Dropbox Daemon via Docker Container**:
   - Dropbox daemon (`dropbox-lnx.x86_64`) diluncurkan dalam container Ubuntu `ubuntu:24.04` terpisah dengan isolasi lingkungan, volume mapping, dan host networking.
   - Penanganan siklus hidup container dikontrol menggunakan nama container unik per email (`dropbox-daemon-<username>`), dan bot secara otomatis mengeksekusi `docker stop` untuk membersihkannya setelah verifikasi selesai atau saat terjadi kegagalan.
   - Menggunakan fitur **Dynamic Path Resolution** untuk mendeteksi jalur folder proyek secara otomatis menggunakan `__dirname` host untuk penyesuaian volume mounting, sehingga tidak diperlukan konfigurasi manual.

---

## 🛠️ Cara Deploy & Menggunakan di VPS (Direct Node & Dockerized Daemon)

Project ini dijalankan secara langsung (*native*) menggunakan Node.js pada VPS, tetapi ia akan secara otomatis meluncurkan dan mengisolasi Dropbox daemon di dalam container Docker minimal saat mengaitkan akun.

### 1. Persiapan File
Pastikan Anda menaruh file kompresi Dropbox dengan nama **`dropbox.tar.gz`** ke dalam sub-direktori `app/` sebelum menjalankan instalasi.
```text
Dropbox/
├── app/
│   └── dropbox.tar.gz
```

### 2. Instalasi Otomatis via `setup.sh`
Kami menyediakan skrip instalasi `setup.sh` untuk menyiapkan seluruh kebutuhan bot (seperti Node.js 20, Git, Docker, dependensi NPM, serta browser Firefox Playwright) pada VPS Ubuntu/Debian yang bersih.

Jalankan perintah berikut pada VPS Anda:
```bash
# Mengunduh dan menjalankan script setup
curl -sSL https://raw.githubusercontent.com/jacksatriadi-jpg/Dropbox/nodocker/setup.sh -o setup.sh
chmod +x setup.sh
./setup.sh
```

### 3. Menjalankan Bot di VPS
Setelah instalasi selesai, masuk ke folder `Dropbox/` dan jalankan script menggunakan `node register.js` dengan opsi/parameter yang diinginkan:

**Contoh: Mode Auto-Generate (10 Akun otomatis)**
```bash
node register.js --alias "VPS-Worker-Auto" --url "https://www.dropbox.com/register" --source auto --domain "kywa.uk" --count 10 --timeout 120 --retry 3 --devices "desktop"
```

**Contoh: Mode Manual Input dengan Proxy SOCKS5**
```bash
node register.js --alias "VPS-Worker-Manual" --source manual --emails "satu@kywa.uk; dua@kywa.uk" --proxy "socks5://192.168.1.1:1080"
```

**Contoh: Mode Password Tetap**
```bash
node register.js --alias "VPS-Fixed" --source auto --domain "kywa.uk" --count 5 --password-mode "fixed" --fixed-password "SuperRahasia123!"
```

---

## 💻 Cara Menjalankan di Lokal Windows (Pengecekan Alur)

Untuk melakukan pengetesan alur UI secara langsung di Windows:
1. Instal dependensi:
   ```bash
   npm install
   npx playwright install firefox
   ```
2. Jalankan perintah (menggunakan browser Firefox non-headless agar visual terlihat):
   ```bash
   node register.js --emails="email_anda@domain.com" --password-mode="fixed" --fixed-password="PasswordAnda" --headless=false
   ```
*Catatan: Saat dijalankan langsung di Windows, daemon `dropboxd` (yang merupakan binary Linux) tidak akan berhasil berjalan, tetapi alur login/signup di browser Firefox akan berjalan 100% secara otomatis hingga halaman verifikasi dan pengiriman email verifikasi.*

---

## 📋 Parameter Referensi `register.js`

Berikut adalah daftar parameter CLI yang didukung oleh `register.js`:

| Parameter | Deskripsi | Nilai Default | Contoh |
| :--- | :--- | :--- | :--- |
| `--alias` | Nama identitas sesi untuk pencatatan | `CLI-Default` | `--alias="VPS-Worker-1"` |
| `--url` | Tautan referal / pendaftaran Dropbox | `https://www.dropbox.com/register` | `--url="https://db.tt/xyz"` |
| `--source` | Sumber email yang diproses | `manual` | `--source="auto"` atau `--source="manual"` |
| `--emails` | Daftar email dipisahkan titik koma `;` (jika mode `manual`) | `""` | `--emails="a@b.com;c@d.com"` |
| `--domain` | Domain tujuan untuk auto-generate email (jika mode `auto`) | `kywa.uk` | `--domain="gudangpemaron.my.id"` |
| `--count` | Jumlah akun yang akan dibuat (jika mode `auto`) | `1` | `--count=5` |
| `--password-mode` | Mode pembuatan password | `random` | `--password-mode="fixed"` atau `"random"` |
| `--fixed-password` | Teks password jika mode password `fixed` | `Password123!` | `--fixed-password="Aa12345678*"` |
| `--timeout` | Waktu habis (detik) per interaksi UI Browser | `60` | `--timeout=120` |
| `--retry` | Jumlah percobaan ulang per email jika gagal | `3` | `--retry=3` |
| `--devices` | Tipe simulasi perangkat (rotasi User Agent) | `desktop` | `--devices="desktop,mobile,tablet"` |
| `--headless` | Menjalankan browser tanpa UI grafis | `true` | `--headless=false` |
| `--proxy` | Meneruskan koneksi bot via server proxy | `""` | `--proxy="socks5://192.168.1.1:1080"` |
| `--host` | Tipe/path host untuk mounting Docker daemon | `wsl` | `--host="vps"` atau `--host="/home/ubuntu"` |

---

## 📊 Melihat Riwayat Registrasi
Setiap akun yang diproses akan tercatat ke dalam berkas JSON riwayat di:
* `./data/history.json`

Format status yang disimpan meliputi:
- `VERIF`: Sukses register, sukses link ke daemon, dan sukses kirim email verifikasi.
- `success`: Sukses register, namun gagal saat verifikasi daemon / email.
- `failed`: Pendaftaran gagal sejak awal.
