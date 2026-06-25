#!/bin/bash

# Setup Script for Dropbox Bot on Ubuntu/Debian VPS
set -e

echo "=================================================="
echo " Starting Dropbox Bot Installation & Setup "
echo "=================================================="

# Update package lists
echo "Updating package lists..."
sudo apt-get update -y

# Install git, curl, and build-essential if not installed
echo "Installing base dependencies..."
sudo apt-get install -y git curl build-essential

# Install NodeJS 20 if not installed
if ! command -v node &> /dev/null; then
    echo "NodeJS not found. Installing NodeJS 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "NodeJS is already installed: $(node -v)"
fi

# Install Docker if not installed (required for running the Dropbox daemon container)
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    echo "✓ Docker installed successfully."
else
    echo "✓ Docker is already installed."
fi

# Clone the repository branch
PROJECT_DIR="Dropbox"
if [ -d "$PROJECT_DIR" ]; then
    echo "Directory $PROJECT_DIR already exists. Moving into it..."
    cd "$PROJECT_DIR"
else
    echo "Cloning the 'docker' branch of the repository..."
    git clone -b docker https://github.com/jacksatriadi-jpg/Dropbox.git
    cd "$PROJECT_DIR"
fi

# Install npm packages
echo "Installing node dependencies..."
npm install

# Install Playwright Firefox and its system dependencies
echo "Installing Playwright Firefox and OS dependencies..."
npx playwright install --with-deps firefox

# Create data directory
mkdir -p data

echo "=================================================="
echo " Setup Completed Successfully! "
echo "=================================================="
echo "You can now run the bot using register.js. Examples:"
echo "  node register.js --emails=\"email@domain.com\""
echo "  node register.js --source=auto --domain=\"domain.com\" --count=5"
echo ""
echo "Note: If you just installed Docker, you may need to log out and log back in (or run 'newgrp docker') before running the script so that your user can run Docker commands without sudo."
echo "=================================================="
