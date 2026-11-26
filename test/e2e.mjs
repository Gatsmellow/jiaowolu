/**
 * 端到端冒烟测试：用真实的 Chrome 跑一遍「上传 → 识别 → 填表 → 标红」。
 *
 * 为什么不用 jsdom：这条链路上有两处只有真浏览器才成立——
 *   1) PDF.js 的 worker；
 *   2) 浏览器直连模型服务的 CORS 行为。
 *   jsdom 里这两样都是假的，测过了也不代表能用。
 *
 * 用法：node test/e2e.mjs
 * 需要：本机装有 Chrome；本地静态服务已在 8765 端口跑起来；secrets/ark_api.txt 有 Key。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
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

async function httpJson(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return r.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  async waitForLoad(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const ready = await this.eval('document.readyState');
      if (ready === 'complete') return;
      await sleep(120);
    }
    throw new Error('页面加载超时');
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-e2e-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // 等调试端口起来
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await httpJson('/json/list');
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
    cdp = new CDP(ws);

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        console.log('[页面异常]', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        console.log('[console.error]', msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    console.log('[1/6] 打开页面');
    await cdp.send('Page.navigate', { url: APP });
    await cdp.waitForLoad();

    console.log('[2/6] 写入 Key 与模型配置');
    await cdp.eval(`
      localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(key)});
      localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({base:'https://api.deepseek.com', model:'deepseek-flash'}));
      'ok'
    `);
    await cdp.send('Page.reload');
    await cdp.waitForLoad();
    // 托管版要把 3 MB 的 PDF.js 从网上拉下来，__S 不一定立刻就绪，等它出现再动手
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.eval('typeof window.__S === "object" && window.__S !== null');
      if (ready) break;
      await sleep(250);
    }
    await sleep(300);

    console.log('[3/6] 拖入三份报告（病程首页 / 血常规 / 生化），把血常规与综合生化标成必填');
    await cdp.eval(`
      (async () => {
        // 页面默认全部参与抽取，但一个必填都没有；这里只把两页标成必填，
        // 用来验证"缺项才标红、没做的不算红"。
        // 注意：每次 change 都会重画侧栏，所以不能用查好的节点循环，要按 value 现查现点。
        for (const v of ['cbc', 'bio']) {
          const el = document.querySelector('.pc-must[value="' + v + '"]');
          if (el && !el.checked) el.click();
        }

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

    const assets = await cdp.eval('window.__S.assets.length');
    console.log('    资产数：' + assets);
    if (!assets) throw new Error('拖入没有生成资产');

    console.log('[4/6] 点击「开始识别」（真实调用模型，耐心等）');
    await cdp.eval('document.getElementById("btn-run").click(); "clicked"');

    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < 180000) {
      const snap = await cdp.eval('({running: window.__S.running, obs: window.__S.observations.length, done: window.__S.assets.filter(a=>a.status==="done").length, err: window.__S.assets.filter(a=>a.status==="error").length})');
      if (snap.obs !== last) { console.log(`    ${Math.round((Date.now() - t0) / 1000)}s  obs=${snap.obs} done=${snap.done} err=${snap.err}`); last = snap.obs; }
      if (!snap.running) break;
      await sleep(700);
    }

    console.log('[5/6] 读表格');
    // 界面默认停在"待核对"（只渲染需要处理的行）；统计前先切到"全部结果"，
    // 并把折叠着的分组展开，否则数出来的行数是少的。
    await cdp.eval(`
      (function () {
        var tab = document.getElementById('btn-results-all');
        if (tab) tab.click();
        return 'all';
      })()
    `);
    await sleep(400);
    await cdp.eval(`
      (function () {
        var collapsed = Array.from(document.querySelectorAll('#grid-body .group-row'))
          .filter(function (el) { return el.getAttribute('aria-expanded') === 'false'; });
        collapsed.forEach(function (el) { el.click(); });
        return collapsed.length;
      })()
    `);
    await sleep(400);
    const assetInfo = await cdp.eval('window.__S.assets.map(a => ({idx: a.fileIndex, st: a.status, err: a.error || ""}))');
    console.log('    资产状态：', JSON.stringify(assetInfo));
    const rows = await cdp.eval(`
      Array.from(document.querySelectorAll('#grid-body tr[data-ind]')).map(tr => ({
        state: tr.className,
        ind: tr.getAttribute('data-ind'),
        value: tr.querySelector('.val-input')?.value || '',
        badge: tr.querySelector('.badge')?.textContent || '',
        src: tr.querySelector('.src-link')?.textContent || ''
      }))
    `);
    console.table(rows);

    console.log('[6/6] 截图');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(ROOT, 'docs', 'figs', 'ui-workbench.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('    已保存 ' + out);

    const usage = await cdp.eval('window.Model.getUsage()');
    console.log('    用量：', JSON.stringify(usage));

    const missing = rows.filter((r) => r.state === 'missing').length;
    const ok = rows.filter((r) => r.state === 'ok').length;
    const absent = rows.filter((r) => r.state === 'absent').length;
    console.log(`\n结果：已识别 ${ok} 项，必填缺失 ${missing} 项，未提供 ${absent} 项，共 ${rows.length} 行`);
    if (ok < 20) { console.error('[!] 识别到的项目偏少，检查提示词或图片清晰度'); process.exitCode = 1; }
    if (missing !== 2) { console.error('[!] 期待正好 2 项必填缺失（血红蛋白、尿酸），实际 ' + missing); process.exitCode = 1; }
    if (rows.length < 35) { console.error('[!] 表格行数偏少，页面可能没加载全'); process.exitCode = 1; }

    // ---- 第 7 步：自定义指标 + 自定义页面 ----
    console.log('[7/7] 新建指标 → 新建页面 → 刷新后还在不在');
    const added = await cdp.eval(`
      (() => {
        document.getElementById('btn-library').click();
        document.querySelector('[data-act="ind-new"]').click();
        document.getElementById('f-id').value = 'FT3';
        document.getElementById('f-name').value = '游离三碘甲状腺原氨酸';
        document.getElementById('f-unit').value = 'pmol/L';
        document.getElementById('f-ref').value = '3.1–6.8';
        document.getElementById('f-alias').value = 'FT3、游离T3';
        document.querySelector('[data-act="ind-save"]').click();
        return window.Library.byId('FT3') ? 'indicator ok' : 'indicator failed';
      })()
    `);
    console.log('    ' + added);

    const pageMade = await cdp.eval(`
      (() => {
        document.querySelector('[data-tab="page"]').click();
        document.querySelector('[data-act="page-new"]').click();
        document.getElementById('p-name').value = '甲功三项（测试）';
        const cb = Array.from(document.querySelectorAll('#p-picks input')).find(x => x.value === 'FT3');
        if (!cb) return 'pick list missing FT3';
        cb.checked = true;
        document.querySelector('[data-act="page-save"]').click();
        return 'saved';
      })()
    `);
    console.log('    页面保存：' + pageMade);

    const libShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'ui-library.png'), Buffer.from(libShot.data, 'base64'));
    console.log('    已保存 docs/figs/ui-library.png');

    const pageMade2 = await cdp.eval(`
      (() => {
        document.querySelector('[data-close]').click();
        return Array.from(document.querySelectorAll('#page-checks .pc-name')).map(e => e.textContent).join('|');
      })()
    `);
    console.log('    侧栏页面：' + pageMade2);

    await cdp.send('Page.reload');
    await cdp.waitForLoad();
    await sleep(500);
    const persisted = await cdp.eval(`
      (() => {
        const hasInd = !!window.Library.byId('FT3');
        const page = window.Library.pages().find(p => p.name === '甲功三项（测试）');
        const inSidebar = Array.from(document.querySelectorAll('#page-checks .pc-name')).some(e => e.textContent.includes('甲功'));
        return { hasInd, page: page ? page.ids : null, inSidebar };
      })()
    `);
    console.log('    刷新后：' + JSON.stringify(persisted));

    if (!persisted.hasInd || !persisted.inSidebar) {
      console.error('[!] 自定义指标/页面没有存下来');
      process.exitCode = 1;
    }

    // 测试数据留在 localStorage 会污染下一次运行，清掉
    await cdp.eval("localStorage.removeItem('jiaowolu.library.v2'); localStorage.removeItem('jiaowolu.selectedPages.v2'); 'cleaned'");
  } finally {
    try { chrome.kill(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
