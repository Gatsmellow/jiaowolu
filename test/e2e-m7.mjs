/**
 * M7 跨页找回的测试：患者只传了化验单，没传病程首页，但"姓名/性别/年龄"
 * 这一类本该在病程首页的必填项，在化验单页眉上是印着的。
 *
 * 期望：这几项被标成「跨页找回」——不是绿色的"已识别"，
 * 因为值来自别的报告，时间点要人确认。
 *
 * 用法：node test/e2e-m7.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
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
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-m7-'));
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

    console.log('[1/5] 打开页面');
    await cdp.send('Page.navigate', { url: APP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }

    console.log('[2/5] 写入 Key');
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
    await sleep(300);

    console.log('[3/5] 只留血常规与生化，把「病程首页」标成必填（但不上传病程首页）');
    await cdp.eval(`
      (() => {
        for (const v of ['course', 'coag', 'liver', 'renal', 'elec', 'bio']) {
          const el = document.querySelector('.pc-use[value="' + v + '"]');
          if (el && el.checked) el.click();
        }
        for (const v of ['cbc', 'bio', 'course']) {
          const el = document.querySelector('.pc-use[value="' + v + '"]');
          if (el && !el.checked) el.click();
        }
        const must = document.querySelector('.pc-must[value="course"]');
        if (must && !must.checked) must.click();
        return 'ok';
      })()
    `);

    console.log('[4/5] 拖入血常规与生化（没有病程首页）');
    await cdp.eval(`
      (async () => {
        const files = [];
        for (const name of ['cbc-20261110.jpg', 'bio-20261110.jpg']) {
          const blob = await (await fetch('test/samples/' + name)).blob();
          files.push(new File([blob], name, { type: 'image/jpeg' }));
        }
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        document.getElementById('dropzone').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        );
        return 'dropped';
      })()
    `);
    await sleep(1500);
    console.log('    资产数：' + await cdp.eval('window.__S.assets.length'));

    console.log('[5/5] 开始识别');
    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');
    for (let i = 0; i < 120; i++) {
      const busy = await cdp.eval('window.__S.assets.some(a => a.status === "running")');
      if (!busy) break;
      await sleep(1000);
    }

    const rows = await cdp.eval(`
      Array.from(document.querySelectorAll('#grid-body tr')).map(tr => ({
        code: (tr.querySelector('.ind-code') || {}).textContent || '',
        state: tr.className,
        badge: (tr.querySelector('.badge') || {}).textContent || '',
        src: (tr.querySelector('.src-link') || {}).textContent || ''
      })).filter(r => r.badge)
    `);

    const borrowed = rows.filter(r => r.state === 'borrowed');
    const missing = rows.filter(r => r.state === 'missing');
    console.log('  页面异常：', cdp.errors.length ? String(cdp.errors[0]).split('\n')[0] : '无');
    console.log('  表格行数：', rows.length);
    console.log('  跨页找回：', borrowed.map(r => r.code + '(' + r.src.trim() + ')').join(', ') || '（无）');
    console.log('  必填缺失：', missing.map(r => r.code).join(', ') || '（无）');
    console.log('  概览文字：', (await cdp.eval('document.querySelector(".stat-note")?.textContent || "(没有提示)"')).trim());

    if (borrowed.length) {
      // 跨页找回的行在表格靠下，先把它们滚进视野再截图
      await cdp.eval(`(function(){
        var row = document.querySelector('tr.borrowed');
        if (row) row.scrollIntoView({ block: 'center' });
        return 'scrolled';
      })()`);
      await sleep(400);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(ROOT, 'docs', 'figs', 'ui-crosspage.png'), Buffer.from(shot.data, 'base64'));
      console.log('  截图：docs/figs/ui-crosspage.png');
    }

    const ok = borrowed.length >= 1 && borrowed.every(r => r.src.includes('跨页'));
    console.log(ok ? '\n通过：化验单页眉里的姓名/性别/年龄被标成「跨页找回」，没有当成已识别。'
                   : '\n不通过：没有出现跨页找回。');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(200);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
