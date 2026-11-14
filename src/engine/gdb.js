/**
 * arm-none-eabi-gdb wrapper speaking MI2.
 *
 * One `GdbSession` == one `gdb` process. Commands are sent with an incrementing
 * token, and the matching `^done`/`^error` resolves the promise; asynchronous
 * records (`*stopped`) are emitted as events so the UI can update on a halt.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killTree } from '../util.js';
import { miInt, MiParser, summarizeStop } from './mi.js';

/** Quote a value as an MI C-string (paths with spaces / backslashes). */
export function miQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const DEFAULT_TIMEOUT = 30_000;

export class GdbSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gdbPath = options.gdbPath;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.child = null;
    this.parser = new MiParser();
    this.tokenSeq = 0;
    this.pending = new Map();
    this.console = [];
    this.lastStop = null;
    this.ready = false;
    this._waiters = [];
  }

  get active() {
    return this.child !== null && this.child.exitCode === null;
  }

  async start() {
    if (this.active) return this;
    if (!this.gdbPath) throw new Error('未找到 arm-none-eabi-gdb');
    this.child = spawn(this.gdbPath, ['-q', '--interpreter=mi2', '-nx'], {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ready = false;
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
    this.child.on('error', (error) => this.emit('error', error));
    this.child.on('close', (code) => {
      this.child = null;
      this.ready = false;
      for (const [token, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, token, class: 'error', data: { msg: `gdb 已退出 (${code})` } });
        this.pending.delete(token);
      }
      this.emit('exit', code);
    });

    // Wait until GDB prints its first prompt.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gdb 启动超时')), 10_000);
      const onPrompt = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('prompt', onPrompt);
      this.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const init = [
      '-gdb-set mi-async on',
      '-gdb-set pagination off',
      '-gdb-set confirm off',
      '-gdb-set height 0',
      '-gdb-set width 0',
      '-gdb-set print pretty off',
      '-enable-pretty-printing',
    ];
    for (const command of init) {
      // Some options are unsupported on older GDB versions; ignore failures.
      await this.send(command, { timeoutMs: 5000 }).catch(() => null);
    }
    this.ready = true;
    return this;
  }

  onData(chunk) {
    let records;
    try {
      records = this.parser.feed(chunk);
    } catch (error) {
      this.emit('stderr', `MI 解析失败: ${error?.message ?? error}`);
      return;
    }
    for (const record of records) {
      if (record.kind === 'prompt') {
        this.emit('prompt');
        const waiters = this._waiters.splice(0);
        for (const w of waiters) w();
        continue;
      }
      if (record.kind === 'console') {
        this.console.push(record.text);
        this.emit('console', record.text);
        continue;
      }
      if (record.kind === 'target') {
        this.emit('target', record.text);
        continue;
      }
      if (record.kind === 'log') {
        this.emit('log', record.text);
        continue;
      }
      if (record.token) {
        const waiter = this.pending.get(record.token);
        if (waiter) {
          if (record.kind === 'result') {
            clearTimeout(waiter.timer);
            this.pending.delete(record.token);
            waiter.resolve({
              ok: record.class === 'done',
              token: record.token,
              class: record.class,
              data: record.data ?? {},
            });
          }
        }
      }
      if (record.kind === 'exec') {
        if (record.class === 'stopped') {
          const stop = summarizeStop(record.data);
          this.lastStop = stop;
          this.emit('stopped', stop);
        } else if (record.class === 'running') {
          this.emit('running', record.data ?? {});
        }
        continue;
      }
      if (record.kind === 'notify') {
        this.emit('notify', record);
        continue;
      }
      this.emit('mi', record);
    }
  }

  /** Wait for the next `(gdb)` prompt (used after burst commands). */
  waitPrompt(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 gdb 提示符超时')), timeoutMs);
      this._waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Send an MI command and await its result record.
   * @param {string} command
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<{ok:boolean, token:string, class:string, data:object}>}
   */
  send(command, options = {}) {
    if (!this.active) return Promise.reject(new Error('gdb 未运行'));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const token = String((this.tokenSeq += 1));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`gdb 命令超时: ${command}`));
      }, timeoutMs);
      this.pending.set(token, { resolve, reject, timer, command });
      try {
        this.child.stdin.write(`${token}${command}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(token);
        reject(error);
      }
    });
  }

  /** Send a CLI command through `-interpreter-exec console`. */
  async cli(command, options = {}) {
    const result = await this.send(`-interpreter-exec console ${miQuote(command)}`, options);
    if (!result.ok) throw new Error(result.data.msg || `命令失败: ${command}`);
    return result;
  }

  /** `monitor <command>` — forwards to the OpenOCD side of the connection. */
  async monitor(command) {
    return this.cli(`monitor ${command}`);
  }

  async load(elfPath) {
    const result = await this.send(`-file-exec-and-symbols ${miQuote(elfPath)}`, { timeoutMs: 60_000 });
    if (!result.ok) throw new Error(result.data.msg || '加载 ELF 失败');
    return result;
  }

  async connect(host = 'localhost', port = 3333) {
    const result = await this.send(`-target-select extended-remote ${host}:${port}`, { timeoutMs: 20_000 });
    // GDB/MI answers `-target-select` with `^connected`, not `^done`; both mean
    // the remote target is attached, so accept either as success.
    const ok = result.class === 'done' || result.class === 'connected';
    if (!ok) throw new Error(result.data.msg || '连接 GDB Server 失败');
    return result;
  }

  async disconnect() {
    return this.send('-target-disconnect', { timeoutMs: 10_000 });
  }

  async resetAndHalt(backend = 'openocd') {
    // OpenOCD accepts a combined `reset halt`; SEGGER's GDB Server does not
    // (it rejects "halt" as a reset type), so reset and halt are two steps.
    if (backend === 'jlink') {
      await this.monitor('reset');
      await this.monitor('halt');
      return;
    }
    await this.monitor('reset halt');
  }

  async continue() {
    const result = await this.send('-exec-continue');
    // GDB/MI acknowledges execution commands with `^running`, not `^done`.
    if (!(result.class === 'done' || result.class === 'running')) throw new Error(result.data.msg || '继续执行失败');
    return result;
  }

  async interrupt() {
    return this.send('-exec-interrupt --all', { timeoutMs: 10_000 });
  }

  async stepInto() {
    const result = await this.send('-exec-step');
    if (!(result.class === 'done' || result.class === 'running')) throw new Error(result.data.msg || '单步失败');
    return result;
  }

  async stepOver() {
    const result = await this.send('-exec-next');
    if (!(result.class === 'done' || result.class === 'running')) throw new Error(result.data.msg || '单步跳过失败');
    return result;
  }

  async stepOut() {
    const result = await this.send('-exec-finish');
    if (!(result.class === 'done' || result.class === 'running')) throw new Error(result.data.msg || '跳出函数失败');
    return result;
  }

  async stepInstruction() {
    const result = await this.send('-exec-step-instruction');
    if (!(result.class === 'done' || result.class === 'running')) throw new Error(result.data.msg || '指令单步失败');
    return result;
  }

  async setBreakpoint(location, options = {}) {
    const flags = [];
    if (options.hardware) flags.push('-h');
    if (options.pending !== false) flags.push('-f');
    if (options.condition) flags.push(`-c ${miQuote(options.condition)}`);
    if (options.ignoreCount) flags.push(`-i ${Number(options.ignoreCount)}`);
    const result = await this.send(`-break-insert ${flags.join(' ')} ${miQuote(location)}`, { timeoutMs: 60_000 });
    if (!result.ok) throw new Error(result.data.msg || `设置断点失败: ${location}`);
    const bkpt = result.data.bkpt ?? {};
    return {
      number: miInt(bkpt.number),
      address: bkpt.addr ?? '',
      func: bkpt.func ?? '',
      file: bkpt.file ?? '',
      fullname: bkpt.fullname ?? '',
      line: miInt(bkpt.line),
      type: bkpt.type ?? '',
      enabled: bkpt.enabled ?? 'y',
      raw: bkpt,
    };
  }

  /**
   * Set a watchpoint (data breakpoint).
   * @param {string} expression variable / address, e.g. `counter` or `*(int*)0x20000000`
   * @param {{read?:boolean, access?:boolean}} [options] read=读监视, access=读写监视
   */
  async setWatchpoint(expression, options = {}) {
    const flags = [];
    if (options.access) flags.push('-a');
    else if (options.read) flags.push('-r');
    const prefix = flags.length > 0 ? `-break-watch ${flags.join(' ')} ` : '-break-watch ';
    const result = await this.send(`${prefix}${miQuote(expression)}`, { timeoutMs: 60_000 });
    if (!result.ok) throw new Error(result.data.msg || `设置监视点失败: ${expression}`);
    const watch = result.data.wpt ?? result.data['hw-rwpt'] ?? result.data['hw-wpt'] ?? result.data.bkpt ?? {};
    return {
      number: miInt(watch.number),
      address: watch.addr ?? '',
      func: watch.func ?? '',
      file: watch.file ?? '',
      line: miInt(watch.line),
      type: watch.type ?? 'watchpoint',
      enabled: watch.enabled ?? 'y',
      raw: watch,
    };
  }

  async deleteBreakpoint(id) {
    const result = await this.send(`-break-delete ${Number(id)}`);
    if (!result.ok) throw new Error(result.data.msg || `删除断点 ${id} 失败`);
    return true;
  }

  async listBreakpoints() {
    const result = await this.send('-break-list', { timeoutMs: 30_000 });
    if (!result.ok) throw new Error(result.data.msg || '读取断点失败');
    const table = result.data.BreakpointTable ?? {};
    const body = Array.isArray(table.body) ? table.body : [];
    return body.map((b) => {
      const bkpt = b.bkpt ?? b;
      return {
        number: miInt(bkpt.number),
        type: bkpt.type ?? '',
        disp: bkpt.disp ?? '',
        enabled: bkpt.enabled ?? 'y',
        address: bkpt.addr ?? '',
        func: bkpt.func ?? '',
        file: bkpt.file ?? '',
        fullname: bkpt.fullname ?? '',
        line: miInt(bkpt.line),
        times: miInt(bkpt.times),
        raw: bkpt,
      };
    });
  }

  async evalExpression(expression) {
    const result = await this.send(`-data-evaluate-expression ${miQuote(expression)}`);
    if (!result.ok) throw new Error(result.data.msg || `表达式求值失败: ${expression}`);
    return { value: String(result.data.value ?? ''), raw: result.data };
  }

  async registerNames() {
    const result = await this.send('-data-list-register-names', { timeoutMs: 20_000 });
    if (!result.ok) throw new Error(result.data.msg || '读取寄存器名失败');
    const names = result.data['register-names'] ?? [];
    return names.map((n, i) => ({ number: i, name: n }));
  }

  /** Read all registers as hex values. */
  async registerValues() {
    const result = await this.send('-data-list-register-values x', { timeoutMs: 20_000 });
    if (!result.ok) throw new Error(result.data.msg || '读取寄存器失败');
    const values = result.data['register-values'] ?? [];
    return values.map((r) => ({ number: miInt(r.number), value: String(r.value ?? '') }));
  }

  async readMemory(address, count) {
    const result = await this.send(`-data-read-memory-bytes ${address} ${Math.max(1, Math.trunc(count))}`);
    if (!result.ok) throw new Error(result.data.msg || `读取内存失败: ${address}`);
    const memory = result.data.memory ?? [];
    const first = Array.isArray(memory) ? memory[0] : memory;
    return {
      begin: first?.begin ?? '',
      contents: String(first?.contents ?? ''),
      raw: result.data,
    };
  }

  async writeMemory(address, hexBytesText) {
    const result = await this.send(`-data-write-memory-bytes ${address} ${hexBytesText}`);
    if (!result.ok) throw new Error(result.data.msg || `写入内存失败: ${address}`);
    return true;
  }

  async stackFrames() {
    const result = await this.send('-stack-list-frames', { timeoutMs: 20_000 });
    if (!result.ok) throw new Error(result.data.msg || '读取调用栈失败');
    const frames = result.data.stack ?? [];
    // GDB encodes each frame as a `frame={...}` result inside the list.
    return frames.map((item) => {
      const f = item?.frame ?? item ?? {};
      return {
        level: miInt(f.level),
        address: f.addr ?? '',
        func: f.func ?? '',
        file: f.file ?? '',
        fullname: f.fullname ?? '',
        line: miInt(f.line),
        raw: f,
      };
    });
  }

  async stackVariables(allValues = true) {
    const result = await this.send(`-stack-list-variables ${allValues ? '--all-values' : ''}`.trim(), { timeoutMs: 20_000 });
    if (!result.ok) throw new Error(result.data.msg || '读取变量失败');
    const variables = result.data.variables ?? [];
    return variables.map((v) => ({
      name: v.name ?? '',
      value: v.value ?? '',
      type: v.type ?? '',
      arg: v.arg === '1' || v.arg === 1,
    }));
  }

  async selectFrame(level) {
    return this.send(`-stack-select-frame ${Number(level)}`);
  }

  async threadInfo() {
    const result = await this.send('-thread-info', { timeoutMs: 20_000 });
    if (!result.ok) throw new Error(result.data.msg || '读取线程失败');
    const threads = result.data.threads ?? [];
    return threads.map((t) => ({
      id: t.id ?? '',
      targetId: t.targetId ?? '',
      name: t.name ?? '',
      state: t.state ?? '',
      frame: t.frame ?? null,
    }));
  }

  async disassemble(startAddress, endAddress) {
    const result = await this.send(`-data-disassemble -s ${startAddress} -e ${endAddress} -- 1`, { timeoutMs: 30_000 });
    if (!result.ok) throw new Error(result.data.msg || '反汇编失败');
    const asm = result.data.asm ?? [];
    return asm.map((item) => ({
      address: item.address ?? '',
      func: item.func ?? '',
      offset: item.offset ?? '',
      instruction: item.inst ?? '',
    }));
  }

  async stop() {
    if (!this.active) return;
    try {
      await Promise.race([
        this.send('-gdb-exit', { timeoutMs: 1500 }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      /* already gone */
    }
    if (this.child) killTree(this.child);
    this.child = null;
    this.ready = false;
  }
}
