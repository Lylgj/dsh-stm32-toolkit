/**
 * One-click toolchain installation (xPack arm-none-eabi-gcc / OpenOCD).
 *
 * Downloads the official xPack Windows archive from GitHub releases, expands it
 * under `<DSH_HOME>/stm32/tools/<component>` and reports where the binaries
 * landed. No native dependencies: `fetch` + PowerShell `Expand-Archive`.
 */

import { createWriteStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir, fileExists, run } from '../util.js';

const USER_AGENT = 'dsh-stm32-toolkit';

/** Known-good fallbacks, used when the GitHub API is unreachable or rate limited. */
const COMPONENTS = {
  gcc: {
    label: 'arm-none-eabi-gcc / gdb',
    repo: 'xpack-dev-tools/arm-none-eabi-gcc-xpack',
    asset: /win32-x64\.zip$/i,
    binaries: ['arm-none-eabi-gcc.exe', 'arm-none-eabi-gdb.exe'],
    fallback: 'https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v15.2.1-1.1/xpack-arm-none-eabi-gcc-15.2.1-1.1-win32-x64.zip',
  },
  openocd: {
    label: 'OpenOCD',
    repo: 'xpack-dev-tools/openocd-xpack',
    asset: /win32-x64\.zip$/i,
    binaries: ['openocd.exe'],
    fallback: 'https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7-win32-x64.zip',
  },
};

/** Pick the Windows x64 zip out of a GitHub "latest release" payload. */
export function pickReleaseAsset(release, assetPattern) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const hit = assets.find((asset) => assetPattern.test(String(asset?.name ?? '')) && asset?.browser_download_url);
  return hit
    ? { name: hit.name, url: hit.browser_download_url, size: Number(hit.size) || 0, version: release.tag_name ?? '' }
    : null;
}

/** Recursively find the executables we care about, relative to the extract root. */
export function findInstalledBinaries(root, names, depth = 5) {
  const found = new Map();
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, level + 1);
      } else if (wanted.has(entry.name.toLowerCase())) {
        if (!found.has(entry.name.toLowerCase())) found.set(entry.name.toLowerCase(), full);
      }
    }
  };
  walk(root, 0);
  return Object.fromEntries(found);
}

async function githubLatest(repo) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Resolve the latest Windows x64 asset through the plain github.com release
 * pages (no API token, no rate limit). Returns null when unavailable.
 */
async function discoverAsset(repo, assetPattern) {
  try {
    const latest = await fetch(`https://github.com/${repo}/releases/latest`, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!latest.ok) return null;
    const tag = String(latest.url ?? '').split('/tag/')[1];
    if (!tag) return null;
    const page = await fetch(`https://github.com/${repo}/releases/expanded_assets/${tag}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!page.ok) return null;
    const html = await page.text();
    for (const match of html.matchAll(/href="([^"]+\.zip)"/g)) {
      const href = match[1];
      const name = href.split('/').pop() ?? '';
      if (!assetPattern.test(name)) continue;
      return { url: href.startsWith('http') ? href : `https://github.com${href}`, version: tag };
    }
    return null;
  } catch {
    return null;
  }
}

/** Download `url` into `dest` and log progress every ~10%. */
async function download(url, dest, { log, timeoutMs = 30 * 60 * 1000 } = {}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error('下载长时间无数据（网络卡住）')), 90_000);
  };
  armStall();
  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal,
    });
  } catch (error) {
    clearTimeout(stallTimer);
    throw new Error(`下载失败: ${error?.message ?? error}`);
  }
  if (!response.ok) {
    clearTimeout(stallTimer);
    throw new Error(`下载失败: HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    clearTimeout(stallTimer);
    throw new Error('下载失败: 响应为空');
  }
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  let lastLogged = -1;
  const file = createWriteStream(dest);
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    armStall();
    received += chunk.length;
    const percent = total ? Math.floor((received / total) * 100) : 0;
    if (total && percent >= lastLogged + 10) {
      lastLogged = percent;
      log?.(`下载中 ${percent}% (${(received / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`);
    }
  });
  try {
    await pipeline(body, file);
  } finally {
    clearTimeout(stallTimer);
  }
  return { bytes: received, total };
}

async function expandArchive(zipPath, destination, log) {
  ensureDir(destination);
  log?.(`解压 ${zipPath} → ${destination}`);
  const command = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`;
  const result = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { timeoutMs: 10 * 60 * 1000 });
  if (!result.ok) throw new Error(`解压失败: ${(result.stderr || result.stdout || '').trim()}`);
}

function scriptsDirFor(root) {
  const candidates = [
    join(root, 'openocd', 'scripts'),
    join(root, 'share', 'openocd', 'scripts'),
    join(root, 'scripts'),
  ];
  return candidates.find((dir) => fileExists(dir)) ?? '';
}

/**
 * Install one component.
 *
 * @param {'gcc'|'openocd'} component
 * @param {{dataDir:string, log?:(text:string)=>void, force?:boolean, url?:string}} options
 * @returns {Promise<{component:string, ok:boolean, dir:string, binaries:object, scripts?:string, version?:string}>}
 */
export async function installComponent(component, options = {}) {
  const spec = COMPONENTS[component];
  if (!spec) throw new Error(`未知工具链组件: ${component}`);
  const { dataDir, log, force = false, url } = options;
  const toolsDir = join(dataDir, 'tools');
  const targetDir = join(toolsDir, component);

  if (!force) {
    const existing = findInstalledBinaries(targetDir, spec.binaries);
    if (Object.keys(existing).length === spec.binaries.length) {
      log?.(`${spec.label} 已安装: ${targetDir}`);
      return { component, ok: true, dir: targetDir, binaries: existing, scripts: scriptsDirFor(targetDir), cached: true };
    }
  }

  let downloadUrl = url || '';
  let version = '';
  if (!downloadUrl) {
    const release = await githubLatest(spec.repo);
    const asset = pickReleaseAsset(release, spec.asset);
    if (asset) {
      downloadUrl = asset.url;
      version = asset.version;
    } else {
      const discovered = await discoverAsset(spec.repo, spec.asset);
      if (discovered) {
        downloadUrl = discovered.url;
        version = discovered.version;
        log?.(`GitHub API 不可用，已从发布页解析地址 (${version})`);
      } else {
        downloadUrl = spec.fallback;
        log?.(`GitHub API 不可用，使用内置地址: ${downloadUrl}`);
      }
    }
  }

  ensureDir(toolsDir);
  const stamp = Date.now();
  const zipPath = join(toolsDir, `.${component}-${stamp}.zip`);
  const candidates = [downloadUrl];
  if (/^https:\/\/github\.com\//i.test(downloadUrl)) {
    candidates.push(`https://ghproxy.net/${downloadUrl}`);
  }
  let lastError = null;
  for (const candidate of candidates) {
    const via = candidate.includes('ghproxy.net') ? 'GitHub 镜像' : 'GitHub 直连';
    log?.(`开始安装 ${spec.label}（${via}）…`);
    try {
      await download(candidate, zipPath, { log });
      const size = statSync(zipPath).size;
      if (size < 1024 * 1024) throw new Error(`下载文件异常（${size} 字节），可能被重定向到错误页面`);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      log?.(`下载失败（${via}）: ${error.message}`);
      try {
        if (fileExists(zipPath)) unlinkSync(zipPath);
      } catch {
        /* ignore */
      }
    }
  }
  if (lastError) throw lastError;
  try {
    await expandArchive(zipPath, targetDir, log);
  } finally {
    try {
      if (fileExists(zipPath)) unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
  }

  const binaries = findInstalledBinaries(targetDir, spec.binaries);
  const missing = spec.binaries.filter((name) => !binaries[name.toLowerCase()]);
  if (missing.length) throw new Error(`安装后缺少可执行文件: ${missing.join(', ')}`);
  const scripts = scriptsDirFor(targetDir);
  log?.(`${spec.label} 安装完成: ${targetDir}`);
  return { component, ok: true, dir: targetDir, binaries, scripts, version };
}

/** Install several components in order; returns per-component results. */
export async function installToolchain(components, options = {}) {
  const results = [];
  for (const component of components) {
    results.push(await installComponent(component, options));
  }
  return results;
}

export { COMPONENTS };
