/**
 * 本地服务：给看板提供「一键同步」。
 *
 * 为什么需要它：浏览器不能直接调官方账单接口——
 *   1. 跨域预检（OPTIONS）会被网关返回 401 且不带 Access-Control-Allow-Origin；
 *   2. JS 无法设置 Origin / Referer（浏览器禁止），也就伪装不了官方 Web 端。
 * 所以「拉数据」这件事必须在 Node 侧完成。
 *
 * 看板页面由本服务提供，页面里的 /api/sync 是同源请求，天然没有跨域问题，
 * 也就不需要用户授权任何目录。
 *
 * 服务本身很薄：收到同步请求就去跑 token-usage-report.js（与双击 bat 完全相同
 * 的那条命令），跑完返回结果摘要，页面再重新加载生成好的数据文件。
 *
 * 零依赖，只用 Node 内置模块。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFile } = require('child_process');

const ROOT = __dirname;
const DEFAULT_PORT = 8099;
const PORT_SCAN_LIMIT = 10;
/** 单次同步的最长等待时间（30 天账单全量拉取实测约 3 秒，给足余量）。 */
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 本地会话目录：服务端有文件系统权限，直接读这两个路径即可，
 * 不需要浏览器再弹目录授权框（那是 file:// 打开时的无奈之举）。
 * 与 token-usage-report.js 里的 SOURCES 保持一致。
 */
const SCAN_DIRS = [
  { name: 'WorkBuddy', dir: path.join(os.homedir(), '.workbuddy', 'projects') },
  { name: 'CodeBuddyCLI', dir: path.join(os.homedir(), '.codebuddy', 'projects') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 同一时间只允许一次同步：重复点击直接拒绝，避免两个脚本抢写数据文件。 */
let syncing = false;

// ---------------------------------------------------------------- 静态文件

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/workbuddy-token.html';

  // 只允许访问本目录内的文件，挡掉 ../ 穿越
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',   // 数据文件必须每次拿最新的
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 同步

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 读取生成好的数据文件里的 meta，用于把「同步到了什么」回报给页面。 */
function readDataMeta() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'token-usage-data.js'), 'utf8');
    const m = text.match(/window\.__TOKEN_DATA__=(\{[\s\S]*\});?\s*$/);
    if (!m) return null;
    const d = JSON.parse(m[1]);
    return {
      generatedAt: d.gen || null,
      turns: (d.meta && d.meta.turns) || 0,
      reqs: (d.meta && d.meta.reqs) || 0,
      accounts: Array.isArray(d.acct) ? d.acct.length : 0,
      billRows: d.official ? d.official.billRows : (Array.isArray(d.bill) ? d.bill.length : 0),
      creditTotal: d.official ? d.official.creditTotal : null,
      windowDays: d.official ? d.official.windowDays : null,
      errors: (d.official && d.official.errors) || [],
    };
  } catch {
    return null;
  }
}

/**
 * 跑一次同步：与双击「同步Token.bat」执行的是同一条命令。
 *
 * `part` 决定同步范围：
 *   undefined / 'all' → 本地会话 + 官方账单（全量，行为同 bat）
 *   'credits'         → 只刷官方账单与积分余额，本地 Token 数据原样保留
 *   'tokens'          → 只扫本地会话，官方数据原样保留
 *
 * 用子进程而不是把主脚本 require 进来——脚本本身是 CLI 入口，
 * 子进程方式能保证行为与手动跑完全一致，也不怕它内部 process.exit()。
 */
function runSync(part) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [path.join(ROOT, 'token-usage-report.js'), '--emit-js'];
    if (part === 'credits' || part === 'tokens') args.push('--only=' + part);

    execFile(
      process.execPath,
      args,
      { cwd: ROOT, timeout: SYNC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const elapsedMs = Date.now() - started;
        if (err) {
          resolve({
            ok: false, elapsedMs, part: part || 'all',
            error: err.killed ? '同步超时' : (err.message || String(err)),
            output: (stdout || '').slice(-4000),
            stderr: (stderr || '').slice(-2000),
          });
          return;
        }
        resolve({
          ok: true, elapsedMs, part: part || 'all',
          meta: readDataMeta(),
          output: (stdout || '').slice(-2000),
        });
      }
    );
  });
}

async function handleSync(req, res) {
  // 允许 /api/sync、/api/sync/credits、/api/sync/tokens 三种写法
  const part = req.url.split('?')[0].replace(/^\/api\/sync\/?/, '').trim() || 'all';
  if (part !== 'all' && part !== 'credits' && part !== 'tokens') {
    json(res, 400, { ok: false, error: '未知的同步类型：' + part });
    return;
  }
  if (syncing) {
    json(res, 409, { ok: false, error: '已有同步进行中，请稍候' });
    return;
  }
  syncing = true;
  try {
    const result = await runSync(part === 'all' ? undefined : part);
    json(res, result.ok ? 200 : 500, result);
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  } finally {
    syncing = false;
  }
}

function handleStatus(req, res) {
  json(res, 200, {
    ok: true,
    syncing,
    meta: readDataMeta(),
    // 页面据此把「连接本地会话」换成「服务已读取的路径」，省掉授权步骤
    scanDirs: SCAN_DIRS.map((s) => ({
      name: s.name,
      dir: s.dir,
      exists: fs.existsSync(s.dir),
    })),
  });
}

// ---------------------------------------------------------------- 启动

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/sync') && req.method === 'POST') return handleSync(req, res);
  if (pathname === '/api/status') return handleStatus(req, res);
  serveStatic(req, res);
});

/** 用系统默认浏览器打开看板。端口可能是探测出来的，所以由服务自己打开。 */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { /* 打不开也不影响服务本身 */ });
}

/** 从默认端口起依次尝试，避免端口被占用时直接失败。 */
function listen(port, remaining) {
  // 重试前必须清掉上一轮的监听器：listen() 的回调是 once('listening')，
  // 上一次失败时它不会被消耗，留着会导致成功时把启动消息打印多次。
  server.removeAllListeners('listening');
  server.removeAllListeners('error');

  server.once('listening', () => {
    const url = `http://127.0.0.1:${port}/workbuddy-token.html`;
    console.log('');
    console.log('  buddyToken 本地服务已启动');
    console.log('  地址：' + url);
    console.log('');
    console.log('  看板里的「💰 同步积分」「🔄 同步 Token」会真正去拉数据。');
    console.log('  关闭本窗口即停止服务（看板仍可双击 HTML 直接打开，只是积分按钮会退回离线模式）。');
    console.log('');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && remaining > 0) {
      console.log(`端口 ${port} 被占用，改用 ${port + 1} …`);
      listen(port + 1, remaining - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1');
}

listen(DEFAULT_PORT, PORT_SCAN_LIMIT);
