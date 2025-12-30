#!/bin/bash

# Termo Uninstall Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PLIST_NAME="com.termo.bot.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "Uninstalling Termo..."

# Stop and unload LaunchAgent
if [ -f "$PLIST_PATH" ]; then
    echo "Stopping service..."
    launchctl stop com.termo.bot 2>/dev/null || true
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm "$PLIST_PATH"
    echo "LaunchAgent removed."
else
    echo "LaunchAgent not found (already uninstalled?)."
fi

# Kill any running termo processes
pkill -f "termo/dist/index.js" 2>/dev/null || true

# Kill tmux session
tmux kill-session -t termo-main 2>/dev/null || true

echo ""
echo "Uninstall complete!"
echo ""
echo "Note: Your data and configuration are preserved in:"
echo "  - Data: $PROJECT_DIR/data/"
echo "  - Config: $PROJECT_DIR/.env"
echo ""
echo "To remove everything, delete the termo directory."
