/**
 * Client-bundle smoke test: load client.js with a fake ModuleLoader / React and
 * render the settings section once with no config loaded. This catches the
 * classic crash "Cannot read properties of null" in hook dependency arrays —
 * that exact bug blanked the whole STM32 settings page once.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const slots = [];
let hooks = [];
let hookIndex = 0;

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

test('client bundle registers settings section and renders with no config', () => {
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const module = factory((name) => {
          if (name === 'react') return React;
          throw new Error(`unexpected require: ${name}`);
        });
        module.apply({
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

  const section = slots.find((entry) => entry.spec.name === 'settings.section');
  assert.ok(section, 'settings.section should be registered');
  hookIndex = 0;
  hooks = [];
  const tree = section.component({});
  assert.match(renderNode(tree), /读取配置/);
});

test('settings form gives every path field a browse button', () => {
  const section = slots.find((entry) => entry.spec.name === 'settings.section');
  assert.ok(section, 'settings.section should stay registered');
  // Pretend the config request already finished.
  hooks = [{ projectDir: 'D:\\lgj\\mcu_acc_app', device: 'STM32F407VGTx', svdPath: '' }];
  hookIndex = 0;
  const html = renderNode(section.component({}));
  const browse = (html.match(/浏览…/g) || []).length;
  assert.ok(browse >= 9, `path fields with a browse button: ${browse}`);
  assert.match(html, /默认串口/);
  assert.match(html, /保存/);
});
