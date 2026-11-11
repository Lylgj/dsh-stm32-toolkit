/**
 * OpenOCD control: start/stop the GDB server and flash firmware.
 *
 * OpenOCD owns the debug probe (ST-Link, CMSIS-DAP, J-Link); GDB connects to
 * it over TCP. For a one-shot "download" OpenOCD can program and reset by
 * itself, which is what Keil's "Download" button effectively does.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileExists, killTree, which } from '../util.js';

const COMMON_DIRS = () => {
  const dirs = [];
  if (process.env.OPENOCD_HOME) dirs.push(join(process.env.OPENOCD_HOME, 'bin'));
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const localApp = process.env.LOCALAPPDATA ?? '';
    dirs.push(
      join(programFiles, 'OpenOCD', 'bin'),
      join(programFiles, 'xpack-openocd', 'bin'),
      localApp ? join(localApp, 'Programs', 'OpenOCD', 'bin') : '',
      'C:\\OpenOCD\\bin',
    );
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');
  }
  return dirs.filter(Boolean);
};

/** Find `openocd`, either configured, on PATH, or in common install roots. */
export function findOpenocd(configuredPath) {
  if (configuredPath) {
    if (fileExists(configuredPath)) return configuredPath;
    const alt = which(configuredPath);
    if (alt) return alt;
  }
  const onPath = which('openocd');
  if (onPath) return onPath;
  for (const dir of COMMON_DIRS()) {
    const candidate = join(dir, process.platform === 'win32' ? 'openocd.exe' : 'openocd');
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function buildConfigArgs(config) {
  const args = [];
  if (config.scriptsPath) args.push('-s', config.scriptsPath);
  if (config.interfaceCfg) args.push('-f', config.interfaceCfg);
  if (config.targetCfg) args.push('-f', config.targetCfg);
  return args;
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
 * Start an OpenOCD GDB server.
 *
 * @param {object} options
 * @param {string} options.openocdPath
 * @param {string} options.interfaceCfg  e.g. `interface/stlink.cfg`
 * @param {string} options.targetCfg     e.g. `target/stm32f4x.cfg`
 * @param {string} [options.scriptsPath]
 * @param {number} [options.gdbPort=3333]
 * @param {number} [options.telnetPort=4444]
 * @param {number} [options.adapterSpeed=4000]
 * @param {string[]} [options.extraCommands]
 * @param {number} [options.timeoutMs=15000]
 */
export async function startGdbServer(options) {
  const {
    openocdPath,
    interfaceCfg,
    targetCfg,
    scriptsPath,
    gdbPort = 3333,
    telnetPort = 4444,
    adapterSpeed = 4000,
    extraCommands = [],
    timeoutMs = 20_000,
  } = options;

  const args = [
    ...buildConfigArgs({ interfaceCfg, targetCfg, scriptsPath }),
    '-c', `gdb port ${gdbPort}`,
    '-c', `telnet port ${telnetPort}`,
    ...(adapterSpeed > 0 ? ['-c', `adapter speed ${adapterSpeed}`] : []),
    ...extraCommands.flatMap((c) => ['-c', c]),
  ];

  const child = spawn(openocdPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines = [];
  let exited = false;
  const append = (chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) logLines.push(line);
    }
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
    const details = logLines.join('\n') || '(openocd 无输出)';
    if (exited) {
      const noProbe = /open failed|no device found|No ST-?Link|unable to open|USB communication|LIBUSB/i.test(details);
      throw new Error(
        (noProbe
          ? 'OpenOCD 没有找到调试器：请确认 ST-Link / CMSIS-DAP / J-Link 已连接，驱动已安装且未被其他程序占用。\n'
          : 'OpenOCD 启动失败并已退出。\n')
        + `--- openocd 输出 ---\n${details}`,
      );
    }
    throw new Error(
      `OpenOCD 未能在 ${Math.round(timeoutMs / 1000)} 秒内监听 ${gdbPort} 端口。\n`
      + `请检查调试器是否连接、驱动是否安装、端口是否被占用。\n--- openocd 输出 ---\n${details}`,
    );
  }

  return {
    process: child,
    gdbPort,
    telnetPort,
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
 * Build the OpenOCD argv for a `program` download. Kept separate so the
 * command line (mass erase / verify / reset) is testable without hardware.
 *
 * @param {object} options
 * @returns {string[]} openocd argv
 */
export function buildFlashArgs(options = {}) {
  const {
    interfaceCfg,
    targetCfg,
    scriptsPath,
    firmware,
    address = '',
    adapterSpeed = 4000,
    extraCommands = [],
    erase = 'none',
    verify = true,
    reset = true,
    logFile = '',
  } = options;

  const ext = String(firmware).toLowerCase().split('.').pop();
  const parts = [
    'program',
    `"${String(firmware).replace(/\\/g, '/')}"`,
    ...(ext === 'bin' && address ? [address] : []),
  ];
  if (verify) parts.push('verify');
  if (reset) parts.push('reset');
  parts.push('exit');

  // Flash driver name for the mass-erase command, e.g. target/stm32f4x.cfg → stm32f4x.
  const driver = String(targetCfg || '').split(/[\\/]/).pop().replace(/\.cfg$/i, '');
  const eraseCommands = erase === 'mass' && driver ? [`${driver} mass_erase`] : [];

  return [
    ...buildConfigArgs({ interfaceCfg, targetCfg, scriptsPath }),
    ...(adapterSpeed > 0 ? ['-c', `adapter speed ${adapterSpeed}`] : []),
    ...extraCommands.flatMap((c) => ['-c', c]),
    ...eraseCommands.flatMap((c) => ['-c', c]),
    '-c', parts.join(' '),
    ...(logFile ? ['-l', logFile] : []),
  ];
}

/**
 * One-shot program + verify + reset, then exit. This is the "下载" path.
 *
 * @param {object} options
 * @param {string} options.openocdPath
 * @param {string} options.firmware  .elf/.hex/.bin
 * @param {string} [options.address] required for raw .bin
 * @returns {Promise<{ok:boolean, output:string, durationMs:number}>}
 */
export async function flashFirmware(options) {
  const {
    openocdPath,
    timeoutMs = 120_000,
  } = options;

  const args = buildFlashArgs(options);

  const startedAt = Date.now();
  const child = spawn(openocdPath, args, {
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
  return {
    ok: code === 0,
    code,
    output: out.join(''),
    durationMs: Date.now() - startedAt,
  };
}

/** Detect the interface config from a probe id. */
export function interfaceConfigFor(probe) {
  const value = String(probe ?? '').toLowerCase();
  if (value.includes('cmsis') || value.includes('dap')) return 'interface/cmsis-dap.cfg';
  if (value.includes('jlink') || value.includes('j-link') || value === 'jlink') return 'interface/jlink.cfg';
  return 'interface/stlink.cfg';
}

export function openocdBinDir(openocdPath) {
  return openocdPath ? dirname(openocdPath) : '';
}
