/**
 * 「同一份叙述里读到多个值」的验证：不能静默挑一个，要标出来让人挑。
 *
 * 做法：注入一份叙述型报告 + 同一指标在同一份报告里的两个不同值，
 * 断言表格标成"同一页多个值"、行动队列提示、检查器里能选、选完落到 OK 且只影响这一天。
 *
 * 不联网、不调用模型。用法：node test/probe-multi.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9379;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-multi-'));
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

    console.log('[1] 准备：清空、注入一份叙述报告与同页两个不同值');
    const setup = await cdp.eval(`(function () {
      localStorage.clear(); localStorage.setItem('jiaowolu.startView', 'all');
      var S = window.__S;
      S.patients = [{ id: 'p1', code: '患者 01' }];
      S.currentId = 'p1';
      S.assets = [{
        id: 'a1', patientId: 'p1', kind: 'image', name: '出院记录.jpg', fileIndex: 1, pageNo: 1,
        dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        width: 800, height: 600, lowRes: false, status: 'done', docType: '出院小结', reportType: '出院小结',
        reportDate: '2026-07-21', sentIds: []
      }];
      S.observations = [
        { id: 'o1', patientId: 'p1', assetId: 'a1', indicatorId: 'WBC', rawName: '白细胞计数', value: '5.65', unit: '10^9/L', date: '2026-07-21', confidence: 0.9, method: 'text-model', src: 'narrative' },
        { id: 'o2', patientId: 'p1', assetId: 'a1', indicatorId: 'WBC', rawName: '白细胞计数', value: '12.38', unit: '10^9/L', date: '2026-07-21', confidence: 0.85, method: 'text-model', src: 'narrative' },
        { id: 'o3', patientId: 'p1', assetId: 'a1', indicatorId: 'HGB', rawName: '血红蛋白', value: '98', unit: 'g/L', date: '2026-07-21', confidence: 0.9, method: 'text-model', src: 'narrative' }
      ];
      S.seq = { asset: 9, obs: 9, patient: 9, review: 0, event: 0 };
      S.running = false;
      // 注入之后必须触发一次完整重绘：点一下"待核对"标签
      document.querySelector('#btn-review').click();
      return S.observations.length;
    })()`);
    await sleep(500);
    want(setup === 3, '注入的观测值不是 3 条');

    console.log('[2] 检查行动队列的说明文字（待核对视图）');
    const queue = await cdp.eval(`(function () {
      var q = document.querySelector('#action-queue');
      if (!q || q.hidden) return null;
      var item = q.querySelector('[data-action-ind="WBC"]');
      return item ? item.textContent : null;
    })()`);
    console.log('   行动队列：', queue);
    want(queue && queue.indexOf('取值不一致') >= 0, '行动队列没有说明"取值不一致"');

    console.log('[3] 切到全部结果，检查表格上的标记');
    await cdp.eval(`(function () { document.querySelector('#btn-results-all').click(); return 'ok'; })()`);
    await sleep(500);
    const row = await cdp.eval(`(function () {
      var tr = document.querySelector('#grid-body tr[data-ind="WBC"]');
      if (!tr) return null;
      return {
        cls: tr.className,
        badge: (tr.querySelector('.badge') || {}).textContent || '',
        value: (tr.querySelector('.val-input') || {}).value || ''
      };
    })()`);
    console.log('   WBC 行：', JSON.stringify(row));
    want(row && /low/.test(row.cls), 'WBC 行没有标成需要确认（low）');
    want(row && row.badge === '同一页多个值', 'WBC 行的标记不是「同一页多个值」，实际是 ' + (row && row.badge));

    console.log('[4] 打开检查器，确认能看到两处来源并选第二处');
    await cdp.eval(`(function () {
      var tr = document.querySelector('#grid-body tr[data-ind="WBC"]');
      tr.querySelector('.src-link').click();
      return 'opened';
    })()`);
    await sleep(400);
    const choices = await cdp.eval(`(function () {
      return Array.prototype.map.call(document.querySelectorAll('.source-choice'), function (b) {
        return b.textContent.replace(/\\s+/g, ' ').trim();
      });
    })()`);
    console.log('   来源选项：', JSON.stringify(choices));
    want(choices.length === 2, '检查器里应该有两处来源，实际 ' + choices.length);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-multi-value.png'), Buffer.from(shot.data, 'base64'));
    console.log('   截图：docs/figs/ui-multi-value.png');

    const picked = await cdp.eval(`(function () {
      var btns = Array.prototype.slice.call(document.querySelectorAll('.source-choice'));
      // 故意选"不是默认那个"的一处，按钮文案应该是「以这一处为准」
      var first = btns.find(function (b) { return /5\\.65/.test(b.textContent); }) || btns[0];
      first.click();
      return first.textContent.replace(/\\s+/g, ' ').trim();
    })()`);
    await sleep(300);
    const pickBtn = await cdp.eval(`(function () {
      var b = document.querySelector('[data-pick]');
      if (!b) return null;
      var t = b.textContent.trim();
      b.click();
      return t;
    })()`);
    console.log('   选中：', picked, '按钮：', pickBtn);
    want(pickBtn === '以这一处为准', '选另一处时按钮文案应是「以这一处为准」，实际 ' + pickBtn);
    await sleep(500);

    console.log('[5] 裁决后的状态');
    const after = await cdp.eval(`(function () {
      var S = window.__S;
      var wbc = S.observations.filter(function (o) { return o.indicatorId === 'WBC'; });
      var tr = document.querySelector('#grid-body tr[data-ind="WBC"]');
      return {
        count: wbc.length,
        value: wbc[0] && wbc[0].value,
        method: wbc[0] && wbc[0].method,
        cls: tr && tr.className,
        badge: tr && (tr.querySelector('.badge') || {}).textContent,
        input: tr && (tr.querySelector('.val-input') || {}).value
      };
    })()`);
    console.log('   ', JSON.stringify(after));
    want(after.count === 1, '裁决后 WBC 应只剩 1 条观测值，实际 ' + after.count);
    want(after.value === '5.65', '裁决后应保留选中的 5.65，实际 ' + after.value);
    want(after.method === 'manual', '裁决后的方法应是 manual，实际 ' + after.method);
    want(/ok/.test(after.cls), '裁决后这一行应变回已识别，实际 ' + after.cls);

    console.log('[6] 其它指标不受影响');
    const hgb = await cdp.eval(`(function () {
      var tr = document.querySelector('#grid-body tr[data-ind="HGB"]');
      return tr ? tr.className : null;
    })()`);
    want(hgb && /ok/.test(hgb), '同页的 HGB 不该被连带改动，实际 ' + hgb);

    if (cdp.errors.length) problems.push('页面有异常：' + cdp.errors[0].split('\n')[0]);
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (problems.length) {
    console.log('');
    problems.forEach((p) => console.log('[x] ' + p));
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('通过：同页多值会标出来、能选、裁决只影响这一天这一项。');
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
