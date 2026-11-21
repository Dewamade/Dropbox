#!/bin/bash

# ==============================================================================
# Setup Script - Dashboard UI Pendaftaran Massal Dropbox (camofox + warp-go)
# Branch: webui4
#
# Semua biner dipasang DI DALAM folder proyek ini, tidak ada biner di luar:
#   camofox-browser/   server REST camofox-browser + Camoufox di .camoufox/
#   camofox-data/      profil/cookie per akun (dibuat saat runtime)
#   warp/              warp-go (source + binary 'warp' + reg.json)
#   psiphon/           psiphon-tunnel-core-x86_64 + psiphon.config per region
#   dropbox-app/       daemon Dropbox resmi (.dropbox-dist/dropboxd)
#
# Satu-satunya biner di luar folder proyek adalah docker engine (service sistem):
# daemon Dropbox justru dijalankan DI DALAM container ubuntu:24.04 supaya setiap akun
# melihat perangkat yang benar-benar baru. Tanpa docker, register.js fallback ke
# eksekusi langsung dari dropbox-app/ dan menghapus state perangkat tiap run.
# ==============================================================================

# Warna untuk output terminal
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Proyek ini x86_64 Linux only (daemon Dropbox + psiphon yang diunduh x86_64-only).
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
    echo -e "${RED}Error: setup ini hanya untuk Linux x86_64 (deteksi: $(uname -s) $(uname -m)).${NC}"
    exit 1
fi

echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN}   Setup Dashboard Pendaftaran Massal Dropbox (camofox / warp-go)      ${NC}"
echo -e "${GREEN}======================================================================${NC}"

REPO_URL="https://github.com/Dewamade/Dropbox.git"
BRANCH="webui4"
CAMOFOX_REPO="https://github.com/jo-inc/camofox-browser"
WARP_REPO="https://github.com/badafans/warp-go"
PSIPHON_URL="https://github.com/Psiphon-Labs/psiphon-tunnel-core-binaries/raw/master/linux/psiphon-tunnel-core-x86_64"
DOCKER_IMAGE="ubuntu:24.04"   # image tempat daemon Dropbox berjalan (lihat langkah 8)

# Unduh image daemon sekali, di langkah 8 — docker.io sudah terpasang di langkah 2,
# jadi tidak perlu dipanggil dua kali lagi. Idempotent.
prepare_daemon_image() {
    if ! command -v docker >/dev/null 2>&1 || ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
        return 1
    fi
    if docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
        echo -e "Image container daemon (${DOCKER_IMAGE}) sudah ada."
        return 0
    fi
    echo -e "Mengunduh image container daemon ${DOCKER_IMAGE}..."
    if docker pull "$DOCKER_IMAGE" >/dev/null 2>&1; then
        echo -e "${GREEN}Image ${DOCKER_IMAGE} terunduh.${NC}"
        return 0
    fi
    echo -e "${YELLOW}Peringatan: docker pull gagal — daemon akan mengunduhnya saat run pertama (butuh internet).${NC}"
    return 1
}

# Biner Camoufox dikenali dari launcher 'camoufox-bin' di dalam .camoufox. Menguji
# direktori .camoufox/browser saja TIDAK cukup: unduhan yang terpotong di tengah juga
# meninggalkan direktori itu, lalu semuanya gagal saat tab pertama dibuat. Kedua letak
# yang diketahui (root .camoufox/ dan browser/) diterima karena nama folder ini adalah
# internals camoufox-js, bukan API.
camoufox_lengkap() {
    local dir="${1:-$(pwd)/camofox-browser/.camoufox}"
    [ -x "$dir/camoufox-bin" ] || [ -x "$dir/browser/camoufox-bin" ]
}

# 1. Deteksi Lingkungan
echo -e "\n${GREEN}[1/9] Memeriksa lingkungan sistem...${NC}"

echo -e "Sistem: $(uname -s) $(uname -m)"

# Node.js & NPM. ./camofox-browser mensyaratkan Node 22+ (engines.node). Angka di
# sini hanya pemeriksaan kasar supaya mesin dengan Node 16 tidak memasang setengah
# proyek dulu; syarat yang sebenarnya dibaca dari package.json hasil clone di
# langkah 5, jadi kalau upstream menaikkan versinya setup ini tetap jujur.
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: Node.js/NPM belum terinstal. Instal Node.js 22+ lebih dahulu.${NC}"
    exit 1
fi
MIN_NODE=22
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
case "$NODE_MAJOR" in '' | *[!0-9]*) NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
    echo -e "${RED}Error: Node.js $(node -v) terlalu lama — camofox-browser butuh Node >= ${MIN_NODE}.${NC}"
    echo -e "${YELLOW}Instal Node 22+ dulu (mis. 'nvm install 22 && nvm use 22'), lalu ulangi setup ini.${NC}"
    exit 1
fi
echo -e "Node.js: $(node -v), NPM: $(npm -v)"

# Bagian yang gagal dipasang. Yang WAJIB (npm proyek, camofox + Camoufox) langsung
# keluar — tanpa itu tidak ada yang bisa dijalankan. Sisanya (warp, psiphon, daemon
# Dropbox) dicatat dan dilaporkan di langkah 9 dengan exit code bukan nol, supaya
# "Setup Berhasil Selesai" tidak pernah tercetak padahal ada yang kurang.
GAGAL=()
catatan_gagal() { GAGAL+=("$1"); echo -e "${YELLOW}Dilewati — dicatat di ringkasan:${NC} $1"; }

# 2. Dependensi sistem (Camoufox butuh pustaka Firefox; mode terlihat butuh
#    Xvfb/x11vnc/noVNC; build warp-go + kompilasi better-sqlite3 butuh toolchain).
#    SENGAJA dijalankan SEBELUM npm install dan download: camofox-browser punya
#    runtime-dependency 'better-sqlite3' yang DIKOMPILASI saat npm install
#    (butuh build-essential + python3 + g++), dan langkah 5-8 memakai git/curl/wget.
#    Kalau langkah ini ditaruh di akhir, mesin bersih gagal di npm install lebih
#    dulu dan tidak pernah sampai ke apt.
echo -e "\n${GREEN}[2/9] Memeriksa dependensi sistem (Camoufox, Xvfb, noVNC, build tools)...${NC}"
SYSDEPS="git procps libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 \
libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
libegl1 libgl1-mesa-dri libgbm1 xvfb x11vnc novnc websockify \
fonts-liberation fonts-noto-color-emoji fontconfig ca-certificates curl wget unzip \
build-essential python3 docker.io"
if [ -f /etc/debian_version ] || [ -f /etc/lsb-release ]; then
    if [ "$EUID" -eq 0 ]; then
        apt-get update
        # apt membatalkan SELURUH transaksi kalau satu nama tidak ada; di beberapa
        # rilis Debian/Ubuntu nama lama berubah (t64), jadi coba lagi dengan nama itu
        # sebelum menyerah.
        if apt-get install -y $SYSDEPS || apt-get install -y $(echo "$SYSDEPS" | sed 's/\blibxt6\b/libxt6t64/; s/\blibasound2\b/libasound2t64/'); then
            echo -e "${GREEN}Dependensi sistem terpasang (termasuk docker.io — image daemon disiapkan di langkah 8).${NC}"
        else
            echo -e "${YELLOW}Peringatan: apt install gagal — lanjut dengan paket yang sudah ada di mesin ini.${NC}"
        fi
    else
        echo -e "${YELLOW}Bukan root — jika Camoufox gagal start atau better-sqlite3 gagal dikompilasi, jalankan:${NC}"
        echo -e "sudo apt update && sudo apt install -y $SYSDEPS"
    fi
else
    echo -e "${YELLOW}Bukan Debian/Ubuntu — pastikan paket untuk Firefox/Xvfb/noVNC, git, curl/wget, unzip, dan build-essential+python3 (kompilasi better-sqlite3) sudah ada.${NC}"
fi

# 3. Status Repositori
echo -e "\n${GREEN}[3/9] Memeriksa status repositori Git...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: Git belum terinstal (lihat langkah 2). Tanpa git camofox-browser dan warp-go tidak bisa dipasang.${NC}"
    exit 1
fi
echo -e "Git terdeteksi: $(git --version)"

IN_REPO=false
if [ -d .git ]; then
    REMOTE_URL=$(git remote get-url origin 2>/dev/null)
    if [[ "$REMOTE_URL" == *"Dropbox"* ]]; then
        IN_REPO=true
    fi
fi

if [ "$IN_REPO" = true ]; then
    echo -e "${YELLOW}Anda sudah berada di dalam repositori Dropbox.${NC}"
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
    if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
        echo -e "Berpindah ke branch ${BRANCH}..."
        # Kode lama = behaviour lama; lebih baik berhenti daripada diam-diam memasang
        # biner untuk branch yang salah.
        git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || {
            echo -e "${RED}Error: pindah ke branch ${BRANCH} gagal (working tree kotor?). Simpan/discard perubahan Anda, lalu ulangi.${NC}"
            exit 1
        }
        echo -e "Branch sekarang: $(git branch --show-current)"
    else
        echo -e "Sudah berada di branch ${BRANCH}."
    fi
elif [ -f "server.js" ] && [ -f "package.json" ]; then
    echo -e "${YELLOW}Berkas proyek terdeteksi di direktori ini; melewati clone.${NC}"
else
    echo -e "Mengkloning repositori Dropbox branch '${BRANCH}' (shallow clone)..."
    git clone --depth 1 -b "$BRANCH" "$REPO_URL"
    cd Dropbox || exit 1
fi

# Direktori tujuan instalasi biner selalu ada, meskipun clone baru
mkdir -p camofox-browser warp psiphon dropbox-app

# 4. Dependensi NPM Proyek
echo -e "\n${GREEN}[4/9] Menginstal dependensi NPM proyek...${NC}"
if ! npm install; then
    echo -e "${RED}Error: Gagal menginstal dependensi NPM.${NC}"
    exit 1
fi
echo -e "${GREEN}Dependensi NPM proyek terpasang (express, ws, socks-proxy-agent).${NC}"

# 5. camofox-browser + Camoufox (browser anti-detect, dipakai sebagai pengganti
#    Playwright Firefox) — dipasang di ./camofox-browser
echo -e "\n${GREEN}[5/9] Memasang camofox-browser + Camoufox di ./camofox-browser...${NC}"

if [ ! -f "camofox-browser/server.js" ]; then
    if [ -n "$(ls -A camofox-browser 2>/dev/null)" ]; then
        echo -e "${RED}Error: folder camofox-browser terisi tapi bukan camofox-browser (tidak ada server.js).${NC}"
        exit 1
    fi
    echo -e "Mengkloning ${CAMOFOX_REPO}..."
    git clone --depth 1 "$CAMOFOX_REPO" camofox-browser || {
        echo -e "${RED}Error: mengkloning camofox-browser gagal (butuh internet).${NC}"
        exit 1
    }
fi

if [ -f "camofox-browser/package.json" ]; then
    # Syarat versi dibaca dari clone, bukan dari angka yang hardcoded di langkah 1:
    # kalau upstream menaikkan engines.node, setup ini berhenti dengan pesan yang
    # jelas, bukan menyerah di runtime dengan error server REST yang aneh.
    BUTA_NODE=$(cd camofox-browser && node -e 'const e=require("./package.json").engines||{};const m=/(\d+)/.exec(e.node||"");console.log(m?m[1]:0)' 2>/dev/null)
    VERSI_CAMOFOX=$(cd camofox-browser && node -p 'require("./package.json").version' 2>/dev/null)
    if [ "${NODE_MAJOR:-0}" -lt "${BUTA_NODE:-0}" ]; then
        echo -e "${RED}Error: camofox-browser v${VERSI_CAMOFOX} butuh Node >= ${BUTA_NODE} (engines.node di package.json-nya), sekarang $(node -v).${NC}"
        echo -e "${YELLOW}Instal Node ${BUTA_NODE}+ (mis. 'nvm install ${BUTA_NODE} && nvm use ${BUTA_NODE}'), lalu ulangi setup ini.${NC}"
        exit 1
    fi
    # Camoufox diunduh ke dalam folder proyek, bukan ke ~/.cache
    export CAMOUFOX_INSTALL_DIR="$(pwd)/camofox-browser/.camoufox"
    # --omit=dev: server REST hanya butuh deps runtime (sama seperti Dockerfile
    # upstream). Dev-dep 'openclaw' menolak Node < 24.16 dan menggagalkan install.
    # Di sana ada 'better-sqlite3' yang dikompilasi — karena itu langkah 2 dulu.
    (cd camofox-browser && npm install --omit=dev) || {
        echo -e "${RED}Error: npm install di camofox-browser gagal (butuh internet + build-essential/python3, lihat langkah 2).${NC}"
        exit 1
    }
    if ! camoufox_lengkap "$CAMOUFOX_INSTALL_DIR"; then
        echo -e "postinstall tidak mengunduh Camoufox — menjalankan fetch manual..."
        (cd camofox-browser && npm run fetch-bin)
    fi
    if camoufox_lengkap "$CAMOUFOX_INSTALL_DIR"; then
        echo -e "${GREEN}camofox-browser + Camoufox siap di ./camofox-browser (.camoufox/).${NC}"
    else
        # Tanpa biner Camoufox tidak ada satu pun pendaftaran yang bisa jalan.
        echo -e "${RED}Error: biner Camoufox belum ada (camofox-browser/.camoufox/camoufox-bin). Ulangi: (cd camofox-browser && CAMOUFOX_INSTALL_DIR=$(pwd)/camofox-browser/.camoufox npm run fetch-bin)${NC}"
        exit 1
    fi
else
    echo -e "${RED}Error: kloning camofox-browser gagal.${NC}"
    exit 1
fi

# Plugin kami (sumbernya di camofox-plugins/, ter-track git) dipasang ke kloning
# camofox-browser/ + diaktifkan di camofox.config.json-nya. 'screen' mengunci
# ukuran layar 1360x768, 'locale' memaksa bahasa browser (en-US) supaya teks
# halaman deterministik. camofox-browser/ di-gitignore, jadi pemasangan ini
# bagian dari setup.
if [ -d "camofox-plugins" ] && [ -f "camofox-browser/server.js" ]; then
    for plugin_dir in camofox-plugins/*/; do
        plugin="$(basename "$plugin_dir")"
        mkdir -p "camofox-browser/plugins/$plugin"
        cp -r "$plugin_dir." "camofox-browser/plugins/$plugin/"
        node -e '
const fs = require("fs");
const p = "camofox-browser/camofox.config.json";
const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
cfg.plugins = cfg.plugins || {};
cfg.plugins[process.argv[1]] = Object.assign({}, cfg.plugins[process.argv[1]], { enabled: true });
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$plugin" || {
            echo -e "${RED}Error: mengaktifkan plugin $plugin di camofox.config.json gagal.${NC}"
            exit 1
        }
        echo -e "${GREEN}Plugin '$plugin' terpasang di camofox-browser.${NC}"
    done
fi

# 6. warp-go (Cloudflare WARP rootless, SOCKS5 127.0.0.1:40000)
echo -e "\n${GREEN}[6/9] Memasang warp-go di ./warp...${NC}"

if [ -x "warp/warp" ]; then
    echo -e "Binary warp sudah ada: ./warp/warp"
else
    if [ ! -f "warp/main.go" ]; then
        echo -e "Mengkloning ${WARP_REPO}..."
        git clone --depth 1 "$WARP_REPO" warp
    fi
    if [ -f "warp/main.go" ]; then
        GO_BIN=""
        if command -v go &> /dev/null; then
            GO_BIN="$(command -v go)"
        elif [ -x ".toolchain/go/bin/go" ]; then
            GO_BIN="$(pwd)/.toolchain/go/bin/go"
        else
            echo -e "Toolchain Go tidak ditemukan — mengunduh Go resmi ke ./.toolchain..."
            GOVER=$(curl -sL "https://go.dev/VERSION?m=text" | head -1)
            if [ -n "$GOVER" ]; then
                mkdir -p .toolchain
                echo -e "Mengunduh ${GOVER}.linux-amd64.tar.gz ..."
                curl -sL -o .toolchain/go.tgz "https://go.dev/dl/${GOVER}.linux-amd64.tar.gz"
                tar -C .toolchain -xzf .toolchain/go.tgz && rm -f .toolchain/go.tgz
            fi
            [ -x ".toolchain/go/bin/go" ] && GO_BIN="$(pwd)/.toolchain/go/bin/go"
        fi
        if [ -x "$GO_BIN" ]; then
            (cd warp && "$GO_BIN" build -o warp .) && chmod +x warp/warp
        else
            echo -e "${YELLOW}Go tidak tersedia dan unduhan ./.toolchain gagal — build warp dilewati.${NC}"
        fi
    fi
    if [ -x "warp/warp" ]; then
        echo -e "${GREEN}warp-go terpasang: ./warp/warp${NC}"
        echo -e "${YELLOW}Registrasi pertama kali (sekali per mesin): ./warp/warp -reg${NC}"
    else
        # Bukan fatal: batch Direct / Psiphon tetap jalan. WARP tinggal diurus nanti.
        catatan_gagal "warp-go tidak terbuild — jalur keluar WARP belum bisa dipakai. Instal Go ('sudo apt install -y golang-go') lalu jalankan setup ini lagi."
    fi
fi

# 7. Psiphon (fallback exit) — binary x86_64 di ./psiphon
echo -e "\n${GREEN}[7/9] Memasang psiphon-tunnel-core di ./psiphon...${NC}"
if [ -f "psiphon/psiphon-tunnel-core-x86_64" ]; then
    echo -e "Psiphon binary sudah ada."
else
    echo -e "Mengunduh Psiphon binary..."
    wget -O psiphon/psiphon-tunnel-core-x86_64 "$PSIPHON_URL" \
        || curl -sL -o psiphon/psiphon-tunnel-core-x86_64 "$PSIPHON_URL"
    if [ -s psiphon/psiphon-tunnel-core-x86_64 ]; then
        chmod +x psiphon/psiphon-tunnel-core-x86_64
        echo -e "${GREEN}Psiphon binary terpasang.${NC}"
    else
        rm -f psiphon/psiphon-tunnel-core-x86_64
        catatan_gagal "biner psiphon-tunnel-core belum terunduh — jalur keluar Psiphon belum bisa dipakai (Direct/WARP tetap jalan)."
    fi
fi
if [ -f "psiphon.config" ]; then
    echo -e "Template psiphon.config ditemukan (config per region ditulis ke ./psiphon/ saat runtime)."
else
    catatan_gagal "psiphon.config tidak ada di folder proyek — Berkas itu ter-track git, jadi clone/checkout tidak lengkap; fase Psiphon tidak akan jalan."
fi

# 8. Daemon Dropbox resmi (dipakai untuk menautkan perangkat + kirim email verifikasi)
#    Biner di ./dropbox-app, tapi normalnya dijalankan DI DALAM container docker yang
#    selalu baru: hanya .dropbox-dist yang di-mount (ro), state (.dropbox/) + folder
#    sync di tmpfs, hostname + machine-id acak -> Dropbox melihat perangkat baru setiap
#    kali, jadi URL cli_link selalu muncul. Tanpa docker, register.js fallback ke
#    eksekusi langsung dan menghapus state lama di ./dropbox-app untuk efek yang sama.
echo -e "\n${GREEN}[8/9] Memasang daemon Dropbox di ./dropbox-app...${NC}"
if [ -d "dropbox-app/.dropbox-dist" ]; then
    echo -e "Daemon Dropbox sudah ada."
else
    echo -e "Mengunduh dan mengekstrak Dropbox daemon..."
    DROPBOX_TGZ="dropbox-app/.dropbox-download.tgz"
    rm -f "$DROPBOX_TGZ"
    if wget -O "$DROPBOX_TGZ" "https://www.dropbox.com/download?plat=lnx.x86_64" \
        || curl -sL -o "$DROPBOX_TGZ" "https://www.dropbox.com/download?plat=lnx.x86_64"; then
        tar -C dropbox-app -xzf "$DROPBOX_TGZ"
    fi
    rm -f "$DROPBOX_TGZ"
    if [ -f "dropbox-app/.dropbox-dist/dropboxd" ]; then
        echo -e "${GREEN}Daemon Dropbox terpasang di ./dropbox-app/.dropbox-dist.${NC}"
    else
        # Tanpa daemon tidak ada device linking / email verifikasi -> semua run
        # berhenti sebagai VERIF. Bukan fatal: setup yang lain tetap terpakai.
        catatan_gagal "daemon Dropbox belum terunduh/terekstrak (./dropbox-app/.dropbox-dist/dropboxd) — device linking + email verifikasi tidak akan jalan. Jalankan setup ini lagi (butuh internet)."
    fi
fi

if prepare_daemon_image; then
    echo -e "Docker terdeteksi — daemon akan dijalankan di container ${DOCKER_IMAGE} (perangkat baru setiap run)."
else
    echo -e "${YELLOW}Docker tidak tersedia/tidak jalan — daemon Dropbox akan dijalankan langsung dari ./dropbox-app (state perangkat dihapus tiap run).${NC}"
    echo -e "Untuk mode container: pasang docker (paket docker.io, lihat langkah 2) dan pastikan user ada di grup docker."
fi

# 9. Ringkasan — daftar periksa nyata terhadap isi folder.
#    Ini bagian yang menjawab "apakah deployment di mesin ini benar-benar jalan?":
#    setiap baris dibaca dari filesystem, bukan dari keberhasilan langkah di atas,
#    jadi hasil setup yang parsial (tanpa internet / tanpa root / tanpa docker)
#    terlihat jelas dan tidak disamarkan oleh "Setup Berhasil".
echo -e "\n${GREEN}[9/9] Ringkasan hasil instalasi...${NC}"
periksa() {
    if eval "$2" >/dev/null 2>&1; then
        echo -e "  ${GREEN}v${NC} $1"
    else
        echo -e "  ${RED}x${NC} $1"
    fi
}
periksa "biner Camoufox (./camofox-browser/.camoufox/camoufox-bin)" "camoufox_lengkap"
periksa "server REST camofox + plugin kami aktif (screen, locale)" "[ -f camofox-browser/server.js ] && [ -f camofox-browser/plugins/screen/index.js ] && [ -f camofox-browser/plugins/locale/index.js ]"
periksa "GeoIP DB Camoufox (kalau x: diunduh sendiri saat start, tidak fatal)" "[ -s camofox-browser/.camoufox/GeoLite2-City.mmdb ]"
periksa "warp-go (./warp/warp)" "[ -x warp/warp ]"
periksa "WARP terdaftar (./warp/reg.json); kalau x jalankan './warp/warp -reg' sekali" "[ -f warp/reg.json ]"
periksa "psiphon-tunnel-core + psiphon.config" "[ -x psiphon/psiphon-tunnel-core-x86_64 ] && [ -f psiphon.config ]"
periksa "daemon Dropbox (./dropbox-app/.dropbox-dist/dropboxd)" "[ -f dropbox-app/.dropbox-dist/dropboxd ]"
periksa "image container ${DOCKER_IMAGE} (opsional)" "docker image inspect ${DOCKER_IMAGE}"
echo -e "Waktu: $(date)"

if [ ${#GAGAL[@]} -gt 0 ]; then
    echo -e "\n${RED}======================================================================${NC}"
    echo -e "${RED}               Setup SELESAI dengan catatan — perbaiki ini:              ${NC}"
    echo -e "${RED}======================================================================${NC}"
    for g in "${GAGAL[@]}"; do
        echo -e "  ${RED}-${NC} $g"
    done
    echo -e "Jalankan ./setup.sh lagi setelah itu; langkah yang sudah beres dilewati."
    echo -e "Tanpa itu, dashboard tetap jalan untuk jalur keluar yang tersedia (lihat daftar periksa di atas)."
    exit 1
fi

echo -e "\n${GREEN}======================================================================${NC}"
echo -e "${GREEN}                      Setup Berhasil Selesai!                         ${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "Langkah berikutnya:"
echo -e "  1) Registrasi WARP sekali saja:  ${YELLOW}./warp/warp -reg${NC}"
echo -e "  2) Jalankan dashboard:          ${YELLOW}node server.js${NC}"
echo -e "  3) Buka:                        ${YELLOW}http://localhost:3000${NC}"
echo -e "Biner: camofox-browser/ (Camoufox di .camoufox/), warp/, psiphon/, dropbox-app/ — semua di folder ini."
echo -e "Daemon Dropbox: container ${DOCKER_IMAGE} baru setiap akun (state di tmpfs). Tanpa docker = mode langsung + state dihapus tiap run."
echo -e "Mode browser terlihat (CAPTCHA manual): centang 'Tampilkan Browser' di Pengaturan, noVNC di http://localhost:6082"
echo -e "${GREEN}======================================================================${NC}"
