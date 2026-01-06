#!/bin/bash

# Session Restore Script

set -e

BACKUP_DIR="./backups"

if [ -z "$1" ]; then
    echo "Usage: $0 <backup-file-name>"
    echo ""
    echo "Available backups:"
    ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null | awk '{print $9}' | xargs -n1 basename
    exit 1
fi

BACKUP_FILE="$BACKUP_DIR/$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

echo "Restoring from backup: $BACKUP_FILE"

# Remove existing session if it exists
if [ -d ".wwebjs_auth" ]; then
    echo "Removing existing session directory..."
    rm -rf .wwebjs_auth
fi

# Extract backup
echo "Extracting backup..."
tar -xzf "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "Session restored successfully!"
    echo "Restart the application to use the restored session."
else
    echo "Error: Restore failed"
    exit 1
fi

