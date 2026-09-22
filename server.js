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
    const off = d.official || {};
    return {
      generatedAt: d.gen || null,
      turns: (d.meta && d.meta.turns) || 0,
      reqs: (d.meta && d.meta.reqs) || 0,
      // accounts＝有余额快照的账号数；accountCount＝本机发现的账号总数（后者更全，
      // 某个账号余额查询失败时它仍有余额以外的信息）。页面描述「几个账号」用后者。
      accounts: Array.isArray(d.acct) ? d.acct.length : 0,
      accountCount: off.accountCount || (Array.isArray(d.acct) ? d.acct.length : 0),
      billRows: off.billRows || (Array.isArray(d.bill) ? d.bill.length : 0),
      addedRows: off.addedRows || 0,
      creditTotal: off.creditTotal != null ? off.creditTotal : null,
      windowDays: off.windowDays != null ? off.windowDays : null,
      errors: off.errors || [],
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
 *   'credits'         → 刷官方账单与积分余额（可 --uid 限单账号），并顺带重扫本地会话
 *   'tokens'          → 只扫本地会话，官方数据原样保留
 *
 * 用子进程而不是把主脚本 require 进来——脚本本身是 CLI 入口，
 * 子进程方式能保证行为与手动跑完全一致，也不怕它内部 process.exit()。
 *
 * uid 非空时只刷新该账号（仅对 'credits' 有意义）。值是「字母数字下划线连字符」，
 * 由 handleSync 先行校验——execFile 本就不经 shell，这里再加一道是纵深防御。
 */
function runSync(part, uid) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [path.join(ROOT, 'token-usage-report.js'), '--emit-js'];
    if (part === 'credits' || part === 'tokens') args.push('--only=' + part);
    if (uid) args.push('--uid=' + uid);

    execFile(
      process.execPath,
      args,
      { cwd: ROOT, timeout: SYNC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const elapsedMs = Date.now() - started;
        if (err) {
          // 脚本自己的报错（如「账号 xxx 刷新失败，数据文件保持不变。」）都在
          // stderr 里，比 execFile 那句 "Command failed: …" 有用得多，优先透出
          const lastErr = (stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
          resolve({
            ok: false, elapsedMs, part: part || 'all',
            error: err.killed ? '同步超时' : (lastErr || err.message || String(err)),
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

  // body 可选：{ uid } 表示只刷新该账号（看板账号卡片上的「刷新」按钮）
  const body = await readBody(req);
  const uid = String(body.uid || '').trim();
  if (uid && !/^[0-9a-zA-Z_-]{1,64}$/.test(uid)) {
    json(res, 400, { ok: false, error: 'uid 格式不合法' });
    return;
  }
  if (uid && part !== 'credits') {
    json(res, 400, { ok: false, error: '只支持「只刷积分」时指定 uid' });
    return;
  }

  syncing = true;
  try {
    const result = await runSync(part === 'all' ? undefined : part, uid);
    json(res, result.ok ? 200 : 500, result);
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  } finally {
    syncing = false;
  }
}

/**
 * 清空所有数据：跑一次 token-usage-report.js --reset。
 *
 * 与同步共用同一把锁——清空删的正是同步在写的那些文件，并发跑会出现
 * 「刚写完又被删掉」的竞态。删除清单由脚本侧维护（固定文件名白名单），
 * 这里只负责触发与回报，不自己拼路径，免得两边清单跑偏。
 *
 * 不动 switch-backups/ 账号凭证备份，也不碰 ~/.workbuddy 下的原始会话记录。
 * 看板侧的快照存在浏览器里，需要页面自己清（见页面里的清空流程）。
 */
function handleReset(req, res) {
  if (syncing) {
    json(res, 409, { ok: false, error: '已有同步进行中，请稍候再清空' });
    return;
  }
  syncing = true;
  execFile(
    process.execPath,
    [path.join(ROOT, 'token-usage-report.js'), '--reset'],
    { cwd: ROOT, timeout: 30 * 1000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      syncing = false;
      const out = stdout || '';
      // 脚本每删掉一个文件就打印一行「  ✓ 文件名」，据此回报给页面
      const removed = [...out.matchAll(/✓\s*(.+)/g)].map((m) => m[1].trim());
      if (err) {
        const lastErr = (stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        json(res, 500, {
          ok: false,
          error: err.killed ? '清空超时' : (lastErr || err.message || String(err)),
          output: out.slice(-2000),
        });
        return;
      }
      json(res, 200, { ok: true, removed, output: out.slice(-2000) });
    }
  );
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
  // 默认重启：桌面端要重启才会重读登录态。CLI 不受此影响——switchAppAccount
  // 内部按 app 判断，非桌面端不触碰任何进程（写完即生效）
  const restart = body.restart !== false;

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

// ---------------------------------------------------------------- 自动化调度

/**
 * 四个自动任务：自动签到 / 自动猫猫 / 自动切换账号 / 自动刷新积分。
 *
 * 开关存 auto-config.json（只存四个布尔，不含任何 token），默认全关——
 * 页面上点开哪个，哪个就按自己的周期开始跑。调度本身常驻，只是被开关门控。
 *
 * 周期（毫秒）按任务性质定：
 *   · 签到：每天至少一次即可，6h 一查（doCheckin 幂等，已签不再提交）。
 *   · 猫猫：状态机 idle→traveling→arrived 跨度可能几小时，30min 一查才能在
 *     到达后及时领奖；查得太稀会漏掉领取窗口。
 *   · 切换账号：每小时评估一次「有没有更该用的账号」。
 *   · 刷新积分：每 30min 拉一次官方余额，保持看板数据新鲜。
 */
const AUTO_CONFIG_FILE = path.join(ROOT, 'auto-config.json');
const AUTO_KEYS = ['checkin', 'travel', 'switch', 'refresh'];
const AUTO_INTERVALS = {
  checkin: 6 * 60 * 60 * 1000,
  travel: 30 * 60 * 1000,
  switch: 60 * 60 * 1000,
  refresh: 30 * 60 * 1000,
};
/** 自动切换只在「有账号积分即将到期（默认 14 天内）」时才切，避免无谓切换。 */
const SWITCH_HORIZON_DAYS = 14;

/**
 * 下次触发的随机抖动：±10% 周期（30min 任务即 ±3min，6h 任务即 ±36min）。
 * 固定间隔的规律性请求容易被识别为脚本，每次执行时重摇一次，
 * 让各任务的实际间隔在标称周期附近随机浮动。
 */
function nextJitter(period) {
  return Math.round((Math.random() * 2 - 1) * period * 0.1);
}

let autoConfig = loadAutoConfig();
/** key → { tryAt, okAt, failAt, error, info }：上次尝试/成功/失败时间与结果摘要。 */
const autoState = {};
const autoRunning = new Set();

function loadAutoConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(AUTO_CONFIG_FILE, 'utf8'));
    const o = {};
    for (const k of AUTO_KEYS) o[k] = !!c[k];
    return o;
  } catch {
    return { checkin: false, travel: false, switch: false, refresh: false };
  }
}
function saveAutoConfig() {
  try { fs.writeFileSync(AUTO_CONFIG_FILE, JSON.stringify(autoConfig, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

/** WorkBuddy 桌面端是否正在运行（决定是否在切换后重启它）。 */
function isWorkbuddyRunning() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return /WorkBuddy\.exe/i.test(out);
  } catch { return false; }
}

/**
 * 自动切换账号：在「有剩余积分且即将到期」的账号里挑到期最早的，
 * 若它还不是某应用的当前登录账号，就切过去——让即将过期的积分先被用掉。
 *
 * 对两个应用都切：CLI 写完即生效（不重启），桌面端仅在「正在运行」时重启生效。
 * 目标账号必须在目标应用有登录快照才可切（token 域不同，跨域借用会被网关拒）。
 *
 * 防震荡：切换的排序键（到期时刻）不因切换而改变，切到手的账号只要临期批次
 * 没花完就不会再动；冷却兜底——自动切换成功后 24h 内不再切（手动 /api/switch
 * 不受限），即使官方数据抖动也不会反复改登录文件、重启桌面端。
 *
 * 返回结果摘要（供前端展示）；没有可切换的对象时原样返回说明，不报错。
 */
const AUTO_SWITCH_COOLDOWN = 24 * 60 * 60 * 1000;
let lastAutoSwitchAt = 0;   // 上次自动切换成功时刻（内存态，重启归零；手动切换不记）

async function autoSwitchAccount() {
  const all = wbApi.discoverAccounts();
  if (!all.length) throw new Error('本机未找到登录态');

  const credits = await wbApi.fetchCreditForAccounts(all);
  let target = null, best = Infinity;
  for (const c of credits) {
    if (!c.ok || !c.totalRemaining || !c.soonestExpireAt) continue;
    if (c.soonestExpireAt < best) { best = c.soonestExpireAt; target = c; }
  }
  if (!target) return '各账号均无带到期时间的剩余积分，无需切换';
  const days = Math.ceil((best - Date.now()) / 86400000);
  if (best > Date.now() + SWITCH_HORIZON_DAYS * 86400000) {
    return `最近到期的积分还有 ${days} 天（超过 ${SWITCH_HORIZON_DAYS} 天），暂不切换`;
  }

  const sw = wbApi.listSwitchableAccounts();
  // 两个应用都已在该账号上时无需冷却判断（本来就不动）；否则看 24h 冷却。
  const cur = sw.currentByApp || {};
  const allCurrent = ['workbuddy-desktop', 'codebuddy-cli'].every((app) => (cur[app] || null) === target.uid);
  if (!allCurrent && Date.now() - lastAutoSwitchAt < AUTO_SWITCH_COOLDOWN) {
    return '24 小时内已自动切换过，冷却中，暂不切换';
  }
  const done = [];
  for (const app of ['workbuddy-desktop', 'codebuddy-cli']) {
    const appName = app === 'codebuddy-cli' ? 'CLI' : '桌面端';
    const current = (sw.currentByApp && sw.currentByApp[app]) || null;
    if (current === target.uid) { done.push(`${appName}已是该账号`); continue; }
    const acc = (sw.accounts || []).find((a) => a.uid === target.uid);
    if (!acc || !acc.snapshots || !acc.snapshots[app]) { done.push(`${appName}无该账号快照`); continue; }
    // 桌面端只在「正在运行」时重启（避免把一个没在用的应用凭空拉起来）；
    // CLI 不重启，写完即生效。
    const restart = app !== 'codebuddy-cli' && isWorkbuddyRunning();
    const r = wbApi.switchAppAccount(app, target.uid, { restart });
    if (!r.ok) throw new Error(`切换${appName}失败：${r.error || '未知错误'}`);
    done.push(`${appName}已切换${restart ? '（已重启客户端）' : ''}`);
    lastAutoSwitchAt = Date.now();
  }
  const d = new Date(best).toLocaleDateString('zh-CN');
  return `已切到「${target.name || target.uid}」（${days} 天后 ${d} 到期）：${done.join('，')}`;
}

/** 各任务的实际动作，返回结果摘要；失败时抛错（由 runAutoTask 记录）。 */
async function runAutoTaskBody(name) {
  if (name === 'checkin') {
    const accounts = pickAccounts();
    if (!accounts.length) throw new Error('本机未找到登录态');
    let okN = 0, newN = 0, credit = 0;
    for (const a of accounts) {
      const r = await wbApi.doCheckin(a);   // 幂等：已签到的回 already，不重复提交
      if (!r.ok) continue;
      okN++;
      if (!r.already) { newN++; credit += (r.todayCredit || 0); }
    }
    if (!okN) throw new Error(`共 ${accounts.length} 个账号，签到全部失败`);
    return `共 ${accounts.length} 个账号：成功 ${okN} 个` +
      (newN ? `，新签 ${newN} 个得 ${credit} 积分` : '（均为已签到的补查）');
  }
  if (name === 'travel') {
    const accounts = pickAccounts();
    if (!accounts.length) throw new Error('本机未找到登录态');
    let departN = 0, claimN = 0, credit = 0, okN = 0, lastErr = '', waitN = 0, limitN = 0;
    for (const a of accounts) {
      const r = await wbApi.runTravel(a);
      if (!r.ok) { lastErr = r.error || '未知错误'; continue; }
      okN++;
      if (r.action === 'depart') departN++;
      else if (r.action === 'claim') { claimN++; credit += (r.rewardCredit || 0); }
      else if (r.action === 'wait') waitN++;      // 旅行中，等到达
      else if (r.action === 'limit') limitN++;    // 今日次数已用完（官方拒绝派出，非故障）
    }
    if (!okN) throw new Error(`共 ${accounts.length} 个账号，全部失败：${lastErr}`);
    const parts = [];
    if (departN) parts.push(`派出 ${departN} 只`);
    if (claimN) parts.push(`领取 ${claimN} 份奖励${credit ? `（+${credit} 积分）` : ''}`);
    if (waitN) parts.push(`${waitN} 只旅行中`);
    if (limitN) parts.push(`${limitN} 只今日次数已用完`);
    return `共 ${accounts.length} 个账号：${parts.join('，') || '无可用动作'}` +
      (lastErr && okN < accounts.length ? `（${accounts.length - okN} 个失败：${lastErr}）` : '');
  }
  if (name === 'switch') {
    if (switching) return '已有手动切换进行中，本次跳过';
    switching = true;
    try { return await autoSwitchAccount(); } finally { switching = false; }
  }
  if (name === 'refresh') {
    if (syncing) return '已有同步进行中，本次跳过';
    syncing = true;
    let r;
    try { r = await runSync('credits'); } finally { syncing = false; }
    if (!r.ok) throw new Error(r.error || '同步失败');
    const m = r.meta || {};
    const parts = [];
    if (m.billRows != null) parts.push(`账单 ${m.billRows} 条`);
    if (m.addedRows) parts.push(`新增 ${m.addedRows} 条`);
    if (m.accounts != null) parts.push(`${m.accounts} 个账号余额已更新`);
    return parts.length ? parts.join('，') : '同步完成';
  }
  throw new Error('未知任务：' + name);
}

/** 执行单个自动任务：记录尝试/成功/失败时间与结果摘要（带防重入）。 */
async function runAutoTask(name) {
  if (autoRunning.has(name)) return;
  autoRunning.add(name);
  if (!autoState[name]) autoState[name] = { tryAt: 0, okAt: 0, failAt: 0, error: '', info: '', jitter: 0 };
  const st = autoState[name];
  st.tryAt = Date.now();
  st.jitter = nextJitter(AUTO_INTERVALS[name]);   // 本次执行时决定下次的触发偏移
  try {
    if (!wbApi) throw new Error('缺少 workbuddy-api.js');
    st.info = await runAutoTaskBody(name);
    st.okAt = Date.now();
    st.error = '';
    console.log('[auto] ' + name + ' ✓ ' + st.info);
  } catch (e) {
    st.failAt = Date.now();
    st.error = e.message || String(e);
    console.error('[auto] ' + name + ' ✗ ' + st.error);
  } finally {
    autoRunning.delete(name);
  }
}

/** 每分钟评估一次：开关开着且距上次「尝试」已超「周期+随机抖动」，就触发（失败也等完整周期再重试）。 */
function autoTick() {
  const now = Date.now();
  for (const name of AUTO_KEYS) {
    if (!autoConfig[name]) continue;
    const st = autoState[name];
    if (now - ((st && st.tryAt) || 0) >= AUTO_INTERVALS[name] + ((st && st.jitter) || 0)) runAutoTask(name);
  }
}

/** 自动任务配置读写：GET 返回当前配置与上次执行时间；POST 合并开关（打开即跑一次）。 */
async function handleAuto(req, res) {
  if (req.method !== 'POST') {
    json(res, 200, { ok: true, config: { ...autoConfig }, lastRun: { ...autoState }, intervals: AUTO_INTERVALS });
    return;
  }
  const body = await readBody(req);
  let changed = false;
  for (const k of AUTO_KEYS) {
    if (typeof body[k] === 'boolean') {
      if (!autoConfig[k] && body[k]) runAutoTask(k);   // 刚打开，立刻跑一次给反馈
      autoConfig[k] = body[k];
      changed = true;
    }
  }
  if (changed) saveAutoConfig();
  json(res, 200, { ok: true, config: { ...autoConfig }, lastRun: { ...autoState } });
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
  if (pathname === '/api/reset' && req.method === 'POST') return handleReset(req, res);
  if (pathname === '/api/checkin' && req.method === 'POST') return handleCheckin(req, res);
  if (pathname === '/api/checkin-status') return handleCheckinStatus(req, res);
  if (pathname === '/api/travel' && req.method === 'POST') return handleTravel(req, res);
  if (pathname === '/api/travel-status') return handleCheckinStatus(req, res);
  if (pathname === '/api/switch' && req.method === 'POST') return handleSwitch(req, res);
  if (pathname === '/api/limits') return handleLimits(req, res);
  if (pathname === '/api/auto') return handleAuto(req, res);
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

/** 自动化调度：每分钟评估一次四个开关，谁开着且到点就跑。 */
setInterval(autoTick, 60 * 1000);
