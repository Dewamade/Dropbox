# Dashboard UI Pendaftaran Massal Dropbox

Dashboard web untuk mengotomatisasi pendaftaran massal akun Dropbox: monitoring progress visual, console log real-time, rotasi IP keluar (Direct, **WARP**, Psiphon, Socks5), dan integrasi otomatis dengan Dropbox Daemon resmi untuk menautkan perangkat + mengirim email verifikasi.

Browser yang dipakai adalah **[camofox-browser](https://github.com/jo-inc/camofox-browser)** (Camoufox, anti-deteksi) yang di-install **di dalam folder proyek** — tidak ada Playwright, tidak ada biner yang dijalankan dari luar folder proyek. Satu-satunya layanan sistem yang dipakai adalah **docker engine**: daemon Dropbox justru dijalankan **di dalam container `ubuntu:24.04` yang selalu baru** supaya setiap akun melihat perangkat benar-benar baru (state perangkat di tmpfs, lenyap bersama container). Tanpa docker, program fallback menjalankan daemon langsung dari `dropbox-app/` dan menghapus state perangkat tiap run — hasilnya sama, hanya lebih rapuh.

> [!IMPORTANT]
> Proyek ini **khusus Linux x86_64**. Biner Dropbox dan Psiphon yang diunduh bersifat x86_64-only; `setup.sh` akan berhenti jika platform lain.

---

## 🚀 Cara Setup

### Metode A: Setup Otomatis (1 perintah)

**curl:**
```bash
curl -sSL https://raw.githubusercontent.com/Dewamade/Dropbox/webui3/setup.sh | bash
```

**wget:**
```bash
wget -qO- https://raw.githubusercontent.com/Dewamade/Dropbox/webui3/setup.sh | bash
```

Setelah selesai, masuk ke direktori proyek:
```bash
cd Dropbox
```

Script `setup.sh` memasang semuanya di dalam folder ini:

|Folder|Isi|
|---|---|
|`camofox-browser/`|Server REST camofox-browser (git clone) + Camoufox di `camofox-browser/.camoufox/`|
|`camofox-plugins/`|Plugin camofox buatan sendiri (ter-track git). `screen/` mengunci ukuran layar browser 1360x768 (Xvfb + angka window/screen Camoufox); `locale/` memaksa bahasa browser (default `en-US`, override lewat env `BROWSER_LOCALE=…`, `off` untuk melepas) supaya dropbox.com selalu melayani teks English — bukan `?lang=en`, karena halaman `cli_link` yang dicetak daemon ikut bahasa sesi. `setup.sh` menyalin SEMUA folder di sini ke `camofox-browser/plugins/` dan mengaktifkannya di `camofox-browser/camofox.config.json`|
|`warp/`|warp-go (source + binary `warp` + `reg.json` hasil registrasi)|
|`psiphon/`|`psiphon-tunnel-core-x86_64` + `psiphon.config` per region (dibuat saat runtime)|
|`dropbox-app/`|Daemon Dropbox resmi (`.dropbox-dist/dropboxd`). Normalnya **tidak dijalankan di host**: hanya `.dropbox-dist/` di-mount (read-only) ke container `ubuntu:24.04` yang selalu baru, jadi state perangkat (`.dropbox/`) + folder sync hidup di tmpfs dan ikut hilang bersama container — satu akun = satu identitas perangkat. Tanpa docker, daemon dijalankan langsung dari folder ini dan state `.dropbox/` dihapus otomatis setiap akun (kalau tidak, daemon tidak pernah memberi URL `cli_link` lagi)|
|`camofox-data/`|Profil/cookie browser per akun (dibuat saat runtime)|

Jika host tidak punya Go, `setup.sh` mengunduh toolchain Go resmi ke `.toolchain/` untuk membangun warp-go. Paket sistem untuk Camoufox/Xvfb/noVNC dipasang otomatis bila dijalankan sebagai root; kalau tidak, daftarnya dicetak.

### Metode B: Setup Manual

1. Dependensi dashboard: `npm install`
2. camofox-browser + Camoufox (masuk ke folder proyek, jangan ke `~/.cache`):
   ```bash
   git clone --depth 1 https://github.com/jo-inc/camofox-browser camofox-browser
   export CAMOUFOX_INSTALL_DIR="$(pwd)/camofox-browser/.camoufox"
   (cd camofox-browser && npm install --omit=dev)
   ```
3. warp-go (dipakai untuk exit IP Cloudflare WARP):
   ```bash
   git clone --depth 1 https://github.com/badafans/warp-go warp
   (cd warp && go build -o warp .)
   ```
4. Psiphon: unduh `psiphon-tunnel-core-x86_64` ke `psiphon/`.
5. Daemon Dropbox:
   ```bash
   wget -O - "https://www.dropbox.com/download?plat=lnx.x86_64" | tar -C dropbox-app -xzf -
   docker pull ubuntu:24.04   # opsional; tanpa docker daemon dijalankan langsung (mode fallback)
   ```
6. Plugin camofox buatan sendiri (yang dilakukan `setup.sh` di langkah 4 — semua plugin di `camofox-plugins/`):
   ```bash
   for d in camofox-plugins/*/; do p=$(basename "$d")
     mkdir -p camofox-browser/plugins/$p
     cp -r "$d." camofox-browser/plugins/$p/
     node -e 'const fs=require("fs"),p="camofox-browser/camofox.config.json";const c=JSON.parse(fs.readFileSync(p));c.plugins=c.plugins||{};c.plugins[process.argv[1]]=Object.assign({},c.plugins[process.argv[1]],{enabled:true});fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' "$p"
   done
   ```

---

## 🔑 Registrasi WARP (sekali per mesin)

```bash
./warp/warp -reg      # membuat warp/reg.json
```

Tombol **🔄 WARP** di tab Pengaturan mengganti kunci WARP (reg.json baru) sehingga exit IP ikut berubah; **🔄 Psiphon** restart tunnel + ganti negara. Panel **Status Mesin Lokal** menampilkan kondisi warp-go / psiphon / camofox / dropboxd beserta exit IP masing-masing.

---

## 🏃‍♂️ Cara Menjalankan Aplikasi

```bash
node server.js         # dashboard http://localhost:3000
node register.js       # mode CLI interaktif (alternatif)
```

Isi URL referral Dropbox, daftar email (pisahkan dengan `;`) atau aktifkan mode otomatis, pilih jalur koneksi, lalu klik **Mulai Pendaftaran**.

- **Mode browser terlihat** (untuk menyelesaikan CAPTCHA manual): centang **Tampilkan Browser** di Pengaturan, lalu buka noVNC di `http://localhost:6082`. Layar browser dikunci 1360x768 (halaman 1360x712 setelah UI Firefox), jadi tampilan noVNC sama di mesin mana pun.
- Port tetap: `3000` dashboard, `9379` camofox, `40000` WARP SOCKS5, `3080` Psiphon SOCKS, `5902`/`6082` VNC/noVNC.

---

## 📂 Informasi Berkas Penting

* [server.js](server.js): Backend server Express & WebSocket (batch, rotasi fase IP, status worker).
* [register.js](register.js): Skrip inti otomasi pendaftaran (mengemudi camofox lewat REST).
* [camofox-manager.js](camofox-manager.js): Menghidupkan/menghentikan `camofox-browser/server.js` lokal.
* [camofox-client.js](camofox-client.js): Klien REST untuk sesi browser (tab, evaluate, klik/isi form).
* [proxy-manager.js](proxy-manager.js): Siklus hidup warp-go + psiphon dan pengecekan IP keluar.
* [db.js](db.js): Penyimpanan `history.json` (riwayat, pengaturan, selector).
* [selector.json](selector.json): Katalog selector form Dropbox + batas waktu tiap langkah.
* [setup.sh](setup.sh): Script penyiapan lingkungan (memasang semua biner di folder ini).
* [.gitignore](.gitignore): Yang diabaikan Git — `node_modules/`, `camofox-browser/`, `camofox-data/`, `warp/`, `psiphon/`, `dropbox-app/`, `.toolchain/`, `data/`, `history.json`, `selector.json`.
