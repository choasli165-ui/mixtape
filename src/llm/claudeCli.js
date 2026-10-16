// Default provider: shells out to the Claude CLI in print mode (`claude -p`).
// Uses whatever auth the CLI already has (Claude subscription or API key) — no key needed here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ClaudeCliProvider {
  constructor(opts = {}) {
    this.command = opts.command || 'claude';
    this.model = opts.model || '';
    this.extraArgs = opts.extraArgs || [];
    this.timeoutMs = opts.timeoutMs || 180000;
    this.name = 'claude-cli';
  }

  describe() { return `Claude CLI (${this.command}${this.model ? `, model ${this.model}` : ''})`; }

  buildArgs(system, systemFile) {
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', '',              // pure text completion: no built-in tools
      '--strict-mcp-config',      // load no MCP servers (avoids recursively starting this agent)
      '--no-session-persistence',
      '--max-turns', '1',
    ];
    if (systemFile) args.push('--system-prompt-file', systemFile);
    else if (system) args.push('--system-prompt', system);
    if (this.model) args.push('--model', this.model);
    return [...args, ...this.extraArgs];
  }

  async complete({ system, prompt }) {
    // System prompt goes through a temp file: multi-line argv is unreliable on Windows shells.
    let dir = null, systemFile = null;
    if (system) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixtape-'));
      systemFile = path.join(dir, 'system.txt');
      fs.writeFileSync(systemFile, system);
    }
    try {
      try { return await this.run(this.command, false, systemFile, prompt); }
      catch (e) {
        // npm-installed Claude Code on Windows is a .cmd shim, which needs a shell.
        if (e.code !== 'ENOENT' || process.platform !== 'win32') throw e;
        return await this.run(this.command, true, systemFile, prompt);
      }
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`Claude CLI "${this.command}" not found. Install Claude Code, or switch provider: mixtape config set llm.provider anthropic`);
      throw e;
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  run(command, viaShell, systemFile, prompt) {
    const q = (a) => (/^[\w\-.:\\/=]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);
    const args = this.buildArgs(null, systemFile);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = viaShell
          ? spawn([command, ...args].map(q).join(' '), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, shell: true, windowsHide: true })
          : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
      } catch (e) { return reject(e); }

      let out = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Claude CLI timed out after ${this.timeoutMs}ms`)); }, this.timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed;
        try { parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}'); } catch { /* plain text */ }
        if (parsed && typeof parsed === 'object' && 'result' in parsed) {
          if (parsed.is_error) return reject(new Error(`Claude CLI error: ${parsed.result || parsed.subtype}`));
          return resolve(String(parsed.result));
        }
        if (code !== 0 && viaShell && /not recognized|cannot find/i.test(err)) return reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
        if (code !== 0) return reject(new Error(`Claude CLI exited ${code}: ${(err || out).trim().slice(0, 500)}`));
        resolve(out);
      });
      child.stdin.end(prompt);
    });
  }
}
