/**
 * 导出口径测试：脱敏、原单位/原参考范围、报告文件名、复核历史。
 *
 * 用的全是合成数据（张建国 / 310101199001011234 / 13800000000），
 * 不联网、不调用模型，只验证 Excel/JSON 里到底写进去了什么。
 *
 * 用法：node test/probe-export-privacy.mjs
 *      可用 JW_CHROME 指定浏览器路径，JW_APP 指定页面地址。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9362;
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

const problems = [];
function want(cond, msg) { if (!cond) problems.push(msg); }

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-exp2-'));
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

    // 先落到本地域上，localStorage 才有地方放
    await cdp.send('Page.navigate', { url: APP });
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }
    await sleep(500);

    // 截下载，不真写盘
    await cdp.eval(`
      window.__cap = []; window.__names = [];
      var origCreate = URL.createObjectURL;
      URL.createObjectURL = function (b) { window.__cap.push(b); return origCreate.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () { window.__names.push(this.download); };
      'ok'
    `);

    console.log('[1/5] 造一份合成数据（含姓名/身份证 + 与指标库默认值不同的单位与参考范围）');
    const seeded = await cdp.eval(`
      (function () {
        var S = window.__S;
        var pid = S.currentId;
        S.assets = S.assets.filter(function (a) { return a.id !== 'assetX' && a.id !== 'assetY'; });
        S.assets.push({
          id: 'assetX', patientId: pid, kind: 'image',
          name: '张建国-血常规-20261110.jpg',
          fileIndex: 1, pageNo: 1, dataUrl: '', width: 1200, height: 900,
          status: 'done', docType: '血常规', reportDate: '2026-11-10'
        });
        // 第二份报告：同一天、同一个指标、值不一样 —— 这一对才是"冲突"
        S.assets.push({
          id: 'assetY', patientId: pid, kind: 'image',
          name: '张建国-急诊血常规-20261110.jpg',
          fileIndex: 2, pageNo: 1, dataUrl: '', width: 1200, height: 900,
          status: 'done', docType: '血常规', reportDate: '2026-11-10'
        });
        S.observations = S.observations.filter(function (o) { return o.patientId !== pid; });
        [
          ['obsN',  'NAME', '张建国', '', '', 'assetX'],
          ['obsI',  'IDNO', '310101199001011234', '', '', 'assetX'],
          // 报告上印的是 10E9/L、4.0-10.0，指标库里是 10^9/L、3.5-9.5
          ['obsW1', 'WBC',  '7.24', '10E9/L', '4.0-10.0', 'assetX'],
          ['obsW2', 'WBC',  '9.99', '10E9/L', '4.0-10.0', 'assetY']
        ].forEach(function (row, i) {
          S.observations.push({
            id: row[0], patientId: pid, assetId: row[5], rawName: '',
            indicatorId: row[1], value: row[2], unit: row[3], ref: row[4],
            date: '2026-11-10', confidence: 1, method: 'exact-alias', src: 'table'
          });
        });
        return { pid: pid, obs: S.observations.length };
      })()
    `);
    console.log('    注入完成：', JSON.stringify(seeded));

    const readBlob = `(function(){
      return new Promise(function(res){
        var b = window.__cap[window.__cap.length - 1];
        if (!b) return res(null);
        var r = new FileReader();
        r.onload = function(){ res(String(r.result)); };
        r.readAsText(b, 'utf-8');
      });
    })()`;

    async function exportJson() {
      await cdp.eval('localStorage.setItem("jiaowolu.startView","all"); "ok"');
      await cdp.eval('document.getElementById("btn-review").click(); document.getElementById("btn-results-all").click(); "ok"');
      await sleep(250);
      await cdp.eval('document.getElementById("btn-export-json").click(); "ok"');
      await sleep(300);
      if (await cdp.eval('document.getElementById("export-dialog").open')) {
        await cdp.eval('document.getElementById("btn-confirm-export").click(); "ok"');
        await sleep(300);
      }
      const text = await cdp.eval(readBlob);
      try { return JSON.parse(text); } catch { return null; }
    }
    async function exportCsv() {
      await cdp.eval('document.getElementById("btn-export").click(); "ok"');
      await sleep(300);
      if (await cdp.eval('document.getElementById("export-dialog").open')) {
        await cdp.eval('document.getElementById("btn-confirm-export").click(); "ok"');
        await sleep(300);
      }
      return await cdp.eval(readBlob);
    }

    function rowOf(doc, code) {
      const rows = (doc.patients || []).reduce((all, p) => all.concat(p.rows || []), []);
      return rows.find((r) => r.code === code);
    }

    console.log('[2/5] 脱敏开启时导出 JSON');
    await cdp.eval('localStorage.setItem("jiaowolu.hideIdent","1"); "ok"');
    let doc = await exportJson();
    want(!!doc, 'JSON 没有导出成功');
    if (doc) {
      const name = rowOf(doc, 'NAME');
      const idno = rowOf(doc, 'IDNO');
      const wbc = rowOf(doc, 'WBC');
      const rep = (doc.patients[0] || {}).reports || [];
      console.log('    姓名导出为：', name && name.value);
      console.log('    身份证导出为：', idno && idno.value);
      console.log('    WBC 单位/参考范围：', wbc && (wbc.unit + ' | ' + wbc.ref));
      console.log('    报告文件名：', rep[0] && rep[0].file, '| 类型', rep[0] && rep[0].type, '| 页码', rep[0] && rep[0].page);
      want(name && name.value === '（已隐藏）', '姓名没有被隐藏');
      want(idno && idno.value === '（已隐藏）', '身份证没有被隐藏');
      want(wbc && wbc.unit === '10E9/L', '单位没有优先用报告上的原值（拿到 ' + (wbc && wbc.unit) + '）');
      want(wbc && wbc.ref === '4.0-10.0', '参考范围没有优先用报告上的原值（拿到 ' + (wbc && wbc.ref) + '）');
      want(rep[0] && rep[0].file && rep[0].file.indexOf('张建国') < 0, '报告文件名没有脱敏或为空');
      want(rep[0] && rep[0].file && rep[0].file.indexOf('（已隐藏）') >= 0, '报告文件名里应出现（已隐藏）');
      want(rep[0] && rep[0].type === '血常规', '报告类型没有导出（拿到 ' + (rep[0] && rep[0].type) + '）');
      want(rep[0] && rep[0].page === 1 && rep[0].date === '2026-11-10', '报告页码/日期没有导出');
      want(Array.isArray(doc.reviewHistory), 'JSON 里没有 reviewHistory 字段');
      // 整份 JSON 扫一遍：任何一个字段（包括报告元数据、复核历史）都不该留下直接标识符
      const whole = JSON.stringify(doc);
      want(whole.indexOf('张建国') < 0, '整份 JSON 里仍然出现了姓名原文');
      want(whole.indexOf('310101199001011234') < 0, '整份 JSON 里仍然出现了身份证原文');
    }

    console.log('[3/5] 脱敏开启时导出 CSV');
    const csv = await exportCsv();
    console.log('    前两行预览：', String(csv || '').split('\r\n').slice(0, 2).join(' / ').slice(0, 160));
    want(csv && csv.indexOf('张建国') < 0, 'CSV 里仍然有姓名原文');
    want(csv && csv.indexOf('310101199001011234') < 0, 'CSV 里仍然有身份证原文');
    want(csv && csv.indexOf('4.0-10.0') >= 0, 'CSV 里没有报告上的原参考范围');
    want(csv && csv.indexOf('10E9/L') >= 0, 'CSV 里没有报告上的原单位');

    console.log('[4/5] 做一次冲突裁决，看复核历史');
    await cdp.eval('document.getElementById("btn-review").click(); "ok"');
    await sleep(300);
    await cdp.eval(`
      (function(){
        var link = document.querySelector('.src-link[data-cmp="WBC"]');
        if (link) link.click();
        return !!link;
      })()
    `);
    await sleep(300);
    const choices = await cdp.eval('Array.from(document.querySelectorAll(".source-choice")).map(function(el){return el.textContent.trim();})');
    console.log('    冲突来源：', JSON.stringify(choices));
    await cdp.eval(`
      (function(){
        var el = Array.from(document.querySelectorAll('.source-choice')).find(function(x){ return /9\\.99/.test(x.textContent); });
        if (el) el.click();
        return !!el;
      })()
    `);
    await sleep(250);
    await cdp.eval(`
      (function(){
        var b = document.querySelector('.inspector [data-pick]');
        if (b) b.click();
        return !!b;
      })()
    `);
    await sleep(400);
    const afterPick = await cdp.eval('window.__S.observations.filter(function(o){return o.indicatorId==="WBC";}).map(function(o){return o.value;})');
    console.log('    裁决后 WBC 剩余：', JSON.stringify(afterPick));

    doc = await exportJson();
    const hist = (doc && doc.reviewHistory) || [];
    console.log('    复核历史条数：', hist.length, '| 第一条：', JSON.stringify(hist[0] || null).slice(0, 200));
    want(hist.length >= 1, '裁决之后没有生成复核历史');
    const pick = hist.find((h) => h.action === 'conflict-pick');
    want(!!pick, '复核历史里没有 conflict-pick 记录');
    want(pick && pick.dropped && pick.dropped.length >= 1, '被否决的来源没有记进 dropped');
    want(pick && String(pick.dropped[0]).indexOf('7.24') >= 0, 'dropped 里没有记下被否决的那个值');
    want(pick && pick.after === '9.99', '复核历史里的新值不对（拿到 ' + (pick && pick.after) + '）');
    want(pick && pick.operator === '本机操作', '没有账号体系时应记为"本机操作"');
    // 复核历史里也不许留下标识符（姓名可能在 before/after 里出现过）
    const histText = JSON.stringify(doc);
    want(histText.indexOf('张建国') < 0, '导出 JSON 的复核历史里出现了姓名原文');
    want(histText.indexOf('310101199001011234') < 0, '导出 JSON 的复核历史里出现了身份证原文');

    console.log('[5/5] 脱敏关闭时导出 JSON');
    await cdp.eval('localStorage.setItem("jiaowolu.hideIdent","0"); "ok"');
    doc = await exportJson();
    if (doc) {
      const name = rowOf(doc, 'NAME');
      const rep = (doc.patients[0] || {}).reports || [];
      console.log('    姓名导出为：', name && name.value, '| 文件名：', rep[0] && rep[0].file);
      want(name && name.value === '张建国', '关掉脱敏后姓名应原样导出');
      want(rep[0] && rep[0].file && rep[0].file.indexOf('张建国') >= 0, '关掉脱敏后文件名应原样导出');
    }

    console.log('    页面异常：', cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无');
    want(cdp.errors.length === 0, '页面有异常：' + cdp.errors[0]);

    console.log('');
    if (problems.length) {
      problems.forEach((p) => console.log('  [x] ' + p));
      console.log('\n不通过：' + problems.length + ' 项没对上。');
      process.exitCode = 1;
    } else {
      console.log('通过：脱敏、原单位/原参考范围、报告文件名、复核历史四项都对上了。');
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
