/* global window */
/**
 * dsh-stm32-toolkit — client half.
 *
 * A Keil-style workbench inside DeepSeek Harness:
 *   toolbar  : build / download / start-debug / pause / step / reset
 *   tabs     : console, registers (core + SVD peripherals), memory,
 *              breakpoints, call stack
 *   settings : toolchain paths, probe, ports
 *
 * The whole UI talks to the host half over `/api/stm32/*`; state is polled once
 * a second, so an agent driving the same service is visible here immediately.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stm32-toolkit',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;
    const module = { exports: {} };

    const API = '/api/stm32';
    const PANEL_ID = 'dsh-stm32-toolkit';
    const PERIPHERAL_LIMIT = 500;

    // ------------------------------------------------------------- utils

    async function api(action, params = {}, options = {}) {
      const method = options.method ?? 'POST';
      const query = method === 'GET' && params && Object.keys(params).length
        ? `?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, value == null ? '' : String(value)])).toString()}`
        : '';
      const url = method === 'GET' ? `${API}/${action}${query}` : `${API}/action`;
      const init = method === 'GET'
        ? { method, headers: { accept: 'application/json' } }
        : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...params }),
        };
      const response = await fetch(url, init);
      const json = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      return json;
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms)) return '';
      if (ms < 1000) return `${Math.round(ms)}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    }

    function hex(value, width = 8) {
      const n = Number(value) >>> 0;
      return `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;
    }

    function formatStop(stop) {
      if (!stop) return '';
      const where = [stop.file, stop.line ? `:${stop.line}` : ''].join('');
      return [stop.func ? `${stop.func}()` : '', where, stop.reason ? `· ${stop.reason}` : ''].filter(Boolean).join(' ');
    }

    // ------------------------------------------------------------ styles

    const STYLE_ID = 'dsh-stm32-toolkit-style';
    const css = `
      .stm32-root { display:flex; flex-direction:column; height:100%; min-height:0; color:inherit;
        font-family:var(--dsw-font-ui, system-ui, -apple-system, "Segoe UI", sans-serif); font-size:12px; }
      .stm32-toolbar { display:flex; align-items:center; gap:6px; padding:8px 10px; flex-wrap:wrap;
        border-bottom:1px solid rgba(128,128,128,.22); }
      .stm32-title { font-weight:600; font-size:12px; margin-right:6px; letter-spacing:.02em; }
      .stm32-chip { padding:1px 7px; border-radius:999px; border:1px solid rgba(128,128,128,.32);
        opacity:.75; font-size:11px; white-space:nowrap; }
      .stm32-chip-btn { cursor:pointer; background:none; color:inherit; opacity:.9;
        max-width:260px; overflow:hidden; text-overflow:ellipsis; }
      .stm32-chip-btn:hover { border-color:#3b82f6; opacity:1; }
      .stm32-toolbar-actions { display:flex; align-items:center; gap:6px; margin-left:auto; flex-wrap:wrap; }
      .stm32-toolbar-field { display:inline-flex; align-items:center; gap:5px; font-size:11.5px;
        opacity:.8; white-space:nowrap; }
      .stm32-toolbar-select { appearance:none; -webkit-appearance:none; cursor:pointer; color:inherit;
        background:rgba(128,128,128,.07); border:1px solid rgba(128,128,128,.3); border-radius:7px;
        height:28px; box-sizing:border-box; padding:0 26px 0 10px; font:inherit; font-size:12px;
        background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23888' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
        background-repeat:no-repeat; background-position:right 9px center; transition:border-color .12s ease; }
      .stm32-toolbar-select:hover { border-color:#3b82f6; }
      .stm32-toolbar-select:focus { outline:none; border-color:#3b82f6;
        box-shadow:0 0 0 3px rgba(59,130,246,.18); }
      .stm32-btn { display:inline-flex; align-items:center; justify-content:center; gap:4px;
        padding:4px 11px; border-radius:7px; border:1px solid rgba(128,128,128,.28);
        background:rgba(128,128,128,.07); color:inherit; cursor:pointer; font-size:12px; line-height:1.5;
        transition:background .12s ease, border-color .12s ease, opacity .12s ease; }
      .stm32-btn:hover:not(:disabled) { background:rgba(128,128,128,.15); }
      .stm32-btn:disabled { opacity:.42; cursor:not-allowed; }
      .stm32-btn.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; }
      .stm32-btn.primary:hover:not(:disabled) { background:#2f6fdb; }
      .stm32-btn.danger { color:#e05c5c; }
      .stm32-tabs { display:flex; gap:3px; padding:6px 8px 0; border-bottom:1px solid rgba(128,128,128,.18);
        overflow-x:auto; scrollbar-width:none; }
      .stm32-tabs::-webkit-scrollbar { display:none; }
      .stm32-tab { padding:6px 11px 7px; cursor:pointer; color:inherit; opacity:.6; white-space:nowrap;
        border:0; border-radius:8px 8px 0 0; background:none; font:inherit; font-size:12.5px;
        transition:background .12s ease, opacity .12s ease; }
      .stm32-tab:hover { opacity:.9; background:rgba(128,128,128,.08); }
      .stm32-tab.active { opacity:1; font-weight:600; background:rgba(128,128,128,.1);
        box-shadow:inset 0 -2px 0 #3b82f6; }
      .stm32-body { flex:1; min-height:0; overflow:auto; padding:8px 10px 12px; }
      .stm32-console { font-family:var(--dsw-font-mono, "Cascadia Code", Consolas, monospace); font-size:11.5px;
        white-space:pre-wrap; word-break:break-word; margin:0; line-height:1.55; }
      .stm32-log-info { opacity:.7; }
      .stm32-log-error { color:#e05c5c; }
      .stm32-log-warn { color:#c9a227; }
      .stm32-log-target { color:#2f9e7d; }
      .stm32-grid { display:grid; grid-template-columns: minmax(200px, 1fr) minmax(280px, 1.6fr); gap:10px; }
      .stm32-card { border:1px solid rgba(128,128,128,.22); border-radius:8px; overflow:hidden;
        background:rgba(128,128,128,.04); }
      .stm32-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:6px 10px; border-bottom:1px solid rgba(128,128,128,.18); font-weight:600; font-size:11.5px; }
      .stm32-table { width:100%; border-collapse:collapse; font-size:11.5px; }
      .stm32-table th { text-align:left; opacity:.65; font-weight:500; padding:4px 10px;
        border-bottom:1px solid rgba(128,128,128,.18); position:sticky; top:0;
        background:Canvas; background:color-mix(in srgb, Canvas 92%, transparent); }
      .stm32-table td { padding:3px 10px; border-bottom:1px solid rgba(128,128,128,.12);
        font-family:var(--dsw-font-mono, Consolas, monospace); white-space:nowrap; }
      .stm32-table.stm32-mono td { white-space:pre; }
      .stm32-table tr:hover td { background:rgba(128,128,128,.08); }
      .stm32-muted { opacity:.55; }
      .stm32-empty { padding:24px 8px; text-align:center; opacity:.55; }
      .stm32-input { background:rgba(128,128,128,.08); color:inherit; border:1px solid rgba(128,128,128,.3);
        border-radius:5px; padding:3px 8px; font-family:var(--dsw-font-mono, Consolas, monospace);
        font-size:11.5px; min-width:0; }
      .stm32-input:focus { outline:none; border-color:#3b82f6; }
      .stm32-row { display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; }
      .stm32-select { background:rgba(128,128,128,.08); color:inherit; border:1px solid rgba(128,128,128,.3);
        border-radius:5px; padding:3px 6px; font-size:11.5px; }
      .stm32-status { display:flex; align-items:center; gap:10px; padding:4px 10px; font-size:11px; opacity:.7;
        border-top:1px solid rgba(128,128,128,.22); }
      .stm32-dot { width:7px; height:7px; border-radius:50%; background:#9aa0aa; display:inline-block; margin-right:5px; }
      .stm32-dot.on { background:#3fae5f; }
      .stm32-dot.busy { background:#c9a227; }
      .stm32-dot.err { background:#e05c5c; }
      .stm32-field { display:grid; grid-template-columns:180px minmax(0,1fr); gap:6px 10px; align-items:center; margin-bottom:8px; }
      .stm32-field label { opacity:.75; }
      .stm32-section-title { margin:14px 0 8px; font-weight:600; font-size:12px; }
      .stm32-hint { opacity:.6; font-size:11px; line-height:1.5; }
      .stm32-badge-err { color:#e05c5c; }
      .stm32-scroll { max-height:calc(100vh - 230px); overflow:auto; }

      /* ---- settings page ---- */
      .stm32-settings { width:100%; max-width:780px; box-sizing:border-box; padding:2px 2px 24px;
        display:flex; flex-direction:column; gap:14px; color:inherit;
        font-family:var(--dsw-font-ui, system-ui, -apple-system, "Segoe UI", sans-serif); font-size:12px; }
      /* Embedded in the workbench tab: use the panel width, keep it compact. */
      .stm32-settings.stm32-settings-embed { max-width:none; padding:4px 2px 30px; gap:12px; }
      .stm32-settings-embed .stm32-set-card-body { padding:2px 12px 6px; }
      .stm32-settings-embed .stm32-set-row { grid-template-columns:132px minmax(0,1fr); gap:8px 12px; padding:7px 0; }
      .stm32-set-head h2 { margin:0 0 3px; font-size:15px; font-weight:600; letter-spacing:.01em; }
      .stm32-set-head p { margin:0; opacity:.6; font-size:12px; line-height:1.5; }
      .stm32-set-layout { display:grid; grid-template-columns:178px minmax(0,1fr); gap:16px; align-items:start; }
      .stm32-set-side { position:sticky; top:6px; display:flex; flex-direction:column; gap:2px; }
      .stm32-set-sideitem { text-align:left; border:0; background:transparent; color:inherit; opacity:.65;
        padding:7px 10px; border-radius:7px; font:inherit; font-size:12.5px; cursor:pointer; }
      .stm32-set-sideitem:hover { background:rgba(128,128,128,.1); opacity:1; }
      .stm32-set-sideitem.active { background:rgba(59,130,246,.13); color:#3b82f6; opacity:1; font-weight:600; }
      .stm32-set-content { display:flex; flex-direction:column; gap:12px; min-width:0; }
      @media (max-width: 760px) {
        .stm32-set-layout { grid-template-columns:1fr; gap:10px; }
        .stm32-set-side { position:static; flex-direction:row; flex-wrap:wrap; }
      }
      .stm32-set-card { border:1px solid rgba(128,128,128,.22); border-radius:10px;
        background:rgba(128,128,128,.04); overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,.04); }
      .stm32-set-card-title { padding:11px 16px 9px; font-size:12.5px; font-weight:600;
        border-bottom:1px solid rgba(128,128,128,.18); }
      .stm32-set-card-body { padding:2px 16px 8px; }
      .stm32-set-row { display:grid; grid-template-columns:150px minmax(0,1fr); gap:10px 16px;
        align-items:start; padding:9px 0; }
      .stm32-set-row + .stm32-set-row { border-top:1px solid rgba(128,128,128,.12); }
      .stm32-set-label { padding-top:6px; font-size:12px; opacity:.7; }
      .stm32-set-control { min-width:0; display:flex; flex-direction:column; gap:4px; }
      .stm32-set-input, .stm32-set-select { width:100%; box-sizing:border-box;
        background:rgba(128,128,128,.08); color:inherit; border:1px solid rgba(128,128,128,.3);
        border-radius:6px; padding:6px 9px; font-size:12px;
        font-family:var(--dsw-font-mono, Consolas, monospace); line-height:1.4;
        transition:border-color .12s ease, box-shadow .12s ease; }
      .stm32-set-select { font-family:var(--dsw-font-ui, system-ui, sans-serif); max-width:260px;
        appearance:none; -webkit-appearance:none; padding-right:28px; cursor:pointer;
        background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23888' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
        background-repeat:no-repeat; background-position:right 10px center; }
      .stm32-set-input:focus, .stm32-set-select:focus { outline:none; border-color:#3b82f6;
        box-shadow:0 0 0 3px rgba(59,130,246,.18); }
      .stm32-set-input::placeholder { opacity:.4; }
      .stm32-set-hint { font-size:11px; line-height:1.55; opacity:.55; }
      .stm32-set-check { display:inline-flex; align-items:center; gap:7px; font-size:12px;
        color:inherit; cursor:pointer; padding-top:4px; }
      .stm32-set-actions { display:flex; align-items:center; gap:8px; padding:2px 2px 0; }
      .stm32-set-actions-center { justify-content:center; }
      .stm32-set-actions-message { text-align:center; font-size:11.5px; opacity:.6; margin-top:4px; }
      /* Keep 保存 reachable while scrolling a long settings form. */
      .stm32-settings-embed .stm32-set-actions {
        position:sticky; bottom:0; z-index:3; padding:8px 2px;
        background:var(--dsw-alias-surface-1, rgba(127,127,127,.08));
        backdrop-filter:blur(6px); border-top:1px solid rgba(128,128,128,.18); }
      .stm32-set-actions .stm32-btn { padding:6px 16px; border-radius:6px; font-size:12.5px; }
      .stm32-set-inputwrap { display:flex; gap:6px; min-width:0; align-items:stretch; }
      .stm32-set-inputwrap .stm32-set-input { flex:1; min-width:0; }
      .stm32-set-browse { flex:none; padding:0 12px; border-radius:6px; cursor:pointer; font-size:12px;
        border:1px solid rgba(128,128,128,.32); background:rgba(128,128,128,.08); color:inherit; }
      .stm32-set-browse:hover { background:rgba(128,128,128,.16); }
      .stm32-check-row { display:grid; grid-template-columns:10px 150px minmax(0,1fr); gap:8px;
        align-items:center; padding:4px 0; font-size:12px; }
      .stm32-check-dot { width:8px; height:8px; border-radius:50%; background:#9aa0aa; }
      .stm32-check-dot.ok { background:#3fae5f; }
      .stm32-check-dot.bad { background:#e05c5c; }
      .stm32-check-dot.unknown { background:#c9a227; }
      .stm32-check-label { opacity:.7; }
      .stm32-check-value { font-family:var(--dsw-font-mono, Consolas, monospace); font-size:11.5px;
        word-break:break-all; }
      .stm32-picker-mask { position:fixed; inset:0; z-index:9999; background:rgba(15,18,24,.45);
        backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; padding:16px; }
      .stm32-picker { width:min(760px,94vw); height:min(540px,84vh); display:flex; flex-direction:column;
        background:Canvas; color:CanvasText; border:1px solid rgba(128,128,128,.3); border-radius:14px;
        box-shadow:0 24px 72px rgba(0,0,0,.45); overflow:hidden; font-size:12px; outline:none; }
      .stm32-picker-head { display:flex; align-items:center; gap:10px; padding:12px 16px;
        border-bottom:1px solid rgba(128,128,128,.18); }
      .stm32-picker-title { font-weight:600; font-size:13px; }
      .stm32-picker-x { margin-left:auto; border:0; background:transparent; color:inherit; font-size:18px;
        line-height:1; width:28px; height:28px; border-radius:7px; cursor:pointer; opacity:.55; }
      .stm32-picker-x:hover { background:rgba(128,128,128,.15); opacity:1; }
      .stm32-picker-bar { display:flex; align-items:center; gap:6px; padding:8px 12px;
        border-bottom:1px solid rgba(128,128,128,.14); }
      .stm32-picker-nav { border:1px solid rgba(128,128,128,.24); background:transparent; color:inherit;
        width:27px; height:27px; border-radius:7px; cursor:pointer; line-height:1; }
      .stm32-picker-nav:hover:not(:disabled) { background:rgba(128,128,128,.12); }
      .stm32-picker-nav:disabled { opacity:.35; cursor:default; }
      .stm32-picker-crumbs { flex:1; min-width:0; display:flex; align-items:center; gap:1px; overflow:hidden;
        border:1px solid rgba(128,128,128,.2); border-radius:7px; padding:3px 6px; background:rgba(128,128,128,.05); }
      .stm32-picker-crumb { border:0; background:transparent; color:inherit; font:inherit; padding:2px 6px;
        border-radius:5px; cursor:pointer; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .stm32-picker-crumb:hover { background:rgba(128,128,128,.14); }
      .stm32-picker-sep { opacity:.3; }
      .stm32-picker-body { flex:1; min-height:0; display:grid; grid-template-columns:172px minmax(0,1fr); }
      .stm32-picker-side { border-right:1px solid rgba(128,128,128,.16); padding:8px 6px; display:flex;
        flex-direction:column; gap:2px; overflow:auto; background:rgba(128,128,128,.035); }
      .stm32-picker-side-title { font-size:10.5px; letter-spacing:.06em; text-transform:uppercase;
        opacity:.45; padding:4px 8px 6px; }
      .stm32-picker-sideitem { display:flex; align-items:center; gap:7px; border:0; background:transparent;
        color:inherit; text-align:left; padding:6px 8px; border-radius:6px; cursor:pointer; font:inherit;
        font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .stm32-picker-sideitem:hover { background:rgba(128,128,128,.12); }
      .stm32-picker-sideitem.active { background:rgba(59,130,246,.14); color:#3b82f6; }
      .stm32-picker-side-empty { opacity:.5; padding:6px 8px; }
      .stm32-picker-main { display:flex; flex-direction:column; min-width:0; min-height:0; }
      .stm32-picker-filterbar { display:flex; align-items:center; gap:10px; padding:7px 10px;
        border-bottom:1px solid rgba(128,128,128,.12); }
      .stm32-picker-filter { flex:1; min-width:0; border:1px solid rgba(128,128,128,.22); border-radius:6px;
        background:rgba(128,128,128,.06); color:inherit; font:inherit; padding:4px 9px; }
      .stm32-picker-filter:focus { outline:none; border-color:#3b82f6; }
      .stm32-picker-count { font-size:11px; opacity:.5; white-space:nowrap; }
      .stm32-picker-list { flex:1; min-height:0; overflow:auto; padding:6px; }
      .stm32-picker-item { display:flex; align-items:center; gap:8px; padding:5px 9px; border-radius:6px;
        cursor:default; white-space:nowrap; overflow:hidden; user-select:none; }
      .stm32-picker-item:hover { background:rgba(128,128,128,.1); }
      .stm32-picker-item.active { background:rgba(59,130,246,.16); }
      .stm32-picker-item.up { opacity:.7; }
      .stm32-picker-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
      .stm32-picker-item.file .stm32-picker-name { font-family:var(--dsw-font-mono,Consolas,monospace); font-size:11.5px; }
      .stm32-picker-tag { font-size:10px; opacity:.4; }
      .stm32-picker-ico { width:16px; text-align:center; flex:0 0 16px; }
      .stm32-picker-empty { padding:40px 8px; text-align:center; opacity:.55; }
      .stm32-picker-error { padding:6px 16px; color:#e05c5c; font-size:11px; }
      .stm32-picker-foot { display:flex; align-items:center; gap:8px; padding:10px 14px;
        border-top:1px solid rgba(128,128,128,.18); }
      .stm32-picker-hint { flex:1; min-width:0; font-size:11px; opacity:.55; font-family:var(--dsw-font-mono,Consolas,monospace);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .stm32-picker-foot .stm32-btn { padding:5px 16px; }
      .stm32-dialog { width:min(480px,92vw); max-height:78vh; display:flex; flex-direction:column;
        background:Canvas; color:CanvasText; border:1px solid rgba(128,128,128,.3); border-radius:14px;
        box-shadow:0 24px 72px rgba(0,0,0,.45); overflow:hidden; font-size:12px; }
      .stm32-dialog-body { padding:10px 16px; overflow:auto; display:flex; flex-direction:column; gap:8px; }
      .stm32-dialog .stm32-picker-foot { justify-content:flex-end; }
      @media (max-width:640px) {
        .stm32-set-row { grid-template-columns:1fr; gap:5px; }
        .stm32-set-label { padding-top:0; }
        .stm32-check-row { grid-template-columns:10px minmax(0,1fr); }
        .stm32-check-value { grid-column:2; }
      }

    `;

    function ensureStyle(doc) {
      if (!doc || doc.getElementById(STYLE_ID)) return;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = css;
      doc.head.appendChild(style);
    }

    // ------------------------------------------------------------- hooks

    function useServiceState() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const alive = useRef(true);
      const load = useCallback(async () => {
        try {
          const json = await api('state', {}, { method: 'GET' });
          if (!alive.current) return;
          if (json.ok) {
            setState(json.state);
            setError('');
          } else {
            setError(json.error ?? '读取状态失败');
          }
        } catch (err) {
          if (alive.current) setError(String(err?.message ?? err));
        }
      }, []);
      useEffect(() => {
        alive.current = true;
        load();
        const timer = setInterval(load, 1000);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [load]);
      return { state, error, reload: load, setState };
    }

    function useAction(setBusy) {
      return useCallback(async (action, params) => {
        setBusy?.((n) => n + 1);
        try {
          const json = await api(action, params);
          if (!json.ok) throw new Error(json.error ?? '操作失败');
          return json;
        } finally {
          setBusy?.((n) => Math.max(0, n - 1));
        }
      }, [setBusy]);
    }

    // ---------------------------------------------------------- toolbar

    function Toolbar({ state, run, busy, tab, setTab, onSwitchProject }) {
      const debug = state?.debug ?? {};
      const project = state?.project;
      const buildRunning = Boolean(state?.lastBuild?.running);
      const flashRunning = Boolean(state?.lastFlash?.running);
      const debugStarting = Boolean(debug.starting);
      const active = Boolean(debug.active);
      const running = Boolean(debug.running);

      const btn = (label, onClick, opts = {}) => h('button', {
        className: `stm32-btn${opts.primary ? ' primary' : ''}${opts.danger ? ' danger' : ''}`,
        title: opts.title ?? label,
        disabled: opts.disabled ?? false,
        onClick,
      }, label);

      const config = state?.config ?? {};
      const quick = (key, label, title, options) => h('label', { className: 'stm32-toolbar-field', key, title }, [
        h('span', null, label),
        h('select', {
          className: 'stm32-toolbar-select',
          value: config[key] ?? options[0]?.value ?? '',
          onChange: (event) => run('config', { patch: { [key]: event.target.value } }),
        }, options.map((option) => h('option', { value: option.value, key: option.value }, option.label))),
      ]);

      return h('div', { className: 'stm32-toolbar' }, [
        h('span', { className: 'stm32-title', key: 't' }, 'STM32'),
        h('button', {
          key: 'proj',
          className: 'stm32-chip stm32-chip-btn',
          title: project?.root ? `${project.root}（点击切换工程）` : '选择工程目录',
          onClick: onSwitchProject,
        }, `工程: ${project?.root ? (project.root.split(/[\\/]/).filter(Boolean).pop() || project.root) : '未设置'} ▾`),
        project ? h('span', { className: 'stm32-chip', key: 'dev', title: project.root }, project.device || '未知芯片') : null,
        project && project.target ? h('span', { className: 'stm32-chip', key: 'tgt' }, project.target) : null,
        project?.backend ? h('span', { className: 'stm32-chip', key: 'be' }, project.backend === 'keil' ? 'Keil UV4' : 'GCC') : null,
        quick('probe', '调试器', '下载 / 调试使用的调试器（与设置页同步）', [
          { value: 'stlink', label: 'ST-Link' },
          { value: 'cmsis-dap', label: 'CMSIS-DAP' },
          { value: 'jlink', label: 'J-Link' },
        ]),
        quick('flashErase', '擦除', '下载时擦除 Flash 的方式（与设置页同步）', [
          { value: 'none', label: '按扇区' },
          { value: 'mass', label: '整片擦除' },
        ]),
        h('span', { key: 'spacer', style: { flex: 1 } }),
        h('div', { className: 'stm32-toolbar-actions', key: 'actions' }, [
          btn(buildRunning ? '编译中…' : '编译', () => run('build'), { disabled: buildRunning || flashRunning, title: '编译工程 (F7)' }),
          btn(flashRunning ? '下载中…' : '下载', () => run('flash'), { disabled: flashRunning || buildRunning || !project?.artifact || active, title: '下载到芯片 (F8)' }),
          active
            ? btn('停止调试', () => run('debugStop'), { danger: true, title: '结束调试会话' })
            : btn(debugStarting ? '启动中…' : '调试', () => run('debugStart'), { primary: true, disabled: debugStarting, title: '启动调试并运行到 main' }),
          active ? btn(running ? '暂停' : '继续', () => run('debug', { op: running ? 'pause' : 'continue', waitMs: 0 }), { title: '暂停 / 继续 (F5)' }) : null,
          active ? btn('单步', () => run('debug', { op: 'stepOver' }), { title: '单步跳过 (F10)' }) : null,
          active ? btn('步入', () => run('debug', { op: 'stepInto' }), { title: '单步进入 (F11)' }) : null,
          active ? btn('复位', () => run('debug', { op: 'reset' }), { title: '复位并暂停' }) : null,
          busy > 0 ? h('span', { key: 'busy', className: 'stm32-chip' }, '…') : null,
        ]),
      ]);
    }

    function TabBar({ tab, setTab }) {
      const tabs = [
        ['console', '控制台'],
        ['registers', '寄存器'],
        ['memory', '内存'],
        ['breakpoints', '断点'],
        ['stack', '调用栈'],
        ['watch', '变量'],
        ['disasm', '反汇编'],
        ['serial', '串口'],
        ['rtt', 'RTT'],
        ['symbols', '符号'],
        ['pins', '引脚'],
        ['settings', '设置'],
      ];
      return h('div', { className: 'stm32-tabs' }, tabs.map(([id, label]) => h('button', {
        key: id,
        className: `stm32-tab${tab === id ? ' active' : ''}`,
        onClick: () => setTab(id),
      }, label)));
    }

    // ---------------------------------------------------------- console

    function ConsoleTab({ state, run }) {
      const ref = useRef(null);
      const logs = state?.logs ?? [];
      const [clearing, setClearing] = useState(false);
      useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      }, [logs.length]);
      const clear = useCallback(async () => {
        setClearing(true);
        try {
          await run('clearLogs');
        } catch {
          /* 下一轮轮询会刷新 */
        } finally {
          setClearing(false);
        }
      }, [run]);
      const errors = state?.lastBuild?.errors ?? [];
      return h('div', null, [
        h('div', { className: 'stm32-row', style: { justifyContent: 'space-between', marginBottom: 6 }, key: 'head' }, [
          h('span', { className: 'stm32-muted' }, logs.length ? `${logs.length} 行日志` : '暂无日志'),
          h('button', { className: 'stm32-btn', onClick: clear, disabled: clearing || logs.length === 0 }, '清除日志'),
        ]),
        errors.length > 0
          ? h('div', { className: 'stm32-card', style: { marginBottom: 8 }, key: 'errs' }, [
            h('div', { className: 'stm32-card-head' }, [
              h('span', null, `编译错误 (${errors.length})`),
            ]),
            h('div', { style: { maxHeight: 180, overflow: 'auto' } }, h('table', { className: 'stm32-table' },
              h('tbody', null, errors.map((e, i) => h('tr', { key: i },
                h('td', { className: 'stm32-badge-err' }, `${e.file || ''}${e.line ? `:${e.line}` : ''}`),
                h('td', { style: { whiteSpace: 'normal' } }, e.message))))))
          ])
          : null,
        h('pre', { className: 'stm32-console', ref, key: 'log' },
          logs.length === 0 ? '等待操作…' : logs.map((l) => `[${new Date(l.time).toLocaleTimeString()}] ${l.text}`).join('\n')),
      ]);
    }

    // -------------------------------------------------------- registers

    function CoreRegisters({ state, run, disabled }) {
      const [core, setCore] = useState(null);
      const [err, setErr] = useState('');
      const refresh = useCallback(async () => {
        try {
          const json = await run('registers');
          setCore(json.registers ?? []);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [run]);
      useEffect(() => {
        if (state?.debug?.active && !state?.debug?.running) refresh();
      }, [state?.debug?.active, state?.debug?.running, state?.debug?.stop?.addr]);
      return h('div', { className: 'stm32-card', key: 'core' }, [
        h('div', { className: 'stm32-card-head' }, [
          h('span', null, 'Cortex-M 内核寄存器'),
          h('button', { className: 'stm32-btn', onClick: refresh, disabled }, '刷新'),
        ]),
        err ? h('div', { className: 'stm32-empty' }, err) : null,
        !core
          ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '点击刷新读取')
          : h('div', { className: 'stm32-scroll' }, h('table', { className: 'stm32-table' }, [
            h('thead', null, h('tr', null, [h('th', null, '寄存器'), h('th', null, '值'), h('th', null, '说明')])),
            h('tbody', null, core.map((r) => h('tr', { key: r.name }, [
              h('td', null, r.name.toUpperCase()),
              h('td', null, r.value),
              h('td', { className: 'stm32-muted', style: { whiteSpace: 'normal' } }, r.description || ''),
            ]))),
          ])),
      ]);
    }

    function PeripheralPanel({ state, run, disabled }) {
      const [list, setList] = useState([]);
      const [selected, setSelected] = useState('');
      const [data, setData] = useState(null);
      const [err, setErr] = useState('');
      const loadList = useCallback(async () => {
        try {
          const json = await api('svd', {}, { method: 'GET' });
          if (json.ok) setList(json.peripherals ?? []);
          else setErr(json.error ?? '');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, []);
      useEffect(() => { loadList(); }, [loadList]);
      const load = useCallback(async (name) => {
        if (!name) return;
        try {
          const json = await run('peripheral', { name });
          setData(json);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [run]);
      useEffect(() => {
        if (data?.peripheral && state?.debug?.active && !state?.debug?.running) load(data.peripheral);
      }, [state?.debug?.stop?.addr]);
      return h('div', { className: 'stm32-card', key: 'peri' }, [
        h('div', { className: 'stm32-card-head' }, [
          h('span', null, '外设寄存器 (SVD)'),
          h('div', { className: 'stm32-row', style: { margin: 0 } }, [
            h('select', {
              className: 'stm32-select',
              value: selected,
              onChange: (event) => { setSelected(event.target.value); load(event.target.value); },
            }, [h('option', { key: '', value: '' }, `选择外设 (${list.length})`),
              ...list.map((p) => h('option', { key: p.name, value: p.name }, `${p.name}  ${hex(p.baseAddress)}`))]),
            h('button', { className: 'stm32-btn', disabled: disabled || !selected, onClick: () => load(selected) }, '刷新'),
          ]),
        ]),
        err ? h('div', { className: 'stm32-empty' }, err) : null,
        !data
          ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '选择外设后读取')
          : h('div', { className: 'stm32-scroll' }, h('table', { className: 'stm32-table' }, [
            h('thead', null, h('tr', null, [h('th', null, '寄存器'), h('th', null, '地址'), h('th', null, '值'), h('th', null, '位域')])),
            h('tbody', null, data.registers.map((r) => h('tr', { key: r.name }, [
              h('td', null, r.name),
              h('td', { className: 'stm32-muted' }, r.address),
              h('td', null, r.value),
              h('td', { style: { whiteSpace: 'normal' } }, r.fields.length === 0 ? '' : r.fields.map((f) => `${f.name}=${f.hex}${f.meaning ? `(${f.meaning})` : ''}`).join('  ')),
            ]))),
          ])),
      ]);
    }

    function RegistersTab({ state, run, disabled }) {
      return h('div', { className: 'stm32-grid' }, [
        h(CoreRegisters, { key: 'a', state, run, disabled }),
        h(PeripheralPanel, { key: 'b', state, run, disabled }),
      ]);
    }

    // ----------------------------------------------------------- memory

    function MemoryTab({ state, run, disabled }) {
      const [address, setAddress] = useState('0x20000000');
      const [count, setCount] = useState(128);
      const [data, setData] = useState(null);
      const [err, setErr] = useState('');
      const read = useCallback(async () => {
        try {
          const json = await run('memoryRead', { address, count });
          setData(json);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [address, count, run]);
      const rows = useMemo(() => {
        if (!data?.bytes) return [];
        const base = Number.parseInt(String(data.address).replace(/^0x/i, ''), 16);
        const out = [];
        for (let i = 0; i < data.bytes.length; i += 16) {
          const chunk = data.bytes.slice(i, i + 16);
          const addr = (base + i).toString(16).toUpperCase().padStart(8, '0');
          const hexPart = chunk.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
          const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
          out.push(`${addr}  ${hexPart.padEnd(47)}  ${ascii}`);
        }
        return out;
      }, [data]);
      return h('div', { className: 'stm32-card' }, [
        h('div', { className: 'stm32-card-head' }, [
          h('span', null, '内存查看'),
          h('div', { className: 'stm32-row', style: { margin: 0 } }, [
            h('input', { className: 'stm32-input', style: { width: 130 }, value: address, onChange: (e) => setAddress(e.target.value), placeholder: '地址' }),
            h('input', { className: 'stm32-input', style: { width: 70 }, value: count, onChange: (e) => setCount(Number(e.target.value) || 64), placeholder: '字节数' }),
            h('button', { className: 'stm32-btn', onClick: read, disabled }, '读取'),
          ]),
        ]),
        err ? h('div', { className: 'stm32-empty' }, err) : null,
        !data
          ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '输入地址后读取')
          : h('pre', { className: 'stm32-console', style: { padding: '8px 10px' } }, rows.join('\n')),
      ]);
    }

    // ------------------------------------------------------ breakpoints

    function BreakpointsTab({ state, run, disabled }) {
      const [list, setList] = useState([]);
      const [kind, setKind] = useState('code');
      const [location, setLocation] = useState('main');
      const [expression, setExpression] = useState('counter');
      const [condition, setCondition] = useState('');
      const [hardware, setHardware] = useState(false);
      const [err, setErr] = useState('');
      const refresh = useCallback(async () => {
        if (!state?.debug?.active) return;
        try {
          const json = await run('breakpointList');
          setList(json.breakpoints ?? []);
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [run, state?.debug?.active]);
      useEffect(() => { refresh(); }, [refresh, state?.debug?.active]);
      const isWatch = kind !== 'code';
      const add = useCallback(async () => {
        try {
          const payload = isWatch
            ? { kind, expression: expression || location }
            : { kind, location, condition: condition || undefined, hardware };
          await run('breakpointAdd', payload);
          setErr('');
          refresh();
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [kind, isWatch, location, expression, condition, hardware, run, refresh]);
      const remove = useCallback(async (id) => {
        try {
          await run('breakpointRemove', { id });
          refresh();
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [run, refresh]);
      const kindSelect = h('select', {
        className: 'stm32-input',
        style: { width: 126 },
        value: kind,
        onChange: (e) => setKind(e.target.value),
      }, [
        h('option', { value: 'code', key: 'code' }, '执行断点'),
        h('option', { value: 'watch', key: 'watch' }, '写监视点'),
        h('option', { value: 'readwatch', key: 'readwatch' }, '读监视点'),
        h('option', { value: 'accesswatch', key: 'accesswatch' }, '读/写监视'),
      ]);
      return h('div', { className: 'stm32-card' }, [
        h('div', { className: 'stm32-card-head' }, [
          h('span', null, `断点 (${list.length})`),
          h('button', { className: 'stm32-btn', onClick: refresh, disabled }, '刷新'),
        ]),
        h('div', { style: { padding: '8px 10px' } }, [
          h('div', { className: 'stm32-row' }, [
            kindSelect,
            isWatch
              ? h('input', {
                className: 'stm32-input',
                style: { flex: 1, minWidth: 160 },
                value: expression,
                onChange: (e) => setExpression(e.target.value),
                placeholder: '变量名 / 地址，例如 counter 或 *(int*)0x20000000',
              })
              : h('input', {
                className: 'stm32-input',
                style: { flex: 1, minWidth: 160 },
                value: location,
                onChange: (e) => setLocation(e.target.value),
                placeholder: '函数名 / 文件:行号 / 地址',
              }),
            !isWatch ? h('input', {
              className: 'stm32-input',
              style: { width: 120 },
              value: condition,
              onChange: (e) => setCondition(e.target.value),
              placeholder: '条件(可选)',
            }) : null,
            !isWatch ? h('label', { className: 'stm32-hint' }, [
              h('input', { type: 'checkbox', checked: hardware, onChange: (e) => setHardware(e.target.checked) }), ' 硬件断点',
            ]) : null,
            h('button', { className: 'stm32-btn primary', onClick: add, disabled }, '添加'),
          ]),
          isWatch ? h('div', { className: 'stm32-hint' }, '监视点需要改动内存时触发；Cortex-M 的硬件监视点数量有限（通常 2~4 个）。') : null,
          err ? h('div', { className: 'stm32-hint stm32-badge-err' }, err) : null,
        ]),
        list.length === 0
          ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '还没有断点')
          : h('div', { className: 'stm32-scroll' }, h('table', { className: 'stm32-table' }, [
            h('thead', null, h('tr', null, [h('th', null, '#'), h('th', null, '位置'), h('th', null, '类型'), h('th', null, '命中'), h('th', null, '')])),
            h('tbody', null, list.map((b) => h('tr', { key: b.number }, [
              h('td', null, String(b.number)),
              h('td', null, `${b.func || b.address} ${b.file ? `${b.file}:${b.line}` : ''}`),
              h('td', { className: 'stm32-muted' }, b.type),
              h('td', { className: 'stm32-muted' }, String(b.times ?? 0)),
              h('td', null, h('button', { className: 'stm32-btn danger', onClick: () => remove(b.number) }, '删除')),
            ]))),
          ])),
      ]);
    }

    // ------------------------------------------------------------ stack

    function StackTab({ state, run, disabled }) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState('');
      const refresh = useCallback(async () => {
        try {
          const json = await run('stack', { depth: 24 });
          setData(json);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [run]);
      useEffect(() => {
        if (state?.debug?.active && !state?.debug?.running) refresh();
      }, [state?.debug?.active, state?.debug?.running, state?.debug?.stop?.addr]);
      return h('div', { className: 'stm32-grid' }, [
        h('div', { className: 'stm32-card', key: 'frames' }, [
          h('div', { className: 'stm32-card-head' }, [
            h('span', null, '调用栈'),
            h('button', { className: 'stm32-btn', onClick: refresh, disabled }, '刷新'),
          ]),
          err ? h('div', { className: 'stm32-empty' }, err) : null,
          !data ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '点击刷新') : h('div', null,
            (data.frames ?? []).map((f) => h('div', { key: f.level, className: 'stm32-row', style: { padding: '3px 8px', margin: 0 } }, [
              h('span', { className: 'stm32-muted', style: { width: 24 } }, `#${f.level}`),
              h('span', { style: { fontFamily: 'var(--dsw-font-mono, Consolas, monospace)' } }, f.func ? `${f.func}()` : '??'),
              h('span', { className: 'stm32-muted' }, `${f.file}${f.line ? `:${f.line}` : ''}`),
            ]))),
        ]),
        h('div', { className: 'stm32-card', key: 'vars' }, [
          h('div', { className: 'stm32-card-head' }, h('span', null, '局部变量 / 参数')),
          !data?.variables?.length
            ? h('div', { className: 'stm32-empty' }, '暂无变量')
            : h('table', { className: 'stm32-table' }, h('tbody', null,
              data.variables.map((v, i) => h('tr', { key: i }, [
                h('td', null, `${v.arg ? '[参数] ' : ''}${v.name}`),
                h('td', null, v.value),
              ])))),
        ]),
      ]);
    }

    // --------------------------------------------------------- watch

    function WatchTab({ state, run, disabled }) {
      const [expressions, setExpressions] = useState(['']);
      const [input, setInput] = useState('');
      const [values, setValues] = useState({});
      const [err, setErr] = useState('');
      const refresh = useCallback(async () => {
        const list = expressions.filter((e) => e.trim());
        const next = {};
        for (const expr of list) {
          try {
            const json = await run('eval', { expression: expr });
            next[expr] = { value: json.result?.value ?? '', ok: true };
          } catch (error) {
            next[expr] = { value: String(error?.message ?? error), ok: false };
          }
        }
        setValues(next);
      }, [expressions, run]);
      useEffect(() => {
        if (state?.debug?.active && !state?.debug?.running) refresh();
      }, [refresh, state?.debug?.active, state?.debug?.running, state?.debug?.stop?.addr]);
      const add = () => {
        const expr = input.trim();
        if (!expr) return;
        setErr('');
        setExpressions([...expressions.filter((e) => e.trim()), expr]);
        setInput('');
      };
      const remove = (expr) => setExpressions(expressions.filter((e) => e !== expr));
      const rows = expressions.filter((e) => e.trim());
      return h('div', { className: 'stm32-card' }, [
        h('div', { className: 'stm32-card-head' }, [
          h('span', null, `变量 / 表达式 (${rows.length})`),
          h('button', { className: 'stm32-btn', onClick: refresh, disabled }, '刷新'),
        ]),
        h('div', { style: { padding: '8px 10px' } }, [
          h('div', { className: 'stm32-row' }, [
            h('input', {
              className: 'stm32-input',
              style: { flex: 1, minWidth: 180 },
              value: input,
              onChange: (e) => setInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') add(); },
              placeholder: '变量名或表达式，例如 counter、&buf、GPIOA->ODR、*(uint32_t*)0x40020014',
            }),
            h('button', { className: 'stm32-btn primary', onClick: add }, '添加'),
          ]),
          err ? h('div', { className: 'stm32-hint stm32-badge-err' }, err) : null,
        ]),
        rows.length === 0
          ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '添加要监视的变量或表达式')
          : h('div', { className: 'stm32-scroll' }, h('table', { className: 'stm32-table' }, [
            h('thead', null, h('tr', null, [h('th', null, '表达式'), h('th', null, '值'), h('th', null, '')])),
            h('tbody', null, rows.map((expr) => {
              const item = values[expr];
              return h('tr', { key: expr }, [
                h('td', { style: { fontFamily: 'var(--dsw-font-mono, Consolas, monospace)' } }, expr),
                h('td', { className: item && !item.ok ? 'stm32-badge-err' : '' }, item ? (item.value || '(空)') : '—'),
                h('td', null, h('button', { className: 'stm32-btn danger', onClick: () => remove(expr) }, '删除')),
              ]);
            })),
          ])),
      ]);
    }

    // -------------------------------------------------------- disasm

    function DisasmTab({ state, run, disabled }) {
      const [address, setAddress] = useState('');
      const [count, setCount] = useState(24);
      const [list, setList] = useState(null);
      const [err, setErr] = useState('');
      const stopAddress = String(state?.debug?.stop?.addr ?? '').toLowerCase();
      const read = useCallback(async () => {
        try {
          const json = await run('disasm', { address: address.trim() || undefined, count: Number(count) || 24 });
          setList(json.instructions ?? []);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [address, count, run]);
      useEffect(() => {
        if (state?.debug?.active && !state?.debug?.running) read();
      }, [read, state?.debug?.active, state?.debug?.running, state?.debug?.stop?.addr]);
      const isPc = (addr) => stopAddress && String(addr).toLowerCase() === stopAddress;
      return h('div', { className: 'stm32-card' }, [
        h('div', { className: 'stm32-card-head' }, [
          h('span', null, '反汇编'),
          h('div', { className: 'stm32-row', style: { margin: 0 } }, [
            h('input', { className: 'stm32-input', style: { width: 140 }, value: address, onChange: (e) => setAddress(e.target.value), placeholder: '留空=当前 PC' }),
            h('input', { className: 'stm32-input', style: { width: 64 }, value: count, onChange: (e) => setCount(e.target.value), placeholder: '条数' }),
            h('button', { className: 'stm32-btn', onClick: read, disabled }, '反汇编'),
          ]),
        ]),
        err ? h('div', { className: 'stm32-empty' }, err) : null,
        !list
          ? h('div', { className: 'stm32-empty' }, disabled ? '调试未启动' : '暂停后点击“反汇编”')
          : h('div', { className: 'stm32-scroll', style: { maxHeight: 420 } }, h('table', { className: 'stm32-table stm32-mono' }, h('tbody', null,
            list.map((item, index) => h('tr', { key: `${item.address}-${index}`, style: isPc(item.address) ? { background: 'rgba(59,130,246,.14)' } : null }, [
              h('td', { className: 'stm32-muted' }, item.address),
              h('td', null, isPc(item.address) ? `▶ ${item.instruction}` : item.instruction),
            ])))))
      ]);
    }

    // --------------------------------------------------------- serial

    function SerialTab({ state, run }) {
      const serial = state?.serial ?? {};
      const [ports, setPorts] = useState([]);
      const [port, setPort] = useState(serial.port || '');
      const [baud, setBaud] = useState(serial.baud || 115200);
      const [data, setData] = useState('');
      const [hexMode, setHexMode] = useState(false);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const lines = serial.lines ?? [];
      const refreshPorts = useCallback(async () => {
        try {
          const json = await run('serialPorts');
          setPorts(json.ports ?? []);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [run]);
      useEffect(() => { refreshPorts(); }, [refreshPorts]);
      useEffect(() => {
        if (serial.port && !port) setPort(serial.port);
      }, [serial.port]); // eslint-disable-line react-hooks/exhaustive-deps
      const act = async (fn) => {
        setBusy(true);
        try { await fn(); setErr(''); } catch (error) { setErr(String(error?.message ?? error)); } finally { setBusy(false); }
      };
      const open = () => act(() => run('serialOpen', { port, baud: Number(baud) || 115200 }));
      const close = () => act(() => run('serialClose'));
      const send = () => act(async () => {
        await run('serialWrite', { data, hex: hexMode });
        setData('');
      });
      const clear = () => act(() => run('serialClear'));
      return h('div', { className: 'stm32-grid' }, [
        h('div', { className: 'stm32-card', key: 'serial' }, [
          h('div', { className: 'stm32-card-head' }, [
            h('span', null, `串口${serial.open ? ` · ${serial.port} @ ${serial.baud}` : ''}`),
            h('div', { className: 'stm32-row', style: { margin: 0 } }, [
              h('button', { className: 'stm32-btn', onClick: refreshPorts, disabled: busy }, '端口'),
              serial.open
                ? h('button', { className: 'stm32-btn danger', onClick: close, disabled: busy }, '关闭')
                : h('button', { className: 'stm32-btn primary', onClick: open, disabled: busy || !port }, '打开'),
              h('button', { className: 'stm32-btn', onClick: clear, disabled: busy }, '清空'),
            ]),
          ]),
          h('div', { className: 'stm32-row', style: { padding: '0 10px 8px' } }, [
            h('select', { className: 'stm32-input', style: { width: 110 }, value: port, onChange: (e) => setPort(e.target.value), disabled: serial.open }, [
              h('option', { value: '', key: '' }, ports.length ? '选择串口' : '无串口'),
              ...ports.map((item) => h('option', { value: item.port, key: item.port }, item.label || item.port)),
            ]),
            h('input', { className: 'stm32-input', style: { width: 96 }, value: baud, onChange: (e) => setBaud(e.target.value), placeholder: '波特率', disabled: serial.open }),
            h('label', { className: 'stm32-hint' }, [
              h('input', { type: 'checkbox', checked: hexMode, onChange: (e) => setHexMode(e.target.checked) }), ' HEX 发送',
            ]),
            h('span', { className: 'stm32-muted', style: { marginLeft: 'auto' } }, `已收 ${serial.bytes ?? 0} 字节`),
          ]),
          err ? h('div', { className: 'stm32-hint stm32-badge-err', style: { padding: '0 10px 6px' } }, err) : null,
          h('pre', { className: 'stm32-console', style: { maxHeight: 260, padding: '8px 10px' } },
            lines.length === 0 ? '暂无数据' : lines.map((line) => line.text.replace(/\r/g, '')).join('')),
        ]),
        h('div', { className: 'stm32-card', key: 'send' }, [
          h('div', { className: 'stm32-card-head' }, h('span', null, hexMode ? '发送 HEX' : '发送文本')),
          h('div', { style: { padding: '8px 10px' } }, [
            h('textarea', {
              className: 'stm32-input',
              style: { width: '100%', minHeight: 70, resize: 'vertical', fontFamily: 'var(--dsw-font-mono, Consolas, monospace)' },
              value: data,
              onChange: (e) => setData(e.target.value),
              placeholder: hexMode ? '01 0A FF 0D 0A' : '要发送的文本（默认自动追加发送一次）',
            }),
            h('div', { className: 'stm32-row', style: { marginTop: 6 } }, [
              h('button', { className: 'stm32-btn primary', onClick: send, disabled: busy || !serial.open || !data }, '发送'),
              h('span', { className: 'stm32-hint' }, hexMode ? '十六进制字节，可空格分隔' : 'UTF-8 文本'),
            ]),
          ]),
        ]),
      ]);
    }

    // ------------------------------------------------------------ panel

    function Workbench() {
      const { state, error, reload } = useServiceState();
      const [tab, setTab] = useState('console');
      const [switchProject, setSwitchProject] = useState(false);
      const [busy, setBusy] = useState(0);
      const run = useAction(setBusy);
      const doRun = useCallback(async (action, params = {}) => {
        setBusy((n) => n + 1);
        try {
          const json = await api(action, params);
          if (!json.ok) throw new Error(json.error ?? '操作失败');
          if (json.started) reload();
          return json;
        } catch (err) {
          // Surface the failure in the console via the log stream if possible.
          console.warn('[stm32]', err);
          throw err;
        } finally {
          setBusy((n) => Math.max(0, n - 1));
        }
      }, [reload]);

      useEffect(() => { ensureStyle(document); }, []);

      const debug = state?.debug ?? {};
      const active = Boolean(debug.active);
      const running = Boolean(debug.running);
      const project = state?.project;

      let body;
      if (tab === 'console') body = h(ConsoleTab, { state, run });
      else if (tab === 'registers') body = h(RegistersTab, { state, run, disabled: !active });
      else if (tab === 'memory') body = h(MemoryTab, { state, run, disabled: !active });
      else if (tab === 'breakpoints') body = h(BreakpointsTab, { state, run, disabled: !active });
      else if (tab === 'watch') body = h(WatchTab, { state, run, disabled: !active });
      else if (tab === 'disasm') body = h(DisasmTab, { state, run, disabled: !active });
      else if (tab === 'serial') body = h(SerialTab, { state, run });
      else if (tab === 'rtt') body = h(RttTab, { state, run, disabled: !active });
      else if (tab === 'symbols') body = h(SymbolTab, { state, run });
      else if (tab === 'pins') body = h(PinsTab, { state, run });
      else if (tab === 'settings') body = h(SettingsPage, { embedded: true });
      else body = h(StackTab, { state, run, disabled: !active });

      return h('div', { className: 'stm32-root' }, [
        h(Toolbar, { key: 'tb', state, run: doRun, busy, tab, setTab, onSwitchProject: () => setSwitchProject(true) }),
        h(TabBar, { key: 'tabs', tab, setTab }),
        h('div', { className: 'stm32-body', key: 'body' }, [
          project && project.errors?.length
            ? h('div', { className: 'stm32-hint stm32-badge-err', key: 'perr', style: { marginBottom: 6 } }, project.errors.join(' · '))
            : null,
          body,
        ]),
        switchProject ? h(PathPicker, {
          key: 'switcher',
          initial: project?.root || '',
          mode: 'dir',
          title: '选择工程目录',
          onPick: async (chosen) => {
            setSwitchProject(false);
            try { await doRun('config', { patch: { projectDir: chosen } }); } catch { /* 日志里会有错误 */ }
            reload();
          },
          onClose: () => setSwitchProject(false),
        }) : null,
        h('div', { className: 'stm32-status', key: 'st' }, [
          h('span', { key: 'd' }, [
            h('span', { className: `stm32-dot ${debug.active ? (debug.running ? 'busy' : 'on') : ''}` }),
            debug.active ? (debug.running ? '目标运行中' : '已暂停') : '调试未启动',
          ]),
          debug.stop && !debug.running ? h('span', { className: 'stm32-muted', key: 'stop' }, formatStop(debug.stop)) : null,
          state?.lastBuild?.running ? h('span', { key: 'b' }, '编译中…') : null,
          state?.lastFlash?.running ? h('span', { key: 'f' }, '下载中…') : null,
          project?.artifact && !debug.active ? h('span', { className: 'stm32-muted', key: 'art', title: project.artifact }, project.artifact.split(/[\\/]/).pop()) : null,
          error ? h('span', { className: 'stm32-badge-err', key: 'e' }, error) : null,
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('span', { className: 'stm32-muted', key: 'tc' },
            state?.toolchain ? `Keil ${state.toolchain.keil?.installed ? '✓' : '✗'} · GCC ${state.toolchain.gcc?.installed ? '✓' : '✗'} · OpenOCD ${state.toolchain.openocd?.installed ? '✓' : '✗'}` : ''),
          h('span', { className: 'stm32-muted', key: 't' }, busy > 0 ? '处理中…' : '就绪'),
        ]),
      ]);
    }

    function RailIcon() {
      return h('span', { title: 'STM32 工具', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
          h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('rect', { x: 5.2, y: 5.2, width: 5.6, height: 5.6, rx: 0.8, stroke: 'currentColor', strokeWidth: 1.1 }),
          [3, 6.5, 10, 13.5].map((x) => h('line', { key: `v${x}`, x1: x, y1: 0.8, x2: x, y2: 2.6, stroke: 'currentColor', strokeWidth: 1.1 })),
          [3, 6.5, 10, 13.5].map((x) => h('line', { key: `vb${x}`, x1: x, y1: 13.4, x2: x, y2: 15.2, stroke: 'currentColor', strokeWidth: 1.1 }))));
    }

    // ------------------------------------------------------- symbols / pins

    function SymbolTab({ state, run }) {
      const [info, setInfo] = useState(null);
      const [query, setQuery] = useState('');
      const [address, setAddress] = useState('');
      const [symbols, setSymbols] = useState(null);
      const [hit, setHit] = useState(null);
      const [err, setErr] = useState('');

      const loadInfo = useCallback(async () => {
        try {
          const json = await api('symbols', {}, { method: 'GET' });
          setInfo(json);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, []);
      useEffect(() => { loadInfo(); }, [loadInfo, state?.project?.artifact]);
      const search = useCallback(async () => {
        try {
          const json = await api('symbols', { query }, { method: 'GET' });
          setSymbols(json.symbols ?? []);
          setHit(null);
          setErr(json.ok ? '' : (json.error ?? '查找失败'));
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [query]);
      const lookup = useCallback(async () => {
        try {
          const json = await api('symbols', { address }, { method: 'GET' });
          setHit(json.ok ? json : null);
          setSymbols(null);
          setErr(json.ok ? '' : (json.error ?? '查找失败'));
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, [address]);
      return h('div', { className: 'stm32-grid' }, [
        h('div', { className: 'stm32-card', key: 'meta' }, [
          h('div', { className: 'stm32-card-head' }, [h('span', null, '符号表')]),
          !info ? h('div', { className: 'stm32-empty' }, '读取中…')
            : info.found
              ? h('div', { className: 'stm32-hint', style: { whiteSpace: 'normal' } }, `${info.file} · ${info.source} · ${info.count} 个符号`)
              : h('div', { className: 'stm32-empty' }, '未找到 .map/.elf，先构建一次工程'),
        ]),
        h('div', { className: 'stm32-card', key: 'query' }, [
          h('div', { className: 'stm32-card-head' }, [h('span', null, '按名字查找')]),
          h('div', { className: 'stm32-row', style: { padding: 0 } }, [
            h('input', {
              className: 'stm32-input',
              value: query,
              placeholder: 'HAL_GPIO_Init / main / SystemClock_Config …',
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') search(); },
            }),
            h('button', { className: 'stm32-btn primary', onClick: search }, '查找'),
          ]),
          symbols ? h('div', { className: 'stm32-scroll', style: { maxHeight: 300, marginTop: 6 } },
            symbols.length === 0
              ? h('div', { className: 'stm32-empty' }, '没有匹配的符号')
              : h('table', { className: 'stm32-table stm32-mono' }, h('tbody', null,
                symbols.map((s, i) => h('tr', { key: `${s.name}-${i}` }, [
                  h('td', null, s.name),
                  h('td', null, s.address),
                  h('td', { className: 'stm32-muted' }, s.size ? `${s.size} B` : ''),
                  h('td', { className: 'stm32-muted' }, s.object || s.type || ''),
                ]))))) : null,
        ]),
        h('div', { className: 'stm32-card', key: 'at' }, [
          h('div', { className: 'stm32-card-head' }, [h('span', null, '按地址反查')]),
          h('div', { className: 'stm32-row', style: { padding: 0 } }, [
            h('input', {
              className: 'stm32-input',
              value: address,
              placeholder: '0x08000c4d',
              onChange: (e) => setAddress(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') lookup(); },
            }),
            h('button', { className: 'stm32-btn', onClick: lookup }, '反查'),
          ]),
          hit ? h('div', { className: 'stm32-hint', style: { whiteSpace: 'normal' } },
            `${hit.address}  ${hit.symbol.name}${hit.symbol.size ? ` (${hit.symbol.size} B)` : ''}${hit.symbol.object ? ` · ${hit.symbol.object}` : ''}`) : null,
        ]),
        err ? h('div', { className: 'stm32-empty stm32-badge-err', key: 'e' }, err) : null,
      ]);
    }

    function PinsTab({ state, run }) {
      const [map, setMap] = useState(null);
      const [filter, setFilter] = useState('');
      const [err, setErr] = useState('');
      const refresh = useCallback(async () => {
        try {
          const json = await api('pins', {}, { method: 'GET' });
          if (!json.ok) throw new Error(json.error ?? '解析失败');
          setMap(json);
          setErr('');
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, []);
      useEffect(() => { refresh(); }, [refresh, state?.project?.root]);
      const pins = (map?.pins ?? []).filter((pin) => {
        if (!filter) return true;
        const text = `${pin.port}${pin.pin} ${pin.label ?? ''} ${pin.mode ?? ''}`.toLowerCase();
        return text.includes(filter.toLowerCase());
      });
      return h('div', null, [
        h('div', { className: 'stm32-card', key: 'tools' }, [
          h('div', { className: 'stm32-card-head' }, [
            h('span', null, `引脚图${map ? ` (${pins.length}/${map.pins.length})` : ''}`),
            h('button', { className: 'stm32-btn', onClick: refresh }, '刷新'),
          ]),
          h('div', { className: 'stm32-row', style: { padding: 0 } }, [
            h('input', {
              className: 'stm32-input',
              value: filter,
              placeholder: '过滤：PA5 / SPI / LED …',
              onChange: (e) => setFilter(e.target.value),
            }),
          ]),
          err ? h('div', { className: 'stm32-empty stm32-badge-err' }, err) : null,
          !map ? h('div', { className: 'stm32-empty' }, '解析中…')
            : pins.length === 0
              ? h('div', { className: 'stm32-empty' }, '没有在源码或 .ioc 中解析到引脚配置')
              : h('div', { className: 'stm32-scroll', style: { maxHeight: 480, marginTop: 6 } },
                h('table', { className: 'stm32-table' }, [
                  h('thead', null, h('tr', null, [h('th', null, '引脚'), h('th', null, '模式'), h('th', null, '标签'), h('th', null, '来源')])),
                  h('tbody', null, pins.map((pin, i) => h('tr', { key: `${pin.port}${pin.pin}-${i}` }, [
                    h('td', null, `${pin.port}${pin.pin}`),
                    h('td', { className: 'stm32-muted' }, pin.mode || '-'),
                    h('td', null, pin.label || ''),
                    h('td', { className: 'stm32-muted' }, (pin.source ?? '').split(/[\\/]/).pop() ?? ''),
                  ]))),
                ])),
        ]),
      ]);
    }

    // ---------------------------------------------------------------- RTT

    function RttTab({ state, run, disabled }) {
      const rtt = state?.rtt ?? {};
      const [address, setAddress] = useState('');
      const [channel, setChannel] = useState(String(state?.config?.rttChannel ?? 0));
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const lines = rtt.lines ?? [];
      const act = async (fn) => {
        setBusy(true);
        try { await fn(); setErr(''); } catch (error) { setErr(String(error?.message ?? error)); } finally { setBusy(false); }
      };
      const start = () => act(() => run('rttStart', {
        address: address.trim() || undefined,
        channel: channel === '' ? undefined : Number(channel),
      }));
      const stop = () => act(() => run('rttStop'));
      const clear = () => act(() => run('rttClear'));
      const write = () => {
        if (!text) return;
        act(async () => { await run('rttWrite', { text }); setText(''); });
      };
      return h('div', { className: 'stm32-grid' }, [
        h('div', { className: 'stm32-card', key: 'ctrl' }, [
          h('div', { className: 'stm32-card-head' }, [
            h('span', null, `SEGGER RTT${rtt.active ? `  端口 ${rtt.port} 通道 ${rtt.channel}` : '  未启动'}`),
            h('span', { className: 'stm32-muted' }, `收到 ${rtt.bytes ?? 0} 字节`),
          ]),
          h('div', { className: 'stm32-row', style: { padding: 0 } }, [
            h('input', { className: 'stm32-input', value: address, placeholder: '_SEGGER_RTT 地址，留空自动查找', onChange: (e) => setAddress(e.target.value) }),
            h('input', { className: 'stm32-input', style: { maxWidth: 90 }, value: channel, placeholder: '通道', onChange: (e) => setChannel(e.target.value) }),
            h('button', { className: 'stm32-btn primary', onClick: start, disabled: disabled || busy || rtt.active }, '启动 RTT'),
            h('button', { className: 'stm32-btn', onClick: stop, disabled: busy || !rtt.active }, '停止'),
            h('button', { className: 'stm32-btn', onClick: clear, disabled: busy }, '清空'),
          ]),
          h('div', { className: 'stm32-row', style: { padding: '6px 0 0' } }, [
            h('input', {
              className: 'stm32-input',
              value: text,
              placeholder: '向 RTT 通道写数据（回车发送）',
              onChange: (e) => setText(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') write(); },
            }),
            h('button', { className: 'stm32-btn', onClick: write, disabled: !rtt.active }, '发送'),
          ]),
          err ? h('div', { className: 'stm32-empty stm32-badge-err', style: { marginTop: 6 } }, err) : null,
          !rtt.active ? h('div', { className: 'stm32-hint', style: { marginTop: 6 } }, '先启动调试会话，再打开 RTT（目标固件需要集成 SEGGER RTT）。') : null,
        ]),
        h('pre', { className: 'stm32-console', key: 'log', style: { maxHeight: 420 } },
          lines.length ? lines.map((line) => line.text).join('') : '等待 RTT 数据…'),
      ]);
    }

    // --------------------------------------------------------- settings

    // -------------------------------------------------------- directory picker

    /**
     * Windows-Explorer style picker: breadcrumb address bar, drive sidebar,
     * name filter, selection highlight, double-click to open, Enter/双击确认.
     */
    function PathPicker({ initial, mode = 'dir', exts = [], title, onPick, onClose }) {
      const [cwd, setCwd] = useState(initial || '');
      const [view, setView] = useState({ dirs: [], files: [], parent: null, drives: [], selected: '' });
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(false);
      const [selected, setSelected] = useState('');
      const [filter, setFilter] = useState('');
      const extKey = exts.join(',');

      const browse = useCallback(async (target) => {
        setLoading(true);
        setError('');
        try {
          const json = await api('fs', { path: target ?? '', ext: extKey }, { method: 'GET' });
          if (!json.ok) throw new Error(json.error ?? '无法读取路径');
          setCwd(json.path ?? '');
          setView({
            dirs: json.dirs ?? [],
            files: json.files ?? [],
            parent: json.parent ?? null,
            drives: json.drives ?? [],
            selected: json.selected ?? '',
          });
          setSelected(json.selected ?? '');
          setFilter('');
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setLoading(false);
        }
      }, [extKey]);

      useEffect(() => { browse(initial || ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

      const activate = () => {
        if (mode === 'file') {
          if (selected) onPick(selected);
          return;
        }
        const path = selected || cwd;
        if (path) onPick(path);
      };

      const crumbs = useMemo(() => {
        if (!cwd) return [];
        const parts = cwd.split(/[\\/]+/).filter(Boolean);
        const list = [];
        let acc = '';
        for (let i = 0; i < parts.length; i += 1) {
          acc = i === 0 ? `${parts[0]}\\` : `${acc.replace(/[\\/]+$/, '')}\\${parts[i]}`;
          list.push({ name: parts[i], path: acc });
        }
        return list;
      }, [cwd]);

      const kw = filter.trim().toLowerCase();
      const dirs = (view.dirs ?? []).filter((d) => !kw || d.name.toLowerCase().includes(kw));
      const files = (view.files ?? []).filter((f) => !kw || f.name.toLowerCase().includes(kw));

      const row = (item, isFile) => h('div', {
        key: `${isFile ? 'f' : 'd'}:${item.path}`,
        className: `stm32-picker-item${isFile ? ' file' : ''}${selected === item.path ? ' active' : ''}`,
        title: item.path,
        onClick: () => setSelected(item.path),
        onDoubleClick: () => (isFile ? onPick(item.path) : browse(item.path)),
      }, [
        h('span', { className: 'stm32-picker-ico' }, isFile ? '📄' : '📁'),
        h('span', { className: 'stm32-picker-name' }, item.name),
        isFile ? h('span', { className: 'stm32-picker-tag' }, '文件') : null,
      ]);

      let list;
      if (loading) {
        list = [h('div', { key: 'loading', className: 'stm32-picker-empty' }, '读取中…')];
      } else if (!dirs.length && !files.length) {
        list = [h('div', { key: 'empty', className: 'stm32-picker-empty' }, error ? '无法读取该目录' : '这个目录是空的')];
      } else {
        list = [
          view.parent ? h('div', {
            key: '..',
            className: 'stm32-picker-item up',
            onClick: () => browse(view.parent),
            onDoubleClick: () => browse(view.parent),
          }, [h('span', { className: 'stm32-picker-ico' }, '↩'), h('span', { className: 'stm32-picker-name' }, '..')]) : null,
          ...dirs.map((item) => row(item, false)),
          ...files.map((item) => row(item, true)),
        ].filter(Boolean);
      }

      const canAct = mode === 'file' ? Boolean(selected) : Boolean(selected || cwd);
      const pickLabel = mode === 'file' ? '打开' : '选择此目录';

      return h('div', {
        className: 'stm32-picker-mask',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
      }, h('div', {
        className: 'stm32-picker',
        tabIndex: -1,
        onKeyDown: (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
          if (event.key === 'Enter') { event.preventDefault(); activate(); }
        },
      }, [
        h('div', { className: 'stm32-picker-head' }, [
          h('span', { className: 'stm32-picker-title' }, title || (mode === 'file' ? '选择文件' : '选择目录')),
          h('button', { className: 'stm32-picker-x', type: 'button', title: '关闭 (Esc)', onClick: onClose }, '×'),
        ]),
        h('div', { className: 'stm32-picker-bar' }, [
          h('button', {
            className: 'stm32-picker-nav',
            type: 'button',
            title: '上一级',
            disabled: !view.parent,
            onClick: () => browse(view.parent),
          }, '⬆'),
          h('button', {
            className: 'stm32-picker-nav',
            type: 'button',
            title: '刷新',
            onClick: () => browse(cwd),
          }, '↻'),
          h('div', { className: 'stm32-picker-crumbs' }, [
            h('button', { key: 'root', className: 'stm32-picker-crumb', type: 'button', onClick: () => browse('') }, '此电脑'),
            ...crumbs.map((crumb) => [
              h('span', { key: `s:${crumb.path}`, className: 'stm32-picker-sep' }, '›'),
              h('button', {
                key: crumb.path,
                className: 'stm32-picker-crumb',
                type: 'button',
                onClick: () => browse(crumb.path),
              }, crumb.name),
            ]).flat(),
          ]),
        ]),
        h('div', { className: 'stm32-picker-body' }, [
          h('aside', { className: 'stm32-picker-side' }, [
            h('div', { className: 'stm32-picker-side-title' }, '此电脑'),
            ...((view.drives ?? []).length
              ? view.drives.map((drive) => h('button', {
                key: drive.path,
                type: 'button',
                className: `stm32-picker-sideitem${cwd === drive.path ? ' active' : ''}`,
                onClick: () => browse(drive.path),
              }, [h('span', { className: 'stm32-picker-ico' }, '💽'), drive.name]))
              : [h('div', { key: 'nodrives', className: 'stm32-picker-side-empty' }, '无磁盘信息')]),
          ]),
          h('div', { className: 'stm32-picker-main' }, [
            h('div', { className: 'stm32-picker-filterbar' }, [
              h('input', {
                className: 'stm32-picker-filter',
                placeholder: '筛选名称…',
                value: filter,
                onChange: (event) => setFilter(event.target.value),
              }),
              h('span', { className: 'stm32-picker-count' }, `${dirs.length} 个文件夹 · ${files.length} 个文件`),
            ]),
            h('div', { className: 'stm32-picker-list' }, list),
          ]),
        ]),
        error ? h('div', { className: 'stm32-picker-error' }, error) : null,
        h('div', { className: 'stm32-picker-foot' }, [
          h('span', { className: 'stm32-picker-hint', title: selected || cwd }, selected || cwd || '选择一个位置'),
          h('button', { className: 'stm32-btn', type: 'button', onClick: onClose }, '取消'),
          h('button', {
            className: 'stm32-btn primary',
            type: 'button',
            disabled: !canAct,
            onClick: activate,
          }, pickLabel),
        ]),
      ]));
    }

    function SettingsPage({ embedded = false } = {}) {
      const [config, setConfig] = useState(null);
      const [checks, setChecks] = useState(null);
      const [message, setMessage] = useState('');
      const [saving, setSaving] = useState(false);
      const [picker, setPicker] = useState(null);
      const [ports, setPorts] = useState([]);
      const [env, setEnv] = useState(null);
      const [installing, setInstalling] = useState(false);
      const [exporting, setExporting] = useState(false);
      const [active, setActive] = useState('project');
      useEffect(() => { ensureStyle(document); api('config').then((json) => { if (json.ok) setConfig(json.config); }).catch(() => {}); }, []);
      const refreshPorts = useCallback(async () => {
        try {
          const json = await api('serialPorts', {});
          if (json.ok) setPorts(json.ports ?? []);
        } catch { /* 串口枚举失败不影响其它设置 */ }
      }, []);
      useEffect(() => { refreshPorts(); }, [refreshPorts]);
      const refreshEnv = useCallback(async () => {
        try {
          const json = await api('env', {}, { method: 'GET' });
          if (json.ok) setEnv(json);
        } catch { /* ignore */ }
      }, []);
      useEffect(() => { refreshEnv(); }, [refreshEnv]);
      const installTools = useCallback(async () => {
        setInstalling(true);
        setMessage('开始下载安装 arm-none-eabi-gcc 与 OpenOCD（体积较大，需要几分钟）…');
        try {
          const json = await api('envInstall', { components: 'all' });
          if (!json.ok) throw new Error(json.error ?? '启动安装失败');
          // Poll the install progress until it finishes.
          for (let i = 0; i < 600; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const status = await api('env', {}, { method: 'GET' }).catch(() => null);
            if (!status?.ok) continue;
            setEnv(status);
            if (!status.install?.running) break;
          }
          setMessage('安装完成，正在刷新工具链路径…');
          const config = await api('config', {}, { method: 'GET' }).catch(() => null);
          if (config?.ok) setConfig(config.config);
          await refreshEnv();
        } catch (error) {
          setMessage(String(error?.message ?? error));
        } finally {
          setInstalling(false);
        }
      }, [refreshEnv]);
      const exportCmake = useCallback(async () => {
        setExporting(true);
        try {
          const json = await api('exportCmake', { projectDir: config.projectDir || undefined });
          if (!json.ok) throw new Error(json.error ?? '导出失败');
          setMessage(`已导出 CMake 工程: ${json.export.dir}（${json.export.sources} 个源文件）`);
        } catch (error) {
          setMessage(String(error?.message ?? error));
        } finally {
          setExporting(false);
        }
      }, [config]);
      const save = useCallback(async () => {        setSaving(true);
        try {
          const json = await api('config', { patch: config });
          if (!json.ok) throw new Error(json.error ?? '保存失败');
          setConfig(json.config);
          setMessage('已保存');
        } catch (error) {
          setMessage(String(error?.message ?? error));
        } finally {
          setSaving(false);
        }
      }, [config]);
      const doctor = useCallback(async () => {
        setChecks([{ label: '检测中', value: '正在读取环境…', ok: null }]);
        try {
          const result = await fetch(`${API}/state`).then((r) => r.json());
          const tc = result.state?.toolchain;
          if (!tc) {
            setChecks([{ label: '环境检测', value: '暂无结果，请稍后重试', ok: false }]);
            return;
          }
          const probes = tc.probes?.probes ?? [];
          setChecks([
            { label: 'Keil UV4', value: tc.keil?.uv4 || '未找到', ok: Boolean(tc.keil?.uv4) },
            { label: 'arm-none-eabi-gcc', value: [tc.gcc?.gcc, tc.gcc?.version].filter(Boolean).join(' ') || '未找到', ok: Boolean(tc.gcc?.gcc) },
            { label: 'arm-none-eabi-gdb', value: tc.gcc?.gdb || '未找到', ok: Boolean(tc.gcc?.gdb) },
            { label: 'OpenOCD', value: tc.openocd?.path || '未找到', ok: Boolean(tc.openocd?.path) },
            { label: '调试器', value: probes.length ? probes.join(', ') : '未检测到已连接的调试器', ok: probes.length > 0 },
            { label: '构建后端', value: tc.backend || '自动（未确定）', ok: Boolean(tc.backend) },
          ]);
        } catch (error) {
          setChecks([{ label: '环境检测', value: String(error?.message ?? error), ok: false }]);
        }
      }, []);
      if (!config) return h('div', { className: 'stm32-empty' }, '读取配置…');

      const set = (key) => (event) => setConfig({ ...config, [key]: event.target.value });
      const field = (key, label, placeholder, hint, opts = {}) => {
        const input = h('input', {
          className: 'stm32-set-input',
          value: config[key] ?? '',
          placeholder: placeholder ?? '',
          spellCheck: false,
          onChange: set(key),
        });
        const control = opts.mode
          ? h('div', { className: 'stm32-set-inputwrap' }, [
            input,
            h('button', {
              className: 'stm32-set-browse',
              type: 'button',
              title: opts.mode === 'file' ? '浏览文件' : '浏览目录',
              onClick: () => setPicker({ key, mode: opts.mode, exts: opts.exts ?? [], title: opts.title }),
            }, '浏览…'),
          ])
          : input;
        return h('div', { className: 'stm32-set-row', key }, [
          h('div', { className: 'stm32-set-label' }, label),
          h('div', { className: 'stm32-set-control' }, [
            control,
            hint ? h('div', { className: 'stm32-set-hint' }, hint) : null,
          ]),
        ]);
      };
      const selectRow = (key, label, options, hint) => h('div', { className: 'stm32-set-row', key }, [
        h('div', { className: 'stm32-set-label' }, label),
        h('div', { className: 'stm32-set-control' }, [
          h('select', {
            className: 'stm32-set-select',
            value: config[key] ?? options[0]?.value ?? '',
            onChange: set(key),
          }, options.map((option) => h('option', { value: option.value, key: option.value }, option.label))),
          hint ? h('div', { className: 'stm32-set-hint' }, hint) : null,
        ]),
      ]);
      const checkRow = (key, label, text) => h('div', { className: 'stm32-set-row', key }, [
        h('div', { className: 'stm32-set-label' }, label),
        h('div', { className: 'stm32-set-control' }, [
          h('label', { className: 'stm32-set-check' }, [
            h('input', {
              type: 'checkbox',
              checked: Boolean(config[key]),
              onChange: (event) => setConfig({ ...config, [key]: event.target.checked }),
            }),
            h('span', null, text),
          ]),
        ]),
      ]);
      const section = (title, rows, id) => h('section', {
        className: 'stm32-set-card',
        key: title,
        id: id ? `stm32-set-${id}` : undefined,
      }, [
        h('div', { className: 'stm32-set-card-title' }, title),
        h('div', { className: 'stm32-set-card-body' }, rows),
      ]);

      const SET_SECTIONS = [
        ['project', '工程'], ['toolchain', '工具链'], ['debug', '调试器'], ['flash', '下载'],
        ['serial', '串口'], ['rtt', 'RTT'], ['symbols', '符号与引脚'], ['multi', '多核'],
      ];
      const jumpTo = (id) => {
        const element = typeof document === 'undefined' ? null : document.getElementById(`stm32-set-${id}`);
        if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      return h('div', { className: `stm32-settings${embedded ? ' stm32-settings-embed' : ''}` }, [
        h('div', { className: 'stm32-set-head' }, [
          h('h2', null, 'STM32 工具链'),
          h('p', null, '配置项目目录、编译器与调试器路径；留空的项会自动探测。修改后点“保存”，面板与工具会立刻生效。'),
        ]),
        h('div', { className: 'stm32-set-layout' }, [
          h('aside', { className: 'stm32-set-side', key: 'side' }, SET_SECTIONS.map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            className: `stm32-set-sideitem${active === id ? ' active' : ''}`,
            onClick: () => { setActive(id); jumpTo(id); },
          }, label))),
          h('div', { className: 'stm32-set-content', key: 'content' }, [
        section('工程', [
          field('projectDir', '工程目录', 'D:\\path\\to\\project', '留空则使用当前会话目录；支持 Keil .uvprojx、CMake、Makefile 工程。', { mode: 'dir', title: '选择工程目录' }),
          field('device', '芯片型号', 'STM32F407VGTx', '留空则从 .uvprojx 自动读取，用于匹配 OpenOCD target 与 SVD。'),
          field('svdPath', 'SVD 文件', '可选，留空自动查找或下载', '寄存器面板使用；留空时依次在 Keil Pack、缓存、cmsis-svd 中查找。', { mode: 'file', exts: ['.svd'], title: '选择 SVD 文件' }),
          h('div', { className: 'stm32-set-row', key: 'exportCmake' }, [
            h('div', { className: 'stm32-set-label' }, '开源构建'),
            h('div', { className: 'stm32-set-control' }, [
              h('button', { className: 'stm32-btn', onClick: exportCmake, disabled: exporting },
                exporting ? '导出中…' : '导出为 CMake/GCC'),
              h('div', { className: 'stm32-set-hint' },
                '把 Keil .uvprojx 的源文件、include、宏定义导出到 <工程>/.dsh-gcc（用 GNU 启动文件替换 Keil 汇编启动文件）。没装 Keil 时点“编译”会自动走这条路。'),
            ]),
          ]),
        ], 'project'),
        section('工具链', [
          field('uv4Path', 'Keil UV4', 'C:\\Keil_v5\\UV4\\UV4.exe', '使用 Keil/AC5 工程构建时需要；纯开源工具链可留空。', { mode: 'file', exts: ['.exe'], title: '选择 UV4.exe' }),
          field('openocdPath', 'OpenOCD', 'C:\\...\\bin\\openocd.exe', '下载与调试都通过它连接 ST-Link / CMSIS-DAP / J-Link。', { mode: 'file', exts: ['.exe'], title: '选择 openocd.exe' }),
          field('openocdScripts', 'OpenOCD scripts', '可选，对应 -s 参数目录', 'interface/ 与 target/ 配置文件所在目录；留空从 OpenOCD 安装位置推断。', { mode: 'dir', title: '选择 OpenOCD scripts 目录' }),
          field('gdbPath', 'arm-none-eabi-gdb', '自动从 PATH 查找', '调试会话使用 GDB/MI 协议；留空自动探测。', { mode: 'file', exts: ['.exe'], title: '选择 arm-none-eabi-gdb.exe' }),
          field('gccPath', 'arm-none-eabi-gcc', '自动从 PATH 查找', '开源工具链构建时使用；Keil 构建不需要。', { mode: 'file', exts: ['.exe'], title: '选择 arm-none-eabi-gcc.exe' }),
          field('ninjaPath', 'Ninja / Make', '自动从 PATH 查找', 'CMake 生成构建文件后调用的构建工具；填 ninja.exe，留空会自动探测。', { mode: 'file', exts: ['.exe'], title: '选择 ninja.exe' }),
        ], 'toolchain'),
        section('调试器', [
          h('div', { className: 'stm32-set-row', key: 'probe' }, [
            h('div', { className: 'stm32-set-label' }, '类型'),
            h('div', { className: 'stm32-set-control' }, [
              h('select', { className: 'stm32-set-select', value: config.probe ?? 'stlink', onChange: set('probe') }, [
                h('option', { value: 'stlink', key: 's' }, 'ST-Link'),
                h('option', { value: 'cmsis-dap', key: 'c' }, 'CMSIS-DAP / DAPLink'),
                h('option', { value: 'jlink', key: 'j' }, 'J-Link'),
              ]),
              h('div', { className: 'stm32-set-hint' }, '选择已连接的调试器类型，OpenOCD 会加载对应的 interface 配置。'),
            ]),
          ]),
          field('interfaceCfg', 'interface 配置', '留空自动选择，如 interface/stlink.cfg', '一般留空即可；需要特殊接法时手动填写。'),
          field('targetCfg', 'target 配置', '留空自动选择，如 target/stm32f4x.cfg', '默认由芯片型号推断，例如 STM32F407 对应 target/stm32f4x.cfg。'),
          field('adapterSpeed', 'SWD 速度 (kHz)', '4000', '连接不稳定时可调低，例如 1000。'),
          field('gdbPort', 'GDB 端口', '3333', 'OpenOCD 与 GDB 之间的本地端口，被占用时换一个。'),
          h('div', { className: 'stm32-set-row', key: 'runToMain' }, [
            h('div', { className: 'stm32-set-label' }, '启动行为'),
            h('div', { className: 'stm32-set-control' }, [
              h('label', { className: 'stm32-set-check' }, [
                h('input', { type: 'checkbox', checked: Boolean(config.runToMain), onChange: (event) => setConfig({ ...config, runToMain: event.target.checked }) }),
                h('span', null, '启动调试后自动运行到 main'),
              ]),
            ]),
          ]),
        ], 'debug'),
        section('下载', [
          selectRow('flashErase', '擦除方式', [
            { value: 'none', label: '按扇区擦除（默认）' },
            { value: 'mass', label: '整片擦除 (mass erase)' },
          ], '整片擦除会清空芯片全部 Flash 内容，请确认后再用。'),
          checkRow('flashVerify', '校验', '下载后校验 Flash 内容'),
          checkRow('flashReset', '复位', '下载完成后复位并运行'),
        ], 'flash'),
        section('串口', [
          h('div', { className: 'stm32-set-row', key: 'serialPort' }, [
            h('div', { className: 'stm32-set-label' }, '默认串口'),
            h('div', { className: 'stm32-set-control' }, [
              h('div', { className: 'stm32-set-inputwrap' }, [
                h('select', {
                  className: 'stm32-set-select',
                  value: config.serialPort ?? '',
                  onChange: set('serialPort'),
                }, [
                  h('option', { key: '', value: '' }, '（不指定）'),
                  ...ports.map((p) => h('option', { key: p.port, value: p.port }, p.label || p.port)),
                  config.serialPort && !ports.some((p) => p.port === config.serialPort)
                    ? h('option', { key: '__cur', value: config.serialPort }, config.serialPort)
                    : null,
                ]),
                h('button', { className: 'stm32-set-browse', type: 'button', title: '重新枚举串口', onClick: refreshPorts }, '刷新'),
              ]),
              h('div', { className: 'stm32-set-hint' }, '串口面板的默认端口；留空则在面板里选择。'),
            ]),
          ]),
          field('serialBaud', '默认波特率', '115200', '串口面板打开时的默认波特率。'),
        ], 'serial'),
        section('RTT 日志', [
          field('rttPort', 'RTT 端口', '9090', 'OpenOCD 为 RTT 打开的 TCP 端口，面板通过它读取日志。'),
          field('rttChannel', 'RTT 通道', '0', '默认读取 channel 0。'),
        ], 'rtt'),
        section('符号与引脚', [
          field('symbolFile', '符号表文件', '可选：.map / .elf', '留空则自动在工程目录里找 .map / .elf，用于符号查找与引脚图。', { mode: 'file', exts: ['.map', '.elf', '.axf'], title: '选择符号表 / ELF' }),
          field('iocFile', 'CubeMX .ioc', '可选：工程 .ioc 文件', '留空则自动在工程目录里找；引脚图会合并 .ioc 与源码中的配置。', { mode: 'file', exts: ['.ioc'], title: '选择 .ioc 文件' }),
        ], 'symbols'),
        section('多核', [
          selectRow('core', '目标内核', [
            { value: '0', label: 'core0（Cortex-M7 / 主核）' },
            { value: '1', label: 'core1（Cortex-M4 / 从核）' },
          ], '仅 H7 等双核器件有效；OpenOCD 一次连接一个核，core1 需要单独启动调试。'),
        ], 'multi'),
        env ? h('section', { className: 'stm32-set-card', key: 'env' }, [
          h('div', { className: 'stm32-set-card-title' }, '工具链安装'),
          h('div', { className: 'stm32-set-card-body' }, [
            h('div', { className: 'stm32-set-hint', style: { whiteSpace: 'normal', marginBottom: 8 } },
              '一键下载 xPack arm-none-eabi-gcc 与 OpenOCD 到 DSH 数据目录（约 300 MB），并自动写回上面的路径。'),
            h('div', { className: 'stm32-set-actions', style: { padding: 0 } }, [
              h('button', { className: 'stm32-btn primary', onClick: installTools, disabled: installing || env.install?.running },
                env.install?.running ? (env.install.message || '安装中…') : (installing ? '安装中…' : '下载并安装工具链')),
              env.cores?.cores > 1 ? h('span', { className: 'stm32-set-hint' }, `检测到 ${env.cores.cores} 核器件，当前 core${env.cores.selected}`) : null,
            ]),
          ]),
        ]) : null,
        checks ? h('div', {
          className: 'stm32-picker-mask',
          key: 'checks-mask',
          onMouseDown: (event) => { if (event.target === event.currentTarget) setChecks(null); },
        }, h('div', { className: 'stm32-dialog' }, [
          h('div', { className: 'stm32-picker-head' }, [
            h('span', { className: 'stm32-picker-title' }, '环境检测'),
            h('button', { className: 'stm32-picker-x', type: 'button', title: '关闭', onClick: () => setChecks(null) }, '×'),
          ]),
          h('div', { className: 'stm32-dialog-body' }, checks.map((row) => h('div', { className: 'stm32-check-row', key: row.label }, [
            h('span', { className: 'stm32-check-dot ' + (row.ok === true ? 'ok' : row.ok === false ? 'bad' : 'unknown') }),
            h('span', { className: 'stm32-check-label' }, row.label),
            h('span', { className: 'stm32-check-value', title: row.value }, row.value),
          ]))),
          h('div', { className: 'stm32-picker-foot' }, [
            h('button', { className: 'stm32-btn primary', type: 'button', onClick: () => setChecks(null) }, '关闭'),
          ]),
        ])) : null,
          ]),
        ]),
        h('div', { className: 'stm32-set-actions stm32-set-actions-center' }, [
          h('button', { className: 'stm32-btn primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', { className: 'stm32-btn', onClick: doctor }, '环境检测'),
        ]),
        message ? h('div', { className: 'stm32-set-actions-message' }, message) : null,
        picker ? h(PathPicker, {
          initial: config[picker.key] || '',
          mode: picker.mode,
          exts: picker.exts,
          title: picker.title,
          onPick: (chosen) => { setConfig({ ...config, [picker.key]: chosen }); setPicker(null); },
          onClose: () => setPicker(null),
        }) : null,
      ]);
    }

    // ----------------------------------------------------------- apply

    function apply(ctx) {
      // The settings page can be opened without ever mounting the workbench,
      // so inject the stylesheet here as well as inside the panel.
      try {
        ensureStyle(typeof document === 'undefined' ? null : document);
      } catch (error) {
        console.error('[dsh-stm32-toolkit] 注入样式失败', error);
      }

      // Seats are only materialized once their slot service exists, so claim
      // them with inject() first — registering directly is a no-op/throw.
      const registerPanel = () => {
        const stopMain = ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ model: null }),
        }, Workbench);
        const stopRail = ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 46,
          label: () => 'STM32',
        }, RailIcon);
        return () => {
          stopRail?.();
          stopMain?.();
        };
      };

      try {
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', registerPanel));
      } catch (error) {
        console.error('[dsh-stm32-toolkit] 注册工作台面板失败', error);
      }
    }

    module.exports = {
      name: 'dsh-stm32-toolkit',
      inject: ['slots', 'locale'],
      apply,
      // Exposed for the render smoke tests; not part of the plugin API.
      __components: { Workbench, SettingsPage, PathPicker, Toolbar },
    };
    return module.exports;
  },
});
