#!/bin/bash

# Termo Startup Script
# Starts tmux session and the Telegram bot

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Set up environment
export HOME="$HOME"
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Create logs directory if it doesn't exist
mkdir -p logs

# Load config for tmux startup directory (optional)
TMUX_START_DIR="${TERMO_START_DIR:-$HOME}"

# Start tmux session if not already running
if ! command -v tmux &> /dev/null; then
    echo "[Termo] tmux not found. Install with: brew install tmux"
    exit 1
fi

if ! tmux has-session -t termo-main 2>/dev/null; then
    echo "[Termo] Starting tmux session..."
    tmux new-session -d -s termo-main -c "$TMUX_START_DIR"
    echo "[Termo] tmux session created"
fi

# Start the Telegram bot
echo "[Termo] Starting Telegram bot..."
exec node "$PROJECT_DIR/dist/index.js"
