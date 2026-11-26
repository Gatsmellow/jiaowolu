/**
 * 一句话质控任务：真实模型端到端验收。
 *
 * 必须用真实 Key（secrets/ark_api.txt），走真浏览器、真模型：
 *   规则对话框 → 「一句话生成质控任务」→ 输入 → 真模型返回 → 预览 → 确认 → 规则真的变了 → 刷新后还在。
 * 另含"取消不改变原规则"与三条验收用例（明确／必填可选混合／越界要求）。
 *
 * 用法：node test/probe-task.mjs            跑用例 1 并应用 + 刷新校验
 *       node test/probe-task.mjs --all      三条用例都跑（只预览，最后不用例 3 的结果覆盖规则）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9370;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN_ALL = process.argv.includes('--all');

const CASES = [
  {
    name: '用例1 明确可校验',
    text: '本次整理病案首页、血常规和肾功能；姓名、血红蛋白、肌酐为必填，其他指标有就整理。',
    expectPages: ['course', 'cbc', 'renal'],
    expectRequired: ['NAME', 'HGB', 'CREA']
  },
  {
    name: '用例2 必填与可选混合',
    text: '整理血常规和出凝血，血红蛋白、白细胞计数和血小板计数必填，出凝血有结果就整理，没有不算缺失。',
    expectPages: ['cbc', 'coag'],
    expectRequired: ['HGB', 'WBC', 'PLT']
  },
  {
    name: '用例3 含越界要求',
    text: '整理血常规，血红蛋白必填，并自动判断患者是否患有白血病、给出治疗建议。',
    expectPages: ['cbc'],
    expectRequired: ['HGB'],
    expectUnmatched: true
  }
];

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

const problems = [];
function want(cond, msg) { if (!cond) problems.push(msg); }

function readKey() {
  try {
    const raw = readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim();
    return raw.split(/\r?\n/)[0].trim();
  } catch { return ''; }
}

async function openTaskDialog(cdp) {
  await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#btn-task-ai').click(); 'ok'`);
  await sleep(300);
}

async function generate(cdp, text) {
  await cdp.eval(`
    (function(){
      var t = document.querySelector('#task-requirement');
      t.value = ${JSON.stringify(text)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-task-generate').click();
      return 'clicked';
    })()
  `);
  const started = Date.now();
  for (let i = 0; i < 240; i++) {
    const state = await cdp.eval(`
      (function(){
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
    if (state.failed) return { ...state, ms: Date.now() - started };
    if (!state.busy && (state.applyEnabled || state.text.includes('配置预览'))) {
      return { ...state, ms: Date.now() - started };
    }
    await sleep(300);
  }
  throw new Error('等待模型返回超时（120 秒）');
}

function parsePreview(text) {
  // 预览里只有名称，没有 id；用名称反查 id 留给断言阶段
  return String(text || '');
}

async function main() {
  const key = readKey();
  if (!key) {
    console.log('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（不是通过）');
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-task-'));
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

    console.log('[1/6] 写入 Key 与视图，清掉本批规则');
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
    await sleep(1500);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object" && !!document.querySelector("#btn-task-ai")')) break;
      await sleep(200);
    }

    const before = await cdp.eval(`localStorage.getItem('jiaowolu.selectedPages.v4')`);
    const usage0 = await cdp.eval(`JSON.stringify(window.Model.getUsage())`);

    console.log('[2/6] 打开规则 → 一句话任务 → 准备阶段不应可应用');
    await openTaskDialog(cdp);
    const initialApply = await cdp.eval(`document.querySelector('#btn-task-apply').disabled`);
    want(initialApply === true, '打开任务对话框时「确认并替换本批规则」应是禁用的');
    console.log('   初始 apply.disabled =', initialApply);

    const cases = RUN_ALL ? CASES : [CASES[0]];
    let applied = false;
    for (const c of cases) {
      console.log(`\n[3/6] ${c.name}`);
      console.log('   输入：' + c.text);
      const res = await generate(cdp, c.text);
      console.log('   耗时 ' + res.ms + ' ms');
      console.log('   ---- 预览 ----');
      console.log(res.text.split('\n').map((l) => '   ' + l).join('\n'));
      if (res.failed) {
        want(false, `${c.name}：模型/配置失败 → ${res.text.split('\n')[0]}`);
        continue;
      }
      want(res.applyEnabled, `${c.name}：返回后「确认」按钮应可用`);
      for (const id of c.expectPages) {
        const hit = res.text.includes(await nameOf(cdp, 'page', id));
        want(hit, `${c.name}：预览里应包含页面 ${id}`);
      }
      for (const id of c.expectRequired) {
        const hit = res.text.includes(await nameOf(cdp, 'indicator', id));
        want(hit, `${c.name}：预览里应包含必填 ${id}`);
      }
      if (c.expectUnmatched) {
        want(/白血病|治疗建议|未自动落实/.test(res.text), `${c.name}：越界要求应出现在未自动落实里`);
      }
    }

    console.log('\n[4/6] 用例 1 的配置：先取消，确认原规则没动');
    await cdp.eval(`document.querySelector('[data-close-task]').click(); 'ok'`);
    await sleep(300);
    const afterCancel = await cdp.eval(`localStorage.getItem('jiaowolu.selectedPages.v4')`);
    want(afterCancel === before, '取消后 selected 不应变化');
    console.log('   取消后 selected 与之前一致：' + (afterCancel === before));

    console.log('[5/6] 重新生成用例 1 并确认应用');
    await openTaskDialog(cdp);
    const res1 = await generate(cdp, CASES[0].text);
    want(res1.applyEnabled, '用例1 重新生成后应可应用');
    if (!res1.applyEnabled) throw new Error('用例1 没拿到可应用的预览，后续跳过');
    await cdp.eval(`document.querySelector('#btn-task-apply').click(); 'ok'`);
    await sleep(900);

    const appliedState = await cdp.eval(`
      (function(){
        var raw = localStorage.getItem('jiaowolu.selectedPages.v4');
        return {
          raw: raw,
          summary: (document.querySelector('#rule-summary') || {}).textContent || '',
          dialogOpen: document.querySelector('#task-dialog').open
        };
      })()
    `);
    console.log('   写入的 selected：' + appliedState.raw);
    console.log('   顶部规则摘要：' + appliedState.summary.trim());
    const sel = JSON.parse(appliedState.raw || '{}');
    const ids = sel.ids || [];
    const add = sel.add || [];
    want(ids.includes('course') && ids.includes('cbc') && ids.includes('renal'), '应用后页面应包含 course/cbc/renal');
    want(add.includes('NAME') && add.includes('HGB') && add.includes('CREA'), '应用后必填应包含 NAME/HGB/CREA');
    want(!add.includes('UA'), '用例1 没要求尿酸必填，不应加进必填');
    want(!appliedState.dialogOpen, '应用后任务对话框应关闭');
    applied = ids.length > 0;

    const usage1 = JSON.parse(await cdp.eval(`JSON.stringify(window.Model.getUsage())`));
    console.log('   模型用量（应用后、刷新前）：' + JSON.stringify(usage1));
    want(usage1.calls > JSON.parse(usage0).calls, '应产生真实模型调用');

    console.log('[6/6] 刷新后配置是否还在');
    await cdp.send('Page.reload');
    await sleep(1800);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('typeof window.__S === "object"')) break;
      await sleep(200);
    }
    const afterReload = await cdp.eval(`
      (function(){
        var raw = localStorage.getItem('jiaowolu.selectedPages.v4');
        var sel = JSON.parse(raw || '{}');
        var summary = (document.querySelector('#rule-summary') || {}).textContent || '';
        var checkedPages = Array.prototype.filter.call(
          document.querySelectorAll('#page-checks .pc-use'),
          function (el) { return el.checked; }
        ).map(function (el) { return el.value; });
        return { ids: sel.ids || [], add: sel.add || [], summary: summary.trim(),
                 checkedPages: checkedPages,
                 target: window.__S && window.__S.currentId ? window.__targetIds() : null };
      })()
    `);
    console.log('   刷新后 selected.ids =', JSON.stringify(afterReload.ids));
    console.log('   刷新后 selected.add =', JSON.stringify(afterReload.add));
    console.log('   刷新后勾选页面数 =', afterReload.checkedPages.length);
    console.log('   刷新后规则摘要 =', afterReload.summary);
    console.log('   本次任务目标指标数 =', afterReload.target ? afterReload.target.length : '(未取到)');
    want(afterReload.ids.length === ids.length, '刷新后页面配置应保持不变');
    want((afterReload.add || []).length === add.length, '刷新后必填配置应保持不变');
    want(afterReload.checkedPages.length === ids.length, '刷新后页面勾选应与配置一致');



    const leaks = cdp.console.filter((line) => line.includes(key.slice(0, 8)));
    want(leaks.length === 0, '控制台不应出现 Key 片段');
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

async function nameOf(cdp, kind, id) {
  return cdp.eval(kind === 'page'
    ? `(window.Library.pageById(${JSON.stringify(id)}) || {}).name || ${JSON.stringify(id)}`
    : `(window.Library.byId(${JSON.stringify(id)}) || {}).name || ${JSON.stringify(id)}`);
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
