/**
 * Serial monitor for the target's UART.
 *
 * Node has no built-in serial port API, so the bridge is a small PowerShell
 * helper process: it owns the `System.IO.Ports.SerialPort`, writes received
 * bytes to stdout as base64 lines and takes writes from stdin as base64 lines.
 * That keeps the plugin dependency-free (no `serialport` native module).
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { run, which } from '../util.js';

const PORT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$names = [System.IO.Ports.SerialPort]::GetPortNames()
$names | ConvertTo-Json -Compress
`.trim();

const BRIDGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$port = $env:DSH_SERIAL_PORT
$baud = [int]$env:DSH_SERIAL_BAUD
try {
  $sp = New-Object System.IO.Ports.SerialPort $port, $baud, 'None', 8, 'One'
  $sp.ReadTimeout = 500
  $sp.Open()
} catch {
  [Console]::Error.WriteLine('OPEN_FAILED: ' + $_.Exception.Message)
  exit 1
}
[Console]::Out.WriteLine('OPENED')
[Console]::Out.Flush()
$stdin = [Console]::OpenStandardInput()
$inbuf = New-Object byte[] 8192
$pending = $stdin.BeginRead($inbuf, 0, $inbuf.Length, $null, $null)
$acc = ''
$out = [Console]::Out
try {
  while ($true) {
    if ($pending.IsCompleted) {
      $n = $stdin.EndRead($pending)
      if ($n -le 0) { break }
      $acc += [Text.Encoding]::UTF8.GetString($inbuf, 0, $n)
      while ($acc.Contains("\`n")) {
        $idx = $acc.IndexOf("\`n")
        $line = $acc.Substring(0, $idx).Trim()
        $acc = $acc.Substring($idx + 1)
        if ($line -eq 'CLOSE') { $sp.Close(); exit 0 }
        elseif ($line.StartsWith('WRITE ')) {
          $bytes = [Convert]::FromBase64String($line.Substring(6))
          $sp.Write($bytes, 0, $bytes.Length)
        }
      }
      $pending = $stdin.BeginRead($inbuf, 0, $inbuf.Length, $null, $null)
    }
    $avail = $sp.BytesToRead
    if ($avail -gt 0) {
      $chunk = New-Object byte[] $avail
      $read = $sp.Read($chunk, 0, $avail)
      if ($read -gt 0) {
        $out.WriteLine('DATA ' + [Convert]::ToBase64String($chunk, 0, $read))
        $out.Flush()
      }
    }
    Start-Sleep -Milliseconds 15
  }
} finally {
  try { $sp.Close() } catch { }
}
`.trim();

function powershellPath() {
  return which('pwsh') || which('powershell') || 'powershell';
}

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** List serial ports (`COM3`, ...). */
export async function listSerialPorts() {
  const shell = powershellPath();
  const result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', PORT_SCRIPT], { timeoutMs: 15_000 });
  if (!result.ok) throw new Error(`读取串口列表失败: ${(result.stderr || result.stdout || '').trim() || 'PowerShell 执行失败'}`);
  const text = result.stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const ports = Array.isArray(parsed) ? parsed : [parsed];
    return ports.filter(Boolean).map((port) => ({ port: String(port), label: String(port) }));
  } catch {
    return [];
  }
}

/**
 * A live serial connection.
 *
 * Events: `open`, `data` (Buffer), `close`, `error` (Error).
 */
export class SerialBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port;
    this.baud = Number(options.baud) || 115200;
    this.child = null;
    this.opened = false;
    this.bytes = 0;
    this._outBuffer = '';
    this._errorText = '';
  }

  get active() {
    return this.opened && this.child != null;
  }

  open() {
    if (this.child) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const shell = powershellPath();
      const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(BRIDGE_SCRIPT)];
      const env = { ...process.env, DSH_SERIAL_PORT: String(this.port), DSH_SERIAL_BAUD: String(this.baud) };
      const child = spawn(shell, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this._fail(error);
          reject(error);
        } else {
          this.opened = true;
          this.emit('open');
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error(`打开串口超时: ${this.port}`)), 15_000);

      child.stdout.on('data', (chunk) => {
        this._outBuffer += chunk.toString('utf8');
        let index;
        while ((index = this._outBuffer.indexOf('\n')) >= 0) {
          const line = this._outBuffer.slice(0, index).replace(/\r$/, '');
          this._outBuffer = this._outBuffer.slice(index + 1);
          if (line === 'OPENED') {
            finish(null);
          } else if (line.startsWith('DATA ')) {
            const buffer = Buffer.from(line.slice(5), 'base64');
            if (buffer.length === 0) continue;
            this.bytes += buffer.length;
            this.emit('data', buffer);
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        this._errorText = (this._errorText + text).slice(-4000);
        const match = /OPEN_FAILED:\s*(.+)/.exec(text);
        if (match) finish(new Error(`打开串口失败: ${match[1].trim()}`));
      });

      child.on('error', (error) => finish(new Error(`无法启动 PowerShell 串口桥: ${error.message}`)));

      child.on('exit', (code) => {
        this.opened = false;
        this.child = null;
        if (!settled) {
          const detail = this._errorText.trim() || `退出码 ${code}`;
          finish(new Error(`串口进程退出: ${detail}`));
        } else {
          this.emit('close', code);
        }
      });
    });
  }

  _fail(error) {
    this.opened = false;
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  /** Write a UTF-8 string to the port. */
  write(text) {
    return this.writeBytes(Buffer.from(String(text), 'utf8'));
  }

  /** Write raw bytes (hex string like "01 0A FF"). */
  writeHex(hexText) {
    const clean = String(hexText).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2 !== 0) throw new Error('十六进制数据长度必须是偶数');
    return this.writeBytes(Buffer.from(clean, 'hex'));
  }

  writeBytes(buffer) {
    if (!this.child || !this.opened) throw new Error('串口未打开');
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (payload.length === 0) return 0;
    this.child.stdin.write(`WRITE ${payload.toString('base64')}\n`);
    return payload.length;
  }

  close() {
    if (!this.child) return;
    try { this.child.stdin.write('CLOSE\n'); } catch { /* ignore */ }
    const child = this.child;
    setTimeout(() => {
      if (this.child === child) {
        try { child.kill(); } catch { /* ignore */ }
      }
    }, 1200).unref?.();
  }
}
