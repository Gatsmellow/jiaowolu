/* 侧栏"添加患者"错位回归：加满 5 个患者后，按钮必须仍然点得到、且不和别的按钮重叠。
 * 判据：用 elementFromPoint 取按钮中心点，落到的必须是这个按钮自己（或它的子节点）。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const PORT = Number(process.env.JW_CDP_PORT || 9350);
const KEY = (await import('node:fs')).readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'jw-sidebar-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,880', 'about:blank',
], { stdio: 'ignore' });

let ws;
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      };
      return;
      }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('连不上 Chrome');
}

let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

const problems = [];
try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2500);

  // 写入 Key，确保页面处于可用状态
  await evaluate(`localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(KEY)});
    localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base:'https://api.deepseek.com', model:'deepseek-flash' }));
    location.reload(); 'reloaded'`);
  await sleep(3000);

  // 连加 5 次，凑到 6 个患者
  for (let i = 0; i < 5; i++) {
    await evaluate(`document.getElementById('btn-add-patient').click(); 'ok'`);
    await sleep(160);
  }

  const state = await evaluate(`(function () {
    var btn = document.getElementById('btn-add-patient');
    var r = btn.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    var list = document.getElementById('patient-list');
    var run = document.getElementById('btn-run').getBoundingClientRect();
    var overlap = !(r.bottom <= run.top || r.top >= run.bottom);
    return {
      patients: document.querySelectorAll('.patient').length,
      btn: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
      run: { top: Math.round(run.top), bottom: Math.round(run.bottom) },
      hitIsButton: hit === btn || btn.contains(hit),
      hitTag: hit ? hit.tagName + '.' + hit.className : 'null',
      overlappingRun: overlap,
      listScrolls: list.scrollHeight > list.clientHeight + 1,
      listClient: list.clientHeight,
      listScroll: list.scrollHeight,
      activeVisible: (function () {
        var a = list.querySelector('.patient.active');
        if (!a) return null;
        var ar = a.getBoundingClientRect(), lr = list.getBoundingClientRect();
        return ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1;
      })()
    };
  })()`);
  console.log('  侧栏状态：', JSON.stringify(state));

  if (state.patients !== 6) problems.push(`患者数 ${state.patients}，应为 6`);
  if (!state.hitIsButton) problems.push(`按钮中心点落到了 ${state.hitTag}，被别的元素盖住了`);
  if (state.overlappingRun) problems.push('「添加患者」和「开始识别」在垂直方向重叠');
  if (!state.listScrolls) problems.push('患者列表没有出现内部滚动，说明还在把下面的按钮顶出去');
  if (state.activeVisible === false) problems.push('刚添加的「患者 06」落在列表可视区外，看着像没加上');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-sidebar.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已保存 docs/figs/ui-sidebar.png');
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (problems.length) {
  console.log('\n不通过：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n通过：加满 6 位患者后，「添加患者」没有被盖住，列表在内部滚动。');
