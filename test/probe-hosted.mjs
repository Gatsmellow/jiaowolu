/**
 * 托管模式的冒烟检查：用一个"不是本机"的主机名打开页面，
 * 确认 1) 根目录能跳到 app/  2) 没有把"服务断开"的红条挂出来  3) 没有控制台报错。
 * 用法：node test/probe-hosted.mjs <页面地址>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const APP = process.argv[2] || 'http://githubtest.io:8791/';
const HOST_RULES = process.env.JW_HOST_RULES || 'MAP githubtest.io 127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-hosted-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--host-resolver-rules=${HOST_RULES}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1280,820', 'about:blank'
], { stdio: 'ignore' });

let ws;
try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* wait */ }
    await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });
  await sleep(4500);

  const state = await evaluate(`({
    href: location.href,
    bar: (function () { var b = document.getElementById('offline-bar'); return b ? b.hidden : 'missing'; })(),
    rows: document.querySelectorAll('#tbody tr').length,
    pages: document.querySelectorAll('.page-check').length,
    pill: (document.getElementById('model-pill') || {}).textContent,
    hosted: typeof HOSTED !== 'undefined' ? HOSTED : 'n/a'
  })`);

  console.log('打开:', APP);
  console.log('落地:', state.href);
  console.log('离线条 hidden:', state.bar, '｜ 表格行:', state.rows, '｜ 页面数:', state.pages, '｜ 模型 pill:', state.pill);
  console.log('控制台报错:', errors.length ? errors.slice(0, 3) : '无');
  const ok = state.bar === true && state.pages >= 7 && errors.length === 0 && /\/app\/$/.test(state.href);
  console.log(ok ? '通过：托管模式下没有误报"服务断开"。' : '不通过，见上。');
  process.exitCode = ok ? 0 : 1;
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
