/**
 * 叙述段落取值的验证：出院记录正文里的化验值能不能抽出来、
 * 以及它会不会跟同一天真正的化验单打架。
 *
 * 场景：同一患者、同一天（2026-11-10）上传
 *   - cbc-20261110.jpg    血常规，血红蛋白 110  ← 表格来源，应该是最终显示的值
 *   - discharge-20261110.jpg 出院记录，正文写"血红蛋白 101 g/L" ← 叙述来源，应被表格压住
 * 期望：
 *   1. 出院记录被判成"出院小结"
 *   2. 从它正文里能抽到 LDH、EBV-DNA、肌酐等，且 src 全为 narrative
 *   3. 血红蛋白显示 110，不是 101，也不是"两处不一致"
 *
 * 用法：node test/probe-narrative.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9349;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (() => {
  try {
    return readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch { return ''; }
})();
if (!key) { console.error('[x] 没有 Key'); process.exit(2); }

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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-nar-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws; let ok = true; const problems = [];
  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch { }
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

    // 只勾常规页（出院小结默认就在里面）
    const on = await cdp.eval(`(function(){
      var keep = ['course','cbc','liver','renal','elec','bio','discharge','infect'];
      ['coag','immu','fish','patho','flow','ct'].forEach(function (p) {
        var cb = document.querySelector('.pc-use[value="' + p + '"]');
        if (cb && cb.checked) cb.click();
      });
      if (!document.querySelector('.pc-use[value="infect"]').checked) {
        document.querySelector('.pc-use[value="infect"]').click();
      }
      var out = [];
      document.querySelectorAll('.pc-use').forEach(function (c) { if (c.checked) out.push(c.value); });
      return out;
    })()`);
    console.log('勾选页面：%s', on.join(','));

    await cdp.eval(`(async function () {
      const names = ['test/samples/batch/cbc-20261110.jpg', 'test/samples/batch/discharge-20261110.jpg'];
      const dt = new DataTransfer();
      for (let i = 0; i < names.length; i++) {
        const blob = await (await fetch(names[i])).blob();
        dt.items.add(new File([blob], names[i].split('/').pop(), { type: 'image/jpeg' }));
      }
      document.getElementById('dropzone').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return dt.items.length;
    })()`);
    for (let i = 0; i < 80; i++) {
      const n = await cdp.eval(`(window.__S.assets || []).filter(function(a){return a.dataUrl && a.width>0;}).length`);
      if (n >= 2) break;
      await sleep(200);
    }
    await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
    for (let i = 0; i < 400; i++) {
      const busy = await cdp.eval(`(function(){
        var a = window.__S.assets || [];
        return a.some(function (x) { return x.status === 'pending' || x.status === 'running' || x.status === 'queued'; });
      })()`);
      if (!busy) break;
      await sleep(500);
    }

    const d = await cdp.eval(`(function(){
      var S = window.__S;
      return {
        assets: S.assets.map(function (a, k) {
          return { idx: k, docType: a.docType || '', status: a.status, date: a.reportDate || '' };
        }),
        obs: S.observations.map(function (o) {
          var idx = -1;
          S.assets.forEach(function (a, k) { if (a.id === o.assetId) idx = k; });
          return { ai: idx, code: o.indicatorId, value: o.value, src: o.src || 'table', date: o.date || '' };
        })
      };
    })()`);

    const dis = d.assets.find((a) => a.docType === '出院小结');
    const cbc = d.assets.find((a) => a.docType === '血常规');
    console.log('报告：', JSON.stringify(d.assets));
    if (!dis) problems.push('没有一份被判成「出院小结」');
    if (!cbc || cbc.status !== 'done') problems.push('血常规没有完成');

    const nar = dis ? d.obs.filter((o) => o.ai === dis.idx) : [];
    console.log('出院记录抽出 %d 项：%s', nar.length,
      nar.map((o) => o.code + '=' + o.value).join(' '));
    if (nar.length < 4) problems.push(`出院记录只抽出 ${nar.length} 项，预期至少 5 项`);
    const notNar = nar.filter((o) => o.src !== 'narrative');
    if (notNar.length) problems.push(`有 ${notNar.length} 项没标记成叙述来源：${notNar.map((o) => o.code).join(',')}`);

    const codeOf = (list, c) => { const h = list.find((o) => o.code === c); return h ? String(h.value) : ''; };
    const ldh = codeOf(nar, 'LDH');
    console.log('LDH = %s（应为 168）', ldh || '(没抽到)');
    if (!/168/.test(ldh)) problems.push('出院记录里的乳酸脱氢酶没抽到');

    const evb = codeOf(nar, 'EBV_DNA');
    console.log('EBV-DNA = %s（应为 <500）', evb || '(没抽到)');
    if (!/500/.test(evb)) problems.push('出院记录里的 EBV-DNA 没抽到');

    // 关键一条：同一天有化验单时，血红蛋白必须显示化验单的值，且不算冲突
    const cell = await cdp.eval(`(function(){
      var tr = document.querySelector('tr[data-ind="HGB"]');
      if (!tr) return null;
      return { cls: tr.className, val: (tr.querySelector('.val-input') || {}).value,
               src: (tr.querySelector('.src-link') ? tr.querySelector('.src-link').textContent : ''),
               tag: (tr.querySelector('.src-tag') ? tr.querySelector('.src-tag').textContent : '') };
    })()`);
    console.log('血红蛋白单元格：', JSON.stringify(cell));
    if (!cell) problems.push('表里找不到血红蛋白这一行');
    else {
      if (String(cell.val) !== '110') problems.push(`血红蛋白显示 ${cell.val}，应为化验单的 110`);
      if (cell.cls !== 'ok') problems.push(`血红蛋白状态是 ${cell.cls}，应为 ok（不报冲突）`);
    }

    // 只有叙述里才有的那一项，应带"文中"标记
    const ldhCell = await cdp.eval(`(function(){
      var tr = document.querySelector('tr[data-ind="LDH"]');
      if (!tr) return null;
      return { cls: tr.className, val: (tr.querySelector('.val-input') || {}).value,
               tag: (tr.querySelector('.src-tag') ? tr.querySelector('.src-tag').textContent : '') };
    })()`);
    console.log('乳酸脱氢酶单元格：', JSON.stringify(ldhCell));
    if (!ldhCell) problems.push('表里找不到乳酸脱氢酶这一行');
    else {
      if (!/文中/.test(ldhCell.tag)) problems.push('叙述来源的值没有显示「文中」标记');
      if (ldhCell.cls !== 'ok') problems.push(`乳酸脱氢酶状态是 ${ldhCell.cls}，应为 ok`);
    }

    if (cdp.errors.length) problems.push('页面异常：' + String(cdp.errors[0]).split('\n')[0]);

    console.log('');
    if (problems.length) { ok = false; console.log('不通过：'); problems.forEach((p) => console.log('  - ' + p)); }
    else console.log('通过：叙述里的值抽出来了，化验单的值优先，没有报假冲突。');
  } catch (e) {
    ok = false; console.error('[x]', e.message);
  } finally {
    try { if (ws) ws.close(); } catch { }
    try { chrome.kill(); } catch { }
  }
  process.exit(ok ? 0 : 1);
}

main();
