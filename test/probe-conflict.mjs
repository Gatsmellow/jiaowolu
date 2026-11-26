/**
 * 验证「两处不一致」现在能说清差在哪。
 *
 * 做法：正常跑一份血常规，然后手工塞一条"另一份报告"的观察值（WBC=9.99），
 * 让同一个指标出现两个不同的值。看表格里是不是把两个来源都列出来，
 * 点开是不是能看到每一份报告读到的值、日期和原文项目名。
 *
 * 用法：node test/probe-conflict.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9345;
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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-cmp-'));
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

    console.log('[1/5] 打开页面');
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

    console.log('[2/5] 传血常规并识别');
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
      const running = await cdp.eval('window.__S.running');
      if (!running) break;
      await sleep(600);
    }

    console.log('[3/5] 塞一份"另一天的血常规"，让白细胞对不上');
    const injected = await cdp.eval(`
      (function () {
        var S = window.__S;
        var pid = S.currentId;
        S.assets.push({
          id: 'asset-fake', patientId: pid, kind: 'image', fileIndex: 9,
          name: '旧报告.jpg', status: 'done', docType: '血常规',
          width: 1200, height: 1500, dataUrl: S.assets[0].dataUrl
        });
        S.observations.push({
          id: 'obs-fake', patientId: pid, assetId: 'asset-fake',
          rawName: '白细胞计数(WBC)', indicatorId: 'WBC', method: 'exact-alias',
          warn: '', value: '9.99', unit: '10^9/L', ref: '3.5-9.5',
          date: '2026-11-10', confidence: 0.95
        });
        // 随便点一下分组标题，触发重绘
        var g = document.querySelector('.group-row');
        if (g) g.click();
        if (g) g.click();
        return S.observations.length;
      })()
    `);
    console.log('    观察值条数：' + injected);

    const row = await cdp.eval(`
      (function () {
        var tr = document.querySelector('tr.conflict[data-ind="WBC"]');
        if (!tr) return null;
        return { src: tr.querySelector('.src-link') ? tr.querySelector('.src-link').textContent : '', badge: tr.querySelector('.badge').textContent };
      })()
    `);
    console.log('    冲突行：' + JSON.stringify(row));
    if (!row) throw new Error('没有出现冲突行');

    await cdp.eval(`
      (function () {
        var tr = document.querySelector('tr.conflict[data-ind="WBC"]');
        tr.scrollIntoView({ block: 'center' });
        return 'ok';
      })()
    `);
    await sleep(300);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'ui-conflict-row.png'), Buffer.from(shot.data, 'base64'));
    console.log('    截图：docs/figs/ui-conflict-row.png');

    console.log('[4/5] 点开来源看对比（新版对比落在右侧检查器里）');
    const cmp = await cdp.eval(`
      (function () {
        var tr = document.querySelector('tr.conflict[data-ind="WBC"]');
        var link = tr.querySelector('.src-link');
        if (link) link.click();
        var choices = Array.from(document.querySelectorAll('.source-choice'));
        return {
          n: choices.length,
          texts: choices.map(function (b) { return b.textContent.replace(/\\s+/g, ' ').trim(); }),
          picks: document.querySelectorAll('.inspector [data-pick]').length
        };
      })()
    `);
    console.log('    来源选项：' + JSON.stringify(cmp.texts));
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'ui-conflict-compare.png'), Buffer.from(shot.data, 'base64'));
    console.log('    截图：docs/figs/ui-conflict-compare.png');

    console.log('[5/5] 检查页面异常');
    console.log('    ' + (cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无'));

    const bothValues = cmp.texts.length === 2 &&
      cmp.texts.join(' ').indexOf('7.24') !== -1 && cmp.texts.join(' ').indexOf('9.99') !== -1;
    const ok = !!(row && (row.src.indexOf('/') !== -1 || row.src.indexOf('个来源') !== -1)) && bothValues;
    if (!ok) {
      console.error('\n不通过：冲突没有把两个来源都列出来');
      process.exitCode = 1;
    } else {
      console.log('\n通过：冲突行列出了两个来源，点开能看到每一份读到的值。');
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
