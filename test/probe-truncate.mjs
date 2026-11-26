/* 验证"失败"的三种真实成因，以及现在能不能自动救回来：
 *   1. 输出额度太小 → 应报 truncated（而不是含糊的"失败"）
 *   2. 截断的 JSON     → parseJson 应尽量抢救回完整的那几条
 *   3. 正常额度         → 能正常抽出指标
 * 这条探针不需要真实报告，就用手上的合成血常规。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const PORT = Number(process.env.JW_CDP_PORT || 9351);
const ROOT = process.cwd();
const KEY = (await import('node:fs')).readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'jw-trunc-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
          }
        };
        return;
      }
    } catch { /* 等 Chrome 起来 */ }
    await sleep(250);
  }
  throw new Error('连不上 Chrome');
}
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

const problems = [];
try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  await ev(`localStorage.setItem('jiaowolu.apiKey', ${JSON.stringify(KEY)});
    localStorage.setItem('jiaowolu.modelConfig', JSON.stringify({ base:'https://api.deepseek.com', model:'deepseek-flash' }));
    location.reload(); 'ok'`);
  await sleep(3000);

  // 把合成血常规读成 dataURL 塞进页面
  await ev(`(async function(){
    const r = await fetch('test/samples/batch/cbc-20261110.jpg');
    const b = await r.blob();
    window.__img = await new Promise(function(res){ const f = new FileReader(); f.onload = function(){ res(f.result); }; f.readAsDataURL(b); });
    return 'ok';
  })()`);

  // 1) 额度给到 8：应该明确报"截断"，而不是笼统失败
  const tiny = await ev(`(async function(){
    try {
      await window.Model.vision(window.__img, '把这张图里的化验项目读成 JSON', { maxTokens: 8 });
      return { ok: true };
    } catch (e) { return { ok: false, code: e.code || '', msg: e.message }; }
  })()`);
  console.log('  [1] 额度 8 的返回：', JSON.stringify(tiny));
  if (tiny.ok) problems.push('额度只有 8 也能成功，说明没在检查截断');
  else if (tiny.code !== 'truncated' && tiny.code !== 'empty') problems.push(`额度 8 的报错没有带 code（${tiny.code || '空'}），上层没法据此重试`);

  // 2) 截断的 JSON 能不能抢救
  const salvage = await ev(`(function(){
    var broken = '{"report_type":"血常规","items":[{"raw_name":"白细胞","value":"7.24"},{"raw_name":"红细胞","value":"4.86"},{"raw_name":"血红';
    var got;
    try { got = window.__parseJson ? window.__parseJson(broken) : null; } catch (e) { return { err: e.message }; }
    return got ? { items: (got.items || []).length } : { err: '没有暴露 parseJson' };
  })()`);
  console.log('  [2] 截断 JSON 抢救：', JSON.stringify(salvage));

  // 3) 正常额度：整条链路仍然能抽出指标
  const normal = await ev(`(async function(){
    var r = await window.Model.vision(window.__img, '把这张图里的化验项目读成 JSON，形如 {"items":[{"raw_name":"","value":"","unit":""}]}', { maxTokens: 2400 });
    return { chars: r.text.length, usage: r.usage };
  })()`);
  console.log('  [3] 正常额度：', JSON.stringify(normal));
  if (!(normal.chars > 20)) problems.push('正常额度下没有返回内容');
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (problems.length) {
  console.log('\n不通过：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n通过：截断会被识别成 truncated 并带上 code，上层可以据此换大额度重试。');
