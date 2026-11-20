/* 验证"关掉页面任务不丢"：传一份报告 → 刷新页面 → 患者和报告还在。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const PORT = Number(process.env.JW_CDP_PORT || 9352);
const KEY = (await import('node:fs')).readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'jw-cache-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
          }
        };
        return;
      }
    } catch { /* 等 */ }
    await sleep(250);
  }
  throw new Error('连不上 Chrome');
}
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function ev(expression) {
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
  await ev(`localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(KEY)});
    localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base:'https://api.deepseek.com', model:'deepseek-flash' }));
    location.reload(); 'ok'`);
  await sleep(3000);

  // 只上传，不识别——缓存要覆盖"传了还没跑"的情况
  await ev(`(async function(){
    const r = await fetch('test/samples/batch/cbc-20261110.jpg');
    const b = await r.blob();
    const f = new File([b], 'cbc-20261110.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return 'dropped';
  })()`);
  await sleep(1800);

  const before = await ev(`({ patients: __S.patients.length, assets: __S.assets.length })`);
  console.log('  刷新前：', JSON.stringify(before));
  if (before.assets !== 1) problems.push('上传后 asset 数量不是 1');

  // 等缓存写盘（节流 700ms，这里多给一些）
  await sleep(1500);
  await send('Page.reload', {});
  await sleep(3500);

  const after = await ev(`({
    patients: __S.patients.length,
    assets: __S.assets.length,
    name: __S.assets[0] ? __S.assets[0].name : '',
    hasData: __S.assets[0] ? String(__S.assets[0].dataUrl || '').slice(0, 5) : '',
    status: __S.assets[0] ? __S.assets[0].status : ''
  })`);
  console.log('  刷新后：', JSON.stringify(after));

  if (after.assets !== 1) problems.push(`刷新后报告数变成 ${after.assets}，应恢复 1 份`);
  if (after.name !== 'cbc-20261110.jpg') problems.push(`恢复的报告名是「${after.name}」，不对`);
  if (after.hasData !== 'data:') problems.push('恢复出来的图片没有内容');

  // 清空任务后，缓存也该没
  await ev(`window.confirm = function(){ return true; }; document.getElementById('btn-reset').click(); 'ok'`);
  await sleep(1600);
  await send('Page.reload', {});
  await sleep(3200);
  const cleared = await ev(`({ assets: __S.assets.length })`);
  console.log('  清空后刷新：', JSON.stringify(cleared));
  if (cleared.assets !== 0) problems.push('点了"清空本次任务"后，刷新还把旧报告恢复回来了');
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
console.log('\n通过：刷新页面任务还在，点"清空"之后不再恢复。');
