import { createCanvas, registerFont } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';

// Terminal-style colors
const COLORS = {
  background: '#1a1b26',  // Dark blue-black (Tokyo Night style)
  foreground: '#a9b1d6',  // Light gray-blue
  green: '#9ece6a',       // Success/prompt
  yellow: '#e0af68',      // Warnings
  red: '#f7768e',         // Errors
  blue: '#7aa2f7',        // Info
  cyan: '#7dcfff',        // Paths
  magenta: '#bb9af7',     // Special
  dim: '#565f89',         // Dimmed text
};

/**
 * Render terminal text as a PNG image
 */
export async function renderTerminalImage(
  text: string,
  options?: {
    width?: number;
    maxLines?: number;
    title?: string;
  }
): Promise<Buffer> {
  const { width = 800, maxLines = 35, title } = options || {};

  // Process lines
  let lines = text.split('\n');

  // Limit lines (take last N lines if too many)
  if (lines.length > maxLines) {
    lines = ['...', ...lines.slice(-maxLines + 1)];
  }

  // Strip ANSI codes for now (simple approach)
  lines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));

  // Calculate dimensions
  const fontSize = 14;
  const lineHeight = fontSize * 1.4;
  const padding = 20;
  const titleHeight = title ? 40 : 0;
  const height = Math.max(200, lines.length * lineHeight + padding * 2 + titleHeight);

  // Create canvas
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Title bar (if title provided)
  if (title) {
    ctx.fillStyle = '#24283b';
    ctx.fillRect(0, 0, width, titleHeight);

    // Window controls (fake macOS style)
    const dotY = titleHeight / 2;
    ctx.fillStyle = '#ff5f56';
    ctx.beginPath();
    ctx.arc(20, dotY, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffbd2e';
    ctx.beginPath();
    ctx.arc(42, dotY, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#27ca40';
    ctx.beginPath();
    ctx.arc(64, dotY, 6, 0, Math.PI * 2);
    ctx.fill();

    // Title text
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${fontSize - 2}px "SF Mono", "Monaco", "Menlo", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, dotY + 4);
    ctx.textAlign = 'left';
  }

  // Terminal text
  ctx.font = `${fontSize}px "SF Mono", "Monaco", "Menlo", "Courier New", monospace`;
  ctx.textBaseline = 'top';

  const startY = titleHeight + padding;

  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;

    // Simple syntax highlighting
    let color = COLORS.foreground;

    // Detect line type and color accordingly
    if (line.startsWith('>') || line.includes('$')) {
      color = COLORS.green;
    } else if (line.includes('Error') || line.includes('error') || line.includes('✗')) {
      color = COLORS.red;
    } else if (line.includes('Warning') || line.includes('warning')) {
      color = COLORS.yellow;
    } else if (line.includes('✓') || line.includes('Done') || line.includes('Success')) {
      color = COLORS.green;
    } else if (line.startsWith('...')) {
      color = COLORS.dim;
    } else if (line.includes('─') || line.includes('│')) {
      color = COLORS.dim;
    } else if (line.includes('thinking') || line.includes('Thinking')) {
      color = COLORS.cyan;
    }

    ctx.fillStyle = color;

    // Truncate long lines
    const maxChars = Math.floor((width - padding * 2) / (fontSize * 0.6));
    const displayLine = line.length > maxChars
      ? line.slice(0, maxChars - 3) + '...'
      : line;

    ctx.fillText(displayLine, padding, y);
  });

  // Add subtle gradient at bottom if truncated
  if (text.split('\n').length > maxLines) {
    const gradient = ctx.createLinearGradient(0, height - 40, 0, height);
    gradient.addColorStop(0, 'rgba(26, 27, 38, 0)');
    gradient.addColorStop(1, 'rgba(26, 27, 38, 0.9)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, height - 40, width, 40);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Save terminal screenshot to temp file and return path
 */
export async function saveTerminalScreenshot(
  text: string,
  options?: {
    width?: number;
    maxLines?: number;
    title?: string;
  }
): Promise<string> {
  const buffer = await renderTerminalImage(text, options);

  const tmpDir = os.tmpdir();
  const filename = `termo-screen-${randomBytes(4).toString('hex')}.png`;
  const filePath = path.join(tmpDir, filename);

  await fs.promises.writeFile(filePath, buffer);

  return filePath;
}
