import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

const execFileAsync = promisify(execFile);

/**
 * Safely copy text to Mac clipboard using pbcopy
 * Uses spawn with stdin pipe - no shell injection possible
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });

    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));

    proc.stdin.write(text);
    proc.stdin.end();
  });
}

/**
 * Play macOS notification sound
 * Uses execFile with fixed arguments - no shell injection possible
 */
export async function playNotificationSound(): Promise<void> {
  try {
    // Use execFile with explicit path and no shell
    spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    // Ignore errors - notification sound is non-critical
  }
}

/**
 * Escape string for safe use in AppleScript
 * Prevents command injection via newlines, backslashes, quotes
 */
function escapeAppleScript(str: string, maxLen = 100): string {
  return str
    .replace(/\\/g, '\\\\')     // Escape backslashes first
    .replace(/"/g, '\\"')       // Escape double quotes
    .replace(/[\n\r]/g, ' ')    // Replace newlines with spaces (injection vector)
    .replace(/[\x00-\x1f]/g, '') // Remove other control characters
    .slice(0, maxLen);
}

/**
 * Show macOS notification with title and message
 * Uses osascript with proper argument escaping via execFile
 */
export async function showNotification(title: string, message: string): Promise<void> {
  try {
    const safeTitle = escapeAppleScript(title, 50);
    const safeMessage = escapeAppleScript(message, 100);
    const script = `display notification "${safeMessage}" with title "${safeTitle}" sound name "Glass"`;

    await execFileAsync('osascript', ['-e', script]);
  } catch {
    // Ignore errors - notification is non-critical
  }
}

/**
 * Notify user that a task is complete with sound and notification
 */
export async function notifyTaskComplete(summary: string): Promise<void> {
  await Promise.all([
    playNotificationSound(),
    showNotification('Termo', summary),
  ]);
}

/**
 * Transcribe audio using Whisper (local whisper.cpp or OpenAI API)
 * Returns transcribed text or null on failure
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  try {
    // Try local whisper first (whisper.cpp)
    const whisperPaths = [
      '/opt/homebrew/bin/whisper',
      '/usr/local/bin/whisper',
      `${process.env.HOME}/.local/bin/whisper`,
    ];

    let whisperPath: string | null = null;
    for (const p of whisperPaths) {
      if (existsSync(p)) {
        whisperPath = p;
        break;
      }
    }

    if (whisperPath) {
      // Use local whisper - outputs to stdout
      const { stdout } = await execFileAsync(whisperPath, [
        audioPath,
        '--model', 'base',
        '--output-format', 'txt',
        '--output-dir', '/tmp',
      ], { timeout: 60000 });

      // Read output file
      const outputPath = audioPath.replace(/\.[^.]+$/, '.txt');
      if (existsSync(outputPath)) {
        const { readFileSync } = await import('fs');
        const text = readFileSync(outputPath, 'utf-8').trim();
        try { unlinkSync(outputPath); } catch {}
        return text || null;
      }

      return stdout.trim() || null;
    }

    // Try OpenAI Whisper API if OPENAI_API_KEY is set
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      const { readFileSync } = await import('fs');
      const FormData = (await import('form-data')).default;
      const fetch = (await import('node-fetch')).default;

      const formData = new FormData();
      formData.append('file', readFileSync(audioPath), {
        filename: 'audio.ogg',
        contentType: 'audio/ogg',
      });
      formData.append('model', 'whisper-1');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData as any,
      });

      if (response.ok) {
        const data = await response.json() as { text: string };
        return data.text || null;
      }
    }

    return null;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    return null;
  }
}

/**
 * Convert text to speech and save as audio file
 * Uses macOS say command or OpenAI TTS
 * Returns path to audio file or null on failure
 */
export async function textToSpeech(text: string): Promise<string | null> {
  try {
    const outputPath = `/tmp/termo_tts_${Date.now()}.aiff`;

    // Use macOS say command (fast, free, works offline)
    await execFileAsync('say', [
      '-o', outputPath,
      '--data-format=LEF32@22050',
      text.slice(0, 2000), // Limit text length
    ], { timeout: 30000 });

    if (existsSync(outputPath)) {
      // Convert to mp3 for smaller file size (if ffmpeg available)
      const mp3Path = outputPath.replace('.aiff', '.mp3');
      try {
        await execFileAsync('ffmpeg', [
          '-i', outputPath,
          '-acodec', 'libmp3lame',
          '-ab', '64k',
          '-y',
          mp3Path,
        ], { timeout: 30000 });

        unlinkSync(outputPath);
        return mp3Path;
      } catch {
        // ffmpeg not available, return aiff
        return outputPath;
      }
    }

    return null;
  } catch (error) {
    console.error('[TTS] Error:', error);
    return null;
  }
}

/**
 * Check if Whisper is available (local or API)
 */
export async function isWhisperAvailable(): Promise<boolean> {
  // Check local whisper
  const whisperPaths = [
    '/opt/homebrew/bin/whisper',
    '/usr/local/bin/whisper',
  ];

  for (const p of whisperPaths) {
    if (existsSync(p)) return true;
  }

  // Check OpenAI API key
  if (process.env.OPENAI_API_KEY) return true;

  return false;
}
