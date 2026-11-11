import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const KEIL_PROJECT_DIR = 'D:\\lgj\\mcu_acc_app';
const REAL_SVD = 'C:\\Users\\Administrator\\.dsh\\stm32\\svd\\STM32F407.svd';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-stm32-test-'));
process.env.DSH_HOME = TEMP_HOME;

const { Stm32Service } = await import('../src/service.js');
const { buildProject } = await import('../src/engine/build.js');
const { apply } = await import('../src/index.js');

function mockResponse() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body += body ?? '';
      this.writableEnded = true;
    },
  };
  return res;
}

function jsonRequest(method, url, body) {
  if (method === 'POST') {
    const req = Readable.from([JSON.stringify(body ?? {})]);
    req.method = 'POST';
    req.url = url;
    req.headers = { host: 'localhost' };
    return req;
  }
  return { method, url, headers: { host: 'localhost' } };
}

function makeCtx() {
  const registered = { tools: [], commands: [], routes: [], effects: [] };
  const ctx = {
    tools: { register: (tool) => { registered.tools.push(tool); return () => {}; } },
    get: (key) => (key === 'commands'
      ? { register: (command) => { registered.commands.push(command); return () => {}; } }
      : undefined),
    effect: (fn, label) => {
      registered.effects.push(label);
      const dispose = fn();
      return { dispose };
    },
    on: () => {},
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        const scoped = {
          effect: (fn) => { fn(); },
          webServer: {
            register: (route) => { registered.routes.push(route); return () => {}; },
          },
        };
        callback(scoped);
      }
    },
  };
  return { ctx, registered };
}

test('service inspects the real Keil project', { skip: !existsSync(KEIL_PROJECT_DIR) }, async () => {
  const service = new Stm32Service();
  const svdConfig = existsSync(REAL_SVD) ? { svdPath: REAL_SVD } : {};
  service.saveConfig({ projectDir: KEIL_PROJECT_DIR, ...svdConfig });
  const info = await service.inspect(KEIL_PROJECT_DIR, true);

  assert.equal(info.project.kind, 'uvprojx');
  assert.equal(info.device, 'STM32F407VGTx');
  assert.equal(info.uvprojx.target, 'STM324xG_EVAL');
  assert.equal(info.uvprojx.cpu.rom[0].start, 0x08000000);
  if (existsSync(REAL_SVD)) {
    assert.equal(info.svd.source, 'config');
    assert.ok(info.svd.path.endsWith('STM32F407.svd'));
  }
  assert.ok(Array.isArray(info.errors));

  // Config round-trips through <DSH_HOME>/stm32/config.json.
  const configPath = join(TEMP_HOME, 'stm32', 'config.json');
  assert.ok(existsSync(configPath));
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(saved.projectDir, KEIL_PROJECT_DIR);
});

test('service snapshot exposes panel state', { skip: !existsSync(KEIL_PROJECT_DIR) }, async () => {
  const service = new Stm32Service();
  await service.inspect(KEIL_PROJECT_DIR, true);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.config.projectDir, KEIL_PROJECT_DIR);
  assert.equal(snapshot.project.device, 'STM32F407VGTx');
  assert.equal(snapshot.project.kind, 'uvprojx');
  assert.equal(snapshot.project.backend, 'gcc'); // no UV4 installed
  assert.equal(snapshot.debug.active, false);
  assert.ok(snapshot.debug.state === undefined);
  assert.ok(Array.isArray(snapshot.logs));
});

test('build without Keil UV4 reports a helpful error', { skip: !existsSync(KEIL_PROJECT_DIR) }, async () => {
  const service = new Stm32Service();
  await service.inspect(KEIL_PROJECT_DIR, true);
  const info = await service.inspect(KEIL_PROJECT_DIR);
  await assert.rejects(
    () => buildProject(info, { dataDir: tempDataDir() }),
    /未找到 Keil UV4\.exe/,
  );
});

function tempDataDir() {
  const dir = join(TEMP_HOME, 'stm32');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('plugin apply registers tools, command, route and panel slots', () => {
  const { ctx, registered } = makeCtx();
  apply(ctx);

  const names = registered.tools.map((tool) => tool.name);
  for (const expected of [
    'stm32_project', 'stm32_doctor', 'stm32_config', 'stm32_build',
    'stm32_flash', 'stm32_debug', 'stm32_breakpoint', 'stm32_registers',
    'stm32_memory', 'stm32_stack', 'stm32_watch', 'stm32_disasm', 'stm32_serial',
    'stm32_env', 'stm32_symbols', 'stm32_pins', 'stm32_ioc', 'stm32_rtt', 'stm32_export',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const tool of registered.tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.description);
    assert.equal(typeof tool.parameters, 'object');
  }

  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, 'stm32');

  assert.equal(registered.routes.length, 1);
  assert.equal(registered.routes[0].path, '/api/stm32');
  assert.equal(registered.routes[0].kind, 'prefix');
});

test('HTTP route serves state, project and SVD to the panel', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx);
  const handler = registered.routes[0].handler;

  const configRes = mockResponse();
  await handler(jsonRequest('POST', '/api/stm32/action', {
    action: 'config',
    patch: { projectDir: KEIL_PROJECT_DIR, ...(existsSync(REAL_SVD) ? { svdPath: REAL_SVD } : {}) },
  }), configRes);
  assert.equal(configRes.status, 200);
  const configJson = JSON.parse(configRes.body);
  assert.equal(configJson.ok, true);

  const inspectRes = mockResponse();
  await handler(jsonRequest('POST', '/api/stm32/action', { action: 'inspect' }), inspectRes);
  assert.equal(inspectRes.status, 200);
  const inspectJson = JSON.parse(inspectRes.body);
  assert.equal(inspectJson.ok, true);
  assert.equal(inspectJson.project.device, 'STM32F407VGTx');

  const stateRes = mockResponse();
  await handler(jsonRequest('GET', '/api/stm32/state'), stateRes);
  assert.equal(stateRes.status, 200);
  const stateJson = JSON.parse(stateRes.body);
  assert.equal(stateJson.ok, true);
  assert.equal(stateJson.state.project.device, 'STM32F407VGTx');
  assert.equal(stateJson.state.debug.active, false);

  const svdRes = mockResponse();
  await handler(jsonRequest('GET', '/api/stm32/svd'), svdRes);
  const svdJson = JSON.parse(svdRes.body);
  assert.equal(svdJson.ok, true);
  assert.ok(svdJson.peripherals.length > 50);
  const gpioa = svdJson.peripherals.find((p) => p.name === 'GPIOA');
  assert.ok(gpioa);
  assert.equal(gpioa.baseAddress, 0x40020000);
});

test('HTTP route returns 405 for unsupported methods', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx);
  const handler = registered.routes[0].handler;
  const res = mockResponse();
  await handler({ method: 'DELETE', url: '/api/stm32/state', headers: {} }, res);
  assert.equal(res.status, 405);
});

test('tools execute against the real project', { skip: !existsSync(KEIL_PROJECT_DIR) }, async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx);
  const byName = new Map(registered.tools.map((tool) => [tool.name, tool]));

  const project = await byName.get('stm32_project').execute({ dir: KEIL_PROJECT_DIR });
  assert.equal(project.ok, true);
  assert.equal(project.project.device, 'STM32F407VGTx');
  assert.equal(project.project.kind, 'uvprojx');

  const config = await byName.get('stm32_config').execute({});
  assert.equal(config.ok, true);
  assert.ok(config.config);

  const build = await byName.get('stm32_build').execute({});
  assert.equal(build.ok, true);
  assert.equal(build.build.ok, false);
  assert.match(build.build.errors[0].message, /UV4/);

  const regs = await byName.get('stm32_registers').execute({});
  assert.equal(regs.ok, false);
  assert.match(regs.error, /调试/);

  const bp = await byName.get('stm32_breakpoint').execute({ action: 'list' });
  assert.equal(bp.ok, false);
});

test('slash command parses status and help', async () => {
  const service = new Stm32Service();
  await service.inspect(KEIL_PROJECT_DIR, true).catch(() => {});
  const { ctx, registered } = makeCtx();
  apply(ctx);
  const command = registered.commands[0];

  const help = await command.handler({ rawInput: 'help' });
  assert.equal(help.kind, 'success');
  assert.match(help.text, /stm32/);

  const status = await command.handler({ rawInput: 'status' });
  assert.equal(status.kind, 'success');
  assert.match(status.text, /STM32F407VGTx|工程/);
});
