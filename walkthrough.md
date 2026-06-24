# Panduan Lengkap Dropbox CLI (Dockerized & Headless Optimized)

Aplikasi ini adalah bot pendaftaran akun Dropbox dan penghubung perangkat daemon (`dropboxd`) otomatis berbasis **Playwright** yang dirancang untuk berjalan di lingkungan **Docker Linux (VPS)** maupun **Windows lokal**.

---

## 🚀 Fitur Utama & Pembaruan
1. **Alur Deteksi & Login Otomatis (Login Fallback)**:
   - Jika mendeteksi email pendaftaran sudah terdaftar, skrip otomatis mengalihkan alur untuk masuk (log in) menggunakan kredensial pendaftaran yang diberikan.
2. **Penyederhanaan Tautan CLI Link**:
   - URL verifikasi `cli_link` dibuka langsung pada tab/halaman aktif (`page`) saat ini (mensimulasikan aksi copy-paste) tanpa membuka tab baru yang berlebih.
   - Skrip fokus mendeteksi tombol **Connect** secara langsung pada halaman tersebut hingga batas waktu (timeout) tercapai.
3. **Restorasi Verifikasi Email & Modal Konfirmasi**:
   - Setelah sukses terhubung, skrip menavigasi ke halaman `/account`.
   - Menunggu tombol "Verify email" / "Verifikasi email" muncul (timeout 60 detik), mengkliknya, lalu menunggu modal terbuka untuk mengklik tombol konfirmasi **"Send email"** / **"Kirim email"** (mendukung multibahasa).
4. **Optimasi Mode Headless (Anti-Detection)**:
   - Jika berjalan dalam mode `headless: true`, skrip menggunakan `--headless=new` (mode headless terbaru Chrome yang identik dengan grafis penuh) dan menetapkan `--window-size=1280,720` untuk melewati sensor deteksi bot Cloudflare/Akamai.
5. **Dukungan Lintas Platform (Windows & Docker Linux)**:
   - Di Windows, menggunakan instalasi Google Chrome Resmi lokal (`channel: 'chrome'`).
   - Di Docker Linux, menggunakan Google Chrome Desktop resmi `/usr/bin/google-chrome`.
6. **Injeksi Parameter Lokalisasi & Zona Waktu**:
   - Skrip secara eksplisit menginjeksikan `locale: 'en-US'` dan `timezoneId: 'America/New_York'` pada pengaturan browser context. Ini mereplikasi behavior browser desktop normal dan meniadakan indikasi ketidaksesuaian/inkonsistensi profile di server VPS (yang secara default tidak memiliki zona waktu atau bermarkas di luar target pasar), sehingga secara signifikan mengurangi kemunculan CAPTCHA pendaftaran.
7. **Restorasi Profil Persisten & Script Evasion (Penyamaran)**:
   - Skrip dikembalikan untuk menggunakan satu folder profil persisten bersama (`./data/firefox-profile`). Cache browser, data startup, sertifikat SSL, dan status profil tetap dipertahankan antar-sesi pendaftaran (hanya membersihkan data sensitif seperti cookies/locks menggunakan fungsi `clearProfileData` di awal siklus). Ini mereplikasi 'warmed-up profile' yang meningkatkan kepercayaan anti-bot.
   - Menyisipkan kembali script penyamaran `addInitScript` untuk menyembunyikan properti `navigator.webdriver`, memalsukan list plugins tiruan, dan me-override izin notifikasi API.
8. **Rotasi User Agent per Launch & Fallback**:
   - Skrip memutar User Agent pada setiap peluncuran browser (termasuk pada percobaan ulang/retry untuk email yang sama).
   - Menyediakan fallback pemilihan User Agent secara otomatis di dalam `registerSingleEmail` jika tidak ada User Agent yang diberikan oleh pemanggil.

---

## 🛠️ Cara Deploy & Menggunakan di VPS (Docker)

### 1. Persiapan File
Pastikan Anda telah menaruh file kompresi Dropbox dengan nama **`dropbox.tar.gz`** ke dalam sub-direktori `app/` sebelum melakukan proses build. 
```text
Dropbox/
├── app/
│   └── dropbox.tar.gz
```

### 2. Membangun (Build) Docker Image di VPS
Masuk ke direktori root proyek di VPS Anda, lalu jalankan perintah:
```bash
docker compose build --no-cache
```
*Proses ini memakan waktu beberapa menit karena mengunduh node dependencies serta menginstal browser Google Chrome Desktop resmi beserta dependensi grafis Linux.*

### 3. Menjalankan Bot via Docker CLI (`run.sh`)
Gunakan berkas pembantu `run.sh` untuk menjalankan bot di dalam container:

**Contoh: Mode Auto-Generate (10 Akun otomatis)**
```bash
./run.sh --alias "VPS-Worker-Auto" --url "https://www.dropbox.com/register" --source auto --domain "kywa.uk" --count 10 --timeout 120 --retry 3 --devices "desktop"
```

**Contoh: Mode Manual Input dengan Proxy SOCKS5**
```bash
./run.sh --alias "VPS-Worker-Manual" --source manual --emails "satu@kywa.uk; dua@kywa.uk" --browser chrome --proxy "socks5://192.168.1.1:1080"
```

**Contoh: Mode Password Tetap**
```bash
./run.sh --alias "VPS-Fixed" --source auto --domain "kywa.uk" --count 5 --password-mode "fixed" --fixed-password "SuperRahasia123!"
```

---

## 💻 Cara Menjalankan di Lokal Windows (Pengecekan Alur)

Untuk melakukan pengetesan alur UI secara langsung di Windows:
1. Instal dependensi:
   ```bash
   npm install
   npx playwright install chromium chrome
   ```
2. Jalankan perintah (menggunakan browser Chrome non-headless agar visual terlihat):
   ```bash
   node register.js --emails="email_anda@domain.com" --password-mode="fixed" --fixed-password="PasswordAnda" --browser=chrome --headless=false
   ```
*Catatan: Saat dijalankan langsung di Windows, daemon `dropboxd` (yang merupakan binary Linux) tidak akan berhasil berjalan, tetapi alur login/signup di browser Chrome akan berjalan 100% secara otomatis hingga halaman verifikasi dan pengiriman email verifikasi.*

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
| `--browser` | Engine browser yang digunakan | `firefox` | `--browser="firefox"` atau `"chrome"` atau `"chromium"` |
| `--headless` | Menjalankan browser tanpa UI grafis | `true` | `--headless=false` |
| `--proxy` | Meneruskan koneksi bot via server proxy | `""` | `--proxy="socks5://192.168.1.1:1080"` |

---

## 📊 Melihat Riwayat Registrasi
Setiap akun yang diproses akan tercatat ke dalam berkas JSON riwayat di:
* `./data/history.json`

Format status yang disimpan meliputi:
- `VERIF`: Sukses register, sukses link ke daemon, dan sukses kirim email verifikasi.
- `success`: Sukses register, namun gagal saat verifikasi daemon / email.
- `failed`: Pendaftaran gagal sejak awal.
