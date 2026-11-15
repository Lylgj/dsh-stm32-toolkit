/**
 * One debug session = one OpenOCD GDB server + one GDB process attached to it.
 *
 * Lifecycle (the same one Keil performs):
 *   start -> OpenOCD -> GDB loads ELF -> connect -> reset & halt -> run to main
 *   pause/resume/step/breakpoints -> stop -> disconnect GDB -> kill OpenOCD
 */

import { EventEmitter } from 'node:events';
import { bufferFromHex, hex, parseAddress } from '../util.js';
import { GdbSession } from './gdb.js';
import { interfaceConfigFor, startGdbServer } from './openocd.js';
import { startJLinkGdbServer } from './jlink.js';
import { readCoreRegisters, readPeripheral, readSingleRegister, resolveRegisterAddress } from './registers.js';

export class DebugSession extends EventEmitter {
  constructor(config, dependencies = {}) {
    super();
    this.config = config;
    this.log = dependencies.log ?? (() => {});
    this.server = null;
    this.backend = 'openocd';
    this.gdb = null;
    this.elf = '';
    this.starting = false;
    this.running = false;
    this.lastStop = null;
    this.breakpoints = [];
  }

  get active() {
    return Boolean(this.gdb?.active);
  }

  state() {
    return {
      active: this.active,
      backend: this.backend ?? null,
      starting: this.starting,
      running: this.running,
      halted: this.active && !this.running,
      elf: this.elf,
      gdbPort: this.server?.gdbPort ?? null,
      stop: this.lastStop,
      breakpoints: this.breakpoints,
    };
  }

  /**
   * Start a full debug session.
   * @param {{elf:string, interfaceCfg?:string, targetCfg?:string, runToMain?:boolean, adapterSpeed?:number}} options
   */
  async start(options = {}) {
    if (this.starting) throw new Error('调试会话正在启动中');
    await this.stop();
    this.starting = true;
    try {
      if (!options.elf) throw new Error('缺少 ELF 文件路径，无法开始调试');
      this.elf = options.elf;
      this.appBase = null;
      this.memory = this.config?.memory ?? null;
      if (!this.config.gdbPath) throw new Error('未找到 arm-none-eabi-gdb');
      const backend = this.config.backend === 'jlink' ? 'jlink' : 'openocd';
      this.backend = backend;

      if (backend === 'jlink') {
        if (!this.config.jlinkGDBServerPath) throw new Error('未找到 JLinkGDBServerCL，请安装 SEGGER J-Link 软件或配置 jlinkGDBServerPath');
        if (!this.config.jlinkDevice) throw new Error('缺少 J-Link 目标器件名（jlinkDevice 或工程 device）');
        this.log(`启动 J-Link GDB Server: ${this.config.jlinkDevice} (${this.config.jlinkInterface || 'SWD'} ${options.adapterSpeed ?? this.config.adapterSpeed ?? 4000}kHz)`);
        this.server = await startJLinkGdbServer({
          gdbserverPath: this.config.jlinkGDBServerPath,
          device: this.config.jlinkDevice,
          interfaceName: this.config.jlinkInterface || 'SWD',
          speed: options.adapterSpeed ?? this.config.adapterSpeed ?? 4000,
          gdbPort: this.config.gdbPort ?? 2331,
        });
      } else {
        const interfaceCfg = options.interfaceCfg
          || this.config.interfaceCfg
          || interfaceConfigFor(this.config.probe);
        const targetCfg = options.targetCfg || this.config.targetCfg;
        if (!targetCfg) throw new Error('缺少 OpenOCD target 配置（例如 target/stm32f4x.cfg）');
        if (!this.config.openocdPath) throw new Error('未找到 openocd');
        this.log(`启动 OpenOCD: ${interfaceCfg} + ${targetCfg}`);
        this.server = await startGdbServer({
          openocdPath: this.config.openocdPath,
          interfaceCfg,
          targetCfg,
          scriptsPath: this.config.openocdScripts,
          gdbPort: this.config.gdbPort ?? 3333,
          telnetPort: this.config.telnetPort ?? 4444,
          adapterSpeed: options.adapterSpeed ?? this.config.adapterSpeed ?? 4000,
          extraCommands: this.config.openocdCommands ?? [],
        });
      }
      this.server.exitedPromise.then((code) => {
        if (this.server && this.active) {
          this.log(`${this.backend === 'jlink' ? 'J-Link GDB Server' : 'OpenOCD'} 已退出 (${code})`);
          this.running = false;
        }
      });

      this.log('启动 GDB 并加载 ELF…');
      const gdb = new GdbSession({
        gdbPath: this.config.gdbPath,
        cwd: this.config.projectDir || process.cwd(),
      });
      this.gdb = gdb;
      gdb.on('stopped', (stop) => {
        this.running = false;
        this.lastStop = stop;
        this.emit('stopped', stop);
      });
      gdb.on('running', () => {
        this.running = true;
        this.emit('running');
      });
      gdb.on('console', (text) => this.emit('console', text));
      gdb.on('target', (text) => this.emit('target', text));
      gdb.on('stderr', (text) => this.emit('stderr', text));
      gdb.on('exit', (code) => {
        this.running = false;
        this.emit('exit', code);
      });
      await gdb.start();
      await gdb.load(this.elf);
      await gdb.connect('localhost', this.server.gdbPort);
      this.log('已连接目标，复位并暂停…');
      await gdb.resetAndHalt(backend);
      this.running = false;

      // Read the reset PC so the panel has something to show immediately.
      await this.refreshStop().catch(() => null);

      if (options.runToMain !== false) {
        await this.runToMain().catch((error) => this.log(`运行到 main 失败: ${error.message}`));
      }
      this.breakpoints = await gdb.listBreakpoints().catch(() => []);
      this.log('调试会话已就绪');
      return this.state();
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    } finally {
      this.starting = false;
    }
  }

  /** Temporary breakpoint on `main`, continue, wait for the halt. */
  async runToMain() {
    const gdb = this.requireGdb();
    const main = await gdb.evalExpression('(void*)main').catch(() => null);
    if (!main) return;
    // A temporary breakpoint (-t) is removed by GDB as soon as it fires, so no
    // stale breakpoint is left behind to surprise a later "continue"/reset.
    const armed = await gdb.setBreakpoint('main', { pending: false, temporary: true }).catch(() => null);
    if (!armed) return;

    // The IAP board can emit a spurious SIGTRAP (or land on a leftover trap)
    // before it actually reaches main. So retry a bounded number of times: on
    // every attempt re-establish the application SP/PC (jumpPastBootloader) and
    // continue again, stopping only when we truly halt at main. The temporary
    // breakpoint survives a reset, so it does not need re-arming.
    const attempts = 4;
    for (let i = 0; i < attempts; i += 1) {
      if (this.backend === 'jlink') {
        await gdb.resetAndHalt('jlink').catch(() => null);
        this.running = false;
      }
      await this.jumpPastBootloader().catch(() => false);
      this.running = true;
      await gdb.continue().catch(() => null);
      const stop = await this.waitForStop(15_000).catch(() => null);
      if (!stop) {
        if (this.running) {
          await gdb.interrupt().catch(() => null);
          await this.waitForStop(5_000).catch(() => null);
        }
        this.log('运行到 main 超时，已暂停目标');
        return;
      }
      if (this._atMain(stop)) return;
      this.log(`运行到 main：本次停在 ${this._describeStop(stop)}，重试 ${i + 1}/${attempts}`);
    }
    this.log('运行到 main：多次尝试仍未精确命中 main，已停在当前断点');
  }

  /** True when a stop event landed inside `main`. */
  _atMain(stop) {
    if (!stop) return false;
    const fn = String(stop.func || '');
    if (/^main$/.test(fn)) return true;
    const file = String(stop.file || '').replace(/\\/g, '/');
    return /main\.c$/i.test(file) && stop.reason === 'breakpoint-hit';
  }

  /** Short human description of a stop, used only for our own logs. */
  _describeStop(stop) {
    if (!stop) return '未知位置';
    const parts = [];
    if (stop.func && stop.func !== '??') parts.push(`${stop.func}()`);
    if (stop.file) parts.push(`${stop.file}${stop.line ? `:${stop.line}` : ''}`);
    if (stop.reason && stop.reason !== 'signal-received') parts.push(`· ${stop.reason}`);
    return parts.length ? parts.join(' ') : `0x${Number(stop.addr || 0).toString(16)}`;
  }

  /**
   * IAP 板子复位后先跑引导程序，只有引导真正跳到应用区才会执行到用户代码；
   * 直接 continue 会一直停在 bootloader 里，main 断点永远打不中。这里读出
   * 应用向量表（默认 0x08010000）里的 SP / Reset，然后把 PC、SP 直接设过去，
   * 相当于手工完成引导的跳转，之后 continue 就能跑到 main。
   * 返回 true 表示已经跳到应用区。
   */
  async jumpPastBootloader() {
    const gdb = this.requireGdb();
    const base = await this.applicationBase();
    if (!base) return false;

    // Vector table: [0]=initial SP, [1]=Reset_Handler.
    let sp = null;
    let reset = null;
    try {
      const mem = await gdb.readMemory(hex(base), 8);
      const bytes = Buffer.from(String(mem.contents || '').replace(/\s+/g, ''), 'hex');
      if (bytes.length >= 8) {
        sp = bytes.readUInt32LE(0);
        reset = bytes.readUInt32LE(4);
      }
    } catch (error) {
      this.log(`读取应用向量表失败: ${error.message}`);
    }

    if (!reset || reset === 0xffffffff || reset === 0) {
      const sym = await gdb.evalExpression('(void*)Reset_Handler').catch(() => null);
      const parsed = sym ? Number.parseInt(String(sym.value).replace(/^0x/i, ''), 16) : NaN;
      if (Number.isFinite(parsed)) reset = parsed;
    }
    if (!reset || reset === 0xffffffff) return false;

    const baseHex = `0x${base.toString(16)}`;
    // No offset image (classic 0x08000000 layout) => after reset the CPU already
    // sits inside the application, so there is nothing to bypass.
    if (base <= 0x08000000) return false;

    // IAP layout: the reset handler runs from the boot region. `monitor reset`
    // may land the CPU either in the bootloader or (racy) inside the app, so do
    // not trust the PC — always install the application's own SP/Reset, which
    // is what a working bootloader would do anyway.
    const pc = await gdb.evalExpression('$pc').catch(() => null);

    this.log(`IAP 布局：手工跳转到应用向量表 ${baseHex}（PC=${pc?.value ?? '?'}），SP=0x${(sp >>> 0).toString(16)}，Reset=0x${reset.toString(16)}`);
    if (sp && sp !== 0xffffffff) {
      await gdb.evalExpression(`$sp = 0x${(sp >>> 0).toString(16)}`).catch(() => null);
    }
    await gdb.evalExpression(`$pc = 0x${reset.toString(16)}`);
    return true;
  }

  /** Application vector-table base: from the project memory map, else 0x08000000. */
  async applicationBase() {
    if (Number.isFinite(this.appBase)) return this.appBase;
    let base = null;
    // Prefer the scatter/memory map the exporter already parsed.
    try {
      const mem = this.memory || this.config?.memory;
      const region = mem?.rom?.[0];
      if (region && Number.isFinite(region.start)) base = region.start;
    } catch { /* ignore */ }
    // No memory map: assume the classic single-image layout at 0x08000000. On
    // such a board the CPU is already inside the image after reset, so the
    // PC<base guard below keeps us from touching anything.
    if (!Number.isFinite(base)) base = 0x08000000;
    this.appBase = base;
    return base;
  }

  async waitForStop(timeoutMs) {
    if (!this.running) return this.lastStop;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('stopped', onStop);
        resolve(null);
      }, timeoutMs);
      const onStop = (stop) => {
        clearTimeout(timer);
        resolve(stop);
      };
      this.once('stopped', onStop);
    });
  }

  /** Refresh the current PC/line after commands that do not emit `*stopped`. */
  async refreshStop() {
    const gdb = this.requireGdb();
    const frames = await gdb.stackFrames();
    const frame = frames[0];
    if (!frame) return null;
    this.lastStop = {
      reason: this.lastStop?.reason ?? 'halt',
      func: frame.func,
      file: frame.file,
      line: frame.line,
      addr: frame.address,
      threadId: '',
    };
    return this.lastStop;
  }

  requireGdb() {
    if (!this.gdb?.active) throw new Error('调试会话未启动');
    return this.gdb;
  }

  async resume() {
    const gdb = this.requireGdb();
    this.running = true;
    const result = await gdb.continue();
    return { ok: true, running: true, raw: result.data };
  }

  /** Continue and optionally wait a bit for a halt. */
  async continueAndWait(waitMs = 2000) {
    await this.resume();
    if (waitMs <= 0) return { running: true, stop: null };
    const stop = await this.waitForStop(waitMs);
    return { running: stop === null, stop, state: this.state() };
  }

  async pause() {
    const gdb = this.requireGdb();
    await gdb.interrupt();
    const stop = await this.waitForStop(5000).catch(() => null);
    if (!stop) await this.refreshStop().catch(() => null);
    return { ok: true, stop: stop ?? this.lastStop, state: this.state() };
  }

  async step(kind = 'over') {
    const gdb = this.requireGdb();
    // A free-running target cannot be stepped; halt it first.
    if (this.running) {
      await gdb.interrupt().catch(() => null);
      await this.waitForStop(3000).catch(() => null);
    }
    if (kind === 'into') await gdb.stepInto();
    else if (kind === 'out') await gdb.stepOut();
    else if (kind === 'instruction') await gdb.stepInstruction();
    else await gdb.stepOver();
    const stop = await this.waitForStop(5000).catch(() => null);
    if (!stop) {
      if (this.running) await gdb.interrupt().catch(() => null);
      await this.waitForStop(3000).catch(() => null);
      await this.refreshStop().catch(() => null);
    }
    return { ok: true, stop: stop ?? this.lastStop, state: this.state() };
  }

  async reset(halt = true) {
    const gdb = this.requireGdb();
    if (this.backend === 'jlink') {
      await gdb.monitor('reset');
      if (halt) await gdb.monitor('halt');
    } else {
      await gdb.monitor(halt ? 'reset halt' : 'reset run');
    }
    this.running = !halt;
    if (!halt) return { ok: true, state: this.state() };

    await this.waitForStop(3000).catch(() => null);
    await this.refreshStop().catch(() => null);

    // IAP board: after reset the CPU sits in the bootloader, so a breakpoint in
    // the application would never be reached. Complete the bootloader's job
    // (install the app SP/PC) and, if the user has breakpoints armed, run on
    // until one of them fires — that is what "reset" means in Keil too.
    await this.jumpPastBootloader().catch(() => false);
    const userBkpts = (this.breakpoints || []).filter((b) => b && b.enabled !== false && b.type === 'breakpoint');
    if (userBkpts.length) {
      this.running = true;
      await gdb.continue().catch(() => null);
      const stop = await this.waitForStop(15_000).catch(() => null);
      if (!stop) {
        if (this.running) {
          await gdb.interrupt().catch(() => null);
          await this.waitForStop(3_000).catch(() => null);
        }
        await this.refreshStop().catch(() => null);
        this.log('复位后运行超时，已暂停目标');
      }
    }
    return { ok: true, state: this.state() };
  }

  async setBreakpoint(location, options = {}) {
    const gdb = this.requireGdb();
    const bkpt = await gdb.setBreakpoint(location, {
      condition: options.condition,
      hardware: options.hardware,
      ignoreCount: options.ignoreCount,
      pending: options.pending,
      temporary: options.temporary,
    });
    this.breakpoints = await gdb.listBreakpoints().catch(() => this.breakpoints);
    return bkpt;
  }

  /** Add a watchpoint (data breakpoint) and refresh the breakpoint list. */
  async setWatchpoint(expression, options = {}) {
    const gdb = this.requireGdb();
    const watch = await gdb.setWatchpoint(expression, {
      read: options.read,
      access: options.access,
    });
    this.breakpoints = await gdb.listBreakpoints().catch(() => this.breakpoints);
    return watch;
  }

  async removeBreakpoint(id) {
    const gdb = this.requireGdb();
    await gdb.deleteBreakpoint(id);
    this.breakpoints = await gdb.listBreakpoints().catch(() => this.breakpoints);
    return { ok: true, breakpoints: this.breakpoints };
  }

  async listBreakpoints() {
    const gdb = this.requireGdb();
    this.breakpoints = await gdb.listBreakpoints();
    return this.breakpoints;
  }

  async registers() {
    return readCoreRegisters(this.requireGdb());
  }

  async readMemory(address, count = 64) {
    const addr = parseAddress(address);
    if (addr === null) throw new Error(`地址无效: ${address}`);
    const result = await this.requireGdb().readMemory(hex(addr), count);
    const bytes = Buffer.from(result.contents, 'hex');
    return { address: hex(addr), count: bytes.length, bytes: [...bytes], contents: result.contents };
  }

  async writeMemory(address, hexText) {
    const addr = parseAddress(address);
    if (addr === null) throw new Error(`地址无效: ${address}`);
    const clean = String(hexText ?? '').replace(/[^0-9a-f]/gi, '');
    if (clean.length === 0 || clean.length % 2 !== 0) throw new Error('写入数据必须是偶数个十六进制字符');
    await this.requireGdb().writeMemory(hex(addr), clean);
    return { ok: true, address: hex(addr), bytes: clean.length / 2 };
  }

  async stack(depth = 24) {
    const frames = await this.requireGdb().stackFrames();
    return frames.slice(0, depth);
  }

  async locals() {
    return this.requireGdb().stackVariables(true);
  }

  async evaluate(expression) {
    return this.requireGdb().evalExpression(expression);
  }

  async disassemble(address, count = 16) {
    const addr = address ? parseAddress(address) : parseAddress(this.lastStop?.addr ?? '');
    if (addr === null) throw new Error('地址无效');
    const start = (addr & ~1) >>> 0;
    const end = (start + Math.max(1, count) * 2) >>> 0;
    return this.requireGdb().disassemble(hex(start), hex(end));
  }

  async peripheral(name, options = {}) {
    const svd = this.svd();
    const peripheral = svd?.byName?.get(String(name).toUpperCase());
    if (!peripheral) throw new Error(`SVD 中没有外设 ${name}`);
    return readPeripheral(this.requireGdb(), peripheral, options);
  }

  async register(input) {
    const svd = this.svd();
    const target = resolveRegisterAddress(svd, input);
    if (!target) throw new Error(`无法解析寄存器地址: ${input}`);
    if (target.register && target.peripheral) {
      return readSingleRegister(this.requireGdb(), target.peripheral, target.register.name);
    }
    const result = await this.requireGdb().readMemory(hex(target.address), 4);
    const contents = String(result.contents ?? '').replace(/^0x/i, '');
    const bytes = bufferFromHex(contents);
    if (bytes.length < 4) throw new Error(`读取寄存器 ${input} 返回的数据不足 4 字节`);
    return {
      address: hex(target.address),
      peripheral: target.peripheral?.name ?? '',
      value: hex(bytes.readUInt32LE(0)),
      contents,
    };
  }

  svd() {
    return this.config.svd ?? null;
  }

  async stop() {
    const gdb = this.gdb;
    this.gdb = null;
    if (gdb) {
      await gdb.stop().catch(() => {});
    }
    if (this.server) {
      await this.server.stop().catch(() => {});
      this.server = null;
    }
    this.running = false;
    this.elf = '';
    this.lastStop = null;
    this.breakpoints = [];
  }
}
