#!/bin/bash

# Pastikan script dijalankan dari direktori yang benar
cd "$(dirname "$0")"

echo "=== Memulai Dropbox Bot CLI ==="

# Menjalankan container Docker dengan parameter yang diteruskan
# Menggunakan docker-compose untuk menjalankan command secara one-off
docker compose run --rm dropbox-bot "$@"
