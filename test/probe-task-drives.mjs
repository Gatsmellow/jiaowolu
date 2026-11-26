/**
 * 一句话任务 → 驱动真实识别与必填核查（阶段 B 的证据）。
 *
 * 链路：真实模型生成任务配置 → 确认应用 → 上传合成报告 → 真实视觉识别
 *      → 结果表只含任务选中的指标 → 必填缺失进待核对行动队列 → 非必填缺项不标红。
 *
 * 用法：node test/probe-task-drives.mjs
 *      JW_APP 可指定页面地址；缺 Key 时退出码 2（跳过，不是通过）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9371;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TASK = '本次整理病案首页、血常规和肾功能；姓名、血红蛋白、肌酐为必填，其他指标有就整理。';
const FILES = ['A-02-cbc-20261105.jpg', 'A-03-bio-20261105.jpg'];

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

const problems = [];
function want(cond, msg) { if (!cond) problems.push(msg); }

function readKey() {
  try { return readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim(); }
  catch { return ''; }
}

async function main() {
  const key = readKey();
  if (!key) {
    console.log('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（不是通过）');
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-drives-'));
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
    await cdp.send('Page.navigate', { url: APP });
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('document.readyState === "complete" && typeof window.__S === "object"')) break;
      await sleep(200);
    }

    console.log('[1/6] 写入 Key，清空本批规则与患者');
    await cdp.eval(`
      (function(key){
        localStorage.setItem('jiaowolu.apiKey', key);
        localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base: 'https://api.deepseek.com', model: 'deepseek-flash' }));
        localStorage.setItem('jiaowolu.startView', 'all');
        localStorage.removeItem('jiaowolu.selectedPages.v4');
        return 'ok';
      })(${JSON.stringify(key)})
    `);
    await cdp.send('Page.reload');
    await sleep(1600);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object" && !!document.querySelector("#btn-task-ai")')) break;
      await sleep(200);
    }

    console.log('[2/6] 一句话生成配置并应用');
    await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
    await sleep(250);
    await cdp.eval(`document.querySelector('#btn-task-ai').click(); 'ok'`);
    await sleep(250);
    await cdp.eval(`
      (function(){
        var t = document.querySelector('#task-requirement');
        t.value = ${JSON.stringify(TASK)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btn-task-generate').click();
        return 'clicked';
      })()
    `);
    let ready = false;
    for (let i = 0; i < 240; i++) {
      const s = await cdp.eval(`(function(){
        var p = document.querySelector('#task-preview');
        var b = document.querySelector('#btn-task-apply');
        return { txt: p ? p.innerText : '', ok: b ? !b.disabled : false };
      })()`);
      if (s.ok) { ready = true; break; }
      await sleep(300);
    }
    want(ready, '真实模型应返回可应用的配置预览');
    if (!ready) throw new Error('没有拿到可应用的配置，后续无法验证驱动关系');
    const previewShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-task-preview.png'), Buffer.from(previewShot.data, 'base64'));
    console.log('   截图：docs/figs/ui-task-preview.png');
    await cdp.eval(`document.querySelector('#btn-task-apply').click(); 'ok'`);
    await sleep(800);

    const cfg = await cdp.eval(`(function(){
      var sel = JSON.parse(localStorage.getItem('jiaowolu.selectedPages.v4') || '{}');
      return { ids: sel.ids || [], add: sel.add || [], target: window.__targetIds() };
    })()`);
    console.log('   任务配置：页面 ' + JSON.stringify(cfg.ids));
    console.log('   必填：' + JSON.stringify(cfg.add));
    console.log('   目标指标数：' + cfg.target.length);
    want(cfg.ids.includes('course') && cfg.ids.includes('cbc') && cfg.ids.includes('renal'), 'AI 选的页面应成为本批规则');
    want(cfg.target.length === 29, '目标指标应是 14+10+5=29 项，实际 ' + cfg.target.length);
    want(!cfg.target.includes('ALT'), '没选的页面（肝功能）不应进入目标指标');

    console.log('[3/6] 上传两份合成报告（血常规缺 HGB、生化缺 UA）');
    await cdp.eval(`(async function(){
      var names = ${JSON.stringify(FILES)};
      var dt = new DataTransfer();
      for (var i = 0; i < names.length; i++) {
        var res = await fetch('test/samples/demo/' + names[i]);
        var blob = await res.blob();
        dt.items.add(new File([blob], names[i], { type: 'image/jpeg' }));
      }
      document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return names.length;
    })()`);
    for (let i = 0; i < 80; i++) {
      const ok = await cdp.eval(`(function(){
        var as = window.__S.assets;
        return as.length === 2 && as.every(function(a){ return a.dataUrl && a.width > 0; });
      })()`);
      if (ok) break;
      await sleep(250);
    }

    console.log('[4/6] 运行识别（真实视觉模型）');
    const usage0 = JSON.parse(await cdp.eval(`JSON.stringify(window.Model.getUsage())`));
    await cdp.eval(`document.getElementById('btn-run').click(); 'run'`);
    for (let i = 0; i < 300; i++) {
      const done = await cdp.eval(`(function(){
        var as = window.__S.assets;
        return as.length > 0 && as.every(function(a){ return ['done','failed','skipped'].indexOf(a.status) >= 0; });
      })()`);
      if (done) break;
      await sleep(300);
    }
    await sleep(600);

    console.log('[5/6] 切到待核对：行动队列');
    await cdp.eval(`document.querySelector('#btn-review').click(); 'ok'`);
    await sleep(500);
    const after = await cdp.eval(`(function(){
      var q = document.querySelector('#action-queue');
      return {
        queueHidden: q ? q.hidden : true,
        queueText: q ? q.innerText.trim() : '',
        queueItems: q ? Array.prototype.map.call(q.querySelectorAll('[data-action-ind]'), function (el) {
          return el.getAttribute('data-ind') || el.getAttribute('data-action-ind');
        }) : [],
        assets: window.__S.assets.map(function (a) { return { type: a.docType || '', status: a.status }; }),
        usage: window.Model.getUsage()
      };
    })()`);

    console.log('   报告类型：' + JSON.stringify(after.assets));
    console.log('   行动队列：' + (after.queueHidden ? '(隐藏)' : after.queueText.split('\n').join(' / ')));
    console.log('   队列项：' + JSON.stringify(after.queueItems));

    want(after.queueHidden === false, '有待核对项时行动队列应出现');
    want(after.queueItems.length === 2, '队列应有 2 项（姓名、血红蛋白），实际 ' + after.queueItems.length);
    want(after.queueItems.includes('NAME') && after.queueItems.includes('HGB'),
      '队列应列出 NAME 与 HGB，实际 ' + JSON.stringify(after.queueItems));
    want(/还有 2 项需要处理/.test(after.queueText), '队列标题应写"还有 2 项需要处理"');

    const queueShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-task-queue.png'), Buffer.from(queueShot.data, 'base64'));
    console.log('   截图：docs/figs/ui-task-queue.png');

    console.log('[6/6] 点队列第一条，应打开核对详情');
    await cdp.eval(`(function(){
      var el = document.querySelector('#action-queue [data-action-ind]');
      if (el) el.click();
      return 'ok';
    })()`);
    await sleep(600);
    const inspector = await cdp.eval(`(function(){
      var box = document.querySelector('#inspector');
      return { hidden: box ? box.hidden : true, text: box ? box.innerText.slice(0, 60) : '' };
    })()`);
    console.log('   检查器：' + JSON.stringify(inspector));
    want(inspector.hidden === false, '点击队列项应打开右侧核对详情');

    console.log('   再切到全部结果，核对整表');
    await cdp.eval(`document.querySelector('#btn-results-all').click(); 'ok'`);
    await sleep(600);
    const table = await cdp.eval(`(function(){
      var rows = {};
      document.querySelectorAll('#grid-body tr[data-ind]').forEach(function (tr) {
        rows[tr.getAttribute('data-ind')] = (tr.className || '').split(' ')[0];
      });
      return { rowCount: Object.keys(rows).length, rows: rows };
    })()`);
    console.log('   表格行数：' + table.rowCount + '（应为 29：14+10+5）');
    console.log('   NAME=' + table.rows.NAME + '  HGB=' + table.rows.HGB + '  CREA=' + table.rows.CREA +
      '  UA=' + table.rows.UA + '  ALT=' + table.rows.ALT);

    want(table.rowCount === 29, '结果表应只含任务选中的 29 项，实际 ' + table.rowCount);
    want(!table.rows.ALT, '未选页面（肝功能）的指标不应出现在表里');
    want(table.rows.NAME === 'missing', '没传病案首页，必填的姓名应标红（实际 ' + table.rows.NAME + '）');
    want(table.rows.HGB === 'missing', '血常规里血红蛋白印的是「—」，必填项应标红（实际 ' + table.rows.HGB + '）');
    want(table.rows.CREA === 'ok', '肌酐在生化里读到了，应正常（实际 ' + table.rows.CREA + '）');
    want(table.rows.UA === 'absent', '尿酸没要求必填、报告里也没有，应显示「未提供」（实际 ' + table.rows.UA + '）');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-task-driven.png'), Buffer.from(shot.data, 'base64'));
    console.log('   截图：docs/figs/ui-task-driven.png');
    console.log('[7/7] 导出 CSV（冷启动演示的最后一步）');
    await cdp.eval(`document.querySelector('#btn-export').click(); 'ok'`);
    await sleep(600);
    // 还有待核对项时会先弹一个对话框（现场正好可以讲"它不会拦着你导出，但要告诉你")
    const dialog = await cdp.eval(`(function(){
      var d = document.querySelector('#export-dialog');
      return { open: !!(d && d.open), text: d ? (document.querySelector('#export-message').textContent || '') : '' };
    })()`);
    console.log('   导出确认框：' + JSON.stringify(dialog));
    if (dialog.open) {
      await cdp.eval(`document.querySelector('#btn-confirm-export').click(); 'ok'`);
      await sleep(600);
    }
    const exported = await cdp.eval(`(function(){ var t = document.body.innerText; return { hasToast: /已导出/.test(t) }; })()`);
    console.log('   导出提示：' + JSON.stringify(exported));
    want(exported.hasToast, '点「导出 CSV」后应有导出提示');
    const exportShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-demo-export.png'), Buffer.from(exportShot.data, 'base64'));
    console.log('   截图：docs/figs/ui-demo-export.png');

    const usage1 = after.usage;
    want(usage1.calls > usage0.calls, '识别应产生真实模型调用');
    want(cdp.errors.length === 0, '页面不应有未捕获异常：' + cdp.errors.slice(0, 2).join(' | '));

    console.log('\n结果：' + (problems.length ? '不通过' : '通过'));
    problems.forEach((p) => console.log(' [!] ' + p));
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
