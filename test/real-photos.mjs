/**
 * 用真实拍摄的报告照片跑一遍，只看"读出来了什么类型、认出了哪些项目、置信度如何"。
 *
 * 刻意不打印任何数值，也不截图：真实病历数据不出这台机器，也不进对话。
 *
 * 用法：
 *   node test/real-photos.mjs <图片目录>
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const APP = 'http://127.0.0.1:8765/';
const SRC = process.argv[2];
if (!SRC) { console.error('用法: node test/real-photos.mjs <图片目录或文件>'); process.exit(2); }

const key = readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 临时把图片放进 app/test/real/ 让页面能 fetch 到；跑完删掉
const STAGE = join(ROOT, 'app', 'test', 'real');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const names = [];
for (const f of readdirSync(SRC)) {
  if (!/\.(png|jpe?g)$/i.test(f)) continue;
  copyFileSync(join(SRC, f), join(STAGE, basename(f)));
  names.push(basename(f));
}
console.log('准备识别 ' + names.length + ' 张：' + names.join(', '));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
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
  const profile = join(tmpdir(), 'jiaowolu-real-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* 等 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('连不上 Chrome');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: APP });
    await sleep(1200);

    await cdp.eval(`localStorage.setItem('jiaowolu.startView','all');localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      localStorage.removeItem('jiaowolu.selectedPages.v2'); 'ok'`);
    await cdp.send('Page.reload');
    await sleep(1500);

    // 全部页面参与抽取，但一项必填都不勾（用户的默认要求）
    const mustCount = await cdp.eval(`document.querySelectorAll('#page-checks .pc-must:checked').length`);
    console.log('默认勾选的必填项：' + mustCount + ' 个（应为 0）');

    await cdp.eval(`
      (async () => {
        const names = ${JSON.stringify(names)};
        const files = [];
        for (const n of names) {
          const blob = await (await fetch('/test/real/' + encodeURIComponent(n))).blob();
          files.push(new File([blob], n, { type: blob.type }));
        }
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return 'dropped ' + files.length;
      })()
    `);
    await sleep(2500);

    const sizes = await cdp.eval('window.__S.assets.map(a => ({idx:a.fileIndex, w:a.width, h:a.height}))');
    console.log('入库尺寸：', JSON.stringify(sizes));

    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      const r = await cdp.eval('window.__S.running');
      if (!r) break;
      await sleep(800);
    }

    const report = await cdp.eval(`
      (() => {
        const obsByAsset = {};
        window.__S.observations.forEach(o => { (obsByAsset[o.assetId] = obsByAsset[o.assetId] || []).push(o); });
        return window.__S.assets.map(a => {
          const list = obsByAsset[a.id] || [];
          return {
            idx: a.fileIndex,
            size: a.width + 'x' + a.height,
            status: a.status,
            error: a.error || '',
            reportType: a.reportType || '',
            reportDate: a.reportDate ? '有' : '无',
            hit: list.map(o => o.indicatorId),
            low: list.filter(o => o.confidence != null && o.confidence < 0.6).length,
            unmatched: (a.unmatched || []).length,
            unmatchedSample: (a.unmatched || []).slice(0, 8)
          };
        });
      })()
    `);
    for (const r of report) {
      console.log(`报告${r.idx} ${r.size} ${r.status} ${r.reportType || '-'} 命中${r.hit.length}项 低置信${r.low} 未匹配${r.unmatched}`);
      console.log('   命中：' + (r.hit.join('、') || '（无）'));
      if (r.unmatched) console.log('   未匹配到的原文项目名：' + r.unmatchedSample.join(' / '));
      if (r.error) console.log('   错误：' + r.error);
    }
    const u = await cdp.eval('window.Model.getUsage()');
    console.log('用量：', JSON.stringify(u));
  } finally {
    try { chrome.kill(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    rmSync(STAGE, { recursive: true, force: true });
    console.log('已清理临时图片目录 app/test/real/');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
