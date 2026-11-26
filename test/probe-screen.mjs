/**
 * 采集质量检测：图片够不够清楚（拉普拉斯响应方差），以及"同一份叙述里读到多个值"的提示。
 *
 * 用法：
 *   node test/probe-screen.mjs            打印各图的清晰度，便于标定阈值
 *   node test/probe-screen.mjs --assert   断言：拍糊/拍屏幕的被标出来，干净件不误报
 *
 * 不联网、不调用模型。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9378;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  // 模糊的：期望被标出来（clear=false）
  { file: 'test/degraded/cbc-L3.jpg', clear: false, note: '拍糊的纸' },
  { file: 'test/degraded/bio-L3.jpg', clear: false, note: '拍糊的纸（生化）' },
  { file: 'test/degraded/cbc-L4.jpg', clear: false, note: '对着屏幕拍（血常规）' },
  { file: 'test/degraded/bio-L4.jpg', clear: false, note: '对着屏幕拍（生化）' },
  { file: 'test/degraded/cbc-L5.jpg', clear: false, note: '又糊又暗' },
  // 干净的：期望不误报
  { file: 'test/samples/virtual/vr-cbc-20261120.jpg', clear: true, note: '干净的化验单' },
  { file: 'test/samples/virtual/vr-course-20261120.jpg', clear: true, note: '干净的表单页' },
  { file: 'test/samples/demo/A-02-cbc-20261105.jpg', clear: true, note: '干净的血常规' },
  { file: 'test/samples/virtual/vr-patho-20261120.jpg', clear: true, note: '干净的叙述页' },
  { file: 'test/samples/virtual/vr-discharge-20261120.jpg', clear: true, note: '干净的出院记录' }
];

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
  const doAssert = process.argv.includes('--assert');
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-screen-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  const problems = [];
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

    const script = `(async function () {
      var cases = ${JSON.stringify(CASES.map((c) => c.file))};
      var out = [];
      var softMin = window.__SOFT_MIN;
      for (var i = 0; i < cases.length; i++) {
        var img = await new Promise(function (resolve, reject) {
          var im = new Image();
          im.onload = function () { resolve(im); };
          im.onerror = function () { reject(new Error('load fail')); };
          im.src = cases[i];
        });
        var w = Math.min(img.naturalWidth, 1500);
        var h = Math.round(img.naturalHeight * w / img.naturalWidth);
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
        out.push({ file: cases[i], sharp: window.__photoSharpness(cv) });
      }
      return { softMin: softMin, rows: out };
    })()`;

    const res = await cdp.eval(script);
    const byFile = {};
    res.rows.forEach((r) => { byFile[r.file] = r; });

    console.log('清晰度阈值 ' + res.softMin + (doAssert ? '（断言模式）' : '（仅标定）'));
    console.log('文件'.padEnd(46) + 'sharp   判定     说明');
    CASES.forEach((c) => {
      const r = byFile[c.file] || {};
      const ok = r.sharp != null && r.sharp >= res.softMin;
      console.log(c.file.padEnd(46) + String(r.sharp).padEnd(8) + (ok ? '正常' : '偏模糊').padEnd(9) + c.note);
      if (doAssert) {
        if (c.clear && !ok) problems.push(c.file + ' 是干净件，却被判成偏模糊（sharp=' + r.sharp + '）');
        if (!c.clear && ok) problems.push(c.file + ' 是模糊件，却没被标出来（sharp=' + r.sharp + '）');
      }
    });

    if (cdp.errors.length) problems.push('页面有异常：' + cdp.errors[0].split('\n')[0]);
    if (doAssert) {
      if (problems.length) {
        console.log('');
        problems.forEach((p) => console.log('[x] ' + p));
        process.exitCode = 1;
      } else {
        console.log('');
        console.log('通过：模糊/拍屏幕的被标出来，干净件没有误报。');
      }
    }
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
