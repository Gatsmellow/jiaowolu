/**
 * 验证时间轴：同一个患者两次就诊，同一个指标两个值，
 * 不应该再被判成"两处不一致"，而应该能按日期切换着看。
 *
 * 用法：node test/probe-timeline.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9346;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';

const key = (() => {
  try {
    return readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
})();
if (!key) {
  console.error('[x] secrets/ark_api.txt 里没有 Key');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  async waitForLoad(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ((await this.eval('document.readyState')) === 'complete') return;
      await sleep(120);
    }
    throw new Error('页面加载超时');
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-tl-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    if (!target) throw new Error('连不上 Chrome 调试端口');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    console.log('[1/4] 打开页面并传一份血常规');
    await cdp.send('Page.navigate', { url: APP });
    await cdp.waitForLoad();
    await cdp.eval(`
      localStorage.setItem('jiaowolu.startView','all');localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      localStorage.removeItem('jiaowolu.selectedPages.v3');
      'ok'
    `);
    await cdp.send('Page.reload');
    await cdp.waitForLoad();
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object"')) break;
      await sleep(250);
    }
    await sleep(300);

    await cdp.eval(`
      (async () => {
        const blob = await (await fetch('test/samples/cbc-20261110.jpg')).blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'cbc-20261110.jpg', { type: 'image/jpeg' }));
        document.getElementById('dropzone').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return 'dropped';
      })()
    `);
    await sleep(2200);
    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!(await cdp.eval('window.__S.running'))) break;
      await sleep(600);
    }

    console.log('[2/4] 塞一次更早就诊的白细胞（3.21，2026-08-20）');
    await cdp.eval(`
      (function () {
        var S = window.__S;
        var pid = S.currentId;
        S.assets.push({
          id: 'asset-old', patientId: pid, kind: 'image', fileIndex: 8,
          name: '旧血常规.jpg', status: 'done', docType: '血常规',
          width: 1200, height: 1500, dataUrl: S.assets[0].dataUrl
        });
        S.observations.push({
          id: 'obs-old', patientId: pid, assetId: 'asset-old',
          rawName: '白细胞计数(WBC)', indicatorId: 'WBC', method: 'exact-alias',
          warn: '', value: '3.21', unit: '10^9/L', ref: '3.5-9.5',
          date: '2026-08-20', confidence: 0.95
        });
        var g = document.querySelector('.group-row');
        if (g) { g.click(); g.click(); }
        return S.observations.length;
      })()
    `);

    const bar = await cdp.eval(`
      (function () {
        var bar = document.getElementById('date-bar');
        return { hidden: bar.hidden, chips: Array.from(bar.querySelectorAll('.date-chip')).map(c => c.textContent.trim()) };
      })()
    `);
    console.log('    时间轴：' + JSON.stringify(bar));

    const rowBefore = await cdp.eval(`
      (function () {
        var tr = document.querySelector('tr[data-ind="WBC"]');
        return { cls: tr.className, val: tr.querySelector('.val-input').value, hint: (tr.querySelector('.date-hint') || {}).textContent || '' };
      })()
    `);
    console.log('    默认状态：' + JSON.stringify(rowBefore));

    console.log('[3/4] 截图（全部）');
    await cdp.eval('document.querySelector(\'tr[data-ind="WBC"]\').scrollIntoView({block:"center"}); "ok"');
    await sleep(300);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'ui-timeline.png'), Buffer.from(shot.data, 'base64'));
    console.log('    已保存 docs/figs/ui-timeline.png');

    console.log('[4/4] 切到 2026-08-20 再看');
    await cdp.eval(`
      (function () {
        var c = Array.from(document.querySelectorAll('.date-chip')).find(x => x.textContent.indexOf('08-20') !== -1);
        c.click(); return 'clicked';
      })()
    `);
    await sleep(400);
    const rowAfter = await cdp.eval(`
      (function () {
        var tr = document.querySelector('tr[data-ind="WBC"]');
        return { cls: tr.className, val: tr.querySelector('.val-input').value };
      })()
    `);
    console.log('    切到 08-20：' + JSON.stringify(rowAfter));

    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'ui-timeline-0820.png'), Buffer.from(shot.data, 'base64'));

    console.log('    页面异常：' + (cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无'));

    const ok = !bar.hidden && bar.chips.length === 3
      && rowBefore.cls === 'ok' && rowBefore.val === '7.24'
      && /另有 1 次/.test(rowBefore.hint)
      && rowAfter.val === '3.21';
    if (!ok) {
      console.error('\n不通过：时间轴没有按预期工作');
      process.exitCode = 1;
    } else {
      console.log('\n通过：两次就诊的值不再算冲突；默认显示最近一次，切日期能看另一次。');
    }
  } finally {
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  }
}

main().catch((e) => {
  console.error('出错：', e.message || e);
  process.exitCode = 1;
});
