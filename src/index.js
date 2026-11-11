/**
 * dsh-stm32-toolkit — host entry.
 *
 * Registers the `stm32_*` tools, the `/stm32` slash command, the HTTP routes
 * used by the panel and (through the bundle) the panel itself.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerCommands } from './commands.js';
import { defineToolCompat } from './define-tool.js';
import { Stm32Service } from './service.js';
import { registerTools } from './tools.js';
import { listDirs } from './util.js';

export const name = 'dsh-stm32-toolkit';
export const inject = ['tools'];

const ROUTE_PREFIX = '/api/stm32';

export function apply(ctx) {
  const service = new Stm32Service();

  registerTools(ctx, service, defineToolCompat);
  registerCommands(ctx, service);

  ctx.effect(() => {
    const stop = () => {
      service.debug.stop().catch(() => {});
      service.serialClose().catch(() => {});
    };
    ctx.on('dispose', stop);
    return stop;
  }, 'stm32:stop-debug-session');

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handleRequest(req, res, service).catch((error) => {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }),
    }), 'stm32:http-routes');
  });

  // Warm the project up in the background so the panel has something to show.
  service.inspect(service.config.projectDir || process.cwd()).catch(() => {});
}

// ------------------------------------------------------------------ routes

async function handleRequest(req, res, service) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
  const method = (req.method ?? 'GET').toUpperCase();
  const body = method === 'POST' ? await readBody(req) : {};

  try {
    if (method === 'GET' && (route === '' || route === 'state')) {
      return sendJson(res, 200, { ok: true, state: await service.snapshot() });
    }
    if (method === 'GET' && route === 'logs') {
      return sendJson(res, 200, { ok: true, logs: service.logs.slice(-400) });
    }
    if (method === 'GET' && route === 'svd') {
      const svd = service.svd();
      if (!svd) return sendJson(res, 200, { ok: false, error: '没有可用的 SVD 文件' });
      const peripheralName = url.searchParams.get('peripheral');
      if (!peripheralName) {
        return sendJson(res, 200, {
          ok: true,
          name: svd.name,
          peripherals: svd.peripherals.map((p) => ({
            name: p.name,
            baseAddress: p.baseAddress,
            description: p.description,
            registers: p.registers.length,
          })),
        });
      }
      const peripheral = svd.byName.get(peripheralName.toUpperCase());
      if (!peripheral) return sendJson(res, 404, { ok: false, error: `SVD 中没有外设 ${peripheralName}` });
      return sendJson(res, 200, { ok: true, peripheral });
    }
    if (method === 'GET' && route === 'artifact') {
      const project = await service.inspect(service.config.projectDir || process.cwd());
      return sendJson(res, 200, { ok: true, artifact: project.artifact, artifacts: project.artifacts ?? [] });
    }
    if (method === 'GET' && route === 'fs') {
      return sendJson(res, 200, listDirectory(url.searchParams.get('path')));
    }
    if (method === 'GET' && route === 'serial') {
      return sendJson(res, 200, { ok: true, serial: service.serialState() });
    }
    if (method === 'GET' && route === 'rtt') {
      return sendJson(res, 200, { ok: true, rtt: service.rttState() });
    }
    if (method === 'GET' && route === 'pins') {
      return sendJson(res, 200, { ok: true, ...service.pins() });
    }
    if (method === 'GET' && route === 'ioc') {
      return sendJson(res, 200, { ok: true, ...service.iocInfo() });
    }
    if (method === 'GET' && route === 'env') {
      return sendJson(res, 200, {
        ok: true,
        toolchain: await service.getToolchain(true),
        cores: service.cores(),
        install: service.installState,
      });
    }
    if (method === 'GET' && route === 'symbols') {
      const address = url.searchParams.get('address');
      const query = url.searchParams.get('query');
      if (address) return sendJson(res, 200, { ok: true, ...(await service.symbolAt(address)) });
      if (query !== null && query !== '') {
        return sendJson(res, 200, { ok: true, ...(await service.symbolFind(query)) });
      }
      const loaded = await service.symbols();
      return sendJson(res, 200, loaded
        ? { ok: true, found: true, file: loaded.file, source: loaded.source, count: loaded.symbols.length }
        : { ok: true, found: false });
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });

    const action = body.action ?? route;
    return await handleAction(action, body, service, res);
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
  }
}

async function handleAction(action, body, service, res) {
  switch (action) {
    case 'config': {
      if (body.patch && typeof body.patch === 'object') {
        const config = service.saveConfig(body.patch);
        if (body.patch.projectDir !== undefined) await service.inspect(service.config.projectDir, true).catch(() => {});
        return sendJson(res, 200, { ok: true, config });
      }
      return sendJson(res, 200, { ok: true, config: service.config });
    }
    case 'inspect':
    case 'project': {
      const info = await service.inspect(body.dir || service.config.projectDir || process.cwd(), true);
      return sendJson(res, 200, { ok: true, project: summarizeProject(info) });
    }
    case 'build': {
      const job = service.build({ clean: Boolean(body.clean), target: body.target });
      job.catch((error) => service.log(`构建失败: ${error.message}`, 'error'));
      return sendJson(res, 202, { ok: true, started: true });
    }
    case 'clean': {
      const job = service.build({ clean: true, target: body.target });
      job.catch((error) => service.log(`清理失败: ${error.message}`, 'error'));
      return sendJson(res, 202, { ok: true, started: true });
    }
    case 'exportCmake': {
      const result = await service.exportCmake({ projectDir: body.projectDir, outputDir: body.outputDir });
      return sendJson(res, 200, { ok: true, export: result });
    }
    case 'flash': {
      const job = service.flash({
        artifact: body.artifact,
        address: body.address,
        erase: body.erase,
        verify: body.verify,
        reset: body.reset,
      });
      job.catch((error) => service.log(`下载失败: ${error.message}`, 'error'));
      return sendJson(res, 202, { ok: true, started: true });
    }
    case 'debugStart': {
      const job = service.debugStart({ elf: body.elf, runToMain: body.runToMain });
      job.catch((error) => service.log(`启动调试失败: ${error.message}`, 'error'));
      return sendJson(res, 202, { ok: true, started: true });
    }
    case 'debugStop':
      return sendJson(res, 200, { ok: true, state: await service.debugStop() });
    case 'debugStatus':
      return sendJson(res, 200, { ok: true, state: service.debug.state() });
    case 'debug': {
      const result = await service.debugAction(body.op ?? 'continue', { waitMs: body.waitMs ?? 0 });
      return sendJson(res, 200, { ok: true, result, state: service.debug.state() });
    }
    case 'breakpointList':
      return sendJson(res, 200, { ok: true, breakpoints: await service.debug.listBreakpoints() });
    case 'breakpointAdd': {
      if (body.kind === 'watch' || body.kind === 'readwatch' || body.kind === 'accesswatch') {
        const watchpoint = await service.debug.setWatchpoint(body.expression || body.location, {
          read: body.kind === 'readwatch',
          access: body.kind === 'accesswatch',
        });
        return sendJson(res, 200, { ok: true, breakpoint: watchpoint, breakpoints: service.debug.breakpoints });
      }
      const breakpoint = await service.debug.setBreakpoint(body.location, {
        condition: body.condition,
        hardware: body.hardware,
      });
      return sendJson(res, 200, { ok: true, breakpoint, breakpoints: service.debug.breakpoints });
    }
    case 'breakpointRemove':
      return sendJson(res, 200, { ok: true, ...(await service.debug.removeBreakpoint(body.id)) });
    case 'registers':
      return sendJson(res, 200, { ok: true, ...(await service.debug.registers()) });
    case 'peripheral': {
      const data = await service.debug.peripheral(body.name);
      return sendJson(res, 200, { ok: true, ...data });
    }
    case 'register':
      return sendJson(res, 200, { ok: true, register: await service.debug.register(body.name) });
    case 'memoryRead': {
      const data = await service.debug.readMemory(body.address, body.count ?? 64);
      return sendJson(res, 200, { ok: true, ...data });
    }
    case 'memoryWrite': {
      const result = await service.debug.writeMemory(body.address, body.data);
      return sendJson(res, 200, { ok: true, ...result });
    }
    case 'stack': {
      const frames = await service.debug.stack(body.depth ?? 24);
      const variables = body.locals === false ? [] : await service.debug.locals().catch(() => []);
      return sendJson(res, 200, { ok: true, frames, variables });
    }
    case 'eval':
      return sendJson(res, 200, { ok: true, result: await service.debug.evaluate(body.expression) });
    case 'disasm': {
      const instructions = await service.debug.disassemble(body.address, body.count ?? 16);
      return sendJson(res, 200, { ok: true, instructions });
    }
    case 'stopDebug':
      return sendJson(res, 200, { ok: true, state: await service.debugStop() });
    case 'serialPorts':
      return sendJson(res, 200, { ok: true, ports: await service.serialPorts() });
    case 'serialState':
      return sendJson(res, 200, { ok: true, serial: service.serialState() });
    case 'serialOpen':
      return sendJson(res, 200, { ok: true, serial: await service.serialOpen({ port: body.port, baud: body.baud }) });
    case 'serialClose':
      return sendJson(res, 200, { ok: true, serial: await service.serialClose() });
    case 'serialWrite':
      return sendJson(res, 200, {
        ok: true,
        write: service.serialWrite(body.data ?? '', { hex: Boolean(body.hex) }),
        serial: service.serialState(),
      });
    case 'serialClear':
      return sendJson(res, 200, { ok: true, serial: service.serialClear() });
    case 'envInstall': {
      const components = body.components && body.components !== 'all'
        ? String(body.components).split(',').map((item) => item.trim())
        : ['gcc', 'openocd'];
      const job = service.envInstall({ components, force: Boolean(body.force), url: body.url });
      job.catch((error) => service.log(`安装工具链失败: ${error.message}`, 'error'));
      return sendJson(res, 202, { ok: true, started: true });
    }
    case 'symbolFind':
      return sendJson(res, 200, { ok: true, ...(await service.symbolFind(body.query ?? '')) });
    case 'symbolAt':
      return sendJson(res, 200, { ok: true, ...(await service.symbolAt(body.address ?? '0')) });
    case 'symbolsInfo': {
      const loaded = await service.symbols(true);
      return sendJson(res, 200, loaded
        ? { ok: true, found: true, file: loaded.file, source: loaded.source, count: loaded.symbols.length }
        : { ok: true, found: false });
    }
    case 'iocSet':
      return sendJson(res, 200, { ok: true, ...service.iocSet(body.patch ?? {}) });
    case 'projectCreate':
      return sendJson(res, 200, { ok: true, ...service.createProject({ dir: body.dir, device: body.device, name: body.name, ledPin: body.ledPin }) });
    case 'rttStart':
      return sendJson(res, 200, { ok: true, rtt: await service.rttStart({ address: body.address, channel: body.channel }) });
    case 'rttStop':
      return sendJson(res, 200, { ok: true, rtt: await service.rttStop() });
    case 'rttState':
      return sendJson(res, 200, { ok: true, rtt: service.rttState() });
    case 'rttWrite':
      return sendJson(res, 200, { ok: true, write: service.rttWrite(body.text ?? ''), rtt: service.rttState() });
    case 'rttClear':
      return sendJson(res, 200, { ok: true, rtt: service.rttClear() });
    case 'pins':
      return sendJson(res, 200, { ok: true, ...service.pins() });
    case 'ioc':
      return sendJson(res, 200, { ok: true, ...service.iocInfo() });
    case 'env':
      return sendJson(res, 200, { ok: true, toolchain: await service.getToolchain(true), cores: service.cores(), install: service.installState });
    default:
      return sendJson(res, 404, { ok: false, error: `未知操作 ${action}` });
  }
}

function summarizeProject(info) {
  return {
    root: info.root,
    kind: info.project?.kind ?? '',
    file: info.project?.file ?? '',
    device: info.device,
    target: info.uvprojx?.target ?? '',
    targets: info.uvprojx?.targets ?? [],
    backend: info.backend,
    artifact: info.artifact,
    artifacts: (info.artifacts ?? []).slice(0, 8).map((a) => ({ path: a.path, ext: a.ext, size: a.size })),
    svd: info.svd,
    errors: info.errors ?? [],
  };
}

/**
 * Directory browser used by the settings page: no path → list drive roots,
 * otherwise list the sub-directories of `path`.
 */
function listDirectory(raw) {
  const input = (raw ?? '').trim();
  if (!input) {
    const drives = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      const root = `${letter}:\\`;
      if (existsSync(root)) drives.push({ name: root, path: root });
    }
    return { ok: true, path: '', parent: null, dirs: drives, drives };
  }
  const dir = resolve(input);
  if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` };
  const dirs = listDirs(dir)
    .map((p) => ({ name: p.split(/[\\/]/).pop() || p, path: p }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = resolve(dir, '..');
  return { ok: true, path: dir, parent: parent === dir ? null : parent, dirs };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}
