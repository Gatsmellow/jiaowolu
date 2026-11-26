/**
 * 验证「必填」已经精确到指标，而不是整页。
 *
 * 场景：只在指标库里把「血红蛋白 HGB」一项标成必填，别的都不标。
 * 然后传三份报告（血常规里故意没有血红蛋白，生化里故意没有尿酸）。
 *
 * 期望：HGB 红（必填缺失）；UA 灰（未提供，因为整页没标必填）；
 *       侧栏「血常规」显示半选 1/10，而不是整页必填。
 *
 * 用法：node test/probe-req.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
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
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-req-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
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

    console.log('[1/5] 打开页面');
    await cdp.send('Page.navigate', { url: APP });
    await cdp.waitForLoad();
    await cdp.eval(`
      localStorage.setItem('jiaowolu.startView','all');localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      localStorage.removeItem('jiaowolu.selectedPages.v3');
      localStorage.removeItem('jiaowolu.selectedPages.v2');
      'ok'
    `);
    await cdp.send('Page.reload');
    await cdp.waitForLoad();
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object" && window.__S !== null')) break;
      await sleep(250);
    }
    await sleep(300);

    console.log('[2/5] 在指标库里只勾「血红蛋白」一项为必填');
    await cdp.eval('document.getElementById("btn-library").click(); "opened"');
    await sleep(250);
    await cdp.eval('document.querySelector("[data-tab=ind]").click(); "tab"');
    await sleep(250);
    const hit = await cdp.eval(`
      (function () {
        var el = document.querySelector('.ind-req[value="HGB"]');
        if (!el) return 'no-checkbox';
        el.click();
        return el.checked ? 'checked' : 'not-checked';
      })()
    `);
    console.log('    血红蛋白勾选：' + hit);
    if (hit !== 'checked') throw new Error('指标库里没找到 HGB 的必填勾');
    await cdp.eval('document.querySelector("[data-close]").click(); "closed"');
    await sleep(400);

    const sideState = await cdp.eval(`
      (function () {
        var el = document.querySelector('.pc-must[value="cbc"]');
        var lab = el && el.closest('.pc-req');
        return { checked: el ? el.checked : null, indeterminate: el ? el.indeterminate : null, text: lab ? lab.textContent.trim() : '' };
      })()
    `);
    console.log('    侧栏血常规：' + JSON.stringify(sideState));

    console.log('[3/5] 拖入三份报告');
    await cdp.eval(`
      (async () => {
        const files = [];
        for (const name of ['course-20261110.jpg', 'cbc-20261110.jpg', 'bio-20261110.jpg']) {
          const blob = await (await fetch('test/samples/' + name)).blob();
          files.push(new File([blob], name, { type: 'image/jpeg' }));
        }
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        document.getElementById('dropzone').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        );
        return 'dropped ' + files.length;
      })()
    `);
    await sleep(2500);

    console.log('[4/5] 开始识别（真实调用模型）');
    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const snap = await cdp.eval('({running: window.__S.running, done: window.__S.assets.filter(a=>a.status==="done").length})');
      if (!snap.running) break;
      await sleep(700);
    }

    const rows = await cdp.eval(`
      Array.from(document.querySelectorAll('#grid-body tr')).map(tr => ({
        state: tr.className,
        ind: tr.getAttribute('data-ind'),
        badge: tr.querySelector('.badge')?.textContent || ''
      }))
    `);
    const missing = rows.filter((r) => r.state === 'missing');
    const absent = rows.filter((r) => r.state === 'absent');
    console.log('    必填缺失：' + missing.map((r) => r.ind).join(', '));
    console.log('    未提供：' + absent.map((r) => r.ind).join(', '));

    console.log('[5/5] 截图');
    // 把标红的那一行滚进视野，截图里能同时看到侧栏的 1/10 和红行
    await cdp.eval(`
      (function () {
        var tr = document.querySelector('tr[data-ind="HGB"]');
        if (tr) tr.scrollIntoView({ block: 'center' });
        return 'scrolled';
      })()
    `);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(ROOT, 'docs', 'figs', 'ui-required.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('    已保存 ' + out);
    console.log('    页面异常：' + (cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无'));

    const ok =
      missing.length === 1 && missing[0].ind === 'HGB' &&
      absent.some((r) => r.ind === 'UA') &&
      sideState.indeterminate === true && /1\/10/.test(sideState.text);
    if (!ok) {
      console.error('\n不通过：必填没有精确到指标');
      process.exitCode = 1;
    } else {
      console.log('\n通过：只有血红蛋白标红，同页的尿酸只是「未提供」；侧栏血常规显示 1/10 半选。');
    }
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
