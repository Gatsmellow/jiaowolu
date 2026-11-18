/**
 * 术语对齐的对抗测试：故意喂一堆"看起来像、其实是另一个东西"的项目名，
 * 看匹配引擎会不会把 A 认成 B。
 *
 * 这个测试不需要调模型 —— 匹配是纯本地逻辑。
 * 判定标准只有一条：**宁可能对不上（返回 null），也不能对错**。
 * 对不上，表格会显示"未识别/必填缺失"，人一眼就看见；
 * 对错了，表格显示绿色，没有人会去查。
 *
 * 用法：node test/probe-match.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const APP = process.env.JW_APP || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [报告上写的名字, 模型给的代号, 报告上的单位, 期望结果]
// 期望 null = 必须拒绝（认不出或认得不准，都不许填）
const CASES = [
  // —— 子串陷阱：A 的名字里含着 B ——
  ['APTT', '', 's', 'APTT'],
  ['PT', '', 's', 'PT'],
  ['TT', '', 's', 'TT'],
  ['FIB', '', 'g/L', 'FIB'],
  ['FIB-4', '', '', null],          // 肝纤维化指数，不是纤维蛋白原
  ['D-二聚体', '', 'mg/L', 'DDIMER'],
  ['CA125', '', 'U/mL', null],      // 肿瘤标志物，不是血钙
  ['氨基转移酶', '', 'U/L', null],   // ALT 和 AST 都叫"氨基转移酶"，必须拒绝
  ['hs-CRP', '', 'mg/L', null],     // 超敏 CRP，不是普通 CRP

  // —— 方法学后缀：该剥掉，剥掉后要认得出 ——
  ['肌酐（酶法）', '', 'μmol/L', 'CREA'],
  ['△肌酐（酶法）', '', 'μmol/L', 'CREA'],
  ['葡萄糖(干化学)', '', 'mmol/L', 'GLU'],
  ['钾离子测定', '', 'mmol/L', 'K'],

  // —— 正常别名：必须认得出 ——
  ['白细胞计数 (WBC)', '', '10^9/L', 'WBC'],
  ['谷丙转氨酶', '', 'U/L', 'ALT'],
  ['丙氨酸氨基转移酶', '', 'U/L', 'ALT'],
  ['天冬氨酸氨基转移酶', '', 'U/L', 'AST'],
  ['空腹血糖', '', 'mmol/L', 'GLU'],
  ['尿酸', '', 'μmol/L', 'UA'],
  ['肌酐', '', 'μmol/L', 'CREA'],

  // —— 量纲陷阱：名字对，单位不对，也不许盲目认 ——
  ['钙', '', 'mg/dL', 'CA'],        // 认得出，但单位要换算 → 会标成存疑
  ['钙', '', 'mmol/L', 'CA'],

  // —— 模型给了代号，但单位对不上 ——
  ['某个看不懂的名字', 'CA', 'U/mL', null]
];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-match-'));
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
      if (await cdp.eval('document.readyState === "complete" && typeof window.Library === "object"')) break;
      await sleep(200);
    }

    const got = await cdp.eval(`(${JSON.stringify(CASES)}).map(function (c) {
      var h = window.Library.match(c[0], c[1] || undefined, c[2] || undefined);
      return h ? h.id : null;
    })`);

    let bad = 0;
    console.log('');
    console.log('报告原文'.padEnd(22) + '单位'.padEnd(10) + '期望'.padEnd(9) + '实际');
    console.log('-'.repeat(58));
    CASES.forEach((c, i) => {
      const want = c[3];
      const have = got[i];
      const ok = want === have;
      if (!ok) bad++;
      console.log(
        String(c[0]).padEnd(22 - (c[0].length - c[0].replace(/[^\x00-\xff]/g, '').length) / 2) +
        String(c[2] || '—').padEnd(10) +
        String(want === null ? '拒绝' : want).padEnd(9) +
        (have === null ? '拒绝' : have) + (ok ? '' : '   ← 不符')
      );
    });
    console.log('-'.repeat(58));
    if (bad) {
      console.log(`\n不通过：${bad}/${CASES.length} 条对不上。错配比漏配危险，必须修。`);
      process.exitCode = 1;
    } else {
      console.log(`\n通过：${CASES.length} 条全部符合预期——该认的认出来，该拒的都拒绝了。`);
    }
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    chrome.kill();
  }
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
