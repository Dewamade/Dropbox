FROM node:20-bookworm

WORKDIR /app

# Menyalin file environment dan dependensi
COPY package.json package-lock.json* ./

# Instalasi npm package
RUN npm install

# Menginstal dependensi Chromium, Google Chrome Asli, dan Firefox untuk Playwright
RUN npx playwright install --with-deps chromium chrome firefox

# Menyalin seluruh kode sumber dan binary
COPY . .

# Mengekstrak dropbox.tar.gz di dalam container Linux
# Ini mengatasi masalah symlink error di Windows
RUN if [ -f "app/dropbox.tar.gz" ]; then \
        echo "Ekstrak dropbox.tar.gz..." && \
        tar -xzf app/dropbox.tar.gz -C app/ && \
        rm app/dropbox.tar.gz; \
    else \
        echo "File app/dropbox.tar.gz tidak ditemukan. Pastikan Anda telah meletakkannya."; \
    fi

# Membuat direktori data untuk penyimpanan SQLite
RUN mkdir -p /app/data

# Mengizinkan eksekusi langsung via CLI command
ENTRYPOINT ["node", "register.js"]
