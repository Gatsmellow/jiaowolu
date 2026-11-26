/**
 * 断线自愈测试：把本地服务杀掉，看页面会不会自己发现、服务恢复后能不能自己回来。
 *
 * 这条测试针对的就是"放一会儿不动就断连"那个抱怨：
 * 页面和本地服务之间没有长连接，浏览器不会告诉你服务没了，
 * 所以必须靠心跳（/__ping）自己发现。
 *
 * 用法：node test/e2e-net.mjs
 * 需要：本机装有 Chrome；8765 端口上没有别的服务（脚本会自己起、自己杀）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.JW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const SRV = Number(process.env.JW_TEST_PORT || 8799); // 不碰 8765：用户可能正开着自己的窗口
const APP = `http://127.0.0.1:${SRV}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const p = spawn('python', ['server.py', '--port', String(SRV), '--dir', join(ROOT, 'app')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore'
  });
  p.unref();
  return p;
}

function killServer() {
  spawnSync('powershell', ['-NoProfile', '-Command',
    `$c=Get-NetTCPConnection -LocalPort ${SRV} -State Listen -ErrorAction SilentlyContinue; ` +
    '$c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'
  ], { stdio: 'ignore' });
}

function serverAlive() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `try{$c=New-Object Net.Sockets.TcpClient;$c.Connect("127.0.0.1",${SRV});$c.Close();"1"}catch{"0"}`
  ], { encoding: 'utf8' });
  return (r.stdout || '').trim() === '1';
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
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  async waitForLoad(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval('document.readyState') === 'complete') return;
      await sleep(120);
    }
    throw new Error('页面加载超时');
  }
}

async function waitBar(cdp, wantVisible, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const visible = await cdp.eval("!document.getElementById('offline-bar').hidden");
    if (visible === wantVisible) return Date.now() - t0;
    await sleep(400);
  }
  return -1;
}

async function main() {
  // 这个测试要独占一个端口：它会故意把服务杀掉再拉起来
  if (serverAlive()) {
    console.error(`[!] ${SRV} 上已经有服务在跑。换个端口：$env:JW_TEST_PORT=8798; node test/e2e-net.mjs`);
    process.exit(2);
  }

  let server = startServer();
  await sleep(1500);
  console.log('服务已起：' + (serverAlive() ? 'ok' : '失败'));

  const profile = mkdtempSync(join(tmpdir(), 'jiaowolu-net-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* 还没起来 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('连不上 Chrome 调试端口');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await cdp.send('Page.navigate', { url: APP });
    await cdp.waitForLoad();
    await sleep(2500);

    const ping = await cdp.eval("fetch('./__ping',{cache:'no-store'}).then(r=>r.json()).then(j=>j.ok).catch(()=>false)");
    const hidden = await cdp.eval("document.getElementById('offline-bar').hidden");
    console.log(`[1] 心跳 ${ping ? '通' : '不通'}；断线提示${hidden ? '未出现' : '出现了'}（预期：通 / 未出现）`);
    if (!ping || !hidden) throw new Error('起始状态就不对');

    console.log('[2] 杀掉本地服务，等页面自己发现…');
    killServer();
    await sleep(800);
    const t1 = await waitBar(cdp, true, 20000);
    console.log(`    ${t1 >= 0 ? `${(t1 / 1000).toFixed(1)}s 后出现了断线提示` : '20 秒内没发现（心跳没起作用）'}`);
    if (t1 < 0) throw new Error('心跳没有检测到断线');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'figs', 'ui-offline.png'), Buffer.from(shot.data, 'base64'));
    console.log('    已保存 docs/figs/ui-offline.png');

    console.log('[3] 重新起服务，等页面自己恢复…');
    server = startServer();
    const t2 = await waitBar(cdp, false, 25000);
    console.log(`    ${t2 >= 0 ? `${(t2 / 1000).toFixed(1)}s 后提示自动消失了` : '25 秒内没恢复'}`);
    if (t2 < 0) throw new Error('服务恢复后页面没有自动恢复');

    console.log('\n通过：断线被发现，恢复后被自动确认。');
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    killServer();
  }
}

main().catch((e) => {
  console.error('[x] ' + e.message);
  process.exitCode = 1;
});
