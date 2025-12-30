#!/bin/bash

# Termo Installation Script

set -e

echo "=== Termo Installation ==="
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Check dependencies
echo "Checking dependencies..."

if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org"
    exit 1
fi

if ! command -v tmux &> /dev/null; then
    echo "Installing tmux..."
    if command -v brew &> /dev/null; then
        brew install tmux
    else
        echo "Error: Homebrew is required to install tmux."
        echo "Install Homebrew from https://brew.sh/ then run this script again."
        exit 1
    fi
fi

echo "  Node.js: $(node -v)"
echo "  tmux: $(tmux -V)"

# Install Tesseract for OCR (optional but recommended)
if ! command -v tesseract &> /dev/null; then
    echo "Installing Tesseract for screenshot OCR..."
    if command -v brew &> /dev/null; then
        brew install tesseract
    else
        echo "  Skipping Tesseract (install Homebrew to enable OCR)"
    fi
fi

if command -v tesseract &> /dev/null; then
    echo "  Tesseract: $(tesseract --version 2>&1 | head -1)"
fi

# Install ImageMagick for image preprocessing
if ! command -v convert &> /dev/null; then
    echo "Installing ImageMagick for image processing..."
    if command -v brew &> /dev/null; then
        brew install imagemagick
    fi
fi

if command -v convert &> /dev/null; then
    echo "  ImageMagick: $(convert --version 2>&1 | head -1)"
fi
echo ""

# Check for .env file
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Creating .env from template..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo ""
    echo "IMPORTANT: Edit .env with your Telegram bot token and user ID"
    echo "  1. Get bot token from @BotFather on Telegram"
    echo "  2. Get your user ID from @userinfobot on Telegram"
    echo ""
    echo "Then run this script again."
    exit 1
fi

# Build the project
echo "Building project..."
cd "$PROJECT_DIR"
npm install
npm run build

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"
mkdir -p "$PROJECT_DIR/data"

# Create LaunchAgent
echo ""
echo "Setting up LaunchAgent for auto-start..."

PLIST_NAME="com.termo.bot.plist"
PLIST_SOURCE="$PROJECT_DIR/launchd/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

# Generate plist with correct paths
cat > "$PLIST_DEST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.termo.bot</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$PROJECT_DIR/scripts/start-termo.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/termo.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/termo-error.log</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

echo "LaunchAgent created at: $PLIST_DEST"

# Load the agent
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo ""
echo "✅ Termo installed successfully!"
echo ""
echo "Open Telegram and message your bot to get started."
echo ""
echo "Useful commands:"
echo "  View logs:  tail -f ~/termo/logs/termo.log"
echo "  Restart:    cd ~/termo && npm run build && npm start"
echo "  Stop:       launchctl unload ~/Library/LaunchAgents/com.termo.bot.plist"
