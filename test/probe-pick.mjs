/**
 * 回归：人工裁决（"以此为准"）只能作废**同一天**的其它来源，
 * 不能把别的就诊日的记录一起删掉；跨次就诊的对照里也不该出现这个按钮。
 *
 * 用法：node test/probe-pick.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9354;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const key = readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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

const problems = [];
const check = (ok, msg) => { console.log((ok ? '    ok   ' : '    FAIL ') + msg); if (!ok) problems.push(msg); };

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-pick-'));
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
      await sleep(200);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    console.log('[1/4] 打开页面，传一份血常规并识别');
    await cdp.send('Page.navigate', { url: APP });
    for (let i = 0; i < 60; i++) {   // 等真正落到应用页，about:blank 也是 complete，不能只看 readyState
      const href = await cdp.eval('location.href').catch(() => '');
      if (href && href.indexOf('127.0.0.1') >= 0 && (await cdp.eval('document.readyState')) === 'complete') break;
      await sleep(200);
    }
    await sleep(400);
    await cdp.eval(`
      localStorage.setItem('jiaowolu.startView','all');localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      localStorage.removeItem('jiaowolu.selectedPages.v3');
      'ok'`);
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
      })()`);
    await sleep(2200);
    console.log('    拖入后：', JSON.stringify(await cdp.eval(`({assets: __S.assets.length, ready: __S.assets.every(function(a){return a.dataUrl && a.width>0;})})`)));
    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');
    await sleep(600);
    console.log('    点完按钮：', JSON.stringify(await cdp.eval(`
      ({running: __S.running, offline: document.getElementById('offline-bar').hidden === false,
        toasts: Array.from(document.querySelectorAll('.toast')).map(function(t){ return t.textContent; })})`)));
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!(await cdp.eval('window.__S.running'))) break;
      await sleep(600);
    }
    console.log('    识别后：', JSON.stringify(await cdp.eval(`({obs: __S.observations.length, st: __S.assets.map(function(a){return a.status + ':' + (a.docType||'');})})`)));

    console.log('[2/4] 制造两条：同一天的第二份来源 + 另一次就诊的旧值');
    const injected = await cdp.eval(`
      (function () {
        var S = window.__S, pid = S.currentId;
        var base = S.observations.filter(function (o) { return o.indicatorId === 'WBC'; })[0];
        S.assets.push({ id: 'asset-dup', patientId: pid, kind: 'image', fileIndex: 9,
          name: '另一份血常规.jpg', status: 'done', docType: '血常规',
          width: 1200, height: 1500, dataUrl: S.assets[0].dataUrl });
        S.observations.push({ id: 'obs-dup', patientId: pid, assetId: 'asset-dup',
          rawName: '白细胞计数(WBC)', indicatorId: 'WBC', method: 'exact-alias', warn: '',
          value: '9.99', unit: '10^9/L', ref: '3.5-9.5',
          date: base.date, confidence: 0.9, src: 'table' });
        S.assets.push({ id: 'asset-old', patientId: pid, kind: 'image', fileIndex: 10,
          name: '上次住院血常规.jpg', status: 'done', docType: '血常规',
          width: 1200, height: 1500, dataUrl: S.assets[0].dataUrl });
        S.observations.push({ id: 'obs-old', patientId: pid, assetId: 'asset-old',
          rawName: '白细胞计数(WBC)', indicatorId: 'WBC', method: 'exact-alias', warn: '',
          value: '3.21', unit: '10^9/L', ref: '3.5-9.5',
          date: '2026-08-20', confidence: 0.95, src: 'table' });
        var g = document.querySelector('.group-row');   // 点两下 = 收起再展开，触发重绘
        if (g) { g.click(); g.click(); }
        return { wbc: S.observations.filter(function (o) { return o.indicatorId === 'WBC'; }).length };
      })()`);
    check(injected.wbc === 3, '注入后 WBC 共 ' + injected.wbc + ' 条（当日 2 条 + 历史 1 条）');

    console.log('[3/4] 打开来源（新版在右侧检查器里），数一下“以此为准”');
    const cmp = await cdp.eval(`
      (function () {
        var link = document.querySelector('tr[data-ind="WBC"] .src-link');
        if (link) link.click();
        var choices = Array.from(document.querySelectorAll('.source-choice'));
        return {
          rows: choices.length,
          texts: choices.map(function (b) { return b.textContent.replace(/\\s+/g, ' ').trim(); }),
          picks: document.querySelectorAll('.inspector [data-pick]').length
        };
      })()`);
    check(cmp.rows === 2, '来源只列同一天那 2 条（实际 ' + cmp.rows + '）');
    check(cmp.texts.join(' ').indexOf('3.21') === -1, '跨日期那条 3.21 不在当天的来源里：' + JSON.stringify(cmp.texts));
    check(cmp.picks === 1, '当前选中的那条带一个“以此为准”（实际 ' + cmp.picks + '）');

    console.log('[4/4] 选 9.99 并以此为准，看历史记录还在不在');
    const after = await cdp.eval(`
      (function () {
        // 先在检查器里选中"9.99 那条"，再点"以此为准"
        var pick = Array.from(document.querySelectorAll('.source-choice'))
          .filter(function (b) { return b.textContent.indexOf('9.99') !== -1; })[0];
        if (pick) pick.click();
        var btn = document.querySelector('.inspector [data-pick]');
        if (btn) btn.click();
        var S = window.__S;
        var left = S.observations.filter(function (o) { return o.indicatorId === 'WBC'; });
        var tr = document.querySelector('tr[data-ind="WBC"]');
        return {
          n: left.length,
          dates: left.map(function (o) { return o.date; }).sort(),
          values: left.map(function (o) { return o.value; }).sort(),
          cls: tr ? tr.className : 'missing',
          shown: tr ? tr.querySelector('.val-input').value : '',
          picked: !!btn
        };
      })()`);
    check(after.picked, '检查器里有可点的“以此为准”');
    check(after.n === 2, '裁决后 WBC 剩 ' + after.n + ' 条（应为 2：保留裁决值 + 历史值）');
    check(after.dates.indexOf('2026-08-20') >= 0, '历史就诊日 2026-08-20 仍在：' + JSON.stringify(after.dates));
    check(after.values.indexOf('3.21') >= 0, '历史值 3.21 没被删掉：' + JSON.stringify(after.values));
    check(after.cls.indexOf('ok') >= 0 && after.shown === '9.99', '当天只剩一个值，行变成已识别且显示 9.99（实际 ' + after.shown + ' / ' + after.cls + '）');

    const errs0 = cdp.errors.filter((e) => e);
    check(errs0.length === 0, '页面异常 ' + errs0.length + ' 个' + (errs0.length ? '：' + errs0[0].split('\n')[0] : ''));

    console.log('[5/5] 跨次就诊的对照里不该出现“以此为准”');
    const span = await cdp.eval(`
      (function () {
        var hint = document.querySelector('tr[data-ind="WBC"] .date-hint');
        if (!hint) return { err: '没有时间轴提示按钮' };
        hint.click();
        return {
          rows: document.querySelectorAll('.source-choice').length,
          texts: Array.from(document.querySelectorAll('.source-choice')).map(function (b) { return b.textContent.replace(/\\s+/g, ' ').trim(); }),
          picks: document.querySelectorAll('.inspector [data-pick]').length
        };
      })()`);
    check(!span.err, '有时间轴提示按钮' + (span.err ? '：' + span.err : ''));
    check(span.picks === 0, '跨日期对照里“以此为准”按钮数 = ' + span.picks + '（应为 0）');
    check((span.texts || []).join(' ').indexOf('3.21') !== -1 && (span.texts || []).join(' ').indexOf('9.99') !== -1,
      '跨日期对照把两次的值都列出来了：' + JSON.stringify(span.texts || []));
  } finally {
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (problems.length) {
    console.log('\n不通过：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('\n通过：裁决只影响同一天，历史就诊的记录仍在。');
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
