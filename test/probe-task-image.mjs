/**
 * 一句话质控任务：贴图 + 人工改 + 另存为页面组。
 *
 * 真浏览器 + 真模型（secrets/ark_api.txt），验证四件事：
 *   1. 只贴一张血常规照片、不写字，模型也能选出页面；
 *   2. 预览里的页面/必填可以人工增删；
 *   3. 确认后 selected 就是改过的这份，不是模型原始输出；
 *   4. 勾"另存为页面组"能把这份配置存成一个新组。
 *
 * 用法：node test/probe-task-image.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9377;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const IMAGE = join(process.cwd(), 'app', 'test', 'samples', 'demo', 'A-02-cbc-20261105.jpg');
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
const want = (cond, msg) => { if (!cond) problems.push(msg); };

function readKey() {
  try {
    return readFileSync(join(process.cwd(), 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
  } catch { return ''; }
}

async function main() {
  const key = readKey();
  if (!key) {
    console.log('[skip] 缺少 secrets/ark_api.txt，本次未重新实测模型准确率（退出码 2 表示跳过，不是通过）');
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-taskimg-'));
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

    console.log('[1/5] 写入 Key，清空本批规则');
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

    console.log('[2/5] 打开任务框，贴一张血常规照片（不写字）');
    await cdp.eval(`document.querySelector('#btn-rules').click(); 'ok'`);
    await sleep(250);
    await cdp.eval(`document.querySelector('#btn-task-ai').click(); 'ok'`);
    await sleep(250);

    const b64 = readFileSync(IMAGE).toString('base64');
    await cdp.eval(`
      (function(b64, name){
        var bin = atob(b64), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var file = new File([arr], name, { type: 'image/jpeg' });
        var dt = new DataTransfer();
        dt.items.add(file);
        var input = document.querySelector('#task-file');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'dropped';
      })(${JSON.stringify(b64)}, 'A-02-cbc-20261105.jpg')
    `);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval(`!document.querySelector('#task-attach').hidden`)) break;
      await sleep(100);
    }
    const attach = await cdp.eval(`
      (function(){
        var box = document.querySelector('#task-attach');
        return {
          visible: !box.hidden,
          thumb: !!box.querySelector('img.task-attach-thumb'),
          name: (box.querySelector('.task-attach-meta') || {}).textContent || ''
        };
      })()
    `);
    console.log('  附件：', JSON.stringify(attach));
    want(attach.visible && attach.thumb, '贴上图片后应显示缩略图');

    console.log('[3/5] 生成配置（只有图，没有文字要求）');
    await cdp.eval(`document.querySelector('#btn-task-generate').click(); 'ok'`);
    let preview = null;
    for (let i = 0; i < 240; i++) {
      const state = await cdp.eval(`
        (function(){
          var p = document.querySelector('#task-preview');
          var btn = document.querySelector('#btn-task-apply');
          var gen = document.querySelector('#btn-task-generate');
          var pages = [].map.call(document.querySelectorAll('.tp-page input:checked'), function (x) { return x.value; });
          var reqs = [].map.call(document.querySelectorAll('.tp-req input:checked'), function (x) { return x.value; });
          return {
            text: p ? p.innerText.trim() : '',
            applyEnabled: btn ? !btn.disabled : false,
            busy: gen ? gen.disabled : false,
            failed: !!(p && p.querySelector('.task-error')),
            pages: pages, reqs: reqs
          };
        })()
      `);
      if (state.failed) { console.log('  模型报错：', state.text.slice(0, 200)); preview = state; break; }
      if (!state.busy && (state.applyEnabled || state.pages.length)) { preview = state; break; }
      await sleep(300);
    }
    if (!preview || preview.failed) {
      console.log('  预览：', preview && preview.text);
      problems.push('贴图生成失败');
      throw new Error('贴图生成失败');
    }
    console.log('  模型选的页面：', JSON.stringify(preview.pages));
    console.log('  模型选的必填：', JSON.stringify(preview.reqs));
    console.log('  耗时/摘要：', preview.text.split('\n').slice(0, 3).join(' / '));
    want(preview.pages.length > 0, '贴图后应至少选出一个页面');
    want(preview.pages.includes('cbc'), '血常规照片应选到 cbc 页面，实际：' + preview.pages.join(','));
    want(preview.text.includes('整理页面'), '预览应出现可编辑的页面清单');

    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'figs', 'ui-task-image.png'), Buffer.from(shot1.data, 'base64'));
    console.log('  截图：docs/figs/ui-task-image.png');
    console.log('[4/5] 人工修改：加一个页面、去掉一个必填');
    const edited = await cdp.eval(`
      (function(){
        var pages = [].slice.call(document.querySelectorAll('.tp-page input'));
        var addedPage = null;
        for (var i = 0; i < pages.length; i++) {
          if (!pages[i].checked) { pages[i].click(); addedPage = pages[i].value; break; }
        }
        var reqs = [].slice.call(document.querySelectorAll('.tp-req input'));
        var removedReq = null, addedReq = null;
        for (var j = 0; j < reqs.length; j++) {
          if (reqs[j].checked) { removedReq = reqs[j].value; reqs[j].click(); break; }
        }
        if (!removedReq) {
          var after = [].slice.call(document.querySelectorAll('.tp-req input'));
          for (var k = 0; k < after.length; k++) {
            if (!after[k].checked) { addedReq = after[k].value; after[k].click(); break; }
          }
        }
        var checkedPages = [].map.call(document.querySelectorAll('.tp-page input:checked'), function (x) { return x.value; });
        var checkedReqs = [].map.call(document.querySelectorAll('.tp-req input:checked'), function (x) { return x.value; });
        return { addedPage: addedPage, removedReq: removedReq, addedReq: addedReq, pages: checkedPages, reqs: checkedReqs };
      })()
    `);
    console.log('  改后：', JSON.stringify(edited));
    want(!!edited.addedPage, '预览里应能增加页面');
    want(!!edited.removedReq || !!edited.addedReq, '预览里应能改必填项');

    console.log('[5/5] 勾"另存为页面组"→ 确认');
    const groupName = '图像任务测试';
    const applied = await cdp.eval(`
      (function(name){
        var box = document.querySelector('#task-save-group');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        var input = document.querySelector('#task-group-name');
        input.value = name;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btn-task-apply').click();
        return 'clicked';
      })(${JSON.stringify(groupName)})
    `);
    await sleep(900);
    const after = await cdp.eval(`
      (function(){
        var raw = localStorage.getItem('jiaowolu.selectedPages.v4');
        var groups = (window.Library && typeof window.Library.groups === 'function') ? window.Library.groups() : [];
        var mine = groups.filter(function (g) { return g.name === ${JSON.stringify(groupName)}; })[0] || null;
        return {
          selected: raw ? JSON.parse(raw) : null,
          summary: (document.querySelector('#rule-summary') || {}).textContent || '',
          group: mine ? { name: mine.name, pageIds: mine.pageIds.slice(), reqIds: mine.reqIds.slice() } : null
        };
      })()
    `);
    console.log('  应用结果：', JSON.stringify(after.selected));
    console.log('  顶部摘要：', String(after.summary).trim());
    console.log('  新页面组：', after.group ? JSON.stringify({ pages: after.group.pageIds, reqs: after.group.reqIds.length }) : '无');

    want(applied === 'clicked', '确认按钮应可点击');
    const sameSet = (a, b) => JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
    want(after.selected && sameSet(after.selected.ids, edited.pages),
      `应用后的页面应是人工改过的那份，期望 ${JSON.stringify(edited.pages)}，实际 ${JSON.stringify(after.selected && after.selected.ids)}`);
    const addSet = new Set((after.selected && after.selected.add) || []);
    want(edited.reqs.every((id) => addSet.has(id)),
      `人工勾的必填应出现在 add 里，期望包含 ${edited.reqs.join(',')}，实际 ${Array.from(addSet).join(',')}`);
    want(after.group && sameSet(after.group.pageIds, edited.pages),
      '另存的页面组应与应用后的页面一致');
    want(after.group && after.group.reqIds.length === edited.reqs.length,
      '另存的页面组必填数量应与预览一致');

    const errors = await cdp.eval('window.__S ? "ok" : "no"');
    want(errors === 'ok', '页面状态应正常');
    if (cdp.errors.length) console.log('  页面异常：', cdp.errors.slice(0, 3));
    want(cdp.errors.length === 0, '页面不应有未捕获异常');
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (problems.length) {
    console.log('\n不通过：');
    problems.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  }
  console.log('\n通过：贴图能生成配置，人工改动生效，另存的页面组与预览一致。');
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
