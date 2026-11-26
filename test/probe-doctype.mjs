/**
 * "自定义页面能不能真的被模型抽到"的端到端测试。
 *
 * 用**模拟模型响应**，只证明链路通：新建指标 → 新建页面（选文书类型）→
 * 页面进入该类文书的候选 → 抽取结果能填进表格。
 * 这不证明模型识别准确率，也不替代真实模型测试。
 *
 * 用法：node test/probe-doctype.mjs
 *      可用 JW_CHROME 指定浏览器路径，JW_APP 指定页面地址。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9363;
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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-dtype-'));
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
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }
    await sleep(400);

    console.log('[1/5] 清掉本地存档，从种子开始');
    await cdp.eval(`
      (function(){
        try {
          localStorage.removeItem('jiaowolu.library.v5');
          localStorage.removeItem('jiaowolu.selectedPages.v4');
          localStorage.setItem('jiaowolu.apiKey', 'mock-key-for-test');
          localStorage.setItem('jiaowolu.startView', 'all');
        } catch(e){}
        return 'ok';
      })()
    `);
    await cdp.send('Page.reload');
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }
    await sleep(600);

    console.log('[2/5] 新建指标 → 用界面新建"生化"类型的页面');
    await cdp.eval(`
      (function(){
        window.Library.addIndicator({ id: 'MYO', name: '肌红蛋白', group: '生化', type: 'num', unit: 'ng/mL', ref: '0-70', aliases: ['肌红蛋白', 'MYO'] });
        document.getElementById('btn-rules').click();
        return 'rules';
      })()
    `);
    await sleep(300);
    await cdp.eval('document.getElementById("btn-library").click(); "lib"');
    await sleep(400);
    await cdp.eval('document.querySelector("[data-tab=\\"page\\"]").click(); "tab"');
    await sleep(200);
    await cdp.eval('document.querySelector("[data-act=\\"page-new\\"]").click(); "new"');
    await sleep(300);
    const filled = await cdp.eval(`
      (function(){
        var name = document.getElementById('p-name');
        var dt = document.getElementById('p-doctype');
        if (!name || !dt) return 'no-form';
        name.value = '心肌酶谱（自定义）';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        dt.value = '生化';
        dt.dispatchEvent(new Event('change', { bubbles: true }));
        var cb = document.querySelector('#p-picks input[value="MYO"]');
        if (cb && !cb.checked) cb.click();
        document.querySelector('[data-act="page-save"]').click();
        return 'saved';
      })()
    `);
    await sleep(500);
    console.log('    表单：', filled);
    const made = await cdp.eval(`
      (function(){
        var L = window.Library;
        var p = L.pages().filter(function(x){ return x.name === '心肌酶谱（自定义）'; })[0];
        return { found: !!p, docType: p && p.docType, ids: p && p.ids, pages: L.pages().length };
      })()
    `);
    console.log('    新页面：', JSON.stringify(made));
    want(made && made.found && made.docType === '生化', '新建页面没有保存文书类型');
    want(made && made.ids && made.ids.indexOf('MYO') >= 0, '新建页面没有记住勾选的指标');
    await cdp.eval('var d=document.querySelector("#rules-dialog"); if(d) d.close(); document.querySelectorAll("#modal-box").forEach(function(m){m.classList.remove("open")}); "closed"');
    await sleep(300);

    console.log('[3/5] 检查它是否进入了"生化"的候选集');
    const cand = await cdp.eval(`({
      sheng: window.__candidatesFor('生化'),
      cbc: window.__candidatesFor('血常规')
    })`);
    console.log('    生化候选含 MYO：', cand.sheng.includes('MYO'), '| 血常规候选含 MYO：', cand.cbc.includes('MYO'));
    want(cand.sheng.includes('MYO'), '新建页面的指标没有进入"生化"候选');
    want(!cand.cbc.includes('MYO'), '不该出现在"血常规"候选里');

    console.log('[4/5] 用模拟模型响应跑一次真实链路');
    await cdp.eval(`
      (function(){
        window.__mockCalls = [];
        window.Model.vision = async function (dataUrl, prompt) {
          window.__mockCalls.push(prompt.slice(0, 40));
          if (prompt.indexOf('doc_type') >= 0) {
            return { text: '{"doc_type":"生化","title":"生化检验报告单","confidence":0.95}',
                     usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, ms: 1 };
          }
          if (prompt.indexOf('MYO') >= 0) {
            return { text: '{"report_type":"生化","report_date":"2026-11-20","items":[{"raw_name":"肌红蛋白","indicator":"MYO","value":"82","unit":"ng/mL","ref":"0-70","confidence":0.95,"src":"table"}]}',
                     usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, ms: 1 };
          }
          return { text: '{"items":[]}', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, ms: 1 };
        };
        return 'mocked';
      })()
    `);

    // 拖一张真实的合成生化单进去
    const dropped = await cdp.eval(`
      (async function(){
        var res = await fetch('test/samples/batch/bio-20261110.jpg');
        var blob = await res.blob();
        var file = new File([blob], 'bio-20261110.jpg', { type: 'image/jpeg' });
        var dt = new DataTransfer();
        dt.items.add(file);
        var dz = document.getElementById('dropzone');
        dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return blob.size;
      })()
    `);
    console.log('    拖入图片字节数：', dropped);

    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval(`(function(){
        var a = window.__S.assets[0];
        return !!(a && a.status === 'pending' && a.dataUrl && a.width > 0);
      })()`);
      if (ready) break;
      await sleep(200);
    }

    await cdp.eval('document.getElementById("btn-run").click(); "run"');
    let done = false;
    for (let i = 0; i < 100; i++) {
      const st = await cdp.eval(`(function(){
        var a = window.__S.assets[0];
        return a ? a.status : 'none';
      })()`);
      if (st === 'done' || st === 'failed') { done = st; break; }
      await sleep(200);
    }
    const dbg = await cdp.eval(`(function(){
      var a = window.__S.assets[0];
      return {
        assets: window.__S.assets.length,
        status: a && a.status,
        error: a && a.error,
        hasKey: window.Model.getConfig().hasKey,
        calls: (window.__mockCalls || []).length,
        toasts: Array.prototype.map.call(document.querySelectorAll('.toast, #toast-box *'), function(n){ return n.textContent; }).filter(Boolean).slice(-2)
      };
    })()`);
    console.log('    识别状态：', done, '| 诊断：', JSON.stringify(dbg));

    const obs = await cdp.eval(`window.__S.observations.filter(function(o){ return o.indicatorId === 'MYO'; }).map(function(o){ return { v: o.value, unit: o.unit, ref: o.ref, src: o.src }; })`);
    console.log('    MYO 观测值：', JSON.stringify(obs));
    want(obs && obs.length === 1, '自定义指标没有被写进观测值');
    want(obs && obs[0] && obs[0].v === '82', '抽到的值不对（拿到 ' + (obs && obs[0] && obs[0].v) + '）');

    const rowText = await cdp.eval(`(function(){
      var tr = document.querySelector('#grid-body tr[data-ind="MYO"]');
      return tr ? tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null;
    })()`);
    console.log('    表格里的那一行：', rowText);
    want(!!rowText, '表格里没有显示这个自定义指标');

    console.log('[5/5] 再建一个不选文书类型的页面，应当被明确提示');
    const warned = await cdp.eval(`
      (function(){
        var L = window.Library;
        L.addIndicator({ id: 'MYO2', name: '肌钙蛋白', group: '生化', type: 'num', unit: 'ng/mL', ref: '0-0.04', aliases: ['肌钙蛋白'] });
        var p = L.addPage({ name: '没选类型的页', ids: ['MYO2'] });
        var cand = window.__candidatesFor('生化');
        return { docType: p.docType, inCandidates: cand.indexOf('MYO2') >= 0 };
      })()
    `);
    console.log('    未选类型的新页面：', JSON.stringify(warned));
    want(warned && warned.docType === '', '不选类型时应存成空');
    want(warned && warned.inCandidates === false, '没选类型的页面不该进入候选');

    console.log('    页面异常：', cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无');
    want(cdp.errors.length === 0, '页面有异常：' + cdp.errors[0]);

    console.log('');
    if (problems.length) {
      problems.forEach((p) => console.log('  [x] ' + p));
      console.log('\n不通过：' + problems.length + ' 项没对上。');
      process.exitCode = 1;
    } else {
      console.log('通过：自定义页面加上文书类型后，确实进入了该类文书的候选并被填进表格（模拟模型响应）。');
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
