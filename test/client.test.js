/**
 * Client-bundle smoke test: load client.js with a fake ModuleLoader / React and
 * render the embedded settings page. Two things are guarded here:
 *  - the settings page must survive the first render (config is still null);
 *    a `useCallback([config.projectDir])` regression once blanked the page.
 *  - every path input must offer a browse button, and the page must no longer
 *    register a separate `settings.section` (settings live in the workbench).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const slots = [];
let hooks = [];
let hookIndex = 0;
let clientModule = null;

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) };
}

const React = {
  createElement,
  Fragment: Symbol('fragment'),
  useState(initial) {
    const i = hookIndex++;
    if (hooks.length <= i) hooks[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks[i], (value) => { hooks[i] = value; }];
  },
  useEffect() {},
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useRef(initial) { return { current: initial }; },
};

function renderNode(node) {
  if (node == null || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(renderNode).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node.type === 'function') return renderNode(node.type({ ...node.props, children: node.children }));
  return node.children.map(renderNode).join('');
}

test('client bundle registers the workbench and no separate settings section', () => {
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        clientModule = factory((name) => {
          if (name === 'react') return React;
          throw new Error(`unexpected require: ${name}`);
        });
        clientModule.apply({
          slots: {
            register(spec, component) { slots.push({ spec, component }); return () => {}; },
            inject(_name, callback) { return callback(); },
          },
          effect() { return () => {}; },
          get() { return null; },
          tools: { register() { return () => {}; } },
        }, {});
      },
    },
    location: { href: 'http://localhost/' },
  };
  globalThis.document = { head: { appendChild() {} }, getElementById() { return null; }, createElement() { return {}; } };
  globalThis.fetch = async () => ({ json: async () => ({ ok: false }), status: 500 });

  // eslint-disable-next-line no-eval
  eval(source);

  assert.ok(clientModule, 'client bundle should evaluate');
  assert.ok(!slots.some((entry) => entry.spec.name === 'settings.section'), 'settings.section must not be registered');
  const main = slots.find((entry) => entry.spec.name === 'main');
  assert.ok(main, 'workbench main seat registered');
  assert.equal(main.spec.key, 'dsh-stm32-toolkit');

  // First render with config === null must not throw and must show a loading hint.
  hookIndex = 0;
  hooks = [];
  const tree = clientModule.__components.SettingsPage({ embedded: true });
  assert.match(renderNode(tree), /读取配置/);
});

test('settings form gives every path field a browse button', () => {
  assert.ok(clientModule, 'client bundle should be loaded by the previous test');
  // Pretend the config request already finished.
  hooks = [{ projectDir: 'D:\\lgj\\mcu_acc_app', device: 'STM32F407VGTx', svdPath: '' }];
  hookIndex = 0;
  const html = renderNode(clientModule.__components.SettingsPage({ embedded: true }));
  const browse = (html.match(/浏览…/g) || []).length;
  assert.ok(browse >= 9, `path fields with a browse button: ${browse}`);
  assert.match(html, /默认串口/);
  assert.match(html, /保存/);
});

test('toolbar offers probe and erase quick selectors', () => {
  assert.ok(clientModule?.__components?.Toolbar, 'Toolbar should be exposed');
  const html = renderNode(clientModule.__components.Toolbar({
    state: { config: { probe: 'cmsis-dap', flashErase: 'mass' }, project: { root: 'D:\\lgj\\mcu_acc_app', device: 'STM32F407VGTx' } },
    run() {},
    busy: 0,
    tab: 'console',
    setTab() {},
    onSwitchProject() {},
  }));
  assert.match(html, /调试器/);
  assert.match(html, /CMSIS-DAP/);
  assert.match(html, /擦除/);
  assert.match(html, /整片擦除/);
});

test('path picker renders Explorer-style shell', () => {
  assert.ok(clientModule?.__components?.PathPicker, 'PathPicker should be exposed');
  // Hooks order: cwd, view, error, loading, selected, filter.
  hooks = [
    'D:\\lgj\\mcu_acc_app',
    {
      dirs: [{ name: 'Src', path: 'D:\\lgj\\mcu_acc_app\\Src' }],
      files: [],
      parent: 'D:\\lgj',
      drives: [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }],
      selected: '',
    },
    '',
    false,
    '',
    '',
  ];
  hookIndex = 0;
  const html = renderNode(clientModule.__components.PathPicker({
    initial: 'D:\\lgj\\mcu_acc_app',
    mode: 'dir',
    onPick() {},
    onClose() {},
  }));
  assert.match(html, /此电脑/);
  assert.match(html, /D:/);
  assert.match(html, /个文件夹/);
  assert.match(html, /选择此目录/);
  assert.match(html, /取消/);
});
