import { spawn } from 'node:child_process';

/** Open a URL in the user's default browser. Best effort; never throws. */
export function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      // `start "" "<url>"` — verbatim args so the empty title and quoted URL (with &) survive.
      child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url.replace(/"/g, '')}"`], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true, windowsHide: true });
    } else {
      child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    }
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
