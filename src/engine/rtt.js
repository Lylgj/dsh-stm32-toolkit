/**
 * SEGGER RTT over OpenOCD.
 *
 * OpenOCD owns the target, so RTT is driven through its telnet console:
 *   rtt setup <addr|range> <size> "SEGGER RTT"
 *   rtt start
 *   rtt server start <tcpPort> <channel>
 * The monitor then reads the TCP stream OpenOCD exposes.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

const PROMPT = '> ';

class TelnetClient {
  constructor(port, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.socket = null;
    this.buffer = '';
    this.waiters = [];
  }

  async connect(timeoutMs = 5000) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ port: this.port, host: this.host });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 OpenOCD telnet ${this.host}:${this.port} 超时`));
      }, timeoutMs);
      socket.setNoDelay(true);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => this.fail(error));
        socket.on('close', () => this.fail(new Error('OpenOCD telnet 已关闭')));
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`连接 OpenOCD telnet 失败: ${error.message}`));
      });
    });
  }

  onData(chunk) {
    // Strip telnet IAC negotiation (OpenOCD sends a few bytes on connect).
    const text = Buffer.from(chunk).toString('utf8').replace(/\xff[\xfb-\xfe]./g, '');
    this.buffer += text;
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      const index = this.buffer.indexOf(PROMPT);
      if (index < 0) break;
      const output = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + PROMPT.length);
      this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(output);
    }
  }

  fail(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async command(command, timeoutMs = 8000) {
    if (!this.socket) throw new Error('OpenOCD telnet 未连接');
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`OpenOCD 命令超时: ${command}`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
    this.socket.write(`${command}\n`);
    return pending;
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.fail(new Error('OpenOCD telnet 已关闭'));
  }
}

export class RttMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.telnetPort = Number(options.telnetPort) || 4444;
    this.host = options.host || '127.0.0.1';
    this.tcpPort = Number(options.tcpPort) || 9090;
    this.channel = Number(options.channel) || 0;
    this.telnet = null;
    this.socket = null;
    this.bytes = 0;
    this.lines = [];
    this.textBuffer = '';
  }

  get active() {
    return Boolean(this.socket);
  }

  state() {
    return {
      active: this.active,
      port: this.tcpPort,
      channel: this.channel,
      bytes: this.bytes,
      lines: this.lines.slice(-200),
    };
  }

  async start({ address = '', searchStart = '0x20000000', searchSize = 0x20000, channel = 0 } = {}) {
    if (this.active) return this.state();
    this.channel = channel;
    const telnet = new TelnetClient(this.telnetPort, this.host);
    await telnet.connect();
    this.telnet = telnet;
    try {
      await telnet.command('rtt stop').catch(() => {});
      if (address) {
        await telnet.command(`rtt setup ${address} 1024 "SEGGER RTT"`);
      } else {
        await telnet.command(`rtt setup ${searchStart} ${searchSize} "SEGGER RTT"`);
      }
      const started = await telnet.command('rtt start');
      if (/not found|could not|error/i.test(started) && !/started/i.test(started)) {
        throw new Error(`RTT 启动失败: ${started.trim() || '未找到 SEGGER RTT 控制块'}`);
      }
      await telnet.command(`rtt server start ${this.tcpPort} ${this.channel}`);
    } catch (error) {
      telnet.close();
      this.telnet = null;
      throw error;
    }
    await this.connectStream();
    return this.state();
  }

  connectStream(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port: this.tcpPort, host: this.host });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 RTT 端口 ${this.tcpPort} 超时`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => this.emit('error', error));
        socket.on('close', () => {
          this.socket = null;
          this.emit('close');
        });
        this.emit('open');
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`连接 RTT 端口失败: ${error.message}`));
      });
    });
  }

  onData(buffer) {
    this.bytes += buffer.length;
    this.textBuffer += buffer.toString('utf8');
    let index;
    while ((index = this.textBuffer.indexOf('\n')) >= 0) {
      const line = this.textBuffer.slice(0, index).replace(/\r$/, '');
      this.textBuffer = this.textBuffer.slice(index + 1);
      this.lines.push(line);
      if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
      this.emit('line', line);
    }
    this.emit('data', buffer);
  }

  write(text) {
    if (!this.socket) throw new Error('RTT 未连接');
    this.socket.write(String(text), 'utf8');
  }

  clear() {
    this.lines = [];
    this.bytes = 0;
    return this.state();
  }

  async stop() {
    this.socket?.destroy();
    this.socket = null;
    if (this.telnet) {
      await this.telnet.command(`rtt server stop ${this.tcpPort}`).catch(() => {});
      await this.telnet.command('rtt stop').catch(() => {});
      this.telnet.close();
      this.telnet = null;
    }
    this.emit('close');
    return this.state();
  }
}

/** Resolve `&_SEGGER_RTT` through GDB (returns a hex address or ''). */
export async function resolveRttAddress(gdb) {
  if (!gdb?.active) return '';
  try {
    const evaluated = await gdb.evalExpression('&_SEGGER_RTT');
    const text = String(evaluated?.data?.value ?? '');
    if (/^0x[0-9a-f]+$/i.test(text)) return text;
  } catch {
    /* fall through to the CLI form */
  }
  try {
    const info = await gdb.cli('info address _SEGGER_RTT');
    const match = /0x[0-9a-f]+/i.exec(String(info?.stdout ?? info ?? ''));
    return match ? match[0] : '';
  } catch {
    return '';
  }
}
