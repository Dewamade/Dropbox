#!/bin/bash

# ==============================================================================
# Setup Script - Dashboard UI Pendaftaran Massal Dropbox (camofox + warp-go)
# Branch: webui3
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
BRANCH="webui3"
CAMOFOX_REPO="https://github.com/jo-inc/camofox-browser"
WARP_REPO="https://github.com/badafans/warp-go"
PSIPHON_URL="https://github.com/Psiphon-Labs/psiphon-tunnel-core-binaries/raw/master/linux/psiphon-tunnel-core-x86_64"
DOCKER_IMAGE="ubuntu:24.04"   # image tempat daemon Dropbox berjalan (lihat langkah 7)

# Unduh image daemon sekali; dipanggil di langkah 7 dan lagi setelah apt di langkah 8
# (untuk mesin yang docker-nya baru saja dipasang). Idempotent.
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

# 1. Deteksi Lingkungan
echo -e "\n${GREEN}[1/8] Memeriksa lingkungan sistem...${NC}"

echo -e "Sistem: $(uname -s) $(uname -m)"

# Git
if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: Git belum terinstal. Silakan instal Git terlebih dahulu.${NC}"
    exit 1
fi
echo -e "Git terdeteksi: $(git --version)"

# Node.js & NPM
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: Node.js/NPM belum terinstal. Silakan instal Node.js terlebih dahulu.${NC}"
    exit 1
fi
echo -e "Node.js: $(node -v), NPM: $(npm -v)"

# 2. Status Repositori
echo -e "\n${GREEN}[2/8] Memeriksa status repositori Git...${NC}"

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
        git checkout "$BRANCH" || git checkout -b "$BRANCH" "origin/$BRANCH"
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

# 3. Dependensi NPM Proyek
echo -e "\n${GREEN}[3/8] Menginstal dependensi NPM proyek...${NC}"
if ! npm install; then
    echo -e "${RED}Error: Gagal menginstal dependensi NPM.${NC}"
    exit 1
fi
echo -e "${GREEN}Dependensi NPM proyek terpasang (express, ws, socks-proxy-agent).${NC}"

# 4. camofox-browser + Camoufox (browser anti-detect, dipakai sebagai pengganti
#    Playwright Firefox) — dipasang di ./camofox-browser
echo -e "\n${GREEN}[4/8] Memasang camofox-browser + Camoufox di ./camofox-browser...${NC}"

if [ ! -f "camofox-browser/server.js" ]; then
    if [ -n "$(ls -A camofox-browser 2>/dev/null)" ]; then
        echo -e "${RED}Error: folder camofox-browser terisi tapi bukan camofox-browser (tidak ada server.js).${NC}"
        exit 1
    fi
    echo -e "Mengkloning ${CAMOFOX_REPO}..."
    git clone --depth 1 "$CAMOFOX_REPO" camofox-browser
fi

if [ -f "camofox-browser/package.json" ]; then
    # Camoufox diunduh ke dalam folder proyek, bukan ke ~/.cache
    export CAMOUFOX_INSTALL_DIR="$(pwd)/camofox-browser/.camoufox"
    # --omit=dev: server REST hanya butuh deps runtime (sama seperti Dockerfile
    # upstream). Dev-dep 'openclaw' menolak Node < 24.16 dan menggagalkan install.
    (cd camofox-browser && npm install --omit=dev) || {
        echo -e "${RED}Error: npm install di camofox-browser gagal.${NC}"
        exit 1
    }
    if [ ! -d "$CAMOUFOX_INSTALL_DIR/browser" ]; then
        echo -e "postinstall tidak mengunduh Camoufox — menjalankan fetch manual..."
        (cd camofox-browser && npm run fetch-bin)
    fi
    if [ -d "$CAMOUFOX_INSTALL_DIR/browser" ]; then
        echo -e "${GREEN}camofox-browser + Camoufox siap di ./camofox-browser (.camoufox/browser).${NC}"
    else
        echo -e "${RED}Error: Camoufox belum terunduh. Ulangi: (cd camofox-browser && npm run fetch-bin)${NC}"
    fi
else
    echo -e "${RED}Error: kloning camofox-browser gagal.${NC}"
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

# 5. warp-go (Cloudflare WARP rootless, SOCKS5 127.0.0.1:40000)
echo -e "\n${GREEN}[5/8] Memasang warp-go di ./warp...${NC}"

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
            GOVER=${GOVER:-go1.26.5}
            mkdir -p .toolchain
            echo -e "Mengunduh ${GOVER}.linux-amd64.tar.gz ..."
            curl -sL -o .toolchain/go.tgz "https://go.dev/dl/${GOVER}.linux-amd64.tar.gz"
            tar -C .toolchain -xzf .toolchain/go.tgz && rm -f .toolchain/go.tgz
            GO_BIN="$(pwd)/.toolchain/go/bin/go"
        fi
        if [ -x "$GO_BIN" ] || [ "$GO_BIN" = "$(command -v go)" ]; then
            (cd warp && "$GO_BIN" build -o warp .) && chmod +x warp/warp
        fi
    fi
    if [ -x "warp/warp" ]; then
        echo -e "${GREEN}warp-go terpasang: ./warp/warp${NC}"
        echo -e "${YELLOW}Registrasi pertama kali (sekali per mesin): ./warp/warp -reg${NC}"
    else
        echo -e "${RED}Error: build warp-go gagal. Instal Go (pkg install golang / apt install golang-go) lalu ulangi.${NC}"
    fi
fi

# 6. Psiphon (fallback exit) — binary x86_64 di ./psiphon
echo -e "\n${GREEN}[6/8] Memasang psiphon-tunnel-core di ./psiphon...${NC}"
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
        echo -e "${RED}Error: gagal mengunduh Psiphon binary.${NC}"
    fi
fi
if [ -f "psiphon.config" ]; then
    echo -e "Template psiphon.config ditemukan (config per region ditulis ke ./psiphon/ saat runtime)."
else
    echo -e "${YELLOW}Peringatan: psiphon.config tidak ditemukan di folder proyek — fase Psiphon tidak akan jalan.${NC}"
fi

# 7. Daemon Dropbox resmi (dipakai untuk menautkan perangkat + kirim email verifikasi)
#    Biner di ./dropbox-app, tapi normalnya dijalankan DI DALAM container docker yang
#    selalu baru: hanya .dropbox-dist yang di-mount (ro), state (.dropbox/) + folder
#    sync di tmpfs, hostname + machine-id acak -> Dropbox melihat perangkat baru setiap
#    kali, jadi URL cli_link selalu muncul. Tanpa docker, register.js fallback ke
#    eksekusi langsung dan menghapus state lama di ./dropbox-app untuk efek yang sama.
echo -e "\n${GREEN}[7/8] Memasang daemon Dropbox di ./dropbox-app...${NC}"
if [ -d "dropbox-app/.dropbox-dist" ]; then
    echo -e "Daemon Dropbox sudah ada."
else
    echo -e "Mengunduh dan mengekstrak Dropbox daemon..."
    wget -O - "https://www.dropbox.com/download?plat=lnx.x86_64" | tar -C dropbox-app -xzf - \
        || curl -sL "https://www.dropbox.com/download?plat=lnx.x86_64" | tar -C dropbox-app -xzf -
    if [ -f "dropbox-app/.dropbox-dist/dropboxd" ]; then
        echo -e "${GREEN}Daemon Dropbox terpasang di ./dropbox-app/.dropbox-dist.${NC}"
    else
        echo -e "${RED}Error: gagal mengunduh/mengekstrak daemon Dropbox.${NC}"
    fi
fi

if prepare_daemon_image; then
    echo -e "Docker terdeteksi — daemon akan dijalankan di container ${DOCKER_IMAGE} (perangkat baru setiap run)."
else
    echo -e "${YELLOW}Docker tidak tersedia/tidak jalan — daemon Dropbox akan dijalankan langsung dari ./dropbox-app (state perangkat dihapus tiap run).${NC}"
    echo -e "Untuk mode container: pasang docker (paket docker.io, lihat langkah 8) dan pastikan user ada di grup docker."
fi

# 8. Dependensi sistem untuk Camoufox + VNC (opsional; hanya Debian/Ubuntu)
echo -e "\n${GREEN}[8/8] Memeriksa dependensi sistem (Camoufox, Xvfb, noVNC)...${NC}"
SYSDEPS="libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 \
libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
libegl1 libgl1-mesa-dri libgbm1 xvfb x11vnc novnc websockify \
fonts-liberation fonts-noto-color-emoji fontconfig ca-certificates curl wget unzip \
build-essential python3 docker.io"
if [ -f /etc/debian_version ] || [ -f /etc/lsb-release ]; then
    if [ "$EUID" -eq 0 ]; then
        apt-get update
        apt-get install -y $SYSDEPS || apt-get install -y $(echo "$SYSDEPS" | sed 's/\blibxt6\b/libxt6t64/; s/\blibasound2\b/libasound2t64/')
        echo -e "${GREEN}Dependensi sistem terpasang.${NC}"
        prepare_daemon_image   # docker mungkin baru saja terpasang
    else
        echo -e "${YELLOW}Bukan root — jika Camoufox gagal start karena pustaka hilang, jalankan:${NC}"
        echo -e "sudo apt update && sudo apt install -y $SYSDEPS"
    fi
else
    echo -e "${YELLOW}Bukan Debian/Ubuntu — pastikan paket untuk Firefox/Xvfb/noVNC dan build-essential+python3 (better-sqlite3) sudah ada.${NC}"
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
