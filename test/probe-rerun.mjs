/**
 * 规则改过之后，要能重新识别（用户反馈的"页面组选错了，切回来没法重读"）。
 *
 * 场景复现：
 *   1. 只勾「肾功能」一页，传一份生化报告并识别 → 只问了 5 个指标；
 *   2. 换成「常规页面组」（多了综合生化等页）→ 这份报告的候选变多，
 *      顶部应出现"本批规则改过了，还有 1 份报告是按旧规则读的"；
 *   3. 点「重新识别这 1 份」→ 提示消失，生化里别的指标被补进来。
 *
 * 用法：node test/probe-rerun.mjs   （JW_APP 可指定页面地址；缺 Key 退出码 2）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const PORT = 9376;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = 'bio-20261110.jpg';

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.console = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        this.console.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
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

const SET_PAGES = `
  (function (keep) {
    for (var guard = 0; guard < 40; guard++) {
      var uses = Array.prototype.slice.call(document.querySelectorAll('#page-checks .pc-use'));
      if (!uses.length) break;
      var wrong = uses.filter(function (el) { return el.checked && keep.indexOf(el.value) === -1; })[0];
      var missing = uses.filter(function (el) { return !el.checked && keep.indexOf(el.value) !== -1; })[0];
      if (wrong) { wrong.click(); continue; }
      if (missing) { missing.click(); continue; }
      break;
    }
    return Array.prototype.slice.call(document.querySelectorAll('#page-checks .pc-use'))
      .filter(function (el) { return el.checked; }).map(function (el) { return el.value; });
  })`;
const problems = [];
const want = (cond, msg) => { if (!cond) problems.push(msg); };

function readKey() {
  try {
    return readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch { return ''; }
}

async function waitIdle(cdp, ms = 240000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const st = await cdp.eval(`(function(){ return { running: !!window.__S.running, done: window.__S.assets.filter(function(a){return a.status==='done';}).length }; })()`);
    if (!st.running) return st;
    await sleep(400);
  }
  throw new Error('识别没有在预期时间内结束');
}

async function main() {
  const key = readKey();
  if (!key) {
    console.log('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）');
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-rerun-'));
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

    console.log('[1/6] 写入 Key、清空任务与规则');
    await cdp.eval(`
      (function (key) {
        localStorage.setItem('jiaowolu.apiKey', key);
        localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base: 'https://api.deepseek.com', model: 'deepseek-flash' }));
        localStorage.setItem('jiaowolu.startView', 'all');
        localStorage.removeItem('jiaowolu.selectedPages.v4');
        return 'ok';
      })(${JSON.stringify(key)})
    `);
    await cdp.send('Page.reload');
    await sleep(1500);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object" && !!document.querySelector("#btn-rules")')) break;
      await sleep(200);
    }

    console.log('[2/6] 只勾「肾功能」一页');
    await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
    await sleep(300);
    const picked = await cdp.eval(SET_PAGES + "(['renal'])");

    console.log('   已勾页面：' + JSON.stringify(picked));
    want(picked.length === 1 && picked[0] === 'renal', '应只勾上肾功能，实际 ' + JSON.stringify(picked));
    await cdp.eval(`document.querySelector('#rules-dialog [data-close-dialog]').click(); 'ok'`);
    await sleep(300);

    console.log('[3/6] 上传一份生化报告并识别');
    await cdp.eval(`
      (async function () {
        var res = await fetch('test/samples/${REPORT}');
        var blob = await res.blob();
        var dt = new DataTransfer();
        dt.items.add(new File([blob], '${REPORT}', { type: 'image/jpeg' }));
        var dz = document.querySelector('#dropzone');
        dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return 'dropped';
      })()
    `);
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval(`(function(){ var a = window.__S.assets[0]; return !!(a && a.status === 'pending' && a.dataUrl && a.width > 0); })()`);
      if (ready) break;
      await sleep(200);
    }
    await cdp.eval(`document.querySelector('#btn-run').click(); 'ok'`);
    await waitIdle(cdp);

    const first = await cdp.eval(`
      (function () {
        var a = window.__S.assets[0];
        return { type: a.docType, sent: (a.sentIds || []).length, obs: window.__S.observations.length };
      })()
    `);
    console.log('   第一轮：判型 ' + first.type + '，问过 ' + first.sent + ' 个指标，落下 ' + first.obs + ' 条观测值');
    want(first.type === '生化', '这份报告应被判成生化，实际 ' + first.type);
    want(first.sent === 5, '只勾肾功能时应该只问 5 个指标，实际 ' + first.sent);
    const before = first.obs;

    console.log('[4/6] 换成「常规页面组」——规则变了，应出现重读提示');
    await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
    await sleep(300);
    await cdp.eval(`document.querySelector('#page-checks .pc-grp input[value="common"]').click(); 'ok'`);
    await sleep(400);
    await cdp.eval(`document.querySelector('#rules-dialog [data-close-dialog]').click(); 'ok'`);
    await sleep(400);

    const hint = await cdp.eval(`
      (function () {
        var box = document.querySelector('#rerun-hint');
        var btn = document.querySelector('#btn-rerun-stale');
        var badge = document.querySelector('#asset-strip .asset-state.stale');
        return {
          hidden: box ? box.hidden : true,
          text: box ? box.innerText.replace(/\\s+/g, ' ').trim() : '',
          button: btn ? btn.textContent.trim() : '',
          staleBadge: badge ? badge.textContent.trim() : ''
        };
      })()
    `);
    console.log('   提示：' + JSON.stringify(hint));
    want(hint.hidden === false, '规则改过之后应出现"需要重新识别"的提示');
    want(/1/.test(hint.text), '提示里应说明有 1 份报告要重读，实际：' + hint.text);
    want(/重新识别/.test(hint.button), '提示里应有重新识别按钮');
    want(hint.staleBadge === '需重读', '报告卡片上应标出「需重读」，实际：' + hint.staleBadge);

    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-rerun-hint.png'), Buffer.from(shot1.data, 'base64'));
    console.log('   截图：docs/figs/ui-rerun-hint.png');

    console.log('[5/6] 点「重新识别这 1 份」');
    await cdp.eval(`document.querySelector('#btn-rerun-stale').click(); 'ok'`);
    await waitIdle(cdp);

    const after = await cdp.eval(`
      (function () {
        var a = window.__S.assets[0];
        var box = document.querySelector('#rerun-hint');
        var ids = window.__S.observations.map(function (o) { return o.indicatorId; });
        return {
          sent: (a.sentIds || []).length,
          obs: ids.length,
          hasAlt: ids.indexOf('ALT') !== -1,
          hasUa: ids.indexOf('UA') !== -1,
          hintHidden: box ? box.hidden : true
        };
      })()
    `);
    console.log('   第二轮：问过 ' + after.sent + ' 个指标，落下 ' + after.obs + ' 条（之前 ' + before + ' 条）');
    console.log('   含 ALT=' + after.hasAlt + '，含 UA=' + after.hasUa + '，提示已消失=' + after.hintHidden);
    want(after.sent > first.sent, '重读时应按新规则问更多指标（' + first.sent + ' → ' + after.sent + '）');
    want(after.obs > before, '重读后观测值应变多（' + before + ' → ' + after.obs + '）');
    want(after.hasAlt, '常规页面组包含综合生化，重读后应读到 ALT');
    want(after.hintHidden === true, '重读完成后提示应消失');

    console.log('[6/6] 再切回只有肾功能：不应误报"需要重读"');
    await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
    await sleep(300);
    const back = await cdp.eval(SET_PAGES + "(['renal'])");
    console.log('   收窄后的页面：' + JSON.stringify(back));

    await sleep(300);
    await cdp.eval(`document.querySelector('#rules-dialog [data-close-dialog]').click(); 'ok'`);
    await sleep(400);
    const narrowed = await cdp.eval(`document.querySelector('#rerun-hint').hidden`);
    console.log('   收窄规则后提示隐藏：' + narrowed);
    want(narrowed === true, '收窄规则（不再需要更多指标）时不该提示重读');

    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-rerun-done.png'), Buffer.from(shot2.data, 'base64'));

    want(cdp.errors.length === 0, '页面不应有未捕获异常：' + cdp.errors.slice(0, 2).join(' | '));

    console.log('\n结果：' + (problems.length ? '不通过' : '通过'));
    problems.forEach((p) => console.log(' [!] ' + p));
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
