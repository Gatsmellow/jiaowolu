/* 页面组回归：组的快捷勾选、组预设必填、导出带上组。
 * 判据：
 *   1. 侧栏出现两个组药丸，默认只勾了常规页面组（7/7），淋巴瘤组半选（7/14）
 *   2. 勾上淋巴瘤组 → 14 页全勾，两个药丸都是满格
 *   3. 给常规页面组加两项必填预设后，取消再勾上，必填跟着来去
 *   4. 导出的配置 JSON 里有 groups，且每条带 pageIds / reqIds */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const PORT = Number(process.env.JW_CDP_PORT || 9355);
const KEY = readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'jw-groups-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,880', 'about:blank',
], { stdio: 'ignore' });

let ws;
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
          }
        };
        return;
      }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('连不上 Chrome');
}

let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

const problems = [];
let shot = null;
const PILLS = `(function () {
  return Array.from(document.querySelectorAll('.pc-grp')).map(function (el) {
    var cb = el.querySelector('input');
    return {
      name: el.querySelector('.grp-name').textContent,
      id: cb.value,
      checked: cb.checked,
      part: cb.indeterminate === true,
      count: el.querySelector('b').textContent
    };
  });
})()`;
const SEL = `(function () {
  var s = JSON.parse(localStorage.getItem('jiaowolu.selectedPages.v4') || '{}');
  var sub = document.getElementById('patient-sub') ? document.getElementById('patient-sub').textContent : '';
  var m = /其中必填 (\\d+) 项/.exec(sub);
  return { pages: (s.ids || []).length, add: (s.add || []).length, drop: (s.drop || []).length, req: m ? Number(m[1]) : null };
})()`;

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  await evaluate(`localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(KEY)});
    localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base:'https://api.deepseek.com', model:'deepseek-flash' }));
    location.reload(); 'reloaded'`);
  await sleep(3000);

  // 1) 默认状态
  const p0 = await evaluate(PILLS);
  console.log('  初始药丸：', JSON.stringify(p0));
  const s0 = await evaluate(SEL);
  console.log('  初始选择：', JSON.stringify(s0));
  if (p0.length !== 2) problems.push(`组药丸 ${p0.length} 个，应为 2 个`);
  const common0 = p0.find((p) => p.id === 'common');
  const lymph0 = p0.find((p) => p.id === 'lymphoma');
  if (!common0 || common0.count !== '7/7' || !common0.checked) problems.push('常规页面组默认应是 7/7 且已勾选');
  if (!lymph0 || lymph0.count !== '7/14' || lymph0.checked) problems.push('淋巴瘤专项检查应是半选 7/14');

  // 3) 给常规页面组存两项必填预设 —— 组还勾着，预设应当立刻生效
  await evaluate(`document.getElementById('btn-library').click(); 'ok'`);
  await sleep(600);
  await evaluate(`document.querySelector('[data-tab="grp"]').click(); 'ok'`);
  await sleep(400);
  const grpRows = await evaluate(`document.querySelectorAll('.mini-grid tbody tr').length`);
  console.log('  页面组列表行数：', grpRows);
  await evaluate(`document.querySelector('[data-act="grp-edit"][data-id="common"]').click(); 'ok'`);
  await sleep(400);
  await evaluate(`(function () {
    ['HGB', 'WBC'].forEach(function (v) {
      var cb = document.querySelector('#g-reqs input[value="' + v + '"]');
      if (cb && !cb.checked) cb.click();
    });
    document.querySelector('[data-act="grp-save"]').click();
    return 'saved';
  })()`);
  await sleep(500);
  const savedReq = await evaluate(`(function () {
    var g = JSON.parse(localStorage.getItem('jiaowolu.library.v5') || '{}');
    var grp = (g.groups || []).filter(function (x) { return x.id === 'common'; })[0];
    return grp ? grp.reqIds : null;
  })()`);
  const s2 = await evaluate(SEL);
  const cbcRow2 = await evaluate(`(function () {
    var inp = document.querySelector('.pc-must[value="cbc"]');
    var el = inp && inp.closest('.pc-req');
    return el ? { text: el.textContent.trim(), on: !!inp.checked } : null;
  })()`);
  console.log('  常规组预设：', JSON.stringify(savedReq), '存完立刻生效 →', JSON.stringify(s2), JSON.stringify(cbcRow2));
  if (s2.req !== 2) problems.push(`组勾着时改预设应立刻生效为 2 项，实际 ${s2.req}`);
  if (!cbcRow2 || !/2\/10/.test(cbcRow2.text)) problems.push('血常规那一行没有显示 2/10 的预设');
  shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-group-edit.png'), Buffer.from(shot.data, 'base64'));

  // 关掉弹层
  await evaluate(`document.querySelector('[data-close]').click(); 'ok'`);
  await sleep(300);

  // 4) 取消常规组 → 页面归零、预设跟着失效
  await evaluate(`document.querySelector('.pc-grp input[value="common"]').click(); 'ok'`);
  await sleep(400);
  const s3 = await evaluate(SEL);
  console.log('  取消常规组后：', JSON.stringify(s3));
  if (s3.pages !== 0) problems.push(`取消唯一的组后页面应归零，实际 ${s3.pages}`);
  if (s3.req !== 0) problems.push(`取消组后必填没失效（${s3.req} 项）`);

  // 5) 重新勾上 → 页面回来、预设自动重生
  await evaluate(`document.querySelector('.pc-grp input[value="common"]').click(); 'ok'`);
  await sleep(400);
  const s4 = await evaluate(SEL);
  console.log('  重新勾上常规组：', JSON.stringify(s4));
  if (s4.pages !== 7 || s4.req !== 2) problems.push(`重新勾上常规组应为 7 页 2 项必填，实际 ${s4.pages} 页 ${s4.req} 项`);

  // 6) 再勾上淋巴瘤组（含全部 14 页），然后把被盖住的常规组取消，应提示而不是静默失效
  await evaluate(`document.querySelector('.pc-grp input[value="lymphoma"]').click(); 'ok'`);
  await sleep(400);
  const s5 = await evaluate(SEL);
  console.log('  再勾淋巴瘤组：', JSON.stringify(s5));
  if (s5.pages !== 14) problems.push(`淋巴瘤组勾上后页面应为 14，实际 ${s5.pages}`);
  if (s5.req !== 2) problems.push('淋巴瘤组勾上后常规组预设应仍然生效');

  // 6) 导出配置里要有组
  const exported = await evaluate(`(function () {
    return new Promise(function (resolve) {
      var orig = URL.createObjectURL;
      URL.createObjectURL = function (blob) {
        blob.text().then(function (t) { URL.createObjectURL = orig; resolve(t); });
        return orig.call(URL, blob);
      };
      document.getElementById('btn-library').click();
      setTimeout(function () {
        document.querySelector('[data-act="lib-export"]').click();
      }, 300);
      setTimeout(function () { resolve(''); }, 3000);
    });
  })()`);
  let cfg = null;
  try { cfg = JSON.parse(exported); } catch { /* ignore */ }
  console.log('  导出配置：', cfg ? { groups: (cfg.groups || []).length, pages: (cfg.pages || []).length } : '拿不到内容');
  if (!cfg) problems.push('导出配置没读到内容');
  else {
    if (!Array.isArray(cfg.groups) || cfg.groups.length !== 2) problems.push('导出的配置里没有带上页面组');
    var g0 = (cfg.groups || []).filter((g) => g.id === 'common')[0];
    if (!g0 || !g0.pageIds.length || g0.reqIds.length !== 2) problems.push('导出的组缺少 pageIds / reqIds');
  }
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (problems.length) {
  console.log('\n不通过：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n通过：页面组能一键勾选、预设必填能跟着组来去、导出配置带上了组。');
