/**
 * 退化测试：把合成报告做成"手机随手拍"的样子，看识别率还剩多少。
 *
 * 没有真实照片时的替代验证。四级难度，每级两张报告，逐张单独跑一遍，
 * 和标准答案逐项比对，分四类计分：
 *   对  —— 认出了这个指标，且数值一字不差
 *   错  —— 认出了这个指标，但数值不对
 *   漏  —— 该有的没认出来
 *   编  —— 报告上根本没有这一项，却给出了值（最严重）
 *
 * 用法：node test/degraded.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (() => {
  try {
    return readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch { return ''; }
})();
if (!key) { console.error('[x] 没有 Key'); process.exit(2); }

// 标准答案。报告上"故意留空"的那一项单独放，用来抓模型编造。
// 页眉里的姓名/性别/年龄/医院也要读（提示词第 7 条要求的），一并计入考核。
const HEAD = { NAME: '张建国', SEX: '男', AGE: '52', HOSP: '上海市某三甲医院' };
const TRUTH = {
  cbc: {
    title: '血常规',
    want: Object.assign({}, HEAD, { WBC: '7.24', RBC: '4.86', PLT: '231', LYMPH_C: '1.62' }),
    mustNot: ['HGB']
  },
  bio: {
    title: '生化',
    want: Object.assign({}, HEAD, {
      ALT: '38', AST: '29', ALP: '76', GGT: '24', LDH: '188',
      TBIL: '14.6', DBIL: '4.1', ALB: '44.2', BUN: '5.3', CREA: '82',
      GLU: '5.4', NA: '141', K: '4.1', CL: '103', CA: '2.31'
    }),
    mustNot: ['UA']
  }
};

const LEVELS = {
  L0: '原图（对照）',
  L1: '随手拍，光线正常',
  L2: '斜着拍，一边阴影',
  L3: '光线差 + 手抖 + 噪点',
  L4: '对着屏幕拍',
  L5: '拍糊了还偏暗'
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
  const dir = join(ROOT, 'app', 'test', 'degraded');
  let files;
  try {
    files = readdirSync(dir).filter((f) => /\.jpg$/i.test(f)).sort();
  } catch {
    console.error('[x] 没有退化图，先跑 python tools/make_degraded.py');
    process.exit(2);
  }
  if (!files.length) { console.error('[x] degraded 目录是空的'); process.exit(2); }
  // 可以只跑某一张：node test/degraded.mjs cbc-L4
  const only = process.argv[2];
  if (only) files = files.filter((f) => f.indexOf(only) >= 0);

  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-deg-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  const rows = [];
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

    // 不设必填：这次只看"读得准不准"，不看"缺了会不会红"
    await cdp.eval(`(document.querySelectorAll('.pc-must') || []).forEach(function (c) { if (c.checked) c.click(); }); 'ok'`);
    // 页面里 confirm() 在无头浏览器里会把整个页面卡死，直接让它永远返回 true
    await cdp.eval(`window.confirm = function () { return true; }; 'ok'`);

    console.log('');
    console.log('共 %d 张退化图，逐张识别……', files.length);

    for (const name of files) {
      const short = name.split('-')[0];
      const tag = (name.match(/-(L\d)\./) || [])[1] || '?';
      const truth = TRUTH[short];
      if (!truth) continue;

      await cdp.eval(`(function(){
        document.getElementById('btn-reset').click();
        if (!window.__S.patients.length) document.getElementById('btn-add-patient').click();
        return window.__S.patients.length;
      })()`);
      await sleep(200);

      await cdp.eval(`(async function () {
        const blob = await (await fetch('test/degraded/${name}')).blob();
        const f = new File([blob], ${JSON.stringify(name)}, { type: 'image/jpeg' });
        const dt = new DataTransfer();
        dt.items.add(f);
        document.getElementById('dropzone').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        );
        return 'dropped';
      })()`);
      await sleep(300);

      // 等图解码、压好、进了状态再点识别。不等的话偶尔会拿空图去问模型，
      // 结果就是"这张图什么都没读出来"，看起来像模型不行，其实是测试太快了。
      let ready = false;
      for (let i = 0; i < 60; i++) {
        ready = await cdp.eval(`(function(){
          const a = window.__S.assets[0];
          return !!(a && a.status === 'pending' && a.dataUrl && a.width > 0);
        })()`);
        if (ready) break;
        await sleep(200);
      }
      if (!ready) console.log('  %s 图片没能就绪', name);

      await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
      const t0 = Date.now();
      let st = 'none';
      for (let i = 0; i < 240; i++) {
        st = await cdp.eval(`(function(){
          const a = window.__S.assets[0];
          return a ? a.status : 'none';
        })()`);
        if (st === 'done' || st === 'failed') break;
        await sleep(250);
      }
      const ms = Date.now() - t0;
      if (st !== 'done') {
        const err = await cdp.eval(`(function(){
          const a = window.__S.assets[0];
          return a ? (a.error || a.status) : '没有资产';
        })()`);
        console.log('  %s 状态异常：%s', name.padEnd(14), err);
      }

      const got = await cdp.eval(`(function(){
        const a = window.__S.assets[0];
        if (!a) return { __low: false };
        const out = {};
        window.__S.observations.filter(function (o) { return o.assetId === a.id; })
          .forEach(function (o) { out[o.indicatorId] = String(o.value == null ? '' : o.value).trim(); });
        out.__low = !!a.lowRes;
        return out;
      })()`);
      const lowRes = !!got.__low;
      delete got.__low;

      const want = truth.want;
      const ids = Object.keys(want);
      const TEXT_FIELDS = { NAME: 1, SEX: 1, HOSP: 1 };
      // 数值项只比数字："52岁" 和 "52" 算同一个值
      const flat = (v) => (String(v).match(/-?\d+(\.\d+)?/) || [''])[0];
      const same = (id, a, b) => (TEXT_FIELDS[id] ? String(a).trim() === String(b).trim() : flat(a) === flat(b));
      const correct = [], wrong = [], missed = [], invented = [];
      ids.forEach((id) => {
        if (!(id in got)) { missed.push(id); return; }
        if (same(id, got[id], want[id])) correct.push(id);
        else wrong.push(id + ' 期望' + want[id] + ' 得到' + got[id]);
      });
      Object.keys(got).forEach((id) => {
        if (truth.mustNot.indexOf(id) >= 0) invented.push(id + '=' + got[id]);
        else if (!(id in want)) invented.push(id + '=' + got[id] + '（不在标准答案里）');
      });

      rows.push({ name, tag, title: truth.title, n: ids.length, correct: correct.length, wrong, missed, invented, ms, lowRes });
      console.log('  %s  %s/%s 对  %s 错  %s 漏  %s 编  (%d ms%s)',
        name.padEnd(14), correct.length, ids.length,
        wrong.length, missed.length, invented.length, ms, lowRes ? '，界面标了图太小' : '');
    }

    console.log('');
    console.log('级别  说明                    报告     应识别  对  错  漏  编   正确率');
    console.log('-'.repeat(76));
    rows.forEach((r) => {
      console.log('%s    %s  %s  %s  %s  %s  %s  %s   %s%%',
        r.tag.padEnd(4),
        LEVELS[r.tag].padEnd(22 - (LEVELS[r.tag].length - LEVELS[r.tag].replace(/[^\x00-\xff]/g, '').length) / 2),
        r.title.padEnd(6), String(r.n).padEnd(5), String(r.correct).padEnd(3),
        String(r.wrong.length).padEnd(3), String(r.missed.length).padEnd(3),
        String(r.invented.length).padEnd(3),
        (100 * r.correct / r.n).toFixed(0));
    });

    const detail = rows.filter((r) => r.wrong.length || r.invented.length || r.missed.length);
    if (detail.length) {
      console.log('\n出错明细：');
      detail.forEach((r) => {
        if (r.wrong.length) console.log('  %s 值不对：%s', r.name, r.wrong.join('；'));
        if (r.missed.length) console.log('  %s 没认出：%s', r.name, r.missed.join('、'));
        if (r.invented.length) console.log('  %s 编造/误配：%s', r.name, r.invented.join('；'));
      });
    }

    const totalN = rows.reduce((s, r) => s + r.n, 0);
    const totalOk = rows.reduce((s, r) => s + r.correct, 0);
    const totalInv = rows.reduce((s, r) => s + r.invented.length, 0);
    console.log('\n合计：%d/%d 项正确（%s%%），编造 %d 项。',
      totalOk, totalN, (100 * totalOk / totalN).toFixed(1), totalInv);
    if (cdp.errors.length) console.log('页面异常：', cdp.errors.slice(0, 2));
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    chrome.kill();
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
