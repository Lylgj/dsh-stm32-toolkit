/** Small, dependency-free helpers shared by the host half. */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Expand `~`, `%VAR%` and `$VAR` so config values can be written like a shell. */
export function expandPath(value) {
  if (typeof value !== 'string' || value === '') return value;
  let out = value;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(1));
  }
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => process.env[name] ?? m);
  return out;
}

export function resolvePath(base, value) {
  if (!value) return value;
  const expanded = expandPath(String(value));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function dirExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Strip ANSI escape sequences (Keil/gcc both colour their logs sometimes). */
export function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Find an executable by name. On Windows this walks PATHEXT too, because
 * `spawn('arm-none-eabi-gcc')` does not apply PATHEXT itself.
 */
export function which(name, extraDirs = []) {
  if (!name) return null;
  if (isAbsolute(name) || /[\\/]/.test(name)) {
    return fileExists(name) ? name : null;
  }
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const dirs = [
    ...extraDirs,
    ...String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':'),
    process.cwd(),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + (name.toLowerCase().endsWith(ext.toLowerCase()) ? '' : ext));
      if (fileExists(candidate)) return candidate;
      if (process.platform !== 'win32' && fileExists(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

/** List directories matching a simple prefix (used for versioned toolchain folders). */
export function listDirs(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(parent, d.name));
  } catch {
    return [];
  }
}

/**
 * Run a command and capture stdout/stderr.
 *
 * `timeoutMs` kills the process tree on expiry. Never uses a shell unless
 * `shell` is true, so arguments cannot be reinterpreted by cmd.exe.
 */
export function run(cmd, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 10 * 60 * 1000,
    env = process.env,
    input = null,
    shell = false,
  } = options;
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        ok: false,
        code: -1,
        signal: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        durationMs: 0,
        timedOut: false,
        command: `${cmd} ${args.join(' ')}`,
      });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs)
      : null;
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    if (input !== null) {
      try {
        child.stdin?.end(input);
      } catch {
        /* stdin already closed */
      }
    } else {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    }
    child.on('error', (error) => {
      err.push(Buffer.from(String(error?.message ?? error)));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        ok: code === 0,
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        command: `${cmd} ${args.join(' ')}`,
      });
    });
  });
}

/** Kill a process and its children (Node's kill does not reach the tree on Windows). */
export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
    return;
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse "0x20000000" / "20000000" / "536870912". Returns null when invalid. */
export function parseAddress(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  const text = String(value ?? '').trim().replace(/_/g, '');
  if (!text) return null;
  try {
    if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16) >>> 0;
    if (/^[0-9a-f]{8}$/i.test(text)) return Number.parseInt(text, 16) >>> 0;
    if (/^[0-9]+$/.test(text)) return Number.parseInt(text, 10) >>> 0;
  } catch {
    return null;
  }
  return null;
}

export function hex(value, width = 8) {
  const n = Number(value) >>> 0;
  return `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;
}

export function hexBytes(bytes) {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function hexFromBuffer(buffer) {
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bufferFromHex(text) {
  const clean = String(text ?? '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) throw new Error('十六进制字节串长度必须是偶数');
  return Buffer.from(clean, 'hex');
}

/** Monotonic-ish id for sessions/log files. */
export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
