#!/bin/bash

# Manual Session Backup Script

set -e

BACKUP_DIR="./backups"
SESSION_DIR=".wwebjs_auth"

if [ ! -d "$SESSION_DIR" ]; then
    echo "Error: Session directory not found: $SESSION_DIR"
    exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/whatsapp-session-$TIMESTAMP.tar.gz"

echo "Creating backup..."
tar -czf "$BACKUP_FILE" "$SESSION_DIR"

if [ $? -eq 0 ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "Backup created successfully: $BACKUP_FILE ($SIZE)"
else
    echo "Error: Backup failed"
    exit 1
fi

