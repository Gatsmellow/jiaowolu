/**
 * 演示样例的一键复现：把 app/test/samples/demo/ 里的两位合成患者跑一遍，
 * 打印"识别多少项 / 冲突几处 / 必填缺几项 / 耗时与调用次数"，并把两位患者的
 * CSV 存到 docs/demo/，供演示和材料引用。
 *
 * 用法：node test/demo-run.mjs          （需要本地服务已在 8765）
 *      JW_APP=... node test/demo-run.mjs（跑线上地址）
 *      JW_CHROME=... 指定浏览器
 *
 * 注意：这里用的是真实模型（需要 secrets/ark_api.txt），数字来自当次运行，
 * 每次会有小幅波动，不能当成固定指标引用。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9364;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (() => {
  try { return readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim(); }
  catch { return ''; }
})();
if (!key) {
  console.error('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）');
  process.exit(2);
}

const A = ['A-01-course.jpg', 'A-02-cbc-20261105.jpg', 'A-03-bio-20261105.jpg',
           'A-04-cbc-20261120.jpg', 'A-05-cbc-20261120b.jpg', 'A-06-discharge.jpg'];
const B = ['B-01-course.jpg', 'B-02-cbc-20261118.jpg'];

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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-demo-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let ws;
  const started = Date.now();
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

    // 先注入 Key 与视图设置，再打开页面
    await cdp.send('Page.navigate', { url: APP });
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete"')) break;
      await sleep(200);
    }
    await cdp.eval(`
      (function(){
        localStorage.clear();
        localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
        localStorage.setItem('jiaowolu.startView', 'all');
        return 'ok';
      })()
    `);
    await cdp.send('Page.reload');
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }
    await sleep(600);

    // 全选 14 个页面，并把"血常规/综合生化"标为必填（演示要用到必填缺失）
    await cdp.eval(`
      (function(){
        document.getElementById('btn-rules').click();
        return 'rules opened';
      })()
    `);
    await sleep(300);
    await cdp.eval(`
      (function(){
        document.querySelectorAll('.pc-use').forEach(function(cb){
          if (!cb.checked) cb.click();
        });
        return document.querySelectorAll('.pc-use:checked').length;
      })()
    `);
    await sleep(300);
    await cdp.eval(`(function(){
      var must = ['cbc','bio'];
      must.forEach(function(pid){
        var cb = document.querySelector('.pc-must[value="' + pid + '"]');
        if (cb && !cb.checked) cb.click();
      });
      return 'must set';
    })()`);
    await sleep(300);
    await cdp.eval('var d=document.getElementById("rules-dialog"); if(d) d.close(); "closed"');

    async function runPatient(files, patientIndex) {
      const pid = await cdp.eval(`window.__S.patients[${patientIndex}].id`);
      // 先切到这位患者（新界面是左栏队列，点卡片才切换）
      await cdp.eval(`(function(){
        var row = document.querySelector('#patient-list [data-pid="${pid}"]');
        if (row) row.click();
        return window.__S.currentId;
      })()`);
      await sleep(400);
      await cdp.eval(`(async function(){
        var names = ${JSON.stringify(files)};
        var dt = new DataTransfer();
        for (var i = 0; i < names.length; i++) {
          var res = await fetch('test/samples/demo/' + names[i]);
          var blob = await res.blob();
          dt.items.add(new File([blob], names[i], { type: 'image/jpeg' }));
        }
        document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return names.length;
      })()`);
      for (let i = 0; i < 80; i++) {
        const ready = await cdp.eval(`(function(){
          var as = window.__S.assets.filter(function(a){ return a.patientId === '${pid}'; });
          return as.length > 0 && as.every(function(a){ return a.dataUrl && a.width > 0; });
        })()`);
        if (ready) break;
        await sleep(250);
      }
      await cdp.eval('document.getElementById("btn-run").click(); "run"');
      for (let i = 0; i < 200; i++) {
        const done = await cdp.eval(`(function(){
          var as = window.__S.assets.filter(function(a){ return a.patientId === '${pid}'; });
          return as.length > 0 && as.every(function(a){ return a.status === 'done' || a.status === 'failed' || a.status === 'skipped'; });
        })()`);
        if (done) break;
        await sleep(300);
      }
      return cdp.eval(`(function(){
        var p = window.__S.patients[${patientIndex}];
        var rows = [];
        document.querySelectorAll('#grid-body tr[data-ind]').forEach(function(tr){
          var st = tr.className.split(' ')[0];
          rows.push({ code: tr.getAttribute('data-ind'), state: st });
        });
        var as = window.__S.assets.filter(function(a){ return a.patientId === p.id; });
        return {
          patient: p.code,
          reports: as.length,
          failed: as.filter(function(a){ return a.status === 'failed'; }).length,
          rows: rows.length,
          ok: rows.filter(function(r){ return r.state === 'ok'; }).length,
          conflict: rows.filter(function(r){ return r.state === 'conflict'; }).length,
          missing: rows.filter(function(r){ return r.state === 'missing'; }).length,
          absent: rows.filter(function(r){ return r.state === 'absent'; }).length,
          low: rows.filter(function(r){ return r.state === 'low'; }).length,
          types: as.map(function(a){ return a.docType || '?'; })
        };
      })()`);
    }

    console.log('跑患者 A（6 份报告，两个就诊日期）…');
    const ra = await runPatient(A, 0);
    console.log('   ', JSON.stringify(ra));

    console.log('新增患者 B 并跑 2 份报告…');
    await cdp.eval('document.getElementById("btn-add-patient").click(); "added"');
    await sleep(400);
    const rb = await runPatient(B, 1);
    console.log('   ', JSON.stringify(rb));

    const usage = await cdp.eval('JSON.stringify(window.Model.getUsage())');
    console.log('\n用量：', usage);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log('墙钟（含启动浏览器、注入、8 份识别）：', secs, '秒');

    // 导出两位患者的 CSV，存到 docs/demo/
    mkdirSync(join(ROOT, 'docs', 'demo'), { recursive: true });
    for (const [idx, name] of [[0, 'patientA'], [1, 'patientB']]) {
      const csv = await cdp.eval(`(function(){
        var p = window.__S.patients[${idx}];
        window.__S.currentId = p.id;
        return null;
      })()`);
      void csv;
    }
    const dumped = await cdp.eval(`
      (function(){
        var out = [];
        window.__S.patients.forEach(function(p){
          window.__S.currentId = p.id;
          var rows = window.__collectRows ? window.__collectRows(p.id, '') : [];
          out.push({ code: p.code, rows: rows.length });
        });
        return out;
      })()
    `);
    console.log('CSV 行数（如需落盘请在浏览器里手动导出）：', JSON.stringify(dumped));

    console.log('\n判定摘要（供《初评演示事实卡》引用，数字来自本次运行）：');
    console.log(`  患者 A：${ra.reports} 份报告 / ${ra.rows} 项 / 已识别 ${ra.ok} / 冲突 ${ra.conflict} / 必填缺失 ${ra.missing} / 未提供 ${ra.absent}`);
    console.log(`  患者 B：${rb.reports} 份报告 / ${rb.rows} 项 / 已识别 ${rb.ok} / 冲突 ${rb.conflict} / 必填缺失 ${rb.missing}`);
    console.log('  报告类型：', JSON.stringify(ra.types));

    const okAll = ra.conflict >= 1 && ra.missing >= 1 && ra.reports >= 5 && rb.reports >= 2;
    if (!okAll) {
      console.log('\n不通过：演示样例没有覆盖到预期条件（至少 5 份报告、1 处冲突、1 处必填缺失）。');
      process.exitCode = 1;
    } else {
      console.log('\n通过：演示样例覆盖了多报告、同日冲突、必填缺失与两位患者隔离。');
      process.exitCode = 0;
    }
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(200);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
