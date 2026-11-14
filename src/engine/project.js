/**
 * Project discovery and inspection.
 *
 * "Open project" in the panel is just: point at a folder, find the most likely
 * build entry (Keil .uvprojx, CMakeLists.txt, Makefile), then resolve artifact,
 * SVD and toolchain from there.
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ensureDir, dirExists, fileExists } from '../util.js';
import { findSvdInPacks, findUv4 } from './toolchain.js';
import { readUvprojx } from './uvprojx.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'Objects', 'build', 'Build', 'Debug', 'Release',
]);

function walk(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower === 'cmakelists.txt' || lower === 'makefile' || lower === 'gnumakefile') out.push(full);
      if (lower.endsWith('.uvprojx') || lower.endsWith('.uvproj')) out.push(full);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    walk(full, depth - 1, out);
  }
}

/** Find build entry files under a directory (bounded depth). */
export function findProjectFiles(dir) {
  const found = [];
  walk(dir, 4, found);
  return found;
}

/**
 * Choose the best project entry for a folder.
 * @returns {{kind:'uvprojx'|'cmake'|'make', file:string, dir:string}|null}
 */
export function discoverProject(dir) {
  const files = findProjectFiles(dir);
  const uvprojx = files.filter((f) => f.toLowerCase().endsWith('.uvprojx'));
  if (uvprojx.length > 0) {
    // Prefer the shallowest path (usually the project root's MDK-ARM).
    uvprojx.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
    return { kind: 'uvprojx', file: uvprojx[0], dir: dirname(uvprojx[0]) };
  }
  const uvproj = files.filter((f) => f.toLowerCase().endsWith('.uvproj'));
  if (uvproj.length > 0) return { kind: 'uvprojx', file: uvproj[0], dir: dirname(uvproj[0]) };
  const cmake = files.find((f) => basename(f).toLowerCase() === 'cmakelists.txt');
  if (cmake) return { kind: 'cmake', file: cmake, dir: dirname(cmake) };
  const make = files.find((f) => /^(gnu)?makefile$/i.test(basename(f)));
  if (make) return { kind: 'make', file: make, dir: dirname(make) };
  return null;
}

/** Find the newest firmware artifact under a folder. */
export function findArtifact(dir, preferred = ['elf', 'axf', 'hex', 'bin']) {
  const found = [];
  const walkArtifact = (folder, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walkArtifact(full, depth - 1);
        continue;
      }
      const ext = entry.name.toLowerCase().split('.').pop();
      if (preferred.includes(ext)) {
        try {
          found.push({ path: full, ext, mtime: statSync(full).mtimeMs, size: statSync(full).size });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walkArtifact(dir, 4);
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

function findBuildDir(projectDir, configured) {
  const candidates = [
    configured,
    join(projectDir, 'build'),
    join(projectDir, 'Build'),
    join(projectDir, 'cmake-build-debug'),
    join(projectDir, 'cmake-build-release'),
    join(projectDir, 'out'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

/** Map device name -> candidate cmsis-svd file names, most specific first. */
export function svdCandidatesForDevice(device) {
  const name = String(device ?? '').toUpperCase().trim();
  if (!name) return [];
  const m = /^STM32([A-Z])(\d)(\d\d)/.exec(name);
  if (!m) return [];
  const family = `STM32${m[1]}${m[2]}`;
  const part = `STM32${m[1]}${m[2]}${m[3]}`; // STM32F407
  const table = {
    STM32F0: 'STM32F0x.svd',
    STM32F1: 'STM32F1xx.svd',
    STM32F2: 'STM32F2xx.svd',
    STM32F3: 'STM32F30x.svd',
    STM32F4: 'STM32F40x.svd',
    STM32F7: 'STM32F7x.svd',
    STM32L0: 'STM32L0xx.svd',
    STM32L1: 'STM32L1xx.svd',
    STM32L4: 'STM32L4x6.svd',
    STM32L5: 'STM32L5x2.svd',
    STM32G0: 'STM32G0x0.svd',
    STM32G4: 'STM32G4x4.svd',
    STM32H7: 'STM32H7x3.svd',
    STM32WB: 'STM32WBxx.svd',
    STM32WL: 'STM32WLxx.svd',
    STM32U5: 'STM32U5x5.svd',
  };
  const out = [`${part}.svd`, `${part}xx.svd`];
  if (table[family]) out.push(table[family]);
  out.push(`${family}x.svd`, `${family}xx.svd`);
  return [...new Set(out)];
}

/** First candidate file name (used in messages and cache paths). */
export function svdNameForDevice(device) {
  return svdCandidatesForDevice(device)[0] ?? '';
}

/**
 * Make sure an SVD is available. Order: explicit config -> Keil packs ->
 * already-cached download -> GitHub cmsis-svd download.
 */
export async function ensureSvd({ svdPath, device, packId, packRoot, cacheDir }) {
  if (svdPath && fileExists(svdPath)) return { path: svdPath, source: 'config' };
  const fromPacks = findSvdInPacks(packRoot, device, packId);
  if (fromPacks) return { path: fromPacks, source: 'keil-pack' };
  const candidates = svdCandidatesForDevice(device);
  if (candidates.length === 0) return { path: '', source: 'none' };
  for (const name of candidates) {
    const cached = join(cacheDir, name);
    if (fileExists(cached)) return { path: cached, source: 'cache', name };
  }

  const urls = [];
  for (const name of candidates) {
    urls.push(
      `https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/STMicro/${name}`,
      `https://raw.githubusercontent.com/posborne/cmsis-svd/master/data/STMicro/${name}`,
    );
  }
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const text = await response.text();
      if (!text.includes('<device')) continue;
      ensureDir(cacheDir);
      const name = basename(new URL(url).pathname);
      const cached = join(cacheDir, name);
      writeFileSync(cached, text, 'utf8');
      return { path: cached, source: 'download', url, name };
    } catch {
      /* try next mirror */
    }
  }
  return { path: '', source: 'unavailable', attempted: candidates[0] };
}

/**
 * Inspect a folder: project + device + artifacts + SVD + toolchain summary.
 *
 * @param {string} dir
 * @param {object} config plugin config
 */
export async function inspectProject(dir, config = {}) {
  const root = resolve(dir);
  const project = discoverProject(root);
  const result = {
    root,
    project,
    uvprojx: null,
    device: config.device || '',
    pack: '',
    artifact: '',
    artifactKind: '',
    debugArtifact: '',
    artifacts: [],
    buildDir: '',
    svd: null,
    backend: '',
    errors: [],
  };
  if (!project) {
    result.errors.push('未找到 .uvprojx / CMakeLists.txt / Makefile');
    return result;
  }
  if (project.kind === 'uvprojx') {
    try {
      const info = readUvprojx(project.file, config.target || undefined);
      result.uvprojx = info;
      result.device = config.device || info.device;
      result.pack = info.pack;
      result.buildDir = info.output.dirAbs;
      const candidatePaths = [
        info.output.elf,
        info.output.hex,
        join(info.output.dirAbs, `${info.output.name}.bin`),
      ];
      // The plugin's own CMake/GCC export lives in `<project.dir>/.dsh-gcc/build`.
      // When it has been built it is usually the freshest firmware, so include it
      // instead of always serving a stale Keil-built .axf/.hex from Objects/.
      const gccBuildDir = join(project.dir, '.dsh-gcc', 'build');
      if (dirExists(gccBuildDir)) {
        for (const found of findArtifact(gccBuildDir)) {
          if (['elf', 'axf', 'hex', 'bin'].includes(found.ext)) candidatePaths.push(found.path);
        }
      }
      const present = [];
      const seen = new Set();
      for (const candidate of candidatePaths) {
        if (seen.has(candidate) || !fileExists(candidate)) continue;
        seen.add(candidate);
        try {
          present.push({ path: candidate, ext: candidate.split('.').pop().toLowerCase(), mtime: statSync(candidate).mtimeMs });
        } catch {
          /* ignore */
        }
      }
      for (const found of findArtifact(info.output.dirAbs)) {
        if (seen.has(found.path)) continue;
        seen.add(found.path);
        present.push(found);
      }
      // For a download prefer the freshest image, breaking mtime ties toward the
      // more compact/authoritative format (.bin > .hex > .elf).
      const flashWeight = { bin: 3, hex: 2, elf: 1, axf: 1 };
      present.sort((a, b) => b.mtime - a.mtime || (flashWeight[b.ext] ?? 0) - (flashWeight[a.ext] ?? 0));
      result.artifacts = present;
      if (present.length > 0) {
        result.artifact = present[0].path;
        result.artifactKind = present[0].ext;
      }
      // Debugging needs symbols, so a .elf/.axf must be used even when a raw
      // .bin (which carries no debug info) was built more recently.
      const symbolic = present.filter((item) => item.ext === 'elf' || item.ext === 'axf');
      result.debugArtifact = symbolic.length > 0 ? symbolic[0].path : (present[0]?.path ?? '');
    } catch (error) {
      result.errors.push(String(error?.message ?? error));
    }
  } else if (project.kind === 'cmake') {
    result.buildDir = findBuildDir(root, config.buildDir);
    result.artifacts = findArtifact(result.buildDir || root);
    if (result.artifacts.length > 0) {
      result.artifact = result.artifacts[0].path;
      result.artifactKind = result.artifacts[0].ext;
    }
  } else {
    result.artifacts = findArtifact(root);
    if (result.artifacts.length > 0) {
      result.artifact = result.artifacts[0].path;
      result.artifactKind = result.artifacts[0].ext;
    }
  }

  const cacheDir = config.svdCacheDir || join(config.dataDir || '.', 'svd');
  result.svd = await ensureSvd({
    svdPath: config.svdPath,
    device: result.device,
    packId: result.pack,
    packRoot: config.keilPackRoot || undefined,
    cacheDir,
  });
  result.backend = project.kind === 'uvprojx'
    ? (findUv4(config.uv4Path) ? 'keil' : 'gcc')
    : 'gcc';
  return result;
}
