/**
 * 生成《产品说明手册》用的两张插图，身份信息一律打码。
 *
 * 图一：工作台（分组 + 时间轴 + 红黄绿）
 * 图二：指标与页面（自定义能力）
 *
 * 用法：node test/shoot-doc-figs.mjs
 * 产物：docs/figs/fig-workbench.png、docs/figs/fig-library.png
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';

const key = (() => {
  try {
    return readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
})();
if (!key) {
  console.error('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
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
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  async waitForLoad(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ((await this.eval('document.readyState')) === 'complete') return;
      await sleep(120);
    }
    throw new Error('页面加载超时');
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-fig-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    if (!target) throw new Error('连不上 Chrome 调试端口');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // 打印级清晰度：1.75 倍，1440 宽的版面出 2520 像素
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 880, deviceScaleFactor: 1.75, mobile: false
    });

    console.log('[1/4] 打开页面');
    await cdp.send('Page.navigate', { url: APP });
    await cdp.waitForLoad();
    await cdp.eval(`
      localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      localStorage.removeItem('jiaowolu.selectedPages.v3');
      'ok'
    `);
    await cdp.send('Page.reload');
    await cdp.waitForLoad();
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object"')) break;
      await sleep(250);
    }
    await sleep(300);

    console.log('[2/4] 传三份报告并识别');
    await cdp.eval(`
      (async () => {
        const files = ['test/samples/course-20261110.jpg','test/samples/cbc-20261110.jpg','test/samples/bio-20261110.jpg'];
        const dt = new DataTransfer();
        for (const f of files) {
          const blob = await (await fetch(f)).blob();
          dt.items.add(new File([blob], f.split('/').pop(), { type: 'image/jpeg' }));
        }
        document.getElementById('dropzone').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return 'dropped';
      })()
    `);
    await sleep(2500);
    // 把血常规与综合生化标成必填，图上才有红
    await cdp.eval(`
      (function () {
        ['cbc','bio'].forEach(function (v) {
          var cb = document.querySelector('.pc-must[value="' + v + '"]');
          if (cb && !cb.checked) cb.click();
        });
        return 'ok';
      })()
    `);
    await sleep(300);
    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      if (!(await cdp.eval('window.__S.running'))) break;
      await sleep(600);
    }

    console.log('[3/4] 脱敏并截图：工作台');
    const masked = await cdp.eval(`
      (function () {
        var mask = {
          NAME: '某 某', IDNO: '3101**********1234', PHONE: '138****0000',
          PHONE2: '（略）', ADDR: '上海市浦东新区某某路 100 号', ADMNO: 'ZY2026****'
        };
        Object.keys(mask).forEach(function (k) {
          var inp = document.querySelector('.val-input[data-ind="' + k + '"]');
          if (inp) { inp.value = mask[k]; }
        });
        // 把病案首页收起来，让下面的"血常规"（含一条标红）升到第一屏
        var g = document.querySelector('.group-row[data-page="course"]');
        if (g) g.click();
        // 回到顶部：让患者抬头、报告缩略图、时间轴、表格开头同屏
        document.querySelectorAll('[class*="toast"]').forEach(function (el) { el.remove(); });
        window.scrollTo(0, 0);
        var wrap = document.querySelector('.table-wrap');
        if (wrap) wrap.scrollTop = 0;
        return Object.keys(mask).length;
      })()
    `);
    console.log('    已脱敏字段：' + masked);
    await sleep(500);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'fig-workbench.png'), Buffer.from(shot.data, 'base64'));
    console.log('    docs/figs/fig-workbench.png');

    console.log('[4/4] 截图：指标与页面');
    await cdp.eval('document.getElementById("btn-library").click(); "opened"');
    await sleep(600);
    // 滚到血常规那几项：单位、参考范围、同义词、必填勾同屏，比停在身份字段那几行好看
    const scrolled = await cdp.eval(`
      (function () {
        var rows = Array.from(document.querySelectorAll('.mini-grid tbody tr'));
        var t = rows.find(function (tr) { return /\\bWBC\\b/.test(tr.textContent); });
        if (t) { t.scrollIntoView({ block: 'start' }); return 'WBC'; }
        return 'none';
      })()
    `);
    console.log('    列表定位：' + scrolled);
    await sleep(400);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'fig-library.png'), Buffer.from(shot.data, 'base64'));
    console.log('    docs/figs/fig-library.png');

    const stats = await cdp.eval('JSON.stringify({rows: document.querySelectorAll("#grid-body tr[data-ind]").length})');
    console.log('    表格行数：' + stats);
    console.log('完成。');
  } finally {
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  }
}

main().catch((e) => {
  console.error('出错：', e.message || e);
  process.exitCode = 1;
});
