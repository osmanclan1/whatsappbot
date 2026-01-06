#!/bin/bash

# AWS EC2 Setup Script for WhatsApp API
# This script installs all required dependencies for running the WhatsApp API on EC2

set -e

echo "========================================="
echo "AWS EC2 Setup for WhatsApp API"
echo "========================================="

# Update system packages
echo "Updating system packages..."
sudo apt-get update -y

# Install Node.js 18.x
echo "Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

# Install PM2 globally
echo "Installing PM2..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
else
    echo "PM2 already installed: $(pm2 --version)"
fi

# Install Puppeteer dependencies
echo "Installing Puppeteer/Chrome dependencies..."
sudo apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  lsb-release \
  wget \
  xdg-utils

# Configure firewall (UFW)
echo "Configuring firewall..."
sudo ufw --force enable
sudo ufw allow 22/tcp
echo "Firewall configured (SSH allowed)"

# Set up swap space (2GB) if needed
echo "Checking swap space..."
if [ -z "$(swapon --show)" ]; then
    echo "Creating swap file..."
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap file created (2GB)"
else
    echo "Swap already configured"
fi

# Create application directories
echo "Creating application directories..."
mkdir -p ~/whatsapp/{logs,backups}
echo "Directories created"

# Set proper permissions
echo "Setting permissions..."
chmod 755 ~/whatsapp

echo "========================================="
echo "Setup completed successfully!"
echo "========================================="
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo "PM2 version: $(pm2 --version)"
echo ""
echo "Next steps:"
echo "1. Upload your application files to ~/whatsapp"
echo "2. Run: cd ~/whatsapp && npm install"
echo "3. Configure .env file"
echo "4. Run: pm2 start ecosystem.config.js"
echo "5. Run: pm2 startup systemd && pm2 save"
echo "========================================="

