#!/bin/bash

# Deployment Script for WhatsApp API

set -e

echo "========================================="
echo "Deploying WhatsApp API"
echo "========================================="

# Install/update dependencies
echo "Installing dependencies..."
npm install

# Create necessary directories
echo "Creating directories..."
mkdir -p logs backups

# Check if .env exists
if [ ! -f .env ]; then
    echo "Warning: .env file not found. Please create one from .env.example"
fi

# Restart PM2 process if running
if command -v pm2 &> /dev/null; then
    if pm2 list | grep -q "whatsapp-bot"; then
        echo "Restarting PM2 process..."
        pm2 restart whatsapp-bot
    else
        echo "Starting PM2 process..."
        pm2 start ecosystem.config.js
    fi
else
    echo "PM2 not found. Install it first: npm install -g pm2"
fi

echo "========================================="
echo "Deployment completed!"
echo "========================================="
echo "Check status: pm2 status"
echo "View logs: pm2 logs whatsapp-bot"
echo "========================================="

