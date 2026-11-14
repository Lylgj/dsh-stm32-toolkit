/**
 * SEGGER J-Link native backend.
 *
 * Two separate SEGGER tools are used as black-box child processes:
 *   - `JLinkGDBServerCL.exe`  : a GDB server that owns the probe; GDB connects
 *                               to it over TCP exactly like it does to OpenOCD.
 *   - `JLink.exe` (Commander) : one-shot download / erase via a script file.
 *
 * This exists because a J-Link with SEGGER's private kernel driver bound to its
 * USB interface cannot be opened through libusb, so OpenOCD/pyOCD cannot see it.
 * Driving SEGGER's own binaries is the only way to use such a probe, and it
 * requires nothing proprietary from us: we only speak the documented CLI and
 * the GDB remote protocol.
 */

import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileExists, killTree, which } from '../util.js';

/** Candidate SEGGER install roots, newest version first. */
export function seggerDirs() {
  const dirs = [];
  if (process.env.SEGGER_JLINK_HOME) dirs.push(process.env.SEGGER_JLINK_HOME);
  const bases = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
    : ['/opt/SEGGER', '/Applications/SEGGER', '/usr/local/SEGGER'];
  for (const base of bases) {
    if (!base) continue;
    const root = join(base, 'SEGGER');
    let names = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^JLink/i.test(d.name))
        .map((d) => d.name);
    } catch {
      continue;
    }
    // JLink_V994 → 994, JLink_V916a → 916
    const ver = (n) => {
      const m = /^JLink_V(\d+)/i.exec(n);
      return m ? Number(m[1]) : 0;
    };
    names.sort((a, b) => ver(b) - ver(a));
    for (const n of names) dirs.push(join(root, n));
  }
  return dirs;
}

/**
 * Locate JLink.exe + JLinkGDBServerCL.exe.
 * @param {object} configured {jlinkPath?, jlinkGDBServerPath?}
 * @returns {{exe:string|null, gdbserver:string|null, dir:string}}
 */
export function findJLinkTools(configured = {}) {
  const win = process.platform === 'win32';
  const exeNames = win ? ['JLink.exe', 'JLinkExe'] : ['JLinkExe'];
  const gdbNames = win ? ['JLinkGDBServerCL.exe', 'JLinkGDBServer.exe'] : ['JLinkGDBServerCLExe', 'JLinkGDBServer'];
  const pick = (dir, names) => names.map((n) => join(dir, n)).find((p) => fileExists(p)) || null;

  let exe = null;
  let gdbserver = null;
  if (configured.jlinkPath && fileExists(configured.jlinkPath)) exe = configured.jlinkPath;
  if (configured.jlinkGDBServerPath && fileExists(configured.jlinkGDBServerPath)) gdbserver = configured.jlinkGDBServerPath;

  const dirs = [];
  if (exe) dirs.push(dirname(exe));
  if (gdbserver) dirs.push(dirname(gdbserver));
  for (const name of exeNames) {
    const w = which(name);
    // JDK ships an unrelated `jlink.exe`; only trust a SEGGER install.
    if (w && !/[\\/]jdk[-\\/]/i.test(w)) {
      if (!exe) exe = w;
      dirs.push(dirname(w));
      break;
    }
  }
  dirs.push(...seggerDirs());

  for (const dir of dirs) {
    if (!exe) {
      const c = pick(dir, exeNames);
      if (c && !/[\\/]jdk[-\\/]/i.test(c)) exe = c;
    }
    if (!gdbserver) {
      const c = pick(dir, gdbNames);
      if (c) gdbserver = c;
    }
    if (exe && gdbserver) break;
  }
  return { exe, gdbserver, dir: gdbserver ? dirname(gdbserver) : (exe ? dirname(exe) : '') };
}

/**
 * Decide which download/debug backend to use for this config.
 * @returns {'jlink'|'openocd'}
 */
export function resolveBackend(config = {}, toolchain = null) {
  const backend = String(config.backend || 'auto').toLowerCase();
  if (backend === 'jlink' || backend === 'segger') return 'jlink';
  if (backend === 'openocd') return 'openocd';
  // auto: honour the explicit probe, else sniff the connected hardware.
  const probe = String(config.probe || '').toLowerCase();
  if (probe.includes('jlink') || probe.includes('j-link') || probe.includes('segger')) return 'jlink';
  if (probe.includes('stlink') || probe.includes('st-link') || probe.includes('cmsis') || probe.includes('dap')) return 'openocd';
  const probes = (toolchain?.probes?.probes ?? []).map((s) => String(s).toLowerCase());
  const hasJlink = probes.some((s) => s.includes('j-link') || s.includes('jlink'));
  const hasOther = probes.some((s) => s.includes('st-link') || s.includes('stlink') || s.includes('cmsis') || s.includes('daplink'));
  if (hasJlink && !hasOther) return 'jlink';
  return 'openocd';
}

/** The `-device` name for J-Link: explicit override, else the project's device. */
export function jlinkDeviceFor(config = {}, project = null) {
  return String(config.jlinkDevice || project?.device || config.device || '').trim();
}

function tcpProbe(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Start `JLinkGDBServerCL.exe` and wait until it accepts GDB connections.
 *
 * @param {object} options
 * @param {string} options.gdbserverPath
 * @param {string} options.device           J-Link device name, e.g. STM32F407VG
 * @param {string} [options.interfaceName='SWD']
 * @param {number} [options.speed=4000]
 * @param {number} [options.gdbPort=2331]
 * @param {number} [options.timeoutMs=20000]
 */
export async function startJLinkGdbServer(options) {
  const {
    gdbserverPath,
    device,
    interfaceName = 'SWD',
    speed = 4000,
    gdbPort = 2331,
    timeoutMs = 20_000,
  } = options;
  if (!gdbserverPath) throw new Error('未找到 JLinkGDBServerCL，请安装 SEGGER J-Link 软件或配置 jlinkGDBServerPath');
  if (!device) throw new Error('缺少 J-Link 目标器件名（jlinkDevice 或工程的 device）');

  const args = [
    '-device', device,
    '-if', interfaceName,
    '-speed', String(speed),
    '-port', String(gdbPort),
    '-nogui',
    '-silent',
  ];

  const child = spawn(gdbserverPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines = [];
  let exited = false;
  const append = (chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) if (line.trim()) logLines.push(line);
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const exitedPromise = new Promise((resolve) => {
    child.once('close', (code) => {
      exited = true;
      resolve(code);
    });
    child.once('error', (error) => {
      exited = true;
      append(String(error?.message ?? error));
      resolve(-1);
    });
  });

  const startedAt = Date.now();
  let ready = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (exited) break;
    if (await tcpProbe('127.0.0.1', gdbPort)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!ready) {
    killTree(child);
    const details = logLines.join('\n') || '(JLinkGDBServer 无输出)';
    if (exited) {
      const noProbe = /could not connect|no j-link|no emulator|failed to get index|unknown device|cannot connect/i.test(details);
      throw new Error(
        (noProbe
          ? `J-Link GDB Server 未能连接目标（device=${device}）。请确认探针已插入、目标器件名正确。\n`
          : 'J-Link GDB Server 启动失败并已退出。\n')
        + `--- JLinkGDBServer 输出 ---\n${details}`,
      );
    }
    throw new Error(
      `J-Link GDB Server 未能在 ${Math.round(timeoutMs / 1000)} 秒内监听 ${gdbPort} 端口。\n`
      + `请检查探针是否连接、端口是否被占用。\n--- JLinkGDBServer 输出 ---\n${details}`,
    );
  }

  return {
    process: child,
    gdbPort,
    backend: 'jlink',
    log: () => [...logLines],
    get exited() {
      return exited;
    },
    exitedPromise,
    async stop() {
      if (!child || child.exitCode !== null) return;
      killTree(child);
      await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 2000))]);
    },
  };
}

/**
 * Build the J-Link Commander script for a one-shot download.
 * @returns {string} script body
 */
export function buildJLinkFlashScript(options = {}) {
  const {
    device,
    interfaceName = 'SWD',
    speed = 4000,
    firmware,
    address = '',
    erase = 'none',
    verify = true,
    reset = true,
  } = options;
  const ext = String(firmware).toLowerCase().split('.').pop();
  const fw = String(firmware).replace(/\\/g, '/');
  const lines = [
    `device ${device}`,
    `si ${interfaceName}`,
    `speed ${speed}`,
    'connect',
  ];
  if (erase === 'mass') lines.push('erase');
  if (ext === 'bin') {
    const addr = address || '0x08000000';
    lines.push(`loadbin "${fw}", ${addr}`);
  } else {
    // loadfile accepts .elf / .hex and programs + verifies automatically.
    lines.push(`loadfile "${fw}"`);
  }
  if (!verify) lines.push('exec SetVerifyDownload = 0');
  if (reset) {
    lines.push('r');
    lines.push('g');
  }
  lines.push('exit');
  return lines.join('\n');
}

/**
 * One-shot program (+verify/reset) via `JLink.exe -CommanderScript`, then exit.
 *
 * @param {object} options
 * @param {string} options.exe        JLink.exe path
 * @param {string} options.firmware   .elf/.hex/.bin
 * @returns {Promise<{ok:boolean, code:number, output:string, durationMs:number}>}
 */
export async function flashFirmwareJLink(options) {
  const {
    exe,
    firmware,
    timeoutMs = 120_000,
    workDir = process.env.TEMP || process.env.TMPDIR || '.',
  } = options;
  if (!exe) throw new Error('未找到 JLink.exe，请安装 SEGGER J-Link 软件或配置 jlinkPath');
  if (!firmware) throw new Error('缺少固件路径');
  if (!options.device) throw new Error('缺少 J-Link 目标器件名');

  const script = buildJLinkFlashScript(options);
  const scriptPath = join(workDir, `dsh-jlink-flash-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jlink`);
  writeFileSync(scriptPath, script);

  const startedAt = Date.now();
  const child = spawn(exe, ['-CommanderScript', scriptPath, '-ExitOnError', '1', '-NoGui', '1'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  child.stdout?.on('data', (c) => out.push(String(c)));
  child.stderr?.on('data', (c) => out.push(String(c)));
  const code = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve(-2);
    }, timeoutMs);
    child.once('close', (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value ?? -1);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(-1);
    });
  });

  const output = out.join('');
  // J-Link reports success with an "O.K." line and failure with Error/Failed.
  const failedText = /(^|\n)\s*(Error|Failed|Could not|Cannot|Unknown device)/i.test(output);
  return {
    ok: code === 0 && !failedText,
    code,
    output,
    durationMs: Date.now() - startedAt,
    script,
  };
}
