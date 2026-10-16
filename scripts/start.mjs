import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runServer } from '../server/server.mjs';

process.env.CANVAS_BASE_URL ||= 'https://byui.instructure.com';
try {
  if (!process.env.CANVAS_ACCESS_TOKEN) {
    if (process.platform === 'win32') {
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      process.env.CANVAS_ACCESS_TOKEN = execFileSync(powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(new URL('./get-token.ps1', import.meta.url))
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
    } else if (process.platform === 'darwin') {
      process.env.CANVAS_ACCESS_TOKEN = execFileSync('/usr/bin/security', [
        'find-generic-password', '-s', 'canvas-inbox-plugin', '-a', 'byui.instructure.com', '-w'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    }
  }
  if (!process.env.CANVAS_ACCESS_TOKEN) throw new Error('Missing token');
  await runServer();
} catch {
  process.stderr.write('Canvas Inbox could not start. Check Node.js and token setup: Windows scripts/set-token.ps1; macOS scripts/set-token.sh.\n');
  process.exitCode = 1;
}
