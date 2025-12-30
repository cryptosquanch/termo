# Termo

## Control Claude Code from Your Phone

Lying in bed but need to code? Termo lets you chat with Claude Code through Telegram - no laptop required.

**What you can do:**
- Chat with Claude Code from anywhere
- Send screenshots of errors - Claude reads them
- Switch between projects with one tap
- Get notified when Claude finishes thinking

---

## Before You Start

You'll need:
- **A Mac** (Termo runs on your Mac and connects to Telegram)
- **Claude Code** already working (you should be able to run `claude` in Terminal)
- **Node.js** installed ([download here](https://nodejs.org/) - get the LTS version)
- **Homebrew** for auto-installing dependencies ([install here](https://brew.sh/))

Don't have these? Install them first, then come back.

---

## Setup (5 minutes)

### Step 1: Create Your Telegram Bot

Every user creates their own private bot. Here's how:

1. Open **Telegram** on your phone
2. Search for **@BotFather** and tap Start
3. Send: `/newbot`
4. Pick any name (example: "My Claude Bot")
5. Pick a username ending in `bot` (example: `myclaudebot`)
6. BotFather will send you a token like this:
   ```
   123456789:ABCDefgh_IJKLmnop-QRSTuvwxyz12345
   ```
   **Copy this token** - you'll need it in Step 3

### Step 2: Get Your Telegram ID

This ensures only YOU can use your bot:

1. In Telegram, search for **@userinfobot** and tap Start
2. It will reply with your ID (a number like `123456789`)
3. **Copy this number** - you'll need it in Step 3

### Step 3: Install Termo

**Open Terminal** (press `Cmd + Space`, type "Terminal", press Enter)

Paste these commands one at a time:

```bash
git clone https://github.com/cryptosquanch/termo.git
```

```bash
cd termo
```

```bash
cp .env.example .env
```

```bash
open .env
```

A text file opens. You'll see:
```
TELEGRAM_BOT_TOKEN=your_bot_token_here
ALLOWED_USER_IDS=your_user_id_here
```

Replace the placeholder text with YOUR values:
```
TELEGRAM_BOT_TOKEN=<paste_token_from_botfather>
ALLOWED_USER_IDS=<your_id_from_userinfobot>
```

**Save the file**: Press `Cmd + S`, then close the window.

Back in Terminal, run:
```bash
./scripts/install.sh
```

Wait for it to finish. The script auto-installs:
- **tmux** (terminal multiplexer)
- **Tesseract** (OCR for screenshots)
- **ImageMagick** (image preprocessing)

You should see:
```
✅ Termo installed successfully!
```

**That's it!** Termo is now running.

---

## How to Use

Open Telegram, find your bot, and send:

```
/attach
```

Navigate to your project folder (replace with your actual path):
```
cd ~/Desktop/my-project
```

Start Claude:
```
claude
```

**Now just chat!** Everything you type goes straight to Claude.

---

## Tips & Tricks

### Save Projects for Quick Access

In Telegram, after `cd`-ing to a project:
```
/pin work
```

Next time, just tap `/pins` and select it - no more typing paths!

### Send Screenshots (OCR)

Got an error on your Mac screen? Screenshot it and send it to the bot. Termo extracts the text using OCR and forwards it to Claude.

Works great with dark terminal screenshots - we preprocess images for better accuracy.

### 🎤 Voice Messages

Send voice messages and Termo transcribes them using Whisper:

**Setup (optional but recommended):**
```bash
# Option 1: Local Whisper (free, faster)
brew install openai-whisper

# Option 2: Cloud Whisper - add to .env
OPENAI_API_KEY=sk-...
```

**Telegram Premium users** get automatic transcription without any setup.

### ⚡ Custom Shortcuts

Create aliases for commands you use often:

```
/alias gs git status
/alias ll ls -la
/alias deploy npm run build && vercel
```

Then just type `!gs` to run `git status`. View all with `/aliases`, remove with `/unalias gs`.

### 🧠 Project Memory

Save context about each project that persists across sessions:

```
/remember stack Node.js + PostgreSQL + Redis
/remember deploy vercel --prod
/remember test npm run test:e2e
```

View with `/memories`, forget with `/forget stack`. Memories are tied to each pinned project.

### ⭐ Bookmarks & Usage

- Tap **⭐ Save** when Claude finishes to bookmark a response
- View saved responses with `/bookmarks`
- Search bookmarks: `/bookmarks auth`
- Check token usage: `/usage`
- Export conversation: `/export`

### Smart Notifications

When Claude finishes a long task, you'll get a "Done!" message - no need to keep checking your phone.

### Claude Code Commands

All Claude Code commands work from Telegram - just type them exactly as you would in Terminal:
- `ultrathink` - Extended thinking mode
- `compact` - Compact responses
- `/clear` - Clear conversation
- `/cost` - Show token usage

Whatever works in your Terminal works here.

---

## Quick Commands

| Command | What it does |
|---------|--------------|
| `/attach` | Connect to Claude Code session |
| `/detach` | Disconnect |
| `/screen` | Refresh display |
| `/full` | Download full output as file |
| `/status` | Check Claude's current status |
| `/ctrlc` | Cancel running command |
| `/reset` | Clear Claude context (fixes "context low") |
| `/pins` | Your saved projects |
| `/pin name` | Save current folder |
| `/menu` | Show all options |
| `/alias name cmd` | Create shortcut |
| `/aliases` | List shortcuts |
| `/unalias name` | Remove shortcut |
| `/remember key value` | Save project memory |
| `/memories` | List project memories |
| `/forget key` | Remove memory |
| `/bookmarks` | Saved Claude responses |
| `/usage` | Token usage dashboard |
| `/export` | Export conversation as markdown |
| `/voice` | Toggle voice output |

---

## Using MCP Servers

Termo works with any MCP servers you've configured in Claude Code. MCPs give Claude access to external tools like databases, APIs, and more.

**Add an MCP server:**
```bash
# HTTP server (like Sentry)
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# Stdio server (like a local tool)
claude mcp add --transport stdio my-tool -- npx -y my-mcp-server

# List your MCPs
claude mcp list
```

**After adding MCPs, restart Claude in tmux:**
```bash
tmux kill-session -t termo-main
tmux new-session -d -s termo-main "claude"
```

Then `/attach` from Telegram - your MCPs are ready!

---

## Important: Keep Your Mac Running

Termo runs on your Mac and connects to Telegram. For it to work:

- ✅ **Mac must be awake** (not sleeping)
- ✅ **Mac must be online** (connected to internet)
- ✅ **Termo must be running** (auto-starts if you used install.sh)

### ✅ Do This (Keep Access)

| Action | How |
|--------|-----|
| Prevent sleep | System Settings → Battery → Options → "Prevent automatic sleeping when display is off" |
| Keep lid closed + awake | Plug in power, close lid - Mac stays awake |
| Use Amphetamine app | Free app to keep Mac awake on schedule |
| Keep WiFi stable | Use ethernet if possible, or stay on reliable WiFi |
| Auto-start Termo | Run `./scripts/install.sh` to enable LaunchAgent |

### ❌ Don't Do This (Lose Access)

| Action | Why It Breaks |
|--------|---------------|
| Let Mac sleep | Termo can't respond when Mac is sleeping |
| Disconnect from internet | No path between Telegram and your Mac |
| Run `sudo shutdown` via Termo | You just turned off your Mac remotely 💀 |
| Kill the tmux session | Claude Code stops, need physical access to restart |
| Change WiFi networks | Mac may not auto-reconnect |
| Close Terminal app (if not using LaunchAgent) | Termo stops running |
| Reboot without LaunchAgent | Termo won't auto-start |

### 🔄 Recovery Options

If you lose access:

1. **Mac sleeping?** → Wake it physically or use Apple Watch unlock
2. **Termo crashed?** → SSH from another device, or physical access
3. **tmux died?** → Restart with `tmux new-session -d -s termo-main "claude"`
4. **Total lockout?** → Physical access to Mac required

**Pro tip:** Set up SSH as backup access method if you have a static IP or use Tailscale/ZeroTier for remote access.

---

## Troubleshooting

**"command not found: git"**
Install Xcode tools: `xcode-select --install`

**Bot not responding?**
Check if your Mac is awake and Termo is running:
```bash
tail -f ~/termo/logs/termo.log
```

**How do I restart Termo?**
```bash
cd ~/termo && npm run build && npm start
```

**How do I stop Termo?**
```bash
launchctl unload ~/Library/LaunchAgents/com.termo.bot.plist
```

---

## Advanced: Connect to Existing Claude Session

Already have Claude running on your Mac? You can connect Termo to that session instead of starting a new one.

**Why use this?** Keep your existing Claude conversation going from your phone - same context, same project, no restart needed.

### Step 1: Start Claude in a Named Session

On your Mac, open Terminal and run:
```bash
tmux new -s claude
claude
```

This starts Claude in a background session called "claude" that Termo can connect to.

### Step 2: Tell Termo Which Session to Use

Edit your `.env` file:
```bash
cd ~/termo
open .env
```

Add this line:
```
TMUX_SESSION=claude
```

### Step 3: Restart Termo

```bash
npm run build && npm start
```

Now `/attach` connects you to your existing Claude session from Telegram!

**Tip:** You can name your session anything (letters, numbers, dashes, underscores). Just make sure the name in `.env` matches what you used in Step 1.

---

## Security

- Only YOUR Telegram ID can access the bot
- Dangerous commands (like `rm -rf /`) are blocked
- Everything runs locally on your Mac - no cloud servers

---

MIT License
