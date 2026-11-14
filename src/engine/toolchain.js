/**
 * Toolchain discovery: Keil UV4, arm-none-eabi GCC/GDB, OpenOCD, pyOCD,
 * STM32CubeProgrammer and connected debug probes.
 *
 * Everything is best-effort: a missing tool is reported, never thrown, so the
 * panel can show a checklist instead of failing to load.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dirExists, fileExists, run, which } from '../util.js';
import { findJLinkTools } from './jlink.js';

const KEIL_ROOTS = () => {
  const roots = [
    process.env.KEIL_ROOT,
    'C:\\Keil_v5',
    'D:\\Keil_v5',
    'C:\\Keil',
    'D:\\Keil',
    'C:\\Program Files\\Keil_v5',
    'C:\\Program Files (x86)\\Keil_v5',
    'D:\\Program Files\\Keil_v5',
    'D:\\Program Files (x86)\\Keil_v5',
  ];
  return roots.filter(Boolean);
};

/** Find UV4.exe (Keil MDK command-line builder). */
export function findUv4(configuredPath) {
  if (configuredPath) {
    if (fileExists(configuredPath)) return configuredPath;
    if (dirExists(configuredPath)) {
      const candidate = join(configuredPath, 'UV4.exe');
      if (fileExists(candidate)) return candidate;
    }
  }
  const onPath = which('UV4');
  if (onPath) return onPath;
  for (const root of KEIL_ROOTS()) {
    const candidate = join(root, 'UV4', 'UV4.exe');
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/** Find the Keil pack root that contains device packs. */
export function findKeilPackRoot(configuredPath) {
  if (configuredPath && dirExists(configuredPath)) return configuredPath;
  for (const root of KEIL_ROOTS()) {
    const candidate = join(root, 'ARM', 'PACK');
    if (dirExists(candidate)) return candidate;
  }
  return null;
}

/** arm-none-eabi toolchain executables. */
export function findGccTools(configured = {}) {
  // Also look next to the configured gcc/gdb: one-click installs and manual
  // unzips usually keep objcopy/size/nm/ninja in the same bin directory.
  const extraDirs = [
    configured.gccBinDir,
    configured.toolchainBinDir,
    configured.gccPath && dirname(configured.gccPath),
    configured.gdbPath && dirname(configured.gdbPath),
  ].filter(Boolean);
  return {
    gcc: configured.gccPath || which('arm-none-eabi-gcc', extraDirs),
    gdb: configured.gdbPath || which('arm-none-eabi-gdb', extraDirs),
    objcopy: which('arm-none-eabi-objcopy', extraDirs),
    size: which('arm-none-eabi-size', extraDirs),
    nm: which('arm-none-eabi-nm', extraDirs),
    make: configured.makePath || which('make', extraDirs) || which('mingw32-make', extraDirs) || which('gmake', extraDirs),
    cmake: configured.cmakePath || which('cmake', extraDirs),
    ninja: configured.ninjaPath || which('ninja', extraDirs),
  };
}

export function findProgrammers(configured = {}) {
  const cubeProgrammer = configured.cubeProgrammerPath
    || which('STM32_Programmer_CLI')
    || [
      'C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin\\STM32_Programmer_CLI.exe',
      'C:\\Program Files (x86)\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin\\STM32_Programmer_CLI.exe',
      'D:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin\\STM32_Programmer_CLI.exe',
    ].find((p) => fileExists(p))
    || null;
  const jlinkCandidate = configured.jlinkPath || which('JLinkExe') || which('JLink.exe');
  // JDK ships an unrelated `jlink.exe`; only trust a SEGGER install.
  const jlink = jlinkCandidate && !/\\jdk[-\\]/i.test(jlinkCandidate) ? jlinkCandidate : null;
  const jlinkTools = findJLinkTools(configured);
  return {
    cubeProgrammer,
    pyocd: configured.pyocdPath || which('pyocd'),
    stlink: which('ST-LINK_CLI') || which('st-flash'),
    jlink: jlink || jlinkTools.exe,
    jlinkGdbServer: jlinkTools.gdbserver,
  };
}

/** Ask Windows which USB debug probes are currently present. */
export async function detectProbes() {
  if (process.platform !== 'win32') return { supported: false, probes: [] };
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Get-PnpDevice -PresentOnly -Class USB |',
    "Where-Object { $_.FriendlyName -match '(ST-?Link|STLink|CMSIS-?DAP|DAPLink|J-?Link|JLink|Black Magic|DFU)' } |",
    'Select-Object -ExpandProperty FriendlyName',
  ].join('\n');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 8000 });
  const probes = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { supported: true, probes: [...new Set(probes)], error: result.ok ? '' : result.stderr.trim() };
}

/** Version strings for the doctor page (parallel, tolerant). */
async function versionOf(exe, args, timeoutMs = 5000) {
  if (!exe) return '';
  const result = await run(exe, args, { timeoutMs }).catch(() => null);
  if (!result) return '';
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split(/\r?\n/)[0] ?? '';
}

/**
 * Full environment report.
 * @param {object} config plugin config
 */
export async function detectToolchain(config = {}) {
  const uv4 = findUv4(config.uv4Path);
  const packRoot = findKeilPackRoot(config.keilPackRoot);
  const gcc = findGccTools(config);
  const programmers = findProgrammers(config);
  const openocdPath = config.openocdPath
    || which('openocd')
    || (config.openocdBinDir ? join(config.openocdBinDir, process.platform === 'win32' ? 'openocd.exe' : 'openocd') : null);
  const openocd = openocdPath && fileExists(openocdPath) ? openocdPath : null;

  const jlinkTools = findJLinkTools(config);
  const jlinkVersion = (() => {
    const m = /JLink_V(\d)(\d+)/i.exec(jlinkTools.dir || '');
    return m ? `V${m[1]}.${m[2]}` : '';
  })();
  const jlink = {
    exe: jlinkTools.exe,
    gdbserver: jlinkTools.gdbserver,
    dir: jlinkTools.dir,
    version: jlinkVersion,
    installed: Boolean(jlinkTools.exe && jlinkTools.gdbserver),
  };

  const [gccVersion, gdbVersion, openocdVersion, probes] = await Promise.all([
    versionOf(gcc.gcc, ['--version']),
    versionOf(gcc.gdb, ['--version']),
    versionOf(openocd, ['--version']),
    detectProbes().catch(() => ({ supported: false, probes: [] })),
  ]);

  // J-Link needs only GDB + its own server (no OpenOCD).
  const jlinkReady = Boolean(gcc.gcc && gcc.gdb && jlink.installed);

  return {
    keil: { uv4, packRoot, installed: Boolean(uv4) },
    gcc: { ...gcc, version: gccVersion, gdbVersion, installed: Boolean(gcc.gcc && gcc.gdb) },
    openocd: { path: openocd, version: openocdVersion, installed: Boolean(openocd) },
    jlink,
    programmers,
    probes,
    backend: uv4 ? 'keil' : gcc.gcc ? 'gcc' : '',
    ready: Boolean(uv4 || (gcc.gcc && gcc.gdb && (openocd || jlink.installed))),
    jlinkReady,
  };
}

/** Locate an SVD file inside Keil packs for a device + pack id. */
export function findSvdInPacks(packRoot, device, packId) {
  if (!packRoot || !dirExists(packRoot)) return null;
  const candidates = [];
  // PackID looks like `Keil.STM32F4xx_DFP.3.1.1`
  const parts = String(packId ?? '').split('.');
  if (parts.length >= 3) {
    const vendor = parts[0];
    const packName = parts[1];
    candidates.push(join(packRoot, vendor, packName));
  }
  candidates.push(join(packRoot, 'Keil'));
  // The SVD name usually matches the device family: STM32F407VGTx -> STM32F40x.svd
  const family = String(device ?? '').toUpperCase().match(/^STM32([A-Z]\d)/);
  const wanted = family ? [`STM32${family[1]}x.svd`, `STM32${family[1]}.svd`] : [];
  const roots = candidates.filter((p) => dirExists(p));
  for (const root of roots) {
    for (const name of wanted) {
      const found = walkFor(root, name, 6);
      if (found) return found;
    }
  }
  return null;
}

function walkFor(root, fileName, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'SVD' || entry.name === 'CMSIS' || /dfp/i.test(entry.name) || /^\d+\.\d+\.\d+$/.test(entry.name)) {
      const found = walkFor(join(root, entry.name), fileName, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Quick "is that file newer than the firmware" helper for the UI. */
export function newerThan(sourceFiles, artifact) {
  if (!artifact || !existsSync(artifact)) return false;
  const target = statSync(artifact).mtimeMs;
  return sourceFiles.some((file) => {
    try {
      return statSync(file).mtimeMs > target;
    } catch {
      return false;
    }
  });
}
