/**
 * 「词库学习」闭环验证：模型读到但词库认不出的名称 → 人工指定指标 → 写进本地同义词 → 下次识别复用。
 *
 * 全程离线：模型响应用 mock 覆盖 window.Model.vision，不联网。
 * 用法：node test/probe-alias-learning.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9380;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const NEW_NAME = '携氧蛋白';        // 合成名称，库中不存在，也不含任何既有别名
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

const problems = [];
function want(cond, msg) { if (!cond) problems.push(msg); }

const MOCK = `
window.__mockCalls = 0;
window.Model.vision = async function (img, prompt) {
  window.__mockCalls++;
  if (String(prompt).indexOf('doc_type') !== -1) {
    return { text: JSON.stringify({ doc_type: '血常规', title: '血常规报告单', confidence: 0.9 }), usage: {}, ms: 1 };
  }
  return { text: JSON.stringify({ report_date: '2026-11-20', items: [
    { indicator: 'WBC', raw_name: '白细胞计数', value: '7.24', unit: '10^9/L' },
    { indicator: '', raw_name: '${NEW_NAME}', value: '135', unit: 'g/L' }
  ] }), usage: {}, ms: 1 };
};
'ok'`;

const DROP = `
(async function () {
  var res = await fetch('test/samples/batch/cbc-20261110.jpg');
  var blob = await res.blob();
  var file = new File([blob], 'cbc-20261110.jpg', { type: 'image/jpeg' });
  var dt = new DataTransfer();
  dt.items.add(file);
  var dz = document.getElementById('dropzone');
  var ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  dz.dispatchEvent(ev);
  return 'dropped';
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-alias-'));
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
      } catch { /* 还没起来 */ }
      await sleep(300);
    }
    if (!target) throw new Error('打不开 Chrome 调试端口');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP });
    await sleep(3500);

    console.log('[1] 准备：清空、写一个假 Key、重载、mock 模型、拖入一份合成血常规');
    await cdp.eval(`(function(){ localStorage.clear(); localStorage.setItem('jiaowolu.startView','all'); localStorage.setItem('jiaowolu.apiKey','sk-mock-for-offline-test'); return 1; })()`);
    // Model 在页面加载时就把 Key 读进内存了，必须重载一次；重载后 window 上的 mock 也会丢，所以放在重载之后
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(3500);
    await cdp.eval(MOCK);
    const before = await cdp.eval(`(function(){ var i = window.Library.byId('HGB'); return { aliases: String(i.aliases||''), unit: i.unit, ref: i.ref, name: i.name }; })()`);

    await cdp.eval(DROP);
    await sleep(600);

    await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
    await sleep(1200);

    for (let i = 0; i < 60; i++) {
      const st = await cdp.eval(`(function(){ var a = window.__S.assets[0]; return a ? a.status : 'none'; })()`);
      if (st === 'done' || st === 'error') break;
      await sleep(500);
    }

    console.log('[2] 采集：陌生名称要进 asset.unmatched，且只带 rawName / docType');
    const got = await cdp.eval(`(function(){
      var a = window.__S.assets[0];
      var obs = window.__S.observations.filter(function(o){ return o.rawName === '${NEW_NAME}'; });
      return { status: a.status, unmatched: a.unmatched || [], obsCount: obs.length,
               fields: (a.unmatched && a.unmatched[0]) ? Object.keys(a.unmatched[0]).sort() : [] };
    })()`);
    want(got.status === 'done', '识别没有完成：' + got.status);
    console.log('    采集结果：', JSON.stringify(got));
    want(got.unmatched.length === 1, '未匹配名称应记录 1 条，实际 ' + got.unmatched.length);
    want(got.unmatched[0] && got.unmatched[0].rawName === NEW_NAME, '记录的原始名称不对：' + JSON.stringify(got.unmatched[0]));
    want(got.obsCount === 0, '陌生名称不应产生 Observation');
    want(JSON.stringify(got.fields) === '["docType","rawName"]', '不该保存多余字段：' + JSON.stringify(got.fields));

    const callsAfterRecognize = await cdp.eval(`window.__mockCalls`);

    console.log('[3] 聚合：词库学习里应看到这个名称、文书类型与页数');
    // 指标与页面弹层现在挂在"本批规则"对话框里，得先打开它
    await cdp.eval(`document.getElementById('btn-rules').click(); 'rules'`);
    await sleep(300);
    await cdp.eval(`document.getElementById('btn-library').click(); 'open'`);
    await sleep(300);
    await cdp.eval(`document.querySelector('[data-tab="alias"]').click(); 'tab'`);
    await sleep(200);
    const listed = await cdp.eval(`(function(){
      var rows = Array.prototype.map.call(document.querySelectorAll('.alias-grid tbody tr'), function(tr){ return tr.textContent.replace(/\\s+/g,' ').trim(); });
      var tab = document.querySelector('[data-tab="alias"]');
      return { rows: rows, tabText: tab ? tab.textContent.trim() : '' };
    })()`);
    want(listed.rows.length === 1, '应列出 1 条建议，实际 ' + listed.rows.length);
    want(/携氧蛋白/.test(listed.rows[0] || ''), '列表里没有该名称');
    want(/血常规/.test(listed.rows[0] || ''), '列表里没有文书类型');
    want(/1 页/.test(listed.rows[0] || ''), '页数显示不对：' + listed.rows[0]);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-alias.png'), Buffer.from(shot.data, 'base64'));
    console.log('    截图：docs/figs/ui-alias.png');

    console.log('[4] 不选指标就确认：必须被拦下，指标库不能变');
    await cdp.eval(`document.querySelector('[data-act="alias-save"]').click(); 'save-empty'`);
    await sleep(200);
    const afterEmpty = await cdp.eval(`(function(){ return { aliases: String(window.Library.byId('HGB').aliases||'') }; })()`);
    want(afterEmpty.aliases === before.aliases, '没选指标却改了别名');

    console.log('[5] 选择 HGB 并确认：只追加别名，其他字段不变');
    await cdp.eval(`(function(){ document.getElementById('alias-sel-0').value = 'HGB'; document.querySelector('[data-act="alias-save"]').click(); return 'saved'; })()`);
    await sleep(400);
    const afterSave = await cdp.eval(`(function(){ var i = window.Library.byId('HGB'); return { aliases: String(i.aliases||''), name: i.name, unit: i.unit, ref: i.ref }; })()`);
    want(afterSave.aliases.indexOf(NEW_NAME) !== -1, '别名没有写进去：' + afterSave.aliases);
    want(afterSave.name === before.name && afterSave.unit === before.unit && afterSave.ref === before.ref, '别名以外的字段被改了');

    const callsAfterLearning = await cdp.eval(`window.__mockCalls`);
    want(callsAfterLearning === callsAfterRecognize, '词库学习不该再调用模型：' + callsAfterRecognize + ' → ' + callsAfterLearning);

    console.log('[6] 学完之后建议应消失');
    const listed2 = await cdp.eval(`document.querySelectorAll('.alias-grid tbody tr').length`);
    want(listed2 === 0, '学完仍显示建议：' + listed2);

    console.log('[7] 复用：重跑同一份 mock 报告，该名称应落进 HGB');
    await cdp.eval(`(function(){ window.__S.assets[0].status = 'pending'; if (window.renderAll) window.renderAll(); return 1; })()`);
    await sleep(300);
    await cdp.eval(`document.getElementById('btn-run').click(); 'rerun'`);
    for (let i = 0; i < 60; i++) {
      const st = await cdp.eval(`(function(){ var a = window.__S.assets[0]; return a ? a.status : 'none'; })()`);
      if (st === 'done') break;
      await sleep(400);
    }
    await sleep(400);
    const reused = await cdp.eval(`(function(){
      var o = window.__S.observations.filter(function(x){ return x.indicatorId === 'HGB'; });
      var a = window.__S.assets[0];
      return { count: o.length, value: o.length ? o[0].value : '', unmatched: (a.unmatched || []).length };
    })()`);
    want(reused.count >= 1, '学习后仍未命中 HGB');
    want(String(reused.value) === '135', '命中值不对：' + reused.value);
    want(reused.unmatched === 0, '命中后不应再记未匹配');

  console.log('[8] 冲突：名称在确认前被挂给了别的指标时，必须阻止改挂');
    await cdp.eval(`(function(){
      window.__S.assets[0].unmatched = [{ rawName: '另一名称', docType: '血常规' }];
      window.__S.assets[0].status = 'done';
      document.getElementById('btn-rules').click();
      return 1;
    })()`);
    await sleep(300);
    await cdp.eval(`(function(){
      document.getElementById('btn-library').click();
      document.querySelector('[data-tab="alias"]').click();
      return 1;
    })()`);
    await sleep(300);
    const conflict = await cdp.eval(`document.querySelectorAll('.alias-grid tbody tr').length`);
    want(conflict === 1, '注入冲突建议失败');
    // 模拟并发：建议已列出、但在用户确认前，这个名字被挂到了 UA 上
    await cdp.eval(`(function(){
      var ua = window.Library.byId('UA');
      var def = {}; Object.keys(ua).forEach(function(k){ def[k] = ua[k]; });
      def.aliases = String(ua.aliases||'') + '，另一名称';
      window.Library.updateIndicator('UA', def);
      return 1;
    })()`);
    await cdp.eval(`(function(){ document.getElementById('alias-sel-0').value = 'HGB'; document.querySelector('[data-act="alias-save"]').click(); return 'try'; })()`);
    await sleep(300);
    const blocked = await cdp.eval(`(function(){
      return { hgb: String(window.Library.byId('HGB').aliases||''), ua: String(window.Library.byId('UA').aliases||'') };
    })()`);
    want(blocked.hgb.indexOf('另一名称') === -1, '冲突名称被错误地加进了 HGB');
    want(blocked.ua.indexOf('另一名称') !== -1, '原有归属被改掉了');

    console.log('[9] 忽略：本次会话不再出现，且不写本地存储');
    await cdp.eval(`document.querySelector('[data-act="alias-ignore"]').click(); 'ignore'`);
    await sleep(300);
    const afterIgnore = await cdp.eval(`(function(){
      var keys = Object.keys(localStorage);
      return { rows: document.querySelectorAll('.alias-grid tbody tr').length,
               aliasKeys: keys.filter(function(k){ return /alias|ignore|mistake/i.test(k); }) };
    })()`);
    want(afterIgnore.rows === 0, '忽略后仍显示建议');
    want(afterIgnore.aliasKeys.length === 0, '忽略不该写本地存储：' + JSON.stringify(afterIgnore.aliasKeys));

    console.log('[10] 清空任务：未匹配记录随报告一起消失，学到的别名保留');
    await cdp.eval(`(function(){ window.confirm = function(){ return true; }; window.__S.currentId=''; return 1; })()`);
    await cdp.eval(`(function(){ var b = document.getElementById('btn-reset'); if (b) b.click(); return 1; })()`);
    await sleep(600);
    const afterClear = await cdp.eval(`(function(){
      return { assets: window.__S.assets.length, hasAlias: String(window.Library.byId('HGB').aliases||'').indexOf('${NEW_NAME}') !== -1 };
    })()`);
    want(afterClear.assets === 0, '清空后仍有报告资产');
    want(afterClear.hasAlias, '清空任务不该删掉已经学到的别名');

    want(cdp.errors.length === 0, '页面有未处理异常：' + JSON.stringify(cdp.errors.slice(0, 3)));

    console.log('\n结果：');
    if (problems.length) {
      problems.forEach((p) => console.log('  ✗ ' + p));
      console.log('\n不通过：' + problems.length + ' 项');
      process.exitCode = 1;
    } else {
      console.log('通过：陌生名称被记录、可人工指定、写入本地同义词、重跑可复用；冲突被阻止、忽略不落盘、清空任务即删。');
    }
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
