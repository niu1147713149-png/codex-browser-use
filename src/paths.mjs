import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const HOST_NAME = 'local.codex.browser_buddy';
export const stateDir = () => resolve(process.env.BROWSER_BUDDY_STATE_DIR ||
  join(process.env.LOCALAPPDATA || homedir(), 'CodexBrowserBuddy'));
export const discoveryPath = () => join(stateDir(), 'connection.json');
