/**
 * PDF 文字层路径冒烟测试：验证「有文字层的 PDF → 文字被读出 → 送进模型」这条分支。
 * 用 node test/e2e-textpdf.mjs
 * 前置：8765 端口已跑起本地服务；secrets/ark_api.txt 有 Key。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const APP = 'http://127.0.0.1:8765/';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
if (!key) { console.error('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）'); process.exit(2); }

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-txtpdf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
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
    if (!target) throw new Error('Chrome did not start');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
      }
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: APP });
    await sleep(1500);

    // 写入 Key 与模型配置，刷新让页面读进去
    await evaluate(`(() => {
      localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      return 'seeded';
    })()`);
    await send('Page.reload');
    await sleep(2200);

    console.log('[1/4] 拖入带文字层的 PDF');
    await evaluate(`(async () => {
      const res = await fetch('/test/samples/text-layer-report.pdf');
      const blob = await res.blob();
      const file = new File([blob], 'text-layer-report.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      for (let i = 0; i < 160; i++) {
        if (window.__S.assets.length >= 1 && !window.__S.ingesting) break;
        await new Promise(r => setTimeout(r, 120));
      }
      return window.__S.assets.length;
    })()`);

    console.log('[2/4] 检查资产与文字层');
    const asset = await evaluate(`(() => {
      const a = window.__S.assets[0];
      if (!a) return null;
      return {
        kind: a.kind, page: a.pageNo, w: a.width, h: a.height,
        textChars: (a.pageText || '').length,
        hasWBC: (a.pageText || '').includes('白细胞'),
        head: (a.pageText || '').slice(0, 30)
      };
    })()`);
    console.log('    ' + JSON.stringify(asset));
    check('生成 1 个资产', !!asset);
    check('kind 是 pdf', !!(asset && asset.kind === 'pdf'));
    check('读到文字层（>80 字）', !!(asset && asset.textChars > 80), (asset && asset.textChars || 0) + ' 字');
    check('文字层里有“白细胞”', !!(asset && asset.hasWBC));

    console.log('[3/4] 真实识别一页');
    const got = await evaluate(`(async () => {
      const t0 = Date.now();
      document.querySelector('#btn-run').click();
      for (let i = 0; i < 400; i++) {
        if (!window.__S.running) break;
        await new Promise(r => setTimeout(r, 150));
      }
      const rows = Array.from(document.querySelectorAll('#grid-body tr'));
      const ok = rows.filter(tr => tr.className === 'ok').length;
      return { ms: Date.now() - t0, rows: rows.length, ok,
               usage: window.Model.getUsage(),
               err: window.__S.assets.map(a => a.error).filter(Boolean) };
    })()`);
    console.log('    ' + JSON.stringify(got));
    check('识别完成无报错', got.err.length === 0, JSON.stringify(got.err));
    check('至少认出 4 项', got.ok >= 4, got.ok + ' 项');

    console.log('[4/4] 截图');
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(ROOT, 'docs', 'figs', 'ui-textpdf.png'), Buffer.from(shot.data, 'base64'));
      console.log('    已保存 docs/figs/ui-textpdf.png');
    } catch (e) { console.log('    截图失败，忽略'); }

  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const bad = results.filter((r) => !r.ok);
  console.log('');
  if (bad.length) {
    console.log(`[FAIL] ${bad.length} 项不通过：` + bad.map((b) => b.name).join('、'));
    process.exit(1);
  }
  console.log('[ok] 文字层路径正常');
}

main().catch((e) => { console.error('[ERR]', e.message); process.exit(1); });
