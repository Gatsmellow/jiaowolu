/**
 * PDF 路径冒烟测试：只验「拆页 + 渲染成图」，不调模型（省额度、也更快定位问题）。
 * 用法：node test/e2e-pdf.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const APP = 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-pdf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
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
      } catch { /* 等端口 */ }
      await sleep(250);
    }
    if (!target) throw new Error('连不上 Chrome');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        console.log('[页面异常]', m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP });
    for (let i = 0; i < 100; i++) {
      if (await ev('document.readyState') === 'complete') break;
      await sleep(120);
    }
    await sleep(400);

    console.log('[1/3] 拖入 2 页 PDF');
    await ev(`
      (async () => {
        const blob = await (await fetch('/test/samples/two-reports.pdf')).blob();
        const file = new File([blob], 'two-reports.pdf', { type: 'application/pdf' });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.getElementById('dropzone').dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        );
        return 'ok';
      })()
    `);

    // 拆页有渲染耗时，给足时间
    for (let i = 0; i < 40; i++) {
      const n = await ev('window.__S.assets.length');
      if (n >= 2) break;
      await sleep(500);
    }

    console.log('[2/3] 检查资产');
    const assets = await ev('window.__S.assets.map(a => ({kind:a.kind, page:a.pageNo, w:a.width, h:a.height, bytes:a.dataUrl.length, status:a.status}))');
    console.table(assets);

    console.log('[3/3] 用 shim 调一次 renderPage，确认 worker 正常');
    const shim = await ev(`
      (async () => {
        const blob = await (await fetch('/test/samples/two-reports.pdf')).blob();
        const pdf = await window.PdfTools.openPdf(new File([blob], 'x.pdf', {type:'application/pdf'}));
        const img = await window.PdfTools.renderPage(pdf, 1, { dpi: 120, maxEdge: 1200 });
        const pages = pdf.numPages;
        await pdf.destroy();
        return { pages, width: img.width, height: img.height, type: img.type, bytes: img.dataUrl.length };
      })()
    `);
    console.log('    ', JSON.stringify(shim));

    const ok = assets.length === 2 && assets.every((a) => a.kind === 'pdf' && a.h > 500 && a.status === 'pending');
    console.log(ok ? '\n[ok] PDF 拆页与渲染正常' : '\n[!] PDF 路径有问题');
    if (!ok) process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
