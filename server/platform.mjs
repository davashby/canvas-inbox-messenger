import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function dataDirectory(platform = process.platform, env = process.env, userHome = homedir()) {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(userHome, 'AppData', 'Roaming'), 'Canvas Inbox Messenger');
  if (platform === 'darwin') return posix.join(userHome, 'Library', 'Application Support', 'Canvas Inbox Messenger');
  return posix.join(env.XDG_CONFIG_HOME || posix.join(userHome, '.config'), 'canvas-inbox-messenger');
}
