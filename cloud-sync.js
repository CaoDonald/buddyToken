#!/usr/bin/env node
/**
 * buddyToken 多端云同步（Supabase）
 *
 * 做什么：每台机器把自己的数据推到云端一张「传阅箱」，再把别人推的拉回来，
 * 合并进本地 token-usage-data.js，看板于是能看到多端汇总，并能按机器筛选。
 *
 * 不做什么：本地文件仍是唯一数据源——看板读的还是同一个文件、同一个位置。
 * 云端不是权威库，只是机器之间的中转站。云同步失败只打警告，不影响本地数据产出。
 *
 * 为什么不用 @supabase/supabase-js：本项目零 npm 依赖，只用 Node 标准库。
 * Supabase 自带 PostgREST，直接发 HTTP 就是它的 REST API，用 Node 18+ 的原生
 * fetch 即可，不需要任何 SDK。
 *
 * 看板为什么不直连：看板固定以 file:// 打开，把 anonKey 放进页面等于公开。
 * 让 key 只留在本机 sync-config.json（已 gitignore）里，风险小得多。
 *
 * 合并铁律（与 token-usage-report.js 一致）：**只做追加，绝不让历史变少**。
 * 所有合并都是「缺失才加 / 更优才覆盖」，没有任何删除路径。
 *
 * 命令行：
 *   node cloud-sync.js              同步一轮（读 sync-config.json）
 *   node cloud-sync.js --dry-run    只统计并打印将要推/拉的行数，不联网写、不落盘
 *   node cloud-sync.js --pull       只拉取合并（不推送）
 *   node cloud-sync.js --push       只推送（不拉取）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'sync-config.json');
const STATE_FILE = path.join(ROOT, 'sync-state.json');
const DATA_FILE = path.join(ROOT, 'token-usage-data.js');
const CREDIT_HISTORY_FILE = path.join(ROOT, 'credit-history.json');

/** 数据文件里的赋值标记，报告脚本与这里共用同一个契约。 */
const DATA_MARKER = 'window.__TOKEN_DATA__=';

/**
 * PostgREST 单次响应上限。Supabase 服务端默认 max-rows=1000，
 * 即使请求更大的 Range 也只会回 1000 行，所以分页就按它来。
 */
const PAGE_SIZE = 1000;

// ============================================================ 配置

/** sync-config.json 的字段与默认值。 */
const CONFIG_DEFAULTS = {
  enabled: false,             // 总开关：false 时整条链路静默跳过
  url: '',                    // 如 https://xxxx.supabase.co（也可填自建反代地址）
  anonKey: '',                // Supabase 项目的 anon public key
  proxy: '',                  // HTTP 代理，如 http://127.0.0.1:10235；留空则直连
  machineName: '',            // 看板上显示的机器名，留空用主机名
  intervalMinutes: 30,        // 后台同步周期
  resyncWindowDays: 7,        // 重推窗口：这么多天内变动过的回合每轮都重推一遍
  batchSize: 500,             // 每次 upsert 的行数
  timeoutMs: 60000,           // 单次 HTTP 超时
};

/**
 * 读 sync-config.json。文件不存在或解析失败都返回 null——调用方据此静默跳过，
 * 让「没配过云同步」与「配置坏了」都不会影响本地链路。
 */
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const cfg = { ...CONFIG_DEFAULTS };
  for (const k of Object.keys(CONFIG_DEFAULTS)) {
    if (raw[k] !== undefined && raw[k] !== null) cfg[k] = raw[k];
  }

  cfg.enabled = !!cfg.enabled;
  cfg.url = String(cfg.url).trim().replace(/\/+$/, '');
  cfg.anonKey = String(cfg.anonKey).trim();
  cfg.proxy = String(cfg.proxy).trim();
  cfg.machineName = String(cfg.machineName).trim();

  const num = (v, dflt, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  cfg.intervalMinutes = num(cfg.intervalMinutes, 30, 1);
  cfg.resyncWindowDays = num(cfg.resyncWindowDays, 7, 1);
  cfg.batchSize = Math.min(num(cfg.batchSize, 500, 1), 1000);
  cfg.timeoutMs = num(cfg.timeoutMs, 60000, 5000);

  return cfg;
}

/** 云同步是否已启用且配置齐全（缺一即视为未启用，等同纯本地模式）。 */
function isEnabled() {
  const cfg = loadConfig();
  return !!(cfg && cfg.enabled && cfg.url && cfg.anonKey);
}

/**
 * 没有 sync-config.json 时写一份模板出来（enabled: false、字段留空、带中文说明）。
 *
 * 为什么自动写：仓库里没有这个文件（含凭证，已 gitignore），刚从 GitHub clone 到
 * 新机器的人既不知道要建它、也不知道字段叫什么、更不知道还有代理这回事。写一份
 * 带说明的模板，「去哪儿填什么」就成了看得见的东西。写成 false 起步，所以它不会
 * 自己跑起来——填好之前，行为与纯本地完全一致。
 *
 * 已有文件一律不碰，哪怕是坏的：那是用户自己改出来的，覆盖会把内容抹掉。
 */
function ensureConfigTemplate() {
  if (fs.existsSync(CONFIG_FILE)) return false;
  const tpl = {
    _comment: [
      '云同步配置（多端数据汇总）。改完保存即可，服务端每 30 秒重读一次，不必重启。',
      '这份文件是自动生成的模板，填好之前不会有任何网络请求。',
      '',
      '启用步骤：',
      '  1) 在第一台机器上建好 Supabase 项目并执行 supabase-cloud-sync.sql（只需一次）；',
      '  2) 把那个项目的 URL 与 anon public key 填到下面；',
      '  3) 把 enabled 改成 true，保存。',
      '',
      '多台机器如何配：',
      '  url / anonKey  —— 所有机器填同一个（连的是同一个项目）',
      '  machineName    —— 每台取不同的名字，看板靠它区分是哪台（如「台式机」「笔记本」）',
      '  proxy          —— 填这台机器自己的代理端口，各机可能不同；先留空试直连',
      '',
      '字段说明：',
      '  enabled           总开关。false 时整条链路静默跳过，看板行为与纯本地完全一致',
      '  url               Supabase 项目地址，形如 https://xxxx.supabase.co（也可填自建反代）',
      '  anonKey           项目的 anon public key。只存本机，切勿提交、切勿贴给别人',
      '  proxy             HTTP 代理，如 http://127.0.0.1:10235；留空则直连。',
      '                    *.supabase.co 走 Cloudflare，国内直连常被 TLS 重置，不通时必须填',
      '  machineName       看板上显示的机器名，留空则用主机名',
      '  intervalMinutes   后台同步周期，单位 分钟',
      '  resyncWindowDays  重推窗口（天）：这么多天内变动过的回合每轮都重推一遍，防漏推',
      '  batchSize         每次上传的行数，网络不稳可调小',
      '  timeoutMs         单次请求超时，单位 毫秒',
    ],
    ...CONFIG_DEFAULTS,
  };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
    console.log('  [云同步] 已生成配置模板 sync-config.json（默认关闭，填好并改成 enabled=true 才会生效）');
    return true;
  } catch {
    return false;   // 写不进去（只读目录等）不该影响主流程
  }
}

/** re-exec 后用来标记「代理环境已就绪」，避免无限重入。 */
const PROXY_ENV_FLAG = '_BT_CLOUD_SYNC_PROXY_READY';

/**
 * 代理环境变量。
 *
 * 为什么必须由「起进程的人」来设：Node 的 fetch（底层 undici）只在**模块初始化时**
 * 读 NODE_USE_ENV_PROXY，之后再改 process.env 不生效——实测同一台机器上，启动时
 * 带这组变量能连通，运行时才设则照旧 ECONNRESET。
 *
 * 本机实测背景：`*.supabase.co` 走 Cloudflare，直连会被 TLS 阶段重置；系统代理
 * （注册表里的 ProxyServer）只有浏览器类应用会用，Node 不读，所以必须显式传。
 */
function proxyEnv(cfg, base) {
  return {
    ...(base || process.env),
    [PROXY_ENV_FLAG]: '1',
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: cfg.proxy,
    HTTPS_PROXY: cfg.proxy,
    NO_PROXY: [process.env.NO_PROXY, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
  };
}

/**
 * CLI 模式下若配了代理、且当前进程还没带代理环境，就带着环境变量重跑自己一次。
 * 这是让 `node cloud-sync.js` 直接可用的唯一干净办法（见 proxyEnv 的说明）。
 */
function reexecWithProxyIfNeeded(cfg) {
  if (!cfg || !cfg.proxy) return;
  if (process.env[PROXY_ENV_FLAG] === '1') return;   // 已经是重跑后的进程
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: proxyEnv(cfg),
  });
  process.exit(r.status === null ? 1 : r.status);
}

// ============================================================ 本机状态

/**
 * 本机同步状态（sync-state.json，已 gitignore）。
 *
 * 游标存本地而不是云端：它是「本机同步到哪」的私有进度，放云端反而要多一套读写，
 * 而且两台机器的进度本来就该各管各的。
 */
function loadState() {
  const empty = {
    machineId: '', hostname: '',
    lastPushMaxT1: 0, lastPushBillTime: 0,
    lastPull: {}, lastRunAt: 0, lastResult: '',
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  return {
    ...empty,
    ...raw,
    lastPull: (raw.lastPull && typeof raw.lastPull === 'object') ? raw.lastPull : {},
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 状态写不进去不该中断同步 */ }
}

/** 生成或取回本机标识（UUID，跨机唯一且与主机名无关）。 */
function newMachineId() {
  return crypto.randomUUID();
}

/**
 * 本机机器标识。
 *
 * 主机名参与判断是为了防「整目录复制」：用户把 buddyToken 目录拷到另一台机器
 * （或从别人的备份恢复）时，若沿用同一个 machineId，两台会互相覆盖对方推的数据，
 * 而且看板上会把两台的数据算成一台。发现主机名变了就换新 id、重置推送水位线
 * （新机器要把自己的数据全量推一遍）。
 *
 * 注意 report.js 也会调它——但只在本函数返回空时会写文件，所以纯本地模式下
 * 由 isEnabled() 先行拦掉，不会平白多出 sync-state.json。
 */
function getMachineId() {
  const state = loadState();
  const host = os.hostname();
  if (state.machineId && state.hostname === host) return state.machineId;

  const id = newMachineId();
  if (state.machineId) {
    console.warn(`  [云同步] 主机名由 ${state.hostname || '（未知）'} 变为 ${host}，` +
      '判定为换机或目录被复制，已启用新的机器标识（本机数据将重新全量推送）');
  }
  saveState({ ...state, machineId: id, hostname: host, lastPushMaxT1: 0, lastPushBillTime: 0 });
  return id;
}

// ============================================================ 本地数据文件

/**
 * 读 token-usage-data.js：返回 { data, header }。
 *
 * header 是 `window.__TOKEN_DATA__=` 之前的全部内容（报告脚本写的两行注释）。
 * 写回时原样保留，只替换数据部分——报告脚本的生成时间与统计摘要有用，
 * 不该被云同步抹掉。
 */
function loadDataFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const i = raw.indexOf(DATA_MARKER);
  if (i < 0) return null;
  const j = raw.lastIndexOf('}');
  if (j <= i) return null;
  try {
    const data = JSON.parse(raw.slice(i + DATA_MARKER.length, j + 1));
    if (!data || typeof data !== 'object') return null;
    return { data, header: raw.slice(0, i) };
  } catch {
    return null;
  }
}

function saveDataFile(file, header, data) {
  fs.writeFileSync(file, header + DATA_MARKER + JSON.stringify(data) + ';\n', 'utf8');
}

/** 本地自然日（与 workbuddy-api.js 的 localDate 同口径）。 */
function localDay(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ============================================================ PostgREST 客户端

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一个 PostgREST 请求。
 *
 * 认证靠 apikey 头（Supabase 的 REST 网关认它）加 Authorization: Bearer；
 * 写请求的 Prefer: resolution=merge-duplicates 让它按主键做 upsert，
 * return=minimal 省掉把整批行回传的响应体。
 */
async function restRequest(cfg, opt) {
  if (typeof fetch !== 'function') {
    throw new Error('需要 Node 18 以上版本（内置 fetch）');
  }
  const qs = [];
  if (opt.onConflict) qs.push('on_conflict=' + encodeURIComponent(opt.onConflict));
  if (opt.query) qs.push(opt.query);
  const url = `${cfg.url}/rest/v1/${opt.table}${qs.length ? '?' + qs.join('&') : ''}`;

  const headers = {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    ...(opt.headers || {}),
  };
  if (opt.rows) {
    headers['Content-Type'] = 'application/json';
    headers.Prefer = 'resolution=merge-duplicates,return=minimal';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: opt.method,
      headers,
      signal: ctrl.signal,
      body: opt.rows ? JSON.stringify(opt.rows) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时（>${cfg.timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 网络抖动与云端限流都算常见，退避重试 3 次（1s / 3s / 9s）。 */
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1000 * Math.pow(3, i));
    }
  }
  throw lastErr;
}

/**
 * 增量拉整张表。
 *
 * 分页用 Range 头（PostgREST 的 limit 同样受服务端 max-rows=1000 限制）。
 * 排序必须带次级键：同一 updated_at 的多行在两次请求间顺序不保证稳定，
 * 只按 updated_at 排序会让分页边界丢行或重复。order 由调用方按各表主键给。
 *
 * 游标推进的时机在调用方——整轮拉完再统一推进，不能每页推，
 * 否则同一毫秒的行会被永久跳过。
 */
async function selectAll(cfg, table, opt = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const parts = ['select=*'];
    if (opt.cursor) parts.push('updated_at=gt.' + encodeURIComponent(opt.cursor));
    if (opt.filter) parts.push(opt.filter);
    if (opt.order) parts.push('order=' + opt.order);

    const res = await withRetry(() => restRequest(cfg, {
      method: 'GET',
      table,
      query: parts.join('&'),
      headers: { Range: `${offset}-${offset + PAGE_SIZE - 1}`, 'Range-Unit': 'items' },
    }));
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

/** 批量 upsert。空数组不发请求；按 batchSize 切块，避免单次请求体过大。 */
async function upsertRows(cfg, table, rows, onConflict) {
  let sent = 0;
  for (let i = 0; i < rows.length; i += cfg.batchSize) {
    const batch = rows.slice(i, i + cfg.batchSize);
    await withRetry(() => restRequest(cfg, {
      method: 'POST', table, rows: batch, onConflict,
    }));
    sent += batch.length;
  }
  return sent;
}

// ============================================================ 推送：本地 → 行

/**
 * 筛选要推送的回合。
 *
 * 难点是「回合会被后续同步补齐」：正在进行的会话，其 token 数会随着后续请求
 * 变大、t1 变晚。只靠「t1 > 上次水位线」能覆盖大部分，但「t1 没变只有 n 变」
 * 的少数情况会漏。所以叠一层时间窗：最近 resyncWindowDays 天内的回合每轮都重推。
 * upsert 是幂等的，重复推没有副作用，只多花点流量。
 *
 * 只推本机的回合：从云端拉回来的他机回合没必要再推回去。
 * 早期数据（启用云同步之前生成的）没有 mch 字段，按本机数据一并推上去。
 */
function buildTurnRows(data, machineId, state, cfg) {
  const winStart = Date.now() - cfg.resyncWindowDays * 86400000;
  const rows = [];
  for (const [key, v] of Object.entries(data.t || {})) {
    if (!v || typeof v !== 'object') continue;
    if (v.mch && v.mch !== machineId) continue;

    const t1 = Number(v.t1) || 0;
    if (!(t1 === 0 || t1 > (state.lastPushMaxT1 || 0) || t1 >= winStart)) continue;

    rows.push({
      machine_id: machineId,
      turn_key: key,
      n: v.n || 0,
      in_tokens: v.in || 0,
      out_tokens: v.out || 0,
      cr_tokens: v.cr || 0,
      cc_tokens: v.cc || 0,
      tot_tokens: v.tot || 0,
      t0: v.t0 || 0,
      t1,
      model: v.m || '',
      session_id: v.s || '',
      source: v.src || '',
      project: v.p || '',
      lat_sum: v.lat || 0,
      lat_n: v.latn || 0,
      steps: Array.isArray(v.d) && v.d.length ? v.d : null,
    });
  }
  return rows;
}

/**
 * 筛选要推送的账单行。
 *
 * 账号列由下标翻成 uid 文本：下标是「本机视角」的序号，跨机后同一个下标
 * 指向不同的人，直接传下标会让别人的账单归属错乱。
 *
 * 机器归属：本地行已有第 7 位就用它；否则反查对应回合拿机器。反查不到的
 * （CLI 会话、其他机器用同账号发出的请求、会话已被清理）留 null，
 * 前端归入「未标注」。
 */
function buildBillRows(data, state, cfg) {
  const uids = data.uids || [];
  const turns = data.t || {};
  const winStart = Date.now() - cfg.resyncWindowDays * 86400000;
  const rows = [];
  for (const r of data.bill || []) {
    if (!Array.isArray(r) || !r[0]) continue;
    const id = String(r[0]);
    const ts = Number(r[4]) || 0;
    if (!(ts === 0 || ts > (state.lastPushBillTime || 0) || ts >= winStart)) continue;

    const idx = Number(r[5]);
    const uid = idx >= 0 && idx < uids.length ? String(uids[idx]) : '';

    let mid = r[6] !== undefined && r[6] !== null ? r[6] : null;
    if (!mid) {
      const t = turns[id.toLowerCase()];
      if (t && t.mch) mid = t.mch;
    }

    rows.push({
      request_id: id,
      credit: Number(r[1]) || 0,
      model: r[2] || '',
      client: r[3] || '',
      request_time: ts,
      uid,
      machine_id: mid,
    });
  }
  return rows;
}

/** 余额历史：本地是 {uid: [[ts, remaining], ...]}，拆成一账号一天一行。 */
function buildHistRows(data, machineId) {
  const rows = [];
  for (const [uid, list] of Object.entries(data.hist || {})) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!Array.isArray(p) || !p[0]) continue;
      rows.push({
        uid,
        day: localDay(p[0]),
        ts: Number(p[0]) || 0,
        remaining: Number(p[1]) || 0,
        machine_id: machineId,
      });
    }
  }
  return rows;
}

/** 余额快照。账号数量本来就少，每轮全量推，不做增量。 */
function buildAcctRows(data, machineId) {
  return (data.acct || [])
    .filter((a) => a && a.uid)
    .map((a) => ({
      uid: a.uid,
      name: a.name || '',
      total: a.total || 0,
      remaining: a.remaining || 0,
      used: a.used || 0,
      packages: a.packages || [],
      login: a.login || null,
      official_updated_at: a.updatedAt || 0,
      machine_id: machineId,
    }));
}

/** 会话标题。会话数量级只有几百，每轮全量推。 */
function buildTitleRows(data, machineId) {
  return Object.entries(data.ti || {})
    .filter(([sid, title]) => sid && title)
    .map(([sid, title]) => ({
      session_id: sid,
      title: String(title),
      machine_id: machineId,
    }));
}

// ============================================================ 合并（纯函数）

/**
 * 以下 merge* 全是纯函数：输入本地结构与远端行，输出合并结果，不碰网络与文件。
 * 这样「只增不减」这条铁律可以脱离环境单独断言（见 _check 脚本）。
 *
 * 统一原则：缺失才加、更优才覆盖，没有任何删除或缩小的路径。
 */

/** 远端行 → 本地回合对象（字段名与顺序对齐 token-usage-report.js 的产物）。 */
function rowToTurn(r) {
  const o = {
    n: r.n || 0,
    in: r.in_tokens || 0,
    out: r.out_tokens || 0,
    cr: r.cr_tokens || 0,
    cc: r.cc_tokens || 0,
    tot: r.tot_tokens || 0,
    t0: r.t0 || 0,
    t1: r.t1 || 0,
    m: r.model || '',
    s: r.session_id || '',
    src: r.source || '',
    p: r.project || '',
    mch: r.machine_id || '',
    lat: r.lat_sum || 0,
    latn: r.lat_n || 0,
  };
  if (Array.isArray(r.steps) && r.steps.length) o.d = r.steps;
  return o;
}

/**
 * 回合合并。
 *
 * 本地 t 仍是单键（TokenData.lookup 与前端全部按单键查，改成多键会波及整条链路），
 * 所以同键多机时靠优先级取舍，而不是存两份：
 *   · 本地已有 → 一律保留本地。本机扫描的是原始 jsonl，比云端副本权威；
 *     若那条是他机推来的，也是「先到先得」，同样不动（动它就可能让数据变少）。
 *   · 本地没有 → 取远端。远端同一键有多台时取 tot 最大者，并列取 machine_id
 *     字典序小者——规则必须是确定的，否则两台机器合并结果不一致、互相覆盖。
 */
function planTurnMerge(localT, remoteRows) {
  const byKey = new Map();
  for (const r of remoteRows) {
    const key = String(r.turn_key || '').trim().toLowerCase();
    if (!key) continue;
    const cand = { row: r, tot: Number(r.tot_tokens) || 0, mid: String(r.machine_id || '') };
    const cur = byKey.get(key);
    if (!cur || cand.tot > cur.tot || (cand.tot === cur.tot && cand.mid < cur.mid)) {
      byKey.set(key, cand);
    }
  }

  const added = {};
  let keptLocal = 0;
  for (const [key, { row }] of byKey) {
    if (localT[key]) { keptLocal++; continue; }
    added[key] = rowToTurn(row);
  }
  return { added, keptLocal, remoteKeys: byKey.size };
}

/**
 * 账单合并。
 *
 * 本地行是紧凑数组 [requestId, credit, model, client, 时间ms, 账号下标, 机器]，
 * 第 7 位是云同步引入的机器归属，旧数据没有（undefined），按 null 处理。
 *
 * 远端行的 uid 是文本，必须翻译成本机 uids 下标：本机没有该 uid 就追加到末尾，
 * 绝不能沿用远端下标（CODEBUDDY.md 里专门警告过归属错乱）。
 *
 * 只补不缩：积分取两者较大值（官方结算是逐步饱和的，取大不会把已结算的抹小），
 * 机器归属只在本地为空时补。
 */
function planBillMerge(localBill, localUids, remoteRows) {
  const uids = [...(localUids || [])];
  const idxOf = new Map();
  uids.forEach((u, i) => { if (!idxOf.has(u)) idxOf.set(u, i); });
  const mapUid = (uid) => {
    if (!idxOf.has(uid)) {
      idxOf.set(uid, uids.length);
      uids.push(uid);
    }
    return idxOf.get(uid);
  };

  const byId = new Map();
  for (const r of localBill || []) {
    if (Array.isArray(r) && r[0]) byId.set(String(r[0]), r);
  }

  let added = 0, creditUp = 0, machinePatched = 0;
  for (const row of remoteRows) {
    const id = String(row.request_id || '');
    if (!id) continue;

    const existing = byId.get(id);
    if (!existing) {
      const uidIdx = row.uid ? mapUid(String(row.uid)) : -1;
      byId.set(id, [
        id,
        Number(row.credit) || 0,
        row.model || '',
        row.client || '',
        Number(row.request_time) || 0,
        uidIdx,
        row.machine_id || null,
      ]);
      added++;
      continue;
    }

    // 本地已有：积分取较大值（官方结算逐步饱和，取大不会把已结算的变小）
    const rc = Number(row.credit) || 0;
    if (rc > (Number(existing[1]) || 0)) { existing[1] = rc; creditUp++; }
    // 机器归属：只补空，绝不覆盖（本机反查的结果更可信）
    if ((existing[6] === undefined || existing[6] === null) && row.machine_id) {
      existing[6] = row.machine_id;
      machinePatched++;
    }
  }

  const bill = [...byId.values()].sort((a, b) => (a[4] || 0) - (b[4] || 0));
  return { bill, uids, added, creditUp, machinePatched };
}

/**
 * 余额历史合并。
 *
 * 同账号同天保留本地值：credit-history.json 里的 ts 是「当天第一次观察的时刻」，
 * 不是「最后一次」，两台机器的同一天记录无法靠 ts 比出谁更新，所以按先到先得，
 * 与其它表的规则一致，也符合只增不减。
 */
function planHistMerge(localHist, remoteRows) {
  const hist = {};
  for (const [uid, list] of Object.entries(localHist || {})) {
    hist[uid] = Array.isArray(list) ? list.map((p) => [p[0], p[1]]) : [];
  }

  let added = 0;
  for (const row of remoteRows) {
    const uid = String(row.uid || '');
    if (!uid) continue;
    const ts = Number(row.ts) || 0;
    const list = hist[uid] || (hist[uid] = []);
    if (list.some((p) => localDay(p[0]) === localDay(ts))) continue;
    list.push([ts, Number(row.remaining) || 0]);
    added++;
  }
  for (const uid of Object.keys(hist)) hist[uid].sort((a, b) => a[0] - b[0]);
  return { hist, added };
}

/**
 * 账号余额快照合并。
 *
 * 余额是「当前值」不是累加量，所以取官方 updatedAt 更大的一条——但 login 例外：
 * 它是「本机装了哪些客户端、凭证何时到期」这种机器本地事实，被远端覆盖会让
 * 本机的登录徽标显示成别人的状态。所以 login 永远保留本机值。
 */
function planAcctMerge(localAcct, remoteRows) {
  const byUid = new Map();
  for (const a of localAcct || []) {
    if (a && a.uid) byUid.set(String(a.uid), { ...a });
  }

  let added = 0, updated = 0;
  for (const row of remoteRows) {
    const uid = String(row.uid || '');
    if (!uid) continue;
    const theirs = Number(row.official_updated_at) || 0;
    const cur = byUid.get(uid);

    if (!cur) {
      // 本机没登录这个账号，login 只能是 null
      byUid.set(uid, {
        uid,
        name: row.name || '',
        total: Number(row.total) || 0,
        remaining: Number(row.remaining) || 0,
        used: Number(row.used) || 0,
        packages: row.packages || [],
        login: null,
        updatedAt: theirs,
      });
      added++;
      continue;
    }

    if (theirs > (Number(cur.updatedAt) || 0)) {
      byUid.set(uid, {
        ...cur,                                   // login 保持本机值
        name: row.name || cur.name,
        total: Number(row.total) || 0,
        remaining: Number(row.remaining) || 0,
        used: Number(row.used) || 0,
        packages: row.packages || cur.packages,
        updatedAt: theirs,
      });
      updated++;
    }
  }
  return { acct: [...byUid.values()], added, updated };
}

/** 会话标题合并：本地有则保留，本地空才用远端。 */
function planTitleMerge(localTi, remoteRows) {
  const ti = { ...(localTi || {}) };
  let added = 0;
  for (const row of remoteRows) {
    const sid = String(row.session_id || '');
    const title = String(row.title || '');
    if (!sid || !title || ti[sid]) continue;
    ti[sid] = title;
    added++;
  }
  return { ti, added };
}

// ============================================================ 拉取编排

/**
 * 拉取各表并合并进本地数据。
 *
 * 各表独立游标（首次为 undefined → 全量拉）。bt_turns 按 machine_id 排除自己：
 * 那是唯一一张自己有主键分片的表，几万行全量拉回自己纯属浪费。其余表没有这个
 * 过滤——bt_bills 的 machine_id 可以为 null（未标注），用 neq 会把 null 行一起
 * 排除掉（SQL 里 null <> 'x' 不为真），反而让未标注的账单永远拉不回来。
 */
async function pullAndMerge(cfg, data, state, machineId, stat) {
  const cur = state.lastPull || {};

  // ---- 回合
  const remoteTurns = await selectAll(cfg, 'bt_turns', {
    cursor: cur.turns,
    filter: machineId ? 'machine_id=neq.' + encodeURIComponent(machineId) : '',
    order: 'updated_at.asc,turn_key.asc',
  });
  const turnPlan = planTurnMerge(data.t || {}, remoteTurns);
  Object.assign(data.t || (data.t = {}), turnPlan.added);
  stat.pulled.turns = remoteTurns.length;
  stat.merged.turns = Object.keys(turnPlan.added).length;

  // ---- 账单
  const remoteBills = await selectAll(cfg, 'bt_bills', {
    cursor: cur.bills,
    order: 'updated_at.asc,request_id.asc',
  });
  const billPlan = planBillMerge(data.bill || [], data.uids || [], remoteBills);
  data.bill = billPlan.bill;
  data.uids = billPlan.uids;
  stat.pulled.bills = remoteBills.length;
  stat.merged.bills = billPlan.added;

  // ---- 余额历史
  const remoteHist = await selectAll(cfg, 'bt_hist', {
    cursor: cur.hist,
    order: 'updated_at.asc,uid.asc,day.asc',
  });
  const histPlan = planHistMerge(data.hist || {}, remoteHist);
  data.hist = histPlan.hist;
  stat.pulled.hist = remoteHist.length;
  stat.merged.hist = histPlan.added;

  // ---- 账号余额
  const remoteAcct = await selectAll(cfg, 'bt_acct', {
    cursor: cur.acct,
    order: 'updated_at.asc,uid.asc',
  });
  const acctPlan = planAcctMerge(data.acct || [], remoteAcct);
  data.acct = acctPlan.acct;
  stat.pulled.acct = remoteAcct.length;
  stat.merged.acct = acctPlan.added + acctPlan.updated;

  // ---- 会话标题
  const remoteTitles = await selectAll(cfg, 'bt_titles', {
    cursor: cur.titles,
    order: 'updated_at.asc,session_id.asc',
  });
  const titlePlan = planTitleMerge(data.ti || {}, remoteTitles);
  data.ti = titlePlan.ti;
  stat.pulled.titles = remoteTitles.length;
  stat.merged.titles = titlePlan.added;

  // ---- 机器名册（无游标，量小，每轮全量）
  const machines = await selectAll(cfg, 'bt_machines', { order: 'machine_id.asc' });
  const map = { ...(data.machines || {}) };
  for (const m of machines) {
    if (m && m.machine_id) map[m.machine_id] = m.machine_name || '';
  }
  data.machines = map;

  // ---- 游标统一推进：整轮拉完才推，避免同毫秒的行在分页边界被跳过
  const nextPull = { ...cur };
  const advanced = {
    turns: maxUpdated(remoteTurns),
    bills: maxUpdated(remoteBills),
    hist: maxUpdated(remoteHist),
    acct: maxUpdated(remoteAcct),
    titles: maxUpdated(remoteTitles),
  };
  for (const [k, v] of Object.entries(advanced)) {
    if (v) nextPull[k] = v;
  }
  return nextPull;
}

/** 一批行里最大的 updated_at（没有则返回空串，表示不推进）。 */
function maxUpdated(rows) {
  let max = '';
  for (const r of rows) {
    const v = r && r.updated_at ? String(r.updated_at) : '';
    if (v > max) max = v;
  }
  return max;
}

// ============================================================ 主流程

/** 按合并后的回合表重算 meta（沿用 report.js syncCreditsOnly 里的算法）。 */
function recalcMeta(data) {
  const t = data.t || {};
  let reqs = 0, from = 0, to = 0;
  for (const v of Object.values(t)) {
    reqs += v.n || 0;
    if (v.t0 && (!from || v.t0 < from)) from = v.t0;
    if (v.t1 && v.t1 > to) to = v.t1;
  }
  data.meta = data.meta || {};
  data.meta.turns = Object.keys(t).length;
  data.meta.reqs = reqs;
  if (from) data.meta.from = from;
  if (to) data.meta.to = to;
}

/**
 * 把远端余额历史并回 credit-history.json。
 *
 * 为什么必须做：报告脚本每轮刷积分都会 `data.hist = loadCreditHistory().byUid`，
 * 是从这个文件整体读出来的。若只把远端历史并进数据文件，下一轮刷积分就会用
 * 本机这份小历史把它整体覆盖掉——远端拉回来的记录全没了，违反只增不减。
 */
function writeCreditHistoryBack(hist) {
  let cur = { v: 1, byUid: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(CREDIT_HISTORY_FILE, 'utf8'));
    if (raw && typeof raw === 'object') cur = raw;
  } catch { /* 文件缺失或损坏：按空历史起步 */ }

  const byUid = (cur.byUid && typeof cur.byUid === 'object') ? cur.byUid : {};
  let changed = false;
  for (const [uid, list] of Object.entries(hist || {})) {
    if (!Array.isArray(list)) continue;
    const mine = Array.isArray(byUid[uid]) ? byUid[uid] : (byUid[uid] = []);
    for (const p of list) {
      if (!Array.isArray(p) || !p[0]) continue;
      if (mine.some((q) => localDay(q[0]) === localDay(p[0]))) continue;
      mine.push([p[0], p[1]]);
      changed = true;
    }
    mine.sort((a, b) => a[0] - b[0]);
  }

  if (changed) {
    try {
      fs.writeFileSync(CREDIT_HISTORY_FILE, JSON.stringify({ ...cur, byUid }), 'utf8');
    } catch { /* 写不进去不影响主流程 */ }
  }
  return changed;
}

/**
 * 跑一轮云同步。
 *
 * 顺序不能反：先推后拉。反过来的话，本机刚跑完 report 生成的新数据要等下一轮
 * 才上云；而先推后拉能让同一轮里「本机新数据已上传、别人的数据也拉回来了」。
 *
 * 返回结构供 server.js 记录到状态里（页面的排障面板会看）。
 */
async function runCloudSync(opt = {}) {
  const dryRun = !!opt.dryRun;
  const doPush = opt.push !== false;
  const doPull = opt.pull !== false;

  const cfg = loadConfig();
  if (!cfg) return { ok: false, skipped: true, reason: '未找到 sync-config.json' };
  if (!cfg.enabled) return { ok: false, skipped: true, reason: '云同步未启用（enabled=false）' };
  if (!cfg.url || !cfg.anonKey) {
    return { ok: false, skipped: true, reason: 'sync-config.json 缺少 url 或 anonKey' };
  }

  // 数据文件不存在 ≠ 数据文件损坏，两者要区别对待：
  //   · 不存在：新机器 clone 下来还没跑过本地同步。用空骨架继续，这样第一轮云同步
  //     就能把别的机器的数据拉回来，不必先手动点一次「⚡ 一键同步」生成文件。
  //   · 存在但解析失败：可能只是写到一半被打断。一律跳过、绝不覆盖——那是本机
  //     唯一的数据副本，宁可这轮不同步，也不能拿空骨架把它盖掉。
  let data, header;
  if (fs.existsSync(DATA_FILE)) {
    const loaded = loadDataFile(DATA_FILE);
    if (!loaded) {
      return { ok: false, error: 'token-usage-data.js 存在但解析失败，本轮跳过（不覆盖它）' };
    }
    ({ data, header } = loaded);
  } else {
    data = {
      v: 1, gen: Date.now(),
      meta: { turns: 0, reqs: 0, from: 0, to: 0, sources: [], light: false },
      t: {}, ti: {},
    };
    header = '/* 由 cloud-sync.js 创建：本机还没跑过本地同步，数据来自云端 */\n';
  }

  const machineId = getMachineId();
  const state = loadState();

  const stat = { pushed: {}, pulled: {}, merged: {}, keptLocal: 0 };
  const started = Date.now();

  // ---------------------------------------------------------- 推送
  if (doPush) {
    const turnRows = buildTurnRows(data, machineId, state, cfg);
    const billRows = buildBillRows(data, state, cfg);
    const histRows = buildHistRows(data, machineId);
    const acctRows = buildAcctRows(data, machineId);
    const titleRows = buildTitleRows(data, machineId);

    stat.pushed = {
      turns: turnRows.length, bills: billRows.length, hist: histRows.length,
      acct: acctRows.length, titles: titleRows.length,
    };

    if (!dryRun) {
      await upsertRows(cfg, 'bt_turns', turnRows, 'machine_id,turn_key');
      await upsertRows(cfg, 'bt_bills', billRows, 'request_id');
      await upsertRows(cfg, 'bt_hist', histRows, 'uid,day');
      await upsertRows(cfg, 'bt_acct', acctRows, 'uid');
      await upsertRows(cfg, 'bt_titles', titleRows, 'session_id');
      await upsertRows(cfg, 'bt_machines', [{
        machine_id: machineId,
        machine_name: cfg.machineName || os.hostname(),
        platform: process.platform,
        last_seen: new Date().toISOString(),
      }], 'machine_id');

      // 水位线只涨不落：涨到本机当前的最大 t1 / 账单时间
      let maxT1 = state.lastPushMaxT1 || 0;
      for (const r of turnRows) if (r.t1 > maxT1) maxT1 = r.t1;
      let maxBill = state.lastPushBillTime || 0;
      for (const r of billRows) if (r.request_time > maxBill) maxBill = r.request_time;
      state.lastPushMaxT1 = maxT1;
      state.lastPushBillTime = maxBill;
    }
  }

  // ---------------------------------------------------------- 拉取 + 合并
  if (doPull) {
    const nextPull = await pullAndMerge(cfg, data, state, machineId, stat);
    if (!dryRun) state.lastPull = nextPull;
    recalcMeta(data);
  }

  // ---------------------------------------------------------- 落盘
  const stamp = fmtTime(new Date());
  const summary = `回合 +${fmt(stat.merged.turns || 0)} · 账单 +${fmt(stat.merged.bills || 0)} · ` +
    `账号 ${data.acct ? data.acct.length : 0} 个 · 共 ${fmt(data.meta ? data.meta.turns : 0)} 回合`;
  const note = header.includes('云同步：')
    ? header
    : header + `/* 云同步：${stamp} · ${summary} */\n`;

  if (!dryRun) {
    saveDataFile(DATA_FILE, note, data);
    writeCreditHistoryBack(data.hist);
    state.lastRunAt = Date.now();
    state.lastResult = `ok ${summary}`;
    saveState(state);
  }

  return {
    ok: true,
    dryRun,
    machineId,
    machineName: cfg.machineName || os.hostname(),
    elapsedMs: Date.now() - started,
    pushed: stat.pushed,
    pulled: stat.pulled,
    merged: stat.merged,
    turnsTotal: data.meta ? data.meta.turns : 0,
    billsTotal: data.bill ? data.bill.length : 0,
    machines: Object.keys(data.machines || {}).length,
  };
}

// ============================================================ CLI

function printResult(r) {
  if (r.skipped) {
    console.log(`  [云同步] 跳过：${r.reason}`);
    return;
  }
  if (!r.ok) {
    console.log(`  [云同步] 失败：${r.error || '未知错误'}`);
    return;
  }
  const p = r.pushed || {}, m = r.merged || {};
  console.log(`  [云同步] 机器「${r.machineName}」` + (r.dryRun ? '（试运行，未落盘）' : '') +
    ` · 耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`    推送：回合 ${fmt(p.turns || 0)} · 账单 ${fmt(p.bills || 0)} · ` +
    `历史 ${fmt(p.hist || 0)} · 账号 ${fmt(p.acct || 0)} · 标题 ${fmt(p.titles || 0)}`);
  console.log(`    合并：回合 +${fmt(m.turns || 0)} · 账单 +${fmt(m.bills || 0)} · ` +
    `标题 +${fmt(m.titles || 0)} · 账号 ${fmt(m.acct || 0)} · 机器 ${r.machines} 台`);
  console.log(`    汇总：${fmt(r.turnsTotal)} 个回合 · ${fmt(r.billsTotal)} 条账单`);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const onlyPull = argv.includes('--pull');
  const onlyPush = argv.includes('--push');
  try {
    // 没有配置文件就先补一份模板出来（让新机器知道要去哪儿填）
    ensureConfigTemplate();
    // 配了代理就先带代理环境重跑自己——Node 的 fetch 只在进程启动时读代理变量
    reexecWithProxyIfNeeded(loadConfig());

    const r = await runCloudSync({ dryRun, push: !onlyPull, pull: !onlyPush });
    printResult(r);
    process.exit(r.ok || r.skipped ? 0 : 1);
  } catch (e) {
    console.error(`  [云同步] 失败：${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  // 供 server.js 调用
  runCloudSync,
  loadConfig,
  loadState,
  isEnabled,
  proxyEnv,
  ensureConfigTemplate,
  // 供 token-usage-report.js 调用（只取本机标识，不触发网络）
  getMachineId,
  // 供自测脚本直接验证合并规则（纯函数，不碰网络与文件）
  planTurnMerge,
  planBillMerge,
  planHistMerge,
  planAcctMerge,
  planTitleMerge,
  rowToTurn,
  localDay,
  loadDataFile,
  DATA_FILE,
  CONFIG_FILE,
  STATE_FILE,
};
