/**
 * Plugin state shared by tools, the HTTP routes and the panel.
 *
 * One `Stm32Service` instance owns: the config file, toolchain detection,
 * current project, SVD, build/flash wrappers and the live debug session.
 * Everything the panel needs is available from `snapshot()`.
 */

import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expandPath, ensureDir, fileExists, readJson, run, writeJson } from './util.js';
import { buildProject } from './engine/build.js';
import { exportKeilToCmake } from './engine/export.js';
import { DebugSession } from './engine/debug.js';
import { installComponent } from './engine/install.js';
import { generateProject, loadIoc, memoryForDevice, parseIoc, setIocValue } from './engine/ioc.js';
import { flashFirmware } from './engine/openocd.js';
import { buildPinMap } from './engine/pins.js';
import { findArtifact, inspectProject } from './engine/project.js';
import { RttMonitor, resolveRttAddress } from './engine/rtt.js';
import { findSymbols, loadSymbols, lookupAddress } from './engine/symbols.js';
import { parseSvd } from './engine/svd.js';
import { listSerialPorts, SerialBridge } from './engine/serial.js';
import { detectToolchain, findGccTools, findUv4 } from './engine/toolchain.js';

export const CONFIG_VERSION = 1;

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function defaultDataDir() {
  return join(dshHome(), 'stm32');
}

const DEFAULTS = {
  version: CONFIG_VERSION,
  projectDir: '',
  uvprojx: '',
  target: '',
  device: '',
  svdPath: '',
  backend: 'auto',
  uv4Path: '',
  openocdPath: '',
  openocdScripts: '',
  gccPath: '',
  gdbPath: '',
  makePath: '',
  cmakePath: '',
  ninjaPath: '',
  cubeProgrammerPath: '',
  probe: 'stlink',
  interfaceCfg: '',
  targetCfg: '',
  adapterSpeed: 4000,
  gdbPort: 3333,
  telnetPort: 4444,
  runToMain: true,
  openocdCommands: [],
  binAddress: '0x08000000',
  flashErase: 'none',
  flashVerify: true,
  flashReset: true,
  serialPort: '',
  serialBaud: 115200,
  rttPort: 9090,
  rttChannel: 0,
  rttSearchStart: '0x20000000',
  rttSearchSize: 0x20000,
  symbolFile: '',
  iocFile: '',
  core: 0,
  buildDir: '',
  cmakeToolchainFile: '',
  cmakeBuildType: '',
  cmakeExtraArgs: [],
  buildTimeoutMs: 20 * 60 * 1000,
};

export class Stm32Service extends EventEmitter {
  constructor(configDir = defaultDataDir()) {
    super();
    this.dataDir = configDir;
    this.configFile = join(configDir, 'config.json');
    this.config = { ...DEFAULTS, ...(readJson(this.configFile, {}) ?? {}) };
    this.logs = [];
    this.toolchain = null;
    this.toolchainAt = 0;
    this.project = null;
    this.projectAt = 0;
    this.svdCache = null;
    this.debug = new DebugSession(this.debugConfig(), { log: (text) => this.log(text) });
    this.lastBuild = null;
    this.lastFlash = null;
    this.serialBridge = null;
    this.serialPort = '';
    this.serialBaud = 0;
    this.serialLines = [];
    this.serialBytes = 0;
    this.rtt = null;
    this.symbolsCache = null;
    this.symbolsAt = 0;
    this.installState = { running: false, component: '', percent: 0, message: '' };
    this.buildCounter = 0;
    this.debug.on('stopped', (stop) => this.log(
      `暂停: ${stop.reason}${stop.func ? ` @ ${stop.func}` : ''}${stop.file ? ` (${stop.file}:${stop.line})` : ''}`,
    ));
    this.debug.on('target', (text) => this.log(text.trimEnd(), 'target'));
    this.debug.on('exit', () => this.emit('debug-exit'));
  }

  // ---------------------------------------------------------------- config

  saveConfig(patch) {
    const next = { ...this.config, ...patch, version: CONFIG_VERSION };
    // Paths typed by hand may contain %VARS% or ~.
    for (const key of ['projectDir', 'uvprojx', 'svdPath', 'uv4Path', 'openocdPath', 'openocdScripts',
      'gccPath', 'gdbPath', 'makePath', 'cmakePath', 'ninjaPath', 'cubeProgrammerPath', 'symbolFile', 'iocFile']) {
      if (typeof next[key] === 'string' && next[key]) next[key] = resolvePathLike(next[key]);
    }
    this.config = next;
    ensureDir(this.dataDir);
    writeJson(this.configFile, this.config);
    this.refreshDebugConfig();
    this.projectAt = 0;
    this.toolchainAt = 0;
    this.emit('config', this.config);
    return this.config;
  }

  refreshDebugConfig() {
    this.debug.config = this.debugConfig();
  }

  debugConfig() {
    const targetCfg = this.config.targetCfg
      || this.project?.uvprojx?.debugger?.recommendedTarget
      || '';
    return {
      ...this.config,
      targetCfg,
      projectDir: this.project?.root ?? this.config.projectDir,
      svd: this.svd(),
    };
  }

  log(text, level = 'info') {
    const entry = { time: new Date().toISOString(), level, text: String(text).replace(/\s+$/, '') };
    if (!entry.text) return;
    this.logs.push(entry);
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    this.emit('log', entry);
  }

  // ------------------------------------------------------------ toolchain

  async getToolchain(force = false) {
    if (!force && this.toolchain && Date.now() - this.toolchainAt < 30_000) return this.toolchain;
    this.toolchain = await detectToolchain(this.config);
    this.toolchainAt = Date.now();
    // Fill in the paths that were auto-discovered so the debugger works.
    const gcc = findGccTools(this.config);
    if (!this.config.uv4Path && this.toolchain.keil.uv4) this.config.uv4Path = this.toolchain.keil.uv4;
    if (!this.config.openocdPath && this.toolchain.openocd.path) this.config.openocdPath = this.toolchain.openocd.path;
    if (!this.config.gdbPath && gcc.gdb) this.config.gdbPath = gcc.gdb;
    if (!this.config.gccPath && gcc.gcc) this.config.gccPath = gcc.gcc;
    if (!this.config.makePath && gcc.make) this.config.makePath = gcc.make;
    if (!this.config.cmakePath && gcc.cmake) this.config.cmakePath = gcc.cmake;
    if (!this.config.ninjaPath && gcc.ninja) this.config.ninjaPath = gcc.ninja;
    this.refreshDebugConfig();
    return this.toolchain;
  }

  // -------------------------------------------------------------- project

  async inspect(dir, force = false) {
    const wanted = dir ? resolvePathLike(dir) : (this.config.projectDir || process.cwd());
    if (!force && this.project && this.project.root === wanted && Date.now() - this.projectAt < 15_000) {
      return this.project;
    }
    this.config.projectDir = wanted;
    const toolchain = await this.getToolchain();
    const info = await inspectProject(wanted, {
      ...this.config,
      uv4Path: this.config.uv4Path || toolchain.keil.uv4,
      keilPackRoot: toolchain.keil.packRoot,
      dataDir: this.dataDir,
      svdCacheDir: join(this.dataDir, 'svd'),
    });
    info.uv4 = this.config.uv4Path || toolchain.keil.uv4;
    info.targetCfg = info.uvprojx?.debugger?.recommendedTarget || '';
    info.interfaceCfg = this.config.interfaceCfg
      || info.uvprojx?.debugger?.recommendedInterface
      || 'interface/stlink.cfg';
    this.project = info;
    this.projectAt = Date.now();
    this.refreshDebugConfig();
    this.log(`工程: ${info.root} (${info.project?.kind ?? '未识别'})`);
    if (info.device) this.log(`芯片: ${info.device}`);
    if (info.svd?.path) this.log(`SVD: ${info.svd.path}`);
    this.emit('project', info);
    return info;
  }

  svd() {
    const path = this.project?.svd?.path || this.config.svdPath;
    if (!path || !fileExists(path)) return null;
    try {
      const mtime = statSync(path).mtimeMs;
      if (this.svdCache && this.svdCache.path === path && this.svdCache.mtime === mtime) return this.svdCache.svd;
      const svd = parseSvd(readFileSync(path, 'utf8'));
      this.svdCache = { path, mtime, svd };
      return svd;
    } catch (error) {
      this.log(`解析 SVD 失败: ${error.message}`, 'warn');
      return null;
    }
  }

  // ---------------------------------------------------------------- build

  async build(options = {}) {
    const project = await this.inspect(options.dir || this.config.projectDir);
    if (!project.project) throw new Error('当前目录没有可构建的工程');
    this.buildCounter += 1;
    this.lastBuild = { running: true, startedAt: Date.now(), backend: project.backend };
    this.emit('build-start');
    const label = project.backend === 'keil'
      ? 'Keil UV4'
      : (project.project?.kind === 'uvprojx' ? 'Keil 工程 → CMake/GCC' : project.project?.kind);
    this.log(`开始构建 (${label})…`);
    let result;
    try {
      result = await buildProject(project, {
        ...this.config,
        uv4Path: this.config.uv4Path || this.toolchain?.keil?.uv4,
        cmakePath: this.config.cmakePath || findGccTools(this.config).cmake,
        makePath: this.config.makePath || findGccTools(this.config).make,
      }, options);
    } catch (error) {
      result = {
        ok: false,
        backend: project.backend,
        code: -1,
        durationMs: 0,
        log: String(error?.message ?? error),
        errors: [{ file: '', line: 0, message: String(error?.message ?? error) }],
        warnings: [],
        artifacts: [],
      };
    }
    this.lastBuild = { ...result, running: false, finishedAt: Date.now() };
    for (const error of result.errors ?? []) {
      this.log(`${error.file || ''}${error.line ? `:${error.line}` : ''} error: ${error.message}`, 'error');
    }
    this.log(
      result.ok
        ? `构建成功 (${(result.durationMs / 1000).toFixed(1)}s)${result.codeText ? ` — ${result.codeText}` : ''}`
        : `构建失败 (${result.errors?.length ?? 0} 个错误)`,
      result.ok ? 'info' : 'error',
    );
    this.project = null; // artifact list changed
    this.emit('build-end', this.lastBuild);
    return this.lastBuild;
  }

  async clean(options = {}) {
    return this.build({ ...options, clean: true });
  }

  /** Export a Keil .uvprojx to a CMake/GCC tree (used by tool + HTTP route). */
  async exportCmake(options = {}) {
    const project = await this.inspect(options.projectDir || this.config.projectDir);
    if (!project.project) throw new Error('当前目录没有可导出的工程');
    if (project.project.kind !== 'uvprojx') throw new Error('只有 Keil .uvprojx 工程需要导出');
    const result = exportKeilToCmake(project, { dir: options.outputDir || undefined });
    this.log(`已导出 CMake: ${result.dir}（${result.sources} 个源文件，跳过 ${result.skipped.length} 个）`);
    return { ok: true, ...result };
  }

  // ---------------------------------------------------------------- flash

  /**
   * Download the firmware.
   * @param {{artifact?:string, address?:string, erase?:string, verify?:boolean, reset?:boolean}} [options]
   */
  async flash(options = {}) {
    const project = await this.inspect(this.config.projectDir);
    const toolchain = await this.getToolchain();
    let artifact = options.artifact || project.artifact;
    if (!artifact) {
      artifact = (this.lastBuild?.artifacts ?? []).find((item) => ['elf', 'hex', 'bin'].includes(item.ext))?.path ?? '';
    }
    if (!artifact) {
      const found = findArtifact(project.buildDir || project.root);
      artifact = found.find((a) => a.ext === 'elf' || a.ext === 'hex' || a.ext === 'bin')?.path ?? '';
    }
    if (!artifact) throw new Error('找不到可下载的固件（.elf/.hex/.bin），请先构建');
    const openocd = this.config.openocdPath || toolchain.openocd.path;
    const ext = artifact.toLowerCase().split('.').pop();
    const address = options.address || (ext === 'bin' ? this.config.binAddress : '');
    const erase = options.erase ?? this.config.flashErase;
    const verify = options.verify ?? this.config.flashVerify;
    const reset = options.reset ?? this.config.flashReset;
    this.log(`开始下载: ${artifact}${erase === 'mass' ? '（整片擦除）' : ''}`);
    this.lastFlash = { running: true, startedAt: Date.now() };
    this.emit('flash-start');

    let result;
    if (openocd) {
      result = await flashFirmware({
        openocdPath: openocd,
        interfaceCfg: options.interfaceCfg || project.interfaceCfg || this.config.interfaceCfg,
        targetCfg: options.targetCfg || project.targetCfg || this.config.targetCfg,
        scriptsPath: this.config.openocdScripts,
        firmware: artifact,
        address,
        adapterSpeed: this.config.adapterSpeed,
        extraCommands: this.config.openocdCommands,
        erase,
        verify,
        reset,
      });
      result.backend = 'openocd';
    } else if (this.config.uv4Path && project.project?.kind === 'uvprojx') {
      // Keil's own download: UV4 -f <project> -t <target>
      const args = ['-f', project.project.file, '-t', project.uvprojx?.target ?? 'Debug'];
      const keil = await run(this.config.uv4Path, args, { timeoutMs: 120_000 });
      result = { ok: keil.code === 0, backend: 'keil', output: keil.stdout + keil.stderr, durationMs: keil.durationMs };
    } else {
      throw new Error('没有可用的下载器：需要 OpenOCD，或已安装的 Keil UV4');
    }
    this.lastFlash = {
      ...result,
      artifact,
      running: false,
      finishedAt: Date.now(),
      output: String(result.output ?? '').slice(-8000),
    };
    this.log(result.ok ? '下载完成' : '下载失败', result.ok ? 'info' : 'error');
    if (!result.ok && result.output) this.log(result.output.slice(-2000), 'error');
    this.emit('flash-end', this.lastFlash);
    return this.lastFlash;
  }

  // ---------------------------------------------------------------- serial

  serialPorts() {
    return listSerialPorts();
  }

  serialState() {
    return {
      open: Boolean(this.serialBridge?.active),
      port: this.serialPort,
      baud: this.serialBaud,
      bytes: this.serialBytes,
      lines: this.serialLines.slice(-120),
    };
  }

  async serialOpen(options = {}) {
    const port = options.port || this.config.serialPort;
    const baud = Number(options.baud || this.config.serialBaud) || 115200;
    if (!port) throw new Error('请选择串口');
    await this.serialClose();
    const bridge = new SerialBridge({ port, baud });
    bridge.on('data', (buffer) => {
      this.serialBytes += buffer.length;
      const text = buffer.toString('utf8');
      this.serialLines.push({ time: Date.now(), text, hex: buffer.toString('hex').toUpperCase(), bytes: buffer.length });
      if (this.serialLines.length > 500) this.serialLines.splice(0, this.serialLines.length - 500);
      this.emit('serial-data', text);
    });
    bridge.on('error', (error) => this.log(`串口错误: ${error.message}`, 'error'));
    bridge.on('close', () => {
      this.serialBridge = null;
      this.log('串口已关闭');
      this.emit('serial-close');
    });
    this.serialBridge = bridge;
    try {
      await bridge.open();
    } catch (error) {
      this.serialBridge = null;
      throw error;
    }
    this.serialPort = port;
    this.serialBaud = baud;
    this.serialBytes = 0;
    this.config.serialPort = port;
    this.config.serialBaud = baud;
    this.log(`串口已打开: ${port} @ ${baud}`);
    return this.serialState();
  }

  async serialClose() {
    if (!this.serialBridge) return this.serialState();
    this.serialBridge.close();
    this.serialBridge = null;
    this.log('串口已关闭');
    return this.serialState();
  }

  serialWrite(data, { hex = false } = {}) {
    if (!this.serialBridge?.active) throw new Error('串口未打开');
    const bytes = hex ? this.serialBridge.writeHex(data) : this.serialBridge.write(data);
    return { ok: true, bytes };
  }

  serialClear() {
    this.serialLines = [];
    this.serialBytes = 0;
    return this.serialState();
  }

  // ------------------------------------------------------------ toolchain env

  /** Install arm-none-eabi-gcc / OpenOCD into <dataDir>/tools. */
  async envInstall(options = {}) {
    if (this.installState.running) throw new Error('工具链安装已在进行中');
    const requested = options.components ?? options.component ?? ['gcc', 'openocd'];
    const components = Array.isArray(requested) ? requested : String(requested).split(',').map((item) => item.trim());
    const list = components.includes('all') ? ['gcc', 'openocd'] : components.filter((item) => ['gcc', 'openocd'].includes(item));
    if (!list.length) throw new Error('请选择要安装的组件: gcc / openocd');
    this.installState = { running: true, component: '', percent: 0, message: '' };
    this.emit('install-start');
    const results = [];
    try {
      for (const component of list) {
        this.installState = { running: true, component, percent: 0, message: `安装 ${component}` };
        this.log(`开始安装工具链组件: ${component}`);
        const result = await installComponent(component, {
          dataDir: this.dataDir,
          force: Boolean(options.force),
          url: options.url,
          log: (text) => {
            this.installState = { ...this.installState, message: text };
            this.log(text);
          },
        });
        results.push(result);
        this.applyInstalledPaths(component, result);
      }
      this.log(`工具链安装完成: ${list.join(', ')}`);
      return { ok: true, results, toolchain: await this.getToolchain(true) };
    } finally {
      this.installState = { running: false, component: '', percent: 0, message: '' };
      this.toolchainAt = 0;
      this.emit('install-end');
    }
  }

  applyInstalledPaths(component, result) {
    const binaries = result.binaries ?? {};
    if (component === 'gcc') {
      const gcc = binaries['arm-none-eabi-gcc.exe'];
      const gdb = binaries['arm-none-eabi-gdb.exe'];
      if (gcc) this.config.gccPath = gcc;
      if (gdb) this.config.gdbPath = gdb;
    } else if (component === 'openocd') {
      const openocd = binaries['openocd.exe'];
      if (openocd) this.config.openocdPath = openocd;
      if (result.scripts) this.config.openocdScripts = result.scripts;
      // xPack puts scripts next to bin; make sure the whole tree is reachable.
      if (result.dir) {
        const binDir = openocd ? openocd.replace(/[\\/]openocd\.exe$/i, '') : '';
        if (binDir && !String(process.env.PATH ?? '').toLowerCase().includes(binDir.toLowerCase())) {
          process.env.PATH = `${binDir};${process.env.PATH ?? ''}`;
        }
      }
    }
    this.saveConfig({});
    this.toolchainAt = 0;
  }

  // --------------------------------------------------------------- symbols

  async symbols(force = false) {
    if (!force && this.symbolsCache && Date.now() - this.symbolsAt < 20_000) return this.symbolsCache;
    const dir = this.project?.root || this.config.projectDir;
    let loaded = null;
    if (this.config.symbolFile && fileExists(this.config.symbolFile)) {
      const { loadSymbolFile } = await import('./engine/symbols.js');
      loaded = loadSymbolFile(this.config.symbolFile);
    }
    if (!loaded) loaded = await loadSymbols(dir, { nm: this.config.gdbPath ? this.config.gdbPath.replace(/gdb[^\\/]*$/i, 'arm-none-eabi-nm.exe') : '' });
    this.symbolsCache = loaded;
    this.symbolsAt = Date.now();
    return loaded;
  }

  async symbolFind(query) {
    const loaded = await this.symbols();
    if (!loaded) return { ok: false, error: '未找到符号表（构建后生成 .map 或 .elf）' };
    return { ok: true, file: loaded.file, source: loaded.source, symbols: findSymbols(loaded.symbols, query) };
  }

  async symbolAt(address) {
    const loaded = await this.symbols();
    if (!loaded) return { ok: false, error: '未找到符号表（构建后生成 .map 或 .elf）' };
    const parsed = Number.isFinite(Number(address)) && String(address).trim() !== ''
      ? Number(address)
      : Number.parseInt(String(address).replace(/^0x/i, ''), 16);
    const symbol = lookupAddress(loaded.symbols, parsed);
    return symbol
      ? { ok: true, address: `0x${parsed.toString(16)}`, symbol }
      : { ok: false, error: `地址 0x${parsed.toString(16)} 没有匹配的符号` };
  }

  // ------------------------------------------------------------- pin map

  iocFile() {
    if (this.config.iocFile && fileExists(this.config.iocFile)) return this.config.iocFile;
    const dir = this.project?.root || this.config.projectDir;
    if (!dir) return '';
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ioc$/i.test(entry.name));
      return entries.length ? join(dir, entries[0].name) : '';
    } catch {
      return '';
    }
  }

  iocInfo() {
    const file = this.iocFile();
    if (!file) return { ok: false, error: '当前工程没有 .ioc 文件' };
    try {
      const parsed = loadIoc(file);
      return { ok: true, ...summarizeIoc(parsed) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  iocSet(patch = {}) {
    const file = this.iocFile();
    if (!file) throw new Error('当前工程没有 .ioc 文件');
    let text = readFileSync(file, 'utf8');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'file' || value === undefined) continue;
      text = setIocValue(text, key, String(value));
    }
    writeFileSync(file, text, 'utf8');
    const parsed = parseIoc(text, file);
    this.log(`已更新 .ioc: ${file}`);
    return { ok: true, ...summarizeIoc(parsed) };
  }

  pins() {
    const dir = this.project?.root || this.config.projectDir;
    if (!dir) return { ok: false, error: '未选择工程目录' };
    const ioc = (() => {
      const file = this.iocFile();
      if (!file) return null;
      try {
        return loadIoc(file);
      } catch {
        return null;
      }
    })();
    const map = buildPinMap(dir, ioc);
    return { ok: true, dir, ...map };
  }

  createProject(options = {}) {
    const dir = resolvePathLike(options.dir || this.config.projectDir || join(process.cwd(), 'stm32_project'));
    const result = generateProject(dir, options);
    this.config.projectDir = dir;
    this.saveConfig({ projectDir: dir });
    this.project = null;
    this.log(`已创建工程: ${dir}`);
    return { ok: true, ...result, cores: memoryForDevice(result.device) };
  }

  // ---------------------------------------------------------------- RTT

  async rttStart(options = {}) {
    if (!this.debug.active) throw new Error('请先启动调试会话，再打开 RTT');
    await this.rttStop();
    const monitor = new RttMonitor({
      telnetPort: this.debug.server?.telnetPort ?? this.config.telnetPort ?? 4444,
      tcpPort: options.tcpPort ?? this.config.rttPort ?? 9090,
      channel: options.channel ?? this.config.rttChannel ?? 0,
    });
    let address = options.address || '';
    if (!address) address = await resolveRttAddress(this.debug.gdb);
    if (!address) this.log('未找到 _SEGGER_RTT 符号，改为在内存中搜索控制块');
    monitor.on('line', (line) => this.log(`RTT: ${line}`, 'target'));
    monitor.on('close', () => { if (this.rtt === monitor) this.rtt = null; });
    await monitor.start({
      address,
      searchStart: options.searchStart ?? this.config.rttSearchStart,
      searchSize: options.searchSize ?? this.config.rttSearchSize,
      channel: options.channel ?? this.config.rttChannel ?? 0,
    });
    this.rtt = monitor;
    this.log(`RTT 已启动: 端口 ${monitor.tcpPort}${address ? ` @ ${address}` : ''}`);
    return monitor.state();
  }

  async rttStop() {
    if (!this.rtt) return { active: false };
    await this.rtt.stop().catch(() => {});
    this.rtt = null;
    this.log('RTT 已停止');
    return { active: false };
  }

  rttState() {
    return this.rtt?.state() ?? { active: false, port: this.config.rttPort, channel: this.config.rttChannel, bytes: 0, lines: [] };
  }

  rttWrite(text) {
    if (!this.rtt) throw new Error('RTT 未启动');
    this.rtt.write(text);
    return { ok: true, bytes: String(text).length };
  }

  rttClear() {
    return this.rtt?.clear() ?? { active: false, lines: [] };
  }

  // ---------------------------------------------------------------- cores

  cores() {
    const device = this.project?.device || this.config.device;
    const memory = memoryForDevice(device);
    return {
      device,
      cores: memory.dualCore ? 2 : 1,
      selected: Number(this.config.core) || 0,
      note: memory.dualCore
        ? '双核器件：当前 OpenOCD/GDB 只连接所选核（core0 默认）。core1 需要单独启动调试并指定其 ELF。'
        : '',
    };
  }

  // ---------------------------------------------------------------- debug

  async debugStart(options = {}) {
    const project = await this.inspect(options.dir || this.config.projectDir);
    await this.getToolchain();
    const toolchain = this.toolchain;
    const elf = options.elf || project.artifact
      || findArtifact(project.buildDir || project.root).find((a) => a.ext === 'elf' || a.ext === 'axf')?.path;
    if (!elf) throw new Error('找不到 ELF/AXF 文件，请先构建');
    const config = {
      ...this.debugConfig(),
      openocdPath: this.config.openocdPath || toolchain.openocd.path,
      gdbPath: this.config.gdbPath || findGccTools(this.config).gdb,
      targetCfg: options.targetCfg || project.targetCfg || this.config.targetCfg,
      interfaceCfg: options.interfaceCfg || project.interfaceCfg || this.config.interfaceCfg,
      projectDir: project.root,
      svd: this.svd(),
    };
    this.debug.config = config;
    this.log(`启动调试: ${elf}`);
    const state = await this.debug.start({
      elf,
      interfaceCfg: config.interfaceCfg,
      targetCfg: config.targetCfg,
      runToMain: options.runToMain ?? this.config.runToMain,
    });
    return state;
  }

  async debugStop() {
    await this.rttStop().catch(() => {});
    await this.debug.stop();
    this.log('调试会话已结束');
    return this.debug.state();
  }

  async debugAction(action, options = {}) {
    switch (action) {
      case 'continue': return this.debug.continueAndWait(options.waitMs ?? 0);
      case 'pause': return this.debug.pause();
      case 'stepInto': return this.debug.step('into');
      case 'stepOver': return this.debug.step('over');
      case 'stepOut': return this.debug.step('out');
      case 'stepInstruction': return this.debug.step('instruction');
      case 'reset': return this.debug.reset(true);
      case 'resetRun': return this.debug.reset(false);
      default: throw new Error(`未知调试动作: ${action}`);
    }
  }

  // ------------------------------------------------------------ snapshot

  async snapshot() {
    // The panel polls this route, so refresh the (30s-cached) toolchain here
    // instead of only in inspect(): a user who just installed OpenOCD/GCC or
    // changed a path in settings should see the result on the next poll.
    if (!this.toolchain || Date.now() - this.toolchainAt > 30_000) {
      await this.getToolchain().catch(() => {});
    }
    const project = this.project;
    return {
      config: {
        projectDir: this.config.projectDir,
        backend: this.config.backend,
        device: this.config.device,
        svdPath: this.config.svdPath,
        uv4Path: this.config.uv4Path,
        openocdPath: this.config.openocdPath,
        gdbPath: this.config.gdbPath,
        probe: this.config.probe,
        interfaceCfg: this.config.interfaceCfg,
        targetCfg: this.config.targetCfg,
        adapterSpeed: this.config.adapterSpeed,
        gdbPort: this.config.gdbPort,
        runToMain: this.config.runToMain,
        flashErase: this.config.flashErase,
        flashVerify: this.config.flashVerify,
        flashReset: this.config.flashReset,
        rttPort: this.config.rttPort,
        rttChannel: this.config.rttChannel,
        core: this.config.core,
        symbolFile: this.config.symbolFile,
        iocFile: this.config.iocFile,
      },
      toolchain: this.toolchain
        ? {
          keil: { installed: this.toolchain.keil.installed, uv4: this.toolchain.keil.uv4, packRoot: this.toolchain.keil.packRoot },
          gcc: { installed: this.toolchain.gcc.installed, version: this.toolchain.gcc.version, gcc: this.toolchain.gcc.gcc, gdb: this.toolchain.gcc.gdb, gdbVersion: this.toolchain.gcc.gdbVersion },
          openocd: this.toolchain.openocd,
          programmers: this.toolchain.programmers,
          probes: this.toolchain.probes,
          ready: this.toolchain.ready,
        }
        : null,
      project: project
        ? {
          root: project.root,
          kind: project.project?.kind ?? '',
          file: project.project?.file ?? '',
          device: project.device,
          target: project.uvprojx?.target ?? '',
          targets: project.uvprojx?.targets ?? [],
          backend: project.backend,
          artifact: project.artifact,
          artifacts: project.artifacts?.slice(0, 8) ?? [],
          svdPath: project.svd?.path ?? '',
          svdSource: project.svd?.source ?? '',
          errors: project.errors ?? [],
          buildDir: project.buildDir,
        }
        : null,
      debug: this.debug.state(),
      serial: this.serialState(),
      rtt: this.rttState(),
      install: this.installState,
      cores: this.cores(),
      lastBuild: this.lastBuild,
      lastFlash: this.lastFlash,
      logs: this.logs.slice(-400),
    };
  }
}

function resolvePathLike(value) {
  const expanded = expandPath(String(value));
  return /^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith('/') || expanded.startsWith('\\\\')
    ? resolve(expanded)
    : resolve(process.cwd(), expanded);
}

function summarizeIoc(parsed) {
  return {
    file: parsed.file,
    mcu: parsed.mcu,
    project: parsed.project,
    pins: parsed.pins.map((pin) => ({
      index: pin.index,
      pin: pin.pin,
      signal: pin.signal,
      label: pin.label,
      mode: pin.mode,
    })),
    peripherals: parsed.peripherals,
    entries: parsed.entries.length,
  };
}

