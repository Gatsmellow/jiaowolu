/**
 * 多患者隔离测试：两位患者的报告、识别结果、切换是否互不干扰。
 * 用 node test/e2e-multi.mjs
 * 前置：8765 端口已跑起本地服务；secrets/ark_api.txt 有 Key。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const APP = 'http://127.0.0.1:8765/';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
if (!key) { console.error('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）'); process.exit(2); }

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-multi-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
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
    if (!target) throw new Error('Chrome did not start');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
      }
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: APP });
    await sleep(1500);
    await evaluate(`(() => {
      localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      localStorage.removeItem('jiaowolu.library.v2');
      localStorage.removeItem('jiaowolu.selectedPages.v2');
      return 'seeded';
    })()`);
    await send('Page.reload');
    await sleep(2200);

    // 只留血常规与综合生化两页。每次点击都会重画侧栏，所以每轮都要重新查询节点。
    const keepOnly = (wanted) => evaluate(`(async () => {
      for (let round = 0; round < 12; round++) {
        const boxes = Array.from(document.querySelectorAll('.pc-use'));
        const extra = boxes.filter(b => b.checked && ${JSON.stringify(wanted)}.indexOf(b.value) === -1);
        if (!extra.length) break;
        extra[0].click();
        await new Promise(r => setTimeout(r, 120));
      }
      const now = Array.from(document.querySelectorAll('.pc-use')).filter(b => b.checked).map(b => b.value);
      return now;
    })()`);

    const upload = (file) => evaluate(`(async () => {
      const before = window.__S.assets.length;
      const res = await fetch('/test/samples/${file}');
      const blob = await res.blob();
      const f = new File([blob], '${file}', { type: 'image/jpeg' });
      const dt = new DataTransfer();
      dt.items.add(f);
      document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      for (let i = 0; i < 200; i++) {
        if (window.__S.assets.length > before) break;
        await new Promise(r => setTimeout(r, 120));
      }
      await new Promise(r => setTimeout(r, 300));
      return window.__S.assets.length;
    })()`);

    const run = () => evaluate(`(async () => {
      document.querySelector('#btn-run').click();
      for (let i = 0; i < 400; i++) {
        if (!window.__S.running) break;
        await new Promise(r => setTimeout(r, 150));
      }
      await new Promise(r => setTimeout(r, 250));
      const rows = Array.from(document.querySelectorAll('#grid-body tr'));
      return {
        rows: rows.length,
        ok: rows.filter(tr => tr.className === 'ok').length,
        obs: window.__S.observations.length,
        assets: window.__S.assets.length
      };
    })()`);

    const snapshot = () => evaluate(`(() => {
      const s = window.__S;
      return {
        patients: s.patients.map(p => ({ id: p.id, code: p.code })),
        currentId: s.currentId,
        assets: s.assets.map(a => ({ pid: a.patientId, status: a.status })),
        obs: s.observations.map(o => ({ pid: o.patientId, asset: o.assetId, ind: o.indicatorId })),
        orphanAssets: s.assets.filter(a => !s.patients.some(p => p.id === a.patientId)).length,
        orphanObs: s.observations.filter(o => !s.patients.some(p => p.id === o.patientId)).length
      };
    })()`);

    const pages = await keepOnly(['cbc', 'bio']);
    console.log('[0/5] 只保留页面：' + pages.join(','));
    check('只勾了血常规与综合生化', pages.length === 2 && pages.includes('cbc') && pages.includes('bio'));

    const p0 = await snapshot();
    check('页面初始只有一位患者', p0.patients.length === 1, JSON.stringify(p0.patients.map(p => p.code)));

    console.log('[1/5] 患者 01：上传血常规并识别');
    await upload('cbc-20261110.jpg');
    const r1 = await run();
    console.log('    ' + JSON.stringify(r1));
    check('患者 01 有识别结果', r1.ok >= 3, r1.ok + ' 项');

    console.log('[2/5] 加患者 02，上传生化并识别');
    await evaluate("document.querySelector('#btn-add-patient').click(); 'added'");
    await sleep(300);
    await upload('bio-20261110.jpg');
    const r2 = await run();
    console.log('    ' + JSON.stringify(r2));
    check('患者 02 有识别结果', r2.ok >= 1, r2.ok + ' 项');

    console.log('[3/5] 归属检查');
    const s2 = await snapshot();
    console.log('    patients=' + s2.patients.length +
      ' assets=' + JSON.stringify(s2.assets.map(a => a.status)) +
      ' obs=' + s2.obs.length);
    check('两位患者', s2.patients.length === 2, s2.patients.map(p => p.code).join(' / '));
    check('每人各 1 份报告', s2.assets.length === 2, s2.assets.length + ' 份');
    check('没有孤儿资产', s2.orphanAssets === 0);
    check('没有孤儿观察值', s2.orphanObs === 0);

    const p1 = s2.patients[0].id, p2 = s2.patients[1].id;
    const assetsOf1 = s2.assets.filter(a => a.pid === p1);
    const assetsOf2 = s2.assets.filter(a => a.pid === p2);
    const obsOf1 = s2.obs.filter(o => o.pid === p1);
    const obsOf2 = s2.obs.filter(o => o.pid === p2);
    check('患者 01 只挂自己的报告', assetsOf1.length === 1 && assetsOf2.length === 1);
    check('患者 02 的观察值不来自患者 01 的报告',
      obsOf2.every(o => !assetsOf1.some(a => a.assetId === o.asset)));

    console.log('[4/5] 切回患者 01');
    await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.patient[data-pid]'));
      const t = rows.find(r => r.getAttribute('data-pid') === ${JSON.stringify(p1)});
      if (t) t.click();
      return rows.length;
    })()`);
    await sleep(500);
    const back = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#grid-body tr'));
      return { rows: rows.length, ok: rows.filter(tr => tr.className === 'ok').length,
               cur: window.__S.currentId };
    })()`);
    console.log('    ' + JSON.stringify(back));
    check('切回后当前患者是 01', back.cur === p1);
    check('切回后结果还在', back.ok === r1.ok, back.ok + ' 项 / 原来 ' + r1.ok + ' 项');
    check('切回后表里没有对方的数据', obsOf1.length === r1.obs, obsOf1.length + ' 条观察值');

  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const bad = results.filter((r) => !r.ok);
  console.log('');
  if (bad.length) {
    console.log(`[FAIL] ${bad.length} 项不通过：` + bad.map((b) => b.name).join('、'));
    process.exit(1);
  }
  console.log('[ok] 多患者隔离正常');
}

main().catch((e) => { console.error('[ERR]', e.message); process.exit(1); });
