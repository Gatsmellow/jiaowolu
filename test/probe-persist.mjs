/**
 * 本地保存相关验证：
 *   A. 任务存档不再 24 小时过期（默认不过期；设成 7 天时，超期的会被丢弃）
 *   B. Ctrl+S 按日期存档、同一天覆盖、内容没变不重复写
 *   C. 导出后标记"已导出"，之后再改动会重新变成未导出
 *   D. 删除患者时，提示里带"尚未导出"
 *
 * 全程离线：模型响应由 mock 顶替。
 * 用法：node test/probe-persist.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9382;
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
      // 应用里加了"未导出就拦一下关闭"的 beforeunload；无头浏览器会卡在确认框上，这里自动放行
      if (m.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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

const problems = [];
const want = (cond, msg) => { if (!cond) problems.push(msg); };

const MOCK = `
window.Model.vision = async function (img, prompt) {
  if (String(prompt).indexOf('doc_type') !== -1) {
    return { text: JSON.stringify({ doc_type: '血常规', title: '血常规报告单', confidence: 0.9 }), usage: {}, ms: 1 };
  }
  return { text: JSON.stringify({ report_date: '2026-11-27', items: [
    { indicator: 'WBC', raw_name: '白细胞计数', value: '7.24', unit: '10^9/L' }
  ] }), usage: {}, ms: 1 };
};
'ok'`;

const DROP = `
(async function () {
  var res = await fetch('test/samples/batch/cbc-20261110.jpg');
  var blob = await res.blob();
  var dt = new DataTransfer();
  dt.items.add(new File([blob], 'cbc-20261110.jpg', { type: 'image/jpeg' }));
  document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'dropped';
})()`;

// 把任务存档的时间改成 N 天前，用来模拟"隔了很久再打开"
const AGE_SESSION = (days) => `
(async function () {
  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('jiaowolu', 2);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  var db = await openDb();
  await new Promise(function (res, rej) {
    var tx = db.transaction('session', 'readwrite');
    var st = tx.objectStore('session');
    var g = st.get('session');
    g.onsuccess = function () {
      var v = g.result;
      v.at = Date.now() - ${days} * 86400000;
      st.put(v, 'session');
    };
    tx.oncomplete = res; tx.onerror = rej;
  });
  return 'aged';
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-persist-'));
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
      } catch { /* not ready */ }
      await sleep(300);
    }
    if (!target) throw new Error('打不开 Chrome 调试端口');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP });
    await sleep(3000);

    await cdp.eval(`(function(){
      localStorage.clear();
      localStorage.setItem('jiaowolu.startView','all');
      localStorage.setItem('jiaowolu.apiKey','sk-mock');
      return 1;
    })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(3000);
    await cdp.eval(MOCK);

    console.log('[1] 跑一次识别，得到一份可保存的结果');
    await cdp.eval(DROP);
    await sleep(600);
    await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
    for (let i = 0; i < 60; i++) {
      const st = await cdp.eval(`(function(){ var a = window.__S.assets[0]; return a ? a.status : 'none'; })()`);
      if (st === 'done') break;
      await sleep(400);
    }
    const base = await cdp.eval(`(function(){ return { obs: window.__S.observations.length, patients: window.__S.patients.length }; })()`);
    want(base.obs >= 1, '识别没有产生结果，后续测试无意义');

    console.log('[2] 存档不过期：把存档时间改成 30 天前，仍应恢复');
    await sleep(1500);   // 等自动存档的 700ms 防抖落盘，否则读到的是上一版记录
    const recBefore = await cdp.eval(`(async function(){
      function openDb(){ return new Promise(function(res){ var r = indexedDB.open('jiaowolu',2); r.onsuccess=function(){res(r.result);}; }); }
      var db = await openDb();
      return await new Promise(function(res){
        var tx = db.transaction('session','readonly');
        var g = tx.objectStore('session').get('session');
        g.onsuccess = function(){ var v = g.result; res(v ? { at: v.at, patients: (v.patients||[]).length, assets: (v.assets||[]).length } : null); };
      });
    })()`);
    console.log('    存档现状：', JSON.stringify(recBefore));
    await cdp.eval(AGE_SESSION(30));
    const recAged = await cdp.eval(`(async function(){
      function openDb(){ return new Promise(function(res){ var r = indexedDB.open('jiaowolu',2); r.onsuccess=function(){res(r.result);}; }); }
      var db = await openDb();
      return await new Promise(function(res){
        var tx = db.transaction('session','readonly');
        var g = tx.objectStore('session').get('session');
        g.onsuccess = function(){ var v = g.result; res(v ? Math.round((Date.now()-v.at)/86400000) + ' 天前 / ' + (v.patients||[]).length + ' 位' : null); };
      });
    })()`);
    console.log('    改成：', recAged);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(3000);
    const kept = await cdp.eval(`(function(){ return { obs: window.__S.observations.length, assets: window.__S.assets.length }; })()`);
    want(kept.obs >= 1 && kept.assets >= 1, '默认不过期时，30 天前的任务应该还能恢复：' + JSON.stringify(kept));

    console.log('[3] 设成保留 7 天后，同样的 30 天前存档应被丢弃');
    await sleep(1500);            // 上一步恢复后又自动存了一份新的，先把它改老
    await cdp.eval(AGE_SESSION(30));
    await cdp.eval(`localStorage.setItem('jiaowolu.retention','7'); 1`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(3000);
    const dropped = await cdp.eval(`(function(){ return { obs: window.__S.observations.length, assets: window.__S.assets.length }; })()`);
    want(dropped.assets === 0, '保留 7 天时，30 天前的存档不该恢复：' + JSON.stringify(dropped));

    console.log('[4] Ctrl+S：按日期存一份，同一天覆盖，不重复写');
    // 第 3 步的 reload 已经把任务清空了。这里清掉旧存档、重建一份带结果的任务，
    // 否则后面"删除提示""导出标记""拦截关闭"三件事都无从验证。
    await cdp.eval(`localStorage.setItem('jiaowolu.retention',''); 1`);
    await cdp.eval(`(async function(){
      function openDb(){ return new Promise(function(res){ var r = indexedDB.open('jiaowolu',2); r.onsuccess=function(){res(r.result);}; }); }
      var db = await openDb();
      await new Promise(function(res){ var tx = db.transaction('session','readwrite'); tx.objectStore('session').clear(); tx.oncomplete = res; });
      return 1;
    })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2500);
    await cdp.eval(MOCK);
    await cdp.eval(DROP);
    await sleep(600);
    await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
    for (let i = 0; i < 60; i++) {
      const st = await cdp.eval(`(function(){ var a = window.__S.assets[0]; return a ? a.status : 'none'; })()`);
      if (st === 'done') break;
      await sleep(400);
    }
    await sleep(1200);
    const rebuilt = await cdp.eval(`(function(){ return { obs: window.__S.observations.length, assets: window.__S.assets.length }; })()`);
    console.log('    重建任务：', JSON.stringify(rebuilt));
    want(rebuilt.obs >= 1, '第 4 步重建的任务没有识别结果');
    await cdp.eval(`(function(){ window.__S.patients[0].exportedAt = 0; return 1; })()`);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); 'save1'`);
    await sleep(800);
    const snap1 = await cdp.eval(`(async function(){
      function openDb(){ return new Promise(function(res){ var r = indexedDB.open('jiaowolu',2); r.onsuccess=function(){res(r.result);}; }); }
      var db = await openDb();
      return await new Promise(function(res){
        var tx = db.transaction('snapshots','readonly');
        var g = tx.objectStore('snapshots').getAll();
        g.onsuccess = function(){ res(g.result.map(function(x){ return { date:x.date, patients:(x.patients||[]).length, hash:x.hash }; })); };
      });
    })()`);
    want(snap1.length === 1, '应产生 1 份当日存档，实际 ' + JSON.stringify(snap1));
    want((snap1[0].patients || 0) >= 1, '存档里没有患者');

    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); 'save2'`);
    await sleep(600);
    const snap2 = await cdp.eval(`(async function(){
      function openDb(){ return new Promise(function(res){ var r = indexedDB.open('jiaowolu',2); r.onsuccess=function(){res(r.result);}; }); }
      var db = await openDb();
      return await new Promise(function(res){
        var tx = db.transaction('snapshots','readonly');
        var g = tx.objectStore('snapshots').getAll();
        g.onsuccess = function(){ res(g.result.map(function(x){ return x.date; })); };
      });
    })()`);
    want(snap2.length === 1, '同一天重复存档应覆盖，而不是新增：' + JSON.stringify(snap2));

    console.log('[5] 导出后标记已导出；再改动又变回未导出');
    const beforeExport = await cdp.eval(`(function(){ return window.__S.patients[0].exportedAt || 0; })()`);
    want(beforeExport === 0, '导出前不该有已导出标记');
    await cdp.eval(`document.getElementById('btn-export').click(); 'export'`);
    await sleep(500);
    await cdp.eval(`(function(){ var b = document.getElementById('btn-confirm-export'); if (b) b.click(); return 1; })()`);
    await sleep(700);
    const afterExport = await cdp.eval(`(function(){ return window.__S.patients[0].exportedAt || 0; })()`);
    want(afterExport > 0, '导出后应记录时间');

    await cdp.eval(`(function(){
      var inp = document.querySelector('#grid-body .val-input');
      if (!inp) return 'no-input';
      inp.focus();
      inp.value = '9.99';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'edited';
    })()`);
    await sleep(400);
    const afterEdit = await cdp.eval(`(function(){ return window.__S.patients[0].exportedAt || 0; })()`);
    want(afterEdit === 0, '改动之后应重新变成未导出，实际 ' + afterEdit);

    console.log('[6] 删除患者时，提示里带"尚未导出"');
    const confirmText = await cdp.eval(`(function(){
      var seen = '';
      var orig = window.confirm;
      window.confirm = function(msg){ seen = msg; return false; };
      var del = document.querySelector('#patient-list .del');
      if (del) del.click();
      window.confirm = orig;      // 必须还原，否则后面所有确认框都会被静默拒绝
      return seen;
    })()`);
    want(/尚未导出/.test(confirmText), '删除提示里没有"尚未导出"：' + confirmText);

    console.log('[7] 有未导出结果时，关闭页面会被拦一下');
    const guarded = await cdp.eval(`(function(){
      var ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    want(guarded === true, 'beforeunload 没有拦截');

    want(cdp.errors.length === 0, '页面有未处理异常：' + JSON.stringify(cdp.errors.slice(0, 3)));

    console.log('[8] 存档能恢复：删掉患者后，从当天的存档装回来');
    const base2 = await cdp.eval(`(function(){ return { p: window.__S.patients.length, a: window.__S.assets.length, o: window.__S.observations.length }; })()`);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); 'save'`);
    await sleep(1000);
    await cdp.eval(`document.getElementById('btn-settings').click(); 'settings'`);
    await sleep(800);
    const hasRestore = await cdp.eval(`(function(){ return !!document.querySelector('[data-act="snap-restore"]'); })()`);
    want(hasRestore, '存档列表里没有"恢复"按钮');
    const shotSnap = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-snapshot.png'), Buffer.from(shotSnap.data, 'base64'));
    console.log('    截图：docs/figs/ui-snapshot.png');

    await cdp.eval(`(function(){ var o = window.confirm; window.confirm = function(){ return true; }; var b = document.querySelector('#patient-list .del'); if (b) b.click(); window.confirm = o; return 1; })()`);
    await sleep(800);
    const afterDel = await cdp.eval(`(function(){ return { p: window.__S.patients.length, a: window.__S.assets.length }; })()`);
    want(afterDel.p === 0 || afterDel.a === 0, '删除患者后任务没有变空，测不出恢复效果');

    await cdp.eval(`document.getElementById('btn-settings').click(); 'settings2'`);
    await sleep(800);
    await cdp.eval(`(function(){ var b = document.querySelector('[data-act="snap-restore"]'); if (b) b.click(); return 1; })()`);
    await sleep(1500);
    const back = await cdp.eval(`(function(){ return { p: window.__S.patients.length, a: window.__S.assets.length, o: window.__S.observations.length }; })()`);
    console.log('    存档时：', JSON.stringify(base2), ' 恢复后：', JSON.stringify(back));
    want(back.p === base2.p && back.a === base2.a && back.o === base2.o, '恢复后的任务与存档不一致');

    console.log('[9] 删除存档');
    await cdp.eval(`document.getElementById('btn-settings').click(); 'settings3'`);
    await sleep(800);
    const before = await cdp.eval(`(function(){ return document.querySelectorAll('.snap-row').length; })()`);
    const delInfo = await cdp.eval(`(function(){
      var b = document.querySelector('[data-act="snap-del"]');
      if (!b) return 'no-button';
      var asked = 0;
      window.__origConfirm = window.confirm;
      window.confirm = function(){ asked++; return true; };
      b.click();
      window.confirm = window.__origConfirm;
      return 'clicked, confirm 调用 ' + asked + ' 次';
    })()`);
    console.log('    删除按钮：', delInfo);
    await sleep(1500);
    const left = await cdp.eval(`(function(){ return document.querySelectorAll('.snap-row').length; })()`);
    console.log('    删前 ' + before + ' 条，删后 ' + left + ' 条');
    want(left === before - 1, '删除存档没有生效');
    console.log('\n结果：');
    if (problems.length) {
      problems.forEach((p) => console.log('  ✗ ' + p));
      console.log('\n不通过：' + problems.length + ' 项');
      process.exitCode = 1;
    } else {
      console.log('通过：存档默认不过期、按保留天数丢弃、Ctrl+S 当日覆盖、导出标记与改动重置、删除与关页提醒都对。');
    }
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
