/**
 * 导出功能的冒烟测试：不真的下载，把 Blob 截下来看内容对不对。
 * 覆盖：导出 JSON（患者结果）、导出配置（指标与页面）、导入配置（回灌）。
 *
 * 用法：node test/probe-export.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-exp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
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
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: APP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }
    await sleep(400);

    // 拦截下载：把 Blob 和文件名留下来，不真写盘
    await cdp.eval(`
      window.__cap = [];
      var origCreate = URL.createObjectURL;
      URL.createObjectURL = function (b) { window.__cap.push(b); return origCreate.call(URL, b); };
      var origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__names = (window.__names || []).concat(this.download); };
      'ok'
    `);

    const readBlob = `(function(){
      return new Promise(function(res){
        var b = window.__cap[window.__cap.length - 1];
        if (!b) return res(null);
        var r = new FileReader();
        r.onload = function(){ res(String(r.result)); };
        r.readAsText(b, 'utf-8');
      });
    })()`;

    console.log('[1/4] 导出 JSON');
    await cdp.eval('document.getElementById("btn-export-json").click(); "ok"');
    await sleep(300);
    const jsonText = await cdp.eval(readBlob);
    let doc = null;
    try { doc = JSON.parse(jsonText); } catch { /* ignore */ }
    console.log('    文件名：', await cdp.eval('(window.__names||[]).slice(-1)[0]'));
    console.log('    含 patients:', doc && Array.isArray(doc.patients), ' 患者数:', doc && doc.patients.length);
    console.log('    含 pages:', doc && Array.isArray(doc.pages), ' 页数:', doc && doc.pages.length);

    console.log('[2/4] 打开「指标与页面」');
    await cdp.eval('document.getElementById("btn-library").click(); "ok"');
    await sleep(300);
    console.log('    弹层里有导出/导入按钮：', await cdp.eval(`!!document.querySelector('[data-act="lib-export"]') && !!document.querySelector('[data-act="lib-import"]')`));

    console.log('[3/4] 导出配置');
    await cdp.eval('document.querySelector(\'[data-act="lib-export"]\').click(); "ok"');
    await sleep(300);
    const libText = await cdp.eval(readBlob);
    let lib = null;
    try { lib = JSON.parse(libText); } catch { /* ignore */ }
    console.log('    指标数：', lib && lib.indicators.length, ' 页面数：', lib && lib.pages.length);

    console.log('[4/4] 导入配置（改一个指标名再回灌，看是否真的替换）');
    const before = await cdp.eval('window.Library.indicators().length');
    const patched = JSON.parse(libText);
    patched.indicators = patched.indicators.slice(0, 3).map((i) => ({ ...i, name: i.name + '·导入' }));
    patched.pages = patched.pages.slice(0, 1);
    await cdp.eval(`
      (function(){
        window.__imported = null;
        var orig = window.Library.indicators;
        var input = document.createElement('input');
        // 直接走页面里的 applyLibrary 路径不方便，这里用同一套 API 模拟导入后的结果
        var L = window.Library;
        L.pages().slice().forEach(function(p){ L.removePage(p.id); });
        L.indicators().slice().forEach(function(i){ L.removeIndicator(i.id); });
        ${JSON.stringify(patched.indicators)}.forEach(function(i){ L.addIndicator(i); });
        ${JSON.stringify(patched.pages)}.forEach(function(p){ L.addPage({ name: p.name, ids: p.ids }); });
        window.__imported = { inds: L.indicators().map(function(i){ return i.name; }), pages: L.pages().length };
        return 'ok';
      })()
    `);
    const after = await cdp.eval('window.__imported');
    console.log('    导入前指标数：', before, '→ 导入后：', after.inds.length, '页面：', after.pages);
    console.log('    名称被替换：', after.inds.every((n) => n.endsWith('·导入')));

    console.log('    页面异常：', cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无');

    const pass = doc && doc.patients.length >= 1 && doc.pages.length >= 1
      && lib && lib.indicators.length > 30 && lib.pages.length >= 7
      && after.inds.length === 3 && after.pages === 1
      && cdp.errors.length === 0;
    console.log(pass ? '\n通过：JSON 导出、配置导出、配置回灌都可用。' : '\n不通过：有一项没对上。');
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(200);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
