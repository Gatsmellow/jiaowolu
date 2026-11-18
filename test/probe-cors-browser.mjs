/**
 * 只回答一个问题：浏览器从 http://127.0.0.1:8765 直连 api.deepseek.com，
 * CORS 到底通不通？同时把响应头打出来。
 * 用法：node test/probe-cors-browser.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const HOST_RULES = process.env.JW_HOST_RULES || '';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();

const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-cors-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  ...(HOST_RULES ? [`--host-resolver-rules=${HOST_RULES}`] : []),
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1200,800', 'about:blank'
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
  const net = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.url.includes('deepseek.com')) {
        net.push({ url: r.url.slice(0, 80), status: r.status, acao: r.headers['access-control-allow-origin'] || null });
      }
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
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2000);

  const out = await evaluate(`(async () => {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${key}' },
        body: JSON.stringify({ model: 'deepseek-flash',
          messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 8, temperature: 0 })
      });
      const t = await r.text();
      return { ok: true, status: r.status, body: t.slice(0, 90) };
    } catch (e) {
      return { ok: false, error: e.name + ': ' + e.message };
    }
  })()`);

  console.log('页面 origin: http://127.0.0.1:8765');
  console.log('fetch 结果:', JSON.stringify(out));
  console.log('网络记录:', JSON.stringify(net));

} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
