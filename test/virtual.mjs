/* 用新生成的 9 张虚拟单据跑一遍真实识别，看看版式更接近真实之后还认不认得出来。 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const PORT = Number(process.env.JW_CDP_PORT || 9353);
const ROOT = process.cwd();
const KEY = (await import('node:fs')).readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = readdirSync(join(ROOT, 'app', 'test', 'samples', 'virtual'))
  .filter((n) => n.endsWith('.jpg')).sort();

// 期望的文书类型（判型错=整页抽空，所以这一步单独核对）
const EXPECT = {
  'vr-cbc': '血常规', 'vr-chem': '生化', 'vr-coag': '出凝血',
  'vr-immu': '免疫', 'vr-infect': '病毒学', 'vr-fish': 'FISH',
  'vr-patho': '病理', 'vr-course': '病案首页', 'vr-discharge': '出院小结'
};

const profile = mkdtempSync(join(tmpdir(), 'jw-virtual-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank',
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
    } catch { /* 等 Chrome */ }
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
  await ev(`window.confirm = function(){ return true; }; document.getElementById('btn-reset').click(); 'reset'`);
  await sleep(800);

  // 特殊页面默认不勾，这次要一次看全，先把所有页面打开
  for (let i = 0; i < 20; i++) {
    const more = await ev(`(function(){
      var cb = Array.from(document.querySelectorAll('.pc-use')).filter(function(c){ return !c.checked; })[0];
      if (!cb) return 0;
      cb.click();
      return 1;
    })()`);
    if (!more) break;
    await sleep(120);
  }
  console.log('  已勾选页面：', await ev(`Array.from(document.querySelectorAll('.pc-use')).filter(function(c){return c.checked;}).length`));

  // 顺序刻意打乱，模拟"一线人员上传顺序一塌糊涂"
  const order = [...FILES].reverse();
  await ev(`(async function(){
    const names = ${JSON.stringify(order)};
    const dt = new DataTransfer();
    for (const n of names) {
      const r = await fetch('test/samples/virtual/' + n);
      const b = await r.blob();
      dt.items.add(new File([b], n, { type: 'image/jpeg' }));
    }
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return dt.items.length;
  })()`);

  // 等所有图都准备好再点识别（不然会拿空图去问模型）
  for (let i = 0; i < 60; i++) {
    const ready = await ev(`__S.assets.length === ${FILES.length} && __S.assets.every(function(a){ return a.status === 'pending' && a.dataUrl && a.width > 0; })`);
    if (ready) break;
    await sleep(400);
  }

  const t0 = Date.now();
  await ev(`document.getElementById('btn-run').click(); 'run'`);
  for (let i = 0; i < 240; i++) {
    const done = await ev(`!__S.running && __S.assets.every(function(a){ return a.status === 'done' || a.status === 'error' || a.status === 'skipped'; })`);
    if (done) break;
    await sleep(1000);
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  const report = await ev(`(function(){
    return __S.assets.map(function(a){
      var obs = __S.observations.filter(function(o){ return o.assetId === a.id; });
      var pick = {};
      ['HGB','WBC','LDH','FIB','B2MG','EBV_DNA','FISH_BCL6','IHC_CD20','NAME','SEX','VISITDATE'].forEach(function(k){
        var o = obs.filter(function(x){ return x.indicatorId === k; })[0];
        if (o) pick[k] = o.value;
      });
      return { file: a.name, type: a.docType, status: a.status, n: obs.length, pick: pick, err: a.error || '' };
    });
  })()`);

  console.log('  墙钟 ' + wall + ' 秒，' + FILES.length + ' 份');
  for (const r of report) {
    console.log('  ' + r.file.padEnd(26) + String(r.type || '-').padEnd(8) + r.status.padEnd(6) + String(r.n).padStart(3) + ' 项  ' + JSON.stringify(r.pick));
    if (r.status !== 'done') problems.push(`${r.file} 状态 ${r.status}：${r.err}`);
    const want = EXPECT[r.file.replace(/-\d+\.jpg$/, '')];
    if (want && r.type !== want) problems.push(`${r.file} 判成「${r.type}」，应为「${want}」`);
    if (r.n < 2) problems.push(`${r.file} 只抽出 ${r.n} 项`);
  }

  const usage = await ev(`window.Model.getUsage()`);
  console.log('  用量：', JSON.stringify(usage));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(join(ROOT, 'docs', 'figs', 'ui-virtual.png'), Buffer.from(shot.data, 'base64'));
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
console.log('\n通过：9 张虚拟单据全部判对类型并抽出了内容。');
