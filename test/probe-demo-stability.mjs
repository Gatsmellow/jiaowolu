/**
 * 初评演示句的稳定性检查：干净浏览器里连续跑 3 次。
 *
 * 每次都是全新的 profile（没有上次的 localStorage / IndexedDB），从这里开始：
 *   打开页面 → 本批规则 → 一句话生成质控任务 → 输入演示句 → 真实模型请求
 *   → 预览 → 点「确认并替换本批规则」→ 读回规则
 *
 * 只记录"这句话能不能稳定变成一套可用的规则"，不涉及识别准确率。
 *
 * 用法：node test/probe-demo-stability.mjs
 *      JW_APP 指定页面地址；JW_RUNS 指定次数（默认 3）；缺 Key 时退出码 2。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const RUNS = Number(process.env.JW_RUNS || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 现场要说的那一句（改这里就等于改演示台词）
const SENTENCE =
  '本次整理病案首页、血常规和肾功能；姓名、血红蛋白、肌酐为必填，其他项目有结果就整理。';

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.console = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        this.console.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
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

function readKey() {
  try {
    return readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch { return ''; }
}

async function connect(port) {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* wait */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome 没有起来（端口 ' + port + '）');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { ws, cdp };
}

async function waitReady(cdp, selector) {
  for (let i = 0; i < 80; i++) {
    const ok = await cdp.eval(`typeof window.__S === 'object' && !!document.querySelector(${JSON.stringify(selector)})`);
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

/** 跑一轮，返回 { ok, ms, ids, add, summary, target, error } */
async function oneRun(key, run, port) {
  const profile = mkdtempSync(join(tmpdir(), `jiaowolu-stab-${run}-`));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    const conn = await connect(port);
    ws = conn.ws;
    const cdp = conn.cdp;
    await cdp.send('Page.navigate', { url: APP });
    await waitReady(cdp, '#btn-rules');

    // 全新的浏览器，只写 Key 和起始视图，不写任何规则/缓存
    await cdp.eval(`
      (function (key) {
        localStorage.setItem('jiaowolu.apiKey', key);
        localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base: 'https://api.deepseek.com', model: 'deepseek-flash' }));
        localStorage.setItem('jiaowolu.startView', 'all');
        return {
          selected: localStorage.getItem('jiaowolu.selectedPages.v4'),
          patients: (window.__S && window.__S.patients.length) || 0
        };
      })(${JSON.stringify(key)})
    `);
    await cdp.send('Page.reload');
    await sleep(1200);
    await waitReady(cdp, '#btn-task-ai');

    const clean = await cdp.eval(`
      (function () {
        return {
          selected: localStorage.getItem('jiaowolu.selectedPages.v4'),
          patients: (window.__S && window.__S.patients.length) || 0,
          assets: (window.__S && window.__S.assets.length) || 0
        };
      })()
    `);

    // 打开规则 → 一句话任务
    await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
    await sleep(250);
    await cdp.eval(`document.querySelector('#btn-task-ai').click(); 'ok'`);
    await sleep(250);

    const started = Date.now();
    await cdp.eval(`
      (function () {
        var t = document.querySelector('#task-requirement');
        t.value = ${JSON.stringify(SENTENCE)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btn-task-generate').click();
        return 'clicked';
      })()
    `);

    let state = null;
    for (let i = 0; i < 240; i++) {
      state = await cdp.eval(`
        (function () {
          var p = document.querySelector('#task-preview');
          var btn = document.querySelector('#btn-task-apply');
          var gen = document.querySelector('#btn-task-generate');
          return {
            text: p ? p.innerText.trim() : '',
            applyEnabled: btn ? !btn.disabled : false,
            busy: gen ? gen.disabled : false,
            failed: !!(p && p.querySelector('.task-error'))
          };
        })()
      `);
      if (state.failed) break;
      if (!state.busy && state.applyEnabled) break;
      await sleep(250);
    }
    const ms = Date.now() - started;
    if (state.failed || !state.applyEnabled) {
      return { ok: false, ms, error: (state.text || '没有返回可确认的配置').split('\n')[0], clean };
    }

    // 确认 → 读回规则
    await cdp.eval(`document.querySelector('#btn-task-apply').click(); 'ok'`);
    await sleep(800);
    const after = await cdp.eval(`
      (function () {
        var sel = JSON.parse(localStorage.getItem('jiaowolu.selectedPages.v4') || '{}');
        var summary = (document.querySelector('#rule-summary') || {}).textContent || '';
        return {
          ids: sel.ids || [],
          add: sel.add || [],
          summary: summary.trim(),
          target: window.__targetIds ? window.__targetIds().length : -1,
          preview: ${JSON.stringify(state.text.slice(0, 400))}
        };
      })()
    `);

    const keyLeak = cdp.console.some((line) => line.includes(key.slice(0, 8)));
    if (keyLeak) return { ok: false, ms, error: '控制台出现了 Key 片段', clean };
    if (cdp.errors.length) return { ok: false, ms, error: '页面异常：' + cdp.errors[0].split('\n')[0], clean };

    return { ok: after.ids.length > 0, ms, ...after, clean };
  } catch (e) {
    return { ok: false, ms: 0, error: String(e.message || e) };
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  const key = readKey();
  if (!key) {
    console.log('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）');
    process.exit(2);
  }

  console.log('演示句：' + SENTENCE);
  console.log(`连续 ${RUNS} 次，每次都是全新的浏览器配置（无规则、无患者、无缓存）\n`);

  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    const port = 9372 + i;
    const r = await oneRun(key, i, port);
    results.push(r);
    if (r.ok) {
      console.log(`[run ${i}] 成功 ${r.ms} ms  页面 ${r.ids.length} 个（${r.ids.join(',')}）必填 ${r.add.length} 项  目标指标 ${r.target} 项`);
      console.log(`        摘要：${r.summary}`);
    } else {
      console.log(`[run ${i}] 失败 ${r.ms} ms  ${r.error || ''}`);
    }
    if (i < RUNS) await sleep(600);
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n结果：${okCount}/${RUNS} 次成功`);
  const sameIds = new Set(results.filter((r) => r.ok).map((r) => r.ids.join(','))).size;
  if (okCount === RUNS) {
    console.log(`三次页面集合${sameIds === 1 ? '完全一致' : '不完全一致（' + sameIds + ' 种）'}；这只是配置生成的一致性，不代表识别准确率。`);
  }
  process.exitCode = okCount === RUNS ? 0 : 1;
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
