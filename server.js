/**
 * 本地服务：给看板提供「一键同步」。
 *
 * 为什么需要它：浏览器不能直接调官方账单接口——
 *   1. 跨域预检（OPTIONS）会被网关返回 401 且不带 Access-Control-Allow-Origin；
 *   2. JS 无法设置 Origin / Referer（浏览器禁止），也就伪装不了官方 Web 端。
 * 所以「拉数据」这件事必须在 Node 侧完成。
 *
 * 看板页面统一用 file:// 打开（见 BOARD_FILE 处的说明），页面请求本服务属于
 * 跨域，因此这里要放行 CORS；服务只监听回环地址、不持有任何凭证，全放行是安全的。
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
/** 单次同步的最长等待时间（默认只拉近 7 天账单，给足余量）。 */
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 看板文件路径：统一用它打开，而不是 http://127.0.0.1:端口/workbuddy-token.html。
 *
 * 浏览器的存储（IndexedDB / localStorage）按地址隔离，http 与 file 是两个
 * 互不相干的仓库。混着用的话「本地快照」会分裂成两份，换个入口就"看不到"了。
 * 所以固定用 file://，服务只当后台接口。页面侧会自动探测服务端口（见页面里的
 * ServerSync），端口被占用时也不用担心。
 */
const BOARD_FILE = path.join(ROOT, 'workbuddy-token.html');

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
/** 切换账号同理：写认证文件期间不允许并发（备份→写→重启必须原子）。 */
let switching = false;

/** 模型限流台账（本地日志扫描，模块内自带 60s 缓存）。 */
let rateLimits = null;
try {
  rateLimits = require('./rate-limits');
} catch { /* 文件缺失时 429 状态不可用，不影响其它功能 */ }

/** 官方接口封装。签到/旅行这两类操作直接在服务进程内调用，不走子进程。 */
let wbApi = null;
try {
  wbApi = require('./workbuddy-api');
} catch { /* 缺失时相关接口返回 503 */ }

// ---------------------------------------------------------------- CORS

/**
 * 放行跨域：看板用 file:// 打开，请求本服务就是跨域请求，Origin 是字面量 "null"。
 * 服务只监听回环地址、不持有任何凭证，所以直接全放行。
 * 不处理预检的话，带 Content-Type 的 POST（签到 / 派猫猫）会被浏览器拦下。
 */
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

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

/** 读取 POST 的 JSON body（体积很小，够用即可）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();   // 防滥用
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 按 uid 挑账号：给了 uid 就只处理那一个，否则处理全部。 */
function pickAccounts(uid) {
  if (!wbApi) return [];
  const all = wbApi.discoverAccounts();
  if (!uid) return all;
  const one = all.filter((a) => a.uid === uid);
  return one.length ? one : all;
}

/** 签到：对指定账号（或全部）执行一次，已签到不会重复提交。 */
async function handleCheckin(req, res) {
  if (!wbApi) {
    json(res, 503, { ok: false, error: '缺少 workbuddy-api.js' });
    return;
  }
  const body = await readBody(req);
  const accounts = pickAccounts(body.uid);
  if (!accounts.length) {
    json(res, 200, { ok: false, error: '本机未找到登录态' });
    return;
  }

  const results = [];
  for (const acct of accounts) {
    results.push(await wbApi.doCheckin(acct));
  }
  json(res, 200, { ok: results.some((r) => r.ok), results });
}

/** 签到与旅行状态（只读，不改变任何服务端状态）。供看板渲染账号卡片状态。 */
async function handleCheckinStatus(req, res) {
  if (!wbApi) {
    json(res, 503, { ok: false, error: '缺少 workbuddy-api.js' });
    return;
  }
  const accounts = pickAccounts();
  if (!accounts.length) {
    json(res, 200, { ok: false, error: '本机未找到登录态', results: [] });
    return;
  }

  const results = [];
  for (const acct of accounts) {
    const r = await wbApi.fetchCheckin(acct);
    // 接口每次只回最近若干天，这里并入本地累积，日历才能显示更长的记录
    if (r.ok) r.checkinDatesAll = wbApi.recordCheckinDates(acct.uid, r.checkinDates);
    // 顺带查旅行状态（只读），账号卡片一次拿到两个活动状态，省一轮轮询
    try {
      const t = await wbApi.fetchTravel(acct);
      r.travel = t.ok
        ? {
            state: t.state,                    // idle / traveling / arrived
            arriveAt: t.arriveAt,              // 旅行中：预计到达时刻（ms）
            locationName: t.location ? t.location.name : '',
            rewardCredit: t.rewardCredit,
            dailyLimitReached: t.dailyLimitReached,
          }
        : null;
    } catch { r.travel = null; }
    results.push(r);
  }
  json(res, 200, { ok: results.some((r) => r.ok), results });
}

/** 猫猫旅行：按状态机决定派发或领奖。 */
async function handleTravel(req, res) {
  if (!wbApi) {
    json(res, 503, { ok: false, error: '缺少 workbuddy-api.js' });
    return;
  }
  const body = await readBody(req);
  const accounts = pickAccounts(body.uid);
  if (!accounts.length) {
    json(res, 200, { ok: false, error: '本机未找到登录态' });
    return;
  }

  const results = [];
  for (const acct of accounts) {
    results.push(await wbApi.runTravel(acct));
  }
  json(res, 200, { ok: results.some((r) => r.ok), results });
}

/**
 * 切换某应用的登录账号（写对应登录文件；桌面端可选重启 WorkBuddy）。
 *
 * body: { uid, app?, restart? }——app 缺省为 workbuddy-desktop（兼容旧调用）。
 * 与同步同款互斥：切换过程中再来的请求直接 409。restart 会杀掉 WorkBuddy
 * 进程再拉起，属于破坏性动作，看板侧会先弹确认框。
 */
async function handleSwitch(req, res) {
  if (!wbApi || !wbApi.switchAppAccount) {
    json(res, 503, { ok: false, error: '缺少 workbuddy-api.js（旧版文件，请更新项目）' });
    return;
  }
  if (switching) {
    json(res, 409, { ok: false, error: '已有切换进行中，请稍候' });
    return;
  }
  const body = await readBody(req);
  const uid = String(body.uid || '').trim();
  if (!uid) {
    json(res, 400, { ok: false, error: '缺少 uid' });
    return;
  }
  const app = String(body.app || 'workbuddy-desktop').trim();
  const restart = body.restart !== false;   // 默认重启（不重启登录态可能不被客户端重读）

  switching = true;
  try {
    const result = wbApi.switchAppAccount(app, uid, { restart });
    json(res, result.ok ? 200 : 500, result);
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  } finally {
    switching = false;
  }
}

/** 模型限流台账（本机日志扫描，60s 缓存在模块内）。 */
function handleLimits(req, res) {
  if (!rateLimits) {
    json(res, 503, { ok: false, error: '缺少 rate-limits.js' });
    return;
  }
  let currentUid = null;
  try {
    if (wbApi && wbApi.listSwitchableAccounts) currentUid = wbApi.listSwitchableAccounts().current;
  } catch { /* 取不到就少了归因兜底 */ }
  const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
  json(res, 200, { ok: true, ...rateLimits.getRateLimits({ force, currentUid }) });
}

function handleStatus(req, res) {
  // 可切换账号（auth 目录快照发现，不含 token）+ 当前桌面端登录 uid
  let switchable = { current: null, accounts: [] };
  try {
    if (wbApi && wbApi.listSwitchableAccounts) switchable = wbApi.listSwitchableAccounts();
  } catch { /* 无 auth 目录时保持空 */ }
  json(res, 200, {
    ok: true,
    syncing,
    switching,
    meta: readDataMeta(),
    switchable,
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
  applyCors(res);
  if (req.method === 'OPTIONS') {          // 跨域预检：放行
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/sync') && req.method === 'POST') return handleSync(req, res);
  if (pathname === '/api/checkin' && req.method === 'POST') return handleCheckin(req, res);
  if (pathname === '/api/checkin-status') return handleCheckinStatus(req, res);
  if (pathname === '/api/travel' && req.method === 'POST') return handleTravel(req, res);
  if (pathname === '/api/travel-status') return handleCheckinStatus(req, res);
  if (pathname === '/api/switch' && req.method === 'POST') return handleSwitch(req, res);
  if (pathname === '/api/limits') return handleLimits(req, res);
  if (pathname === '/api/status') return handleStatus(req, res);
  serveStatic(req, res);
});

/** 用系统默认浏览器打开看板。传文件路径（file://），原因见 BOARD_FILE 处的说明。 */
function openBrowser(target) {
  const cmd = process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
      : `xdg-open "${target}"`;
  exec(cmd, () => { /* 打不开也不影响服务本身 */ });
}

/** 从默认端口起依次尝试，避免端口被占用时直接失败。 */
function listen(port, remaining) {
  // 重试前必须清掉上一轮的监听器：listen() 的回调是 once('listening')，
  // 上一次失败时它不会被消耗，留着会导致成功时把启动消息打印多次。
  server.removeAllListeners('listening');
  server.removeAllListeners('error');

  server.once('listening', () => {
    console.log('');
    console.log('  buddyToken 本地服务已启动');
    console.log('  接口：http://127.0.0.1:' + port + '/api/…');
    console.log('');
    console.log('  看板里的「💰 同步积分」「🔄 同步 Token」会真正去拉数据。');
    console.log('  看板固定用 file:// 打开（与双击 HTML 是同一个地址），快照只存一份，');
    console.log('  请勿再用 http://127.0.0.1:' + port + ' 打开它，否则快照会分成两份。');
    console.log('  关闭本窗口即停止服务（看板照常能看，只是同步按钮会提示服务未启动）。');
    console.log('');
    if (!process.argv.includes('--no-open')) openBrowser(BOARD_FILE);
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
