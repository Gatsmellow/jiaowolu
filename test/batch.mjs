/**
 * 批量混装测试：一次拖入 10 份不同类型的报告，验证三件事。
 *
 *   1. 乱序混装不串页 —— 每份报告的抽取结果只能落在它自己那类页面的指标上
 *   2. 单张坏图不拖累整批 —— 一张拍糊的（长边 < 900）应该被跳过，其余照常完成
 *   3. 一次 10 份的耗时与花费 —— 墙钟时间、调用次数、token 数
 *
 * 用法：node test/batch.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9348;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (() => {
  try {
    return readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch { return ''; }
})();
if (!key) { console.error('[x] 没有 Key'); process.exit(2); }

// 故意打乱：把两次就诊的同类报告隔开，模拟"一线人员上传顺序一塌糊涂"
const FILES = [
  { path: 'test/samples/batch/bio-20261205.jpg', doc: '生化',      name: 'bio-20261205.jpg' },
  { path: 'test/samples/batch/coag-20261110.jpg', doc: '出凝血',    name: 'coag-20261110.jpg' },
  { path: 'test/samples/batch/cbc-20261110.jpg', doc: '血常规',     name: 'cbc-20261110.jpg' },
  { path: 'test/degraded/bio-L5.jpg',            doc: '(坏图)',    name: 'blur-20261205.jpg' },
  { path: 'test/samples/batch/virus-20261110.jpg', doc: '病毒学',   name: 'virus-20261110.jpg' },
  { path: 'test/samples/batch/bio-20261110.jpg', doc: '生化',       name: 'bio-20261110.jpg' },
  { path: 'test/samples/batch/flow-20261110.jpg', doc: '骨髓流式',  name: 'flow-20261110.jpg' },
  { path: 'test/samples/batch/cbc-20261205.jpg', doc: '血常规',     name: 'cbc-20261205.jpg' },
  { path: 'test/samples/batch/immu-20261110.jpg', doc: '免疫',      name: 'immu-20261110.jpg' },
  { path: 'test/samples/batch/course-20261110.jpg', doc: '病案首页', name: 'course-20261110.jpg' }
];

// 文书类型 → 允许出现的页面。抽到别的页面的指标就算串页。
const DOC_PAGES = {
  '血常规': ['cbc'], '生化': ['bio', 'liver', 'renal', 'elec'], '出凝血': ['coag'],
  '免疫': ['immu'], '病毒学': ['infect'], '骨髓流式': ['flow'], '病案首页': ['course']
};

// 抽检：这几项必须读对（值做归一化比较，去掉单位与符号）
const SPOT = {
  'cbc-20261110.jpg': { WBC: '7.24', HGB: '110' },
  'cbc-20261205.jpg': { WBC: '8.10' },
  'bio-20261110.jpg': { ALT: '38', CREA: '82' },
  'bio-20261205.jpg': { ALT: '41' },
  'coag-20261110.jpg': { APTT: '26.7', FIB: '2.08' },
  'immu-20261110.jpg': { IGG: '12.6', ESR: '12' },
  'flow-20261110.jpg': { FLOW_INV: '阴性' }
};

const num = (v) => {
  const m = String(v == null ? '' : v).replace(/[，,]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? String(parseFloat(m[0])) : '';
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-batch-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let ok = true;
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
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }

    await cdp.eval(`
      localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      'ok'
    `);
    await cdp.send('Page.reload');
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(250);
    }
    await cdp.eval(`window.confirm = function () { return true; }; 'ok'`);

    // 只勾这次的常规 7 页 + 出凝血/免疫/病毒学/骨髓流式，其余不勾。
    // 注意：每次 change 都会重画侧栏，旧节点会被 detach，所以必须"现查现点"。
    const pages = await cdp.eval(`(function () {
      var map = ${JSON.stringify(DOC_PAGES)};
      var want = [];
      Object.keys(map).forEach(function (n) {
        map[n].forEach(function (p) { if (want.indexOf(p) < 0) want.push(p); });
      });
      want.forEach(function (pid) {
        var cb = document.querySelector('.pc-use[value="' + pid + '"]');
        if (cb && !cb.checked) cb.click();
      });
      // 把不想要的关掉（出院小结这次没有报告，留着只会多一片灰）
      ['discharge'].forEach(function (pid) {
        var cb = document.querySelector('.pc-use[value="' + pid + '"]');
        if (cb && cb.checked) cb.click();
      });
      var on = [];
      document.querySelectorAll('.pc-use').forEach(function (cb) { if (cb.checked) on.push(cb.value); });
      return on;
    })()`);
    await sleep(300);

    console.log('');
    console.log('一次拖入 %d 份（含 1 张拍糊的），勾选页面：%s', FILES.length, pages.join(','));

    // 一次性全拖进去
    const dropped = await cdp.eval(`(async function () {
      var names = ${JSON.stringify(FILES)};
      var dt = new DataTransfer();
      for (var i = 0; i < names.length; i++) {
        var blob = await (await fetch(names[i].path)).blob();
        dt.items.add(new File([blob], names[i].name, { type: 'image/jpeg' }));
      }
      document.getElementById('dropzone').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
      return dt.items.length;
    })()`);
    console.log('  拖入文件数：%d', dropped);

    // 等 10 张全部解码就绪
    let ready = 0;
    for (let i = 0; i < 120; i++) {
      ready = await cdp.eval(`(function(){
        var a = window.__S.assets || [];
        return a.filter(function (x) { return x.dataUrl && x.width > 0; }).length;
      })()`);
      if (ready >= FILES.length) break;
      await sleep(250);
    }
    console.log('  解码就绪：%d/%d', ready, FILES.length);

    const t0 = Date.now();
    await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
    let busy = true;
    for (let i = 0; i < 600; i++) {
      busy = await cdp.eval(`(function(){
        var a = window.__S.assets || [];
        return a.some(function (x) { return x.status === 'pending' || x.status === 'running' || x.status === 'queued'; });
      })()`);
      if (!busy) break;
      await sleep(500);
    }
    const secs = (Date.now() - t0) / 1000;

    const data = await cdp.eval(`(function(){
      var S = window.__S;
      var pages = window.Library.pages();
      var byId = {};
      pages.forEach(function (p) { byId[p.id] = p; });
      var HEAD = ['NAME','SEX','AGE','ADMNO','VISITDATE','HOSP','HUKOU','IDNO','PHONE','PHONE2','ADDR','DIAGTYPE','VISITAGE','ETHNIC'];
      var assets = S.assets.map(function (a) {
        return {
          name: a.sourceName || a.name || '', docType: a.docType || '', status: a.status || '',
          w: a.width, h: a.height, lowRes: !!a.lowRes
        };
      });
      var obs = S.observations.map(function (o) {
        var a = S.assets.filter(function (x) { return x.id === o.assetId; })[0] || {};
        return { asset: a.sourceName || a.name || '', code: o.indicatorId, value: o.value, date: o.date || '' };
      });
      var usage = (window.Model && window.Model.getUsage) ? window.Model.getUsage() : (S.usage || {});
      return { assets: assets, obs: obs, usage: usage, headList: HEAD };
    })()`);

    console.log('');
    console.log('  墙钟：%ss，调用 %d 次，prompt %d tokens / completion %d tokens',
      secs.toFixed(1), data.usage.calls || 0, data.usage.promptTokens || 0, data.usage.completionTokens || 0);

    // ---- 判定 ----
    const allowedByDoc = await cdp.eval(`(function(){
      var map = ${JSON.stringify(DOC_PAGES)};
      var pages = window.Library.pages();
      var out = {};
      Object.keys(map).forEach(function (n) {
        var ids = [];
        map[n].forEach(function (pid) {
          var p = pages.filter(function (x) { return x.id === pid; })[0];
          if (p) p.ids.forEach(function (i) { if (ids.indexOf(i) < 0) ids.push(i); });
        });
        out[n] = ids;
      });
      return out;
    })()`);
    const HEAD = data.headList;
    const allow = (doc, code) => {
      if (HEAD.indexOf(code) >= 0) return true;
      const list = allowedByDoc[doc] || [];
      return list.indexOf(code) >= 0;
    };

    const problems = [];
    console.log('');
    console.log('  %s', '─'.repeat(84));
    console.log('  %s  %s  %s  %s', '文件'.padEnd(26), '判定类型'.padEnd(12), '状态'.padEnd(10), '抽到的指标');
    for (const f of FILES) {
      const a = data.assets.find((x) => x.name === f.name);
      const mine = data.obs.filter((o) => o.asset === f.name);
      const codes = mine.map((o) => o.code);
      const uniq = codes.filter((c, i) => codes.indexOf(c) === i);
      console.log('  %s  %s  %s  %s', f.name.padEnd(26), (a ? a.docType : '?').padEnd(12),
        (a ? a.status : '?').padEnd(10), uniq.slice(0, 8).join(', ') + (uniq.length > 8 ? ' …' : ''));
      if (!a) { problems.push(`${f.name}：页面上找不到这份资产`); continue; }
      if (f.doc === '(坏图)') {
        if (a.status !== 'skipped' && a.status !== 'failed') {
          problems.push(`${f.name}：坏图没被拦住（状态 ${a.status}）`);
        }
        continue;
      }
      if (a.status !== 'done') { problems.push(`${f.name}：状态是 ${a.status}`); continue; }
      if (a.docType !== f.doc) problems.push(`${f.name}：判成「${a.docType}」，应为「${f.doc}」`);
      const bad = uniq.filter((c) => !allow(a.docType, c));
      if (bad.length) problems.push(`${f.name}（${a.docType}）串页：${bad.join(', ')}`);
    }

    console.log('  %s', '─'.repeat(84));

    // 抽检数值
    console.log('');
    for (const [file, want] of Object.entries(SPOT)) {
      const mine = data.obs.filter((o) => o.asset === file);
      for (const [code, expect] of Object.entries(want)) {
        const hit = mine.find((o) => o.code === code);
        const got = hit ? hit.value : '(没抽到)';
        const same = hit && (num(hit.value) === num(expect) || String(hit.value).trim() === expect);
        if (!same) problems.push(`抽检 ${file} ${code}：期望 ${expect}，实际 ${got}`);
      }
    }
    const spotCount = Object.values(SPOT).reduce((n, o) => n + Object.keys(o).length, 0);
    console.log('  抽检 %d 项，问题 %d 个', spotCount, problems.length);

    const dates = Array.from(new Set(data.obs.map((o) => String(o.date).trim()).filter(Boolean))).sort();
    console.log('  就诊日期：%s', dates.join(' / ') || '(无)');

    const done = data.assets.filter((a) => a.status === 'done').length;
    const skipped = data.assets.filter((a) => a.status === 'skipped').length;
    const failed = data.assets.filter((a) => a.status === 'failed').length;
    console.log('');
    console.log('  完成 %d / 跳过 %d / 失败 %d', done, skipped, failed);
    if (done !== FILES.length - 1) problems.push(`完成数 ${done}，应为 ${FILES.length - 1}`);
    if (failed !== 0) problems.push(`有 ${failed} 张失败`);

    if (cdp.errors.length) problems.push('页面异常：' + String(cdp.errors[0]).split('\n')[0]);

    console.log('');
    if (problems.length) {
      ok = false;
      console.log('不通过：');
      problems.forEach((p) => console.log('  - ' + p));
    } else {
      console.log('通过：10 份乱序混装，页页对得上，坏图被跳过，整批没被拖垮。');
    }
  } catch (e) {
    ok = false;
    console.error('[x]', e.message);
  } finally {
    try { if (ws) ws.close(); } catch { }
    try { chrome.kill(); } catch { }
  }
  process.exit(ok ? 0 : 1);
}

main();
