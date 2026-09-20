/**
 * WorkBuddy / CodeBuddy 官方接口封装（零依赖，仅用 Node 内置能力）。
 *
 * 只做三件事：
 *   1. 从本机登录态里发现账号（可能多个）
 *   2. 拉取账号的积分账单明细（替代手动导出 Excel）
 *   3. 查询账号的积分余额与到期时间
 *
 * 认证方式：读 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`，
 * 每个快照是一份登录态，按 uid 去重后取最新的一份即当前有效凭证。
 *
 * 隐私约束：账单接口的响应里带 `input`（提问正文），本模块**只提取**
 * 白名单字段（requestId / credit / model / client / requestTime），
 * 正文一律丢弃，绝不写盘。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- 常量

/** 登录态快照目录（WorkBuddy 桌面端写入）。 */
const AUTH_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
  'CodeBuddyExtension', 'Data', 'Public', 'auth'
);

/** 接口基址：账单与积分都在 web 域下（与 token 签发域一致）。 */
const BASE = 'https://www.workbuddy.cn';

/**
 * 积分活动（签到、猫猫旅行）走的是另一个域。
 * 实测账单在 workbuddy.cn、活动在 codebuddy.cn，混用会被网关拒。
 */
const ACTIVITY_BASE = 'https://www.codebuddy.cn';

const PATH_BILLING = '/billing/meter/get-user-request-usage';
const PATH_RES_SUMMARY = '/billing/meter/get-user-resource-summary';
const PATH_RES_PAID = '/billing/meter/get-user-resource-paid-packages';
const PATH_RES_FREE = '/billing/meter/get-user-resource-free-packages';
const PATH_REFRESH = '/v2/plugin/auth/token/refresh';

// ---- 积分活动（签到 / 猫猫旅行），基址是 ACTIVITY_BASE ----
const PATH_CHECKIN_STATUS = '/v2/billing/meter/checkin-activity-status';
const PATH_CHECKIN_DO = '/v2/billing/meter/daily-checkin';
const PATH_TRAVEL_CONFIG = '/activity/growth/buddy/travel/config';
const PATH_TRAVEL_STATUS = '/activity/growth/buddy/travel/status';
const PATH_TRAVEL_DEPART = '/activity/growth/buddy/travel/depart';
const PATH_TRAVEL_CLAIM = '/activity/growth/buddy/travel/claim';

/** 服务端单次最多返回的条数（超过即静默截断，且是从窗口起点开始取）。 */
const PAGE_SIZE = 3000;
/** 账单查询窗口上限：超过约 31 天服务端返回空，故按此切分。 */
const MAX_WINDOW_DAYS = 30;
/** 分页推进的安全上限，防御服务端异常导致的死循环。 */
const MAX_ROUNDS = 100;

/** 官方客户端使用的套餐码清单（多带不存在的码无副作用）。 */
const PAID_PACKAGE_CODES = [
  'TCACA_code_002_AkiJS3ZHF5', 'TCACA_code_023_4xbGhMrE6q',
  'TCACA_code_026_BaESVICNoi', 'TCACA_code_027_0FCGVA6vSa',
  'TCACA_code_009_0XmEQc2xOf', 'TCACA_code_038_OhvqZtiPKr',
  'TCACA_code_003_FAnt7lcmRT', 'TCACA_code_036_lupO5WgNdG',
];
const FREE_PACKAGE_CODES = [
  'TCACA_code_008_cfWoLwvjU4', 'TCACA_code_007_nzdH5h4Nl0',
  'TCACA_code_028_NtpWi0jzXs', 'TCACA_code_029_6wCGEWquYy',
  'TCACA_code_030_BjSt89qTvr', 'TCACA_code_001_PqouKr6QWV',
  'TCACA_code_006_DbXS0lrypC', 'TCACA_code_035_ArVxJcGDsm',
  'TCACA_code_037_WxOD3MpI2o', 'TCACA_code_039_KRcQj7wUat',
  'TCACA_code_040_mi9rCYg46x',
];

/** 剩余不足该天数即视为「即将到期」。 */
const EXPIRING_SOON_DAYS = 7;
/**
 * 到期时间覆盖阈值：DeductionEndTime 比 CycleEndTime 晚超过一年时，
 * 视为长期占位值，改用周期结束时间。
 */
const EXPIRY_CYCLE_OVERRIDE_DAYS = 365;
/** 距今超过该天数的到期时间视为「长期有效」，不展示。 */
const FAR_FUTURE_EXPIRY_DAYS = 730;

// ---------------------------------------------------------------- 工具

const pad = (n) => String(n).padStart(2, '0');

/** Date → `YYYY-MM-DD HH:mm:ss`（服务端要求的本地时间格式）。 */
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 数值型字段可能是字符串（服务端返回 "3097.23"），统一转数字。 */
function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** 从候选键里取第一个能转成数字的值。 */
function pickNum(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const n = num(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

/** 从候选键里取第一个非空值。 */
function pickValue(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/** 按点分路径取嵌套值。 */
function atPath(obj, pathArr) {
  let cur = obj;
  for (const key of pathArr) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// ---------------------------------------------------------------- 账号发现

/**
 * 扫描登录态目录，按 uid 去重并各取最新的一份快照。
 *
 * 快照目录会同时保留多个账号的历史登录态（切换账号时旧文件不会删除），
 * 因此这里是「多账号」的唯一来源，不需要用户手动录入任何 token。
 */
function discoverAccounts() {
  let files;
  try {
    files = fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith('.info'));
  } catch {
    return [];
  }

  const byUid = new Map();
  for (const file of files) {
    const full = path.join(AUTH_DIR, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;   // 半写入或损坏的快照直接跳过
    }
    const account = raw.account || {};
    const auth = raw.auth || {};
    const uid = account.uid || raw.uid;
    const accessToken = auth.accessToken || account.accessToken || raw.accessToken;
    if (!uid || !accessToken) continue;

    const mtime = fs.statSync(full).mtimeMs;
    const prev = byUid.get(uid);
    if (prev && prev._mtime >= mtime) continue;

    byUid.set(uid, {
      _mtime: mtime,
      uid,
      /** 展示名：昵称优先，缺失时退化为 uid 前 8 位。 */
      name: account.nickname || String(uid).slice(0, 8),
      accessToken,
      refreshToken: auth.refreshToken || '',
      domain: auth.domain || '',
      expiresAt: num(auth.expiresAt) || 0,
      /** 凭证来源文件名，便于排查。 */
      source: file,
    });
  }

  return [...byUid.values()].map(({ _mtime, ...rest }) => rest);
}

// ---------------------------------------------------------------- 账号归属

/** WorkBuddy 桌面端的 SQLite 库（会话元数据）。 */
const WB_DB = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');

/**
 * 读「会话 ID → 账号 uid」映射，用于给本地回合标注账号归属。
 *
 * 为什么需要它：本地 jsonl 里**完全没有**账号字段（实测 400 条记录确认），
 * 但桌面端把会话元数据写在 workbuddy.db 的 sessions 表里，user_id 正是账号 uid。
 *
 * 覆盖边界：只含 WorkBuddy 桌面端会话；CodeBuddy CLI 的会话不在库里
 * （`~/.codebuddy` 下没有任何 .db），那部分靠账单 requestId 反向标注补。
 *
 * `node:sqlite` 是 Node 22.5+ 的实验特性，低版本下静默返回空映射。
 */
function readSessionsFromDb() {
  let DatabaseSync;
  try {
    // node:sqlite 会打一条 ExperimentalWarning，脚本输出里很吵，这里只静音加载那一瞬
    const origEmit = process.emitWarning;
    process.emitWarning = () => {};
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } finally {
      process.emitWarning = origEmit;
    }
  } catch {
    return {};   // Node 版本过低，降级
  }
  if (!fs.existsSync(WB_DB)) return {};

  let db = null;
  try {
    db = new DatabaseSync(WB_DB, { readOnly: true });
    const rows = db
      .prepare("SELECT id, user_id FROM sessions WHERE user_id IS NOT NULL AND user_id <> ''")
      .all();
    const map = {};
    for (const r of rows) {
      if (r.id && r.user_id) map[String(r.id)] = String(r.user_id);
    }
    return map;
  } catch {
    return {};   // 库被占用 / 结构变化，都不该影响主流程
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 余额快照

/**
 * 积分余额的历史观察值。
 *
 * 官方接口**只返回当前余额，不提供历史序列**，所以要画趋势只能自己攒：
 * 每次同步成功后记一条（同一账号同一天只留最后一条），据此还原「余额怎么掉的」。
 *
 * 存在项目目录下（与其它产物一起被 .gitignore 排除）；文件损坏或缺失都当空历史处理。
 */
const CREDIT_HISTORY_FILE = path.join(__dirname, 'credit-history.json');
/** 每个账号保留的天数，避免文件无限增长。 */
const CREDIT_HISTORY_DAYS = 120;

const localDate = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 读历史快照。结构：{ v:1, byUid: { uid: [[ts, remaining], ...] } } */
function loadCreditHistory() {
  try {
    const raw = fs.readFileSync(CREDIT_HISTORY_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (d && d.byUid && typeof d.byUid === 'object') return d;
  } catch { /* 首次运行或文件损坏 */ }
  return { v: 1, byUid: {} };
}

/**
 * 把本次查到的余额并入历史：同账号同一天只保留最后一条，并裁剪过期数据。
 * 返回是否发生了写入。
 */
function recordCreditHistory(credits, now) {
  const at = now || Date.now();
  const today = localDate(at);
  const cutoff = at - CREDIT_HISTORY_DAYS * 86400000;
  const hist = loadCreditHistory();
  let changed = false;

  for (const c of credits || []) {
    if (!c || !c.ok || !c.uid) continue;
    const remaining = Math.round(c.totalRemaining || 0);
    const list = hist.byUid[c.uid] || (hist.byUid[c.uid] = []);

    // 同一天已有记录就覆盖（保留当天最后一次观察）
    const last = list[list.length - 1];
    if (last && localDate(last[0]) === today) {
      if (last[1] !== remaining) {
        last[1] = remaining;
        changed = true;
      }
    } else {
      list.push([at, remaining]);
      changed = true;
    }

    // 裁剪过期点
    const kept = list.filter((p) => p[0] >= cutoff);
    if (kept.length !== list.length) changed = true;
    hist.byUid[c.uid] = kept;
  }

  if (changed) {
    try {
      fs.writeFileSync(CREDIT_HISTORY_FILE, JSON.stringify(hist), 'utf8');
    } catch { /* 写失败不影响同步 */ }
  }
  return changed;
}

/**
 * 签到日期本地累积。
 *
 * `checkin-activity-status` 每次只回最近若干天的签到日期（实测 5 条），而且随活动
 * 赛季重置——所以单次查询看不到完整历史。把每次查到的日期按 uid 去重并入本地，
 * 签到日历才能显示比单次返回更长的记录。
 *
 * 存在项目目录下（与其它产物一起被 .gitignore 排除）；文件损坏或缺失都当空历史处理。
 */
const CHECKIN_HISTORY_FILE = path.join(__dirname, 'checkin-history.json');
/** 每个账号保留的天数，避免文件无限增长。 */
const CHECKIN_HISTORY_DAYS = 400;

/** 读累积的签到日期。结构：{ v:1, byUid: { uid: ["YYYY-MM-DD", ...] } }（升序） */
function loadCheckinHistory() {
  try {
    const d = JSON.parse(fs.readFileSync(CHECKIN_HISTORY_FILE, 'utf8'));
    if (d && d.byUid && typeof d.byUid === 'object') return d;
  } catch { /* 首次运行或文件损坏 */ }
  return { v: 1, byUid: {} };
}

/**
 * 把本次查到的签到日期并入本地历史，返回该账号累积后的完整日期数组（升序）。
 * 只动本工具自己的缓存文件，不改服务端任何状态。
 */
function recordCheckinDates(uid, dates, now) {
  if (!uid) return [];
  const at = now || Date.now();
  const hist = loadCheckinHistory();
  const cutoff = localDate(at - CHECKIN_HISTORY_DAYS * 86400000);
  const prev = hist.byUid[uid] || [];

  const set = new Set(prev);
  for (const d of dates || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) set.add(String(d));
  }
  const list = [...set].filter((d) => d >= cutoff).sort();

  if (list.length !== prev.length || list.some((d, i) => d !== prev[i])) {
    hist.byUid[uid] = list;
    try {
      fs.writeFileSync(CHECKIN_HISTORY_FILE, JSON.stringify(hist), 'utf8');
    } catch { /* 写失败不影响查询 */ }
  }
  return list;
}

// ---------------------------------------------------------------- 请求

/** 组装认证与网关头（缺失时网关会把请求判为未知客户端而拒绝）。 */
function authHeaders(acct) {
  return {
    Authorization: `Bearer ${acct.accessToken}`,
    'X-User-Id': acct.uid,
    'X-Client-Platform': 'web',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: BASE,
    Referer: `${BASE}/profile/plans-usage`,
  };
}

/** 单次 POST，返回解析后的 JSON（解析失败返回 null）。 */
async function postOnce(acct, p, body) {
  try {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: authHeaders(acct),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;   // 网络层失败交由调用方按「不可用」处理
  }
}

const isOk = (j) => !!j && (j.code === 0 || j.code === 200);
const isUnauthorized = (j) => {
  if (!j) return false;
  const code = j.code;
  // 401/403 与业务码 10085 都表示凭证失效
  return code === 401 || code === 403 || code === 10085;
};

/**
 * 用 refresh token 换新的 access token。
 *
 * 必须带 `X-Auth-Refresh-Source: plugin`：缺失时网关会把这次刷新
 * 判定成另一个 client 来源并拒绝。
 */
async function refreshAccount(acct) {
  if (!acct.refreshToken) return null;
  let j;
  try {
    const res = await fetch(BASE + PATH_REFRESH, {
      method: 'POST',
      headers: { ...authHeaders(acct), 'X-Refresh-Token': acct.refreshToken, 'X-Auth-Refresh-Source': 'plugin' },
      body: '{}',
    });
    j = JSON.parse(await res.text());
  } catch {
    return null;
  }
  if (!isOk(j)) return null;

  const data = j.data || {};
  const accessToken = data.accessToken || data.access_token;
  if (!accessToken) return null;

  return {
    ...acct,
    accessToken,
    refreshToken: data.refreshToken || data.refresh_token || acct.refreshToken,
    expiresAt: num(data.expiresAt) ||
      (num(data.expiresIn) ? Date.now() + num(data.expiresIn) * 1000 : acct.expiresAt),
  };
}

/**
 * 带认证的 POST：遇到未授权自动刷新一次并重试。
 *
 * 返回 `{ json, account }`——`account` 可能是刷新后的新凭证，
 * 调用方应沿用它做后续请求，避免重复刷新（旧 refresh token 会失效）。
 */
async function authedPost(acct, p, body) {
  let working = acct;
  let json = await postOnce(working, p, body);

  if (isUnauthorized(json) && working.refreshToken) {
    const refreshed = await refreshAccount(working);
    if (refreshed) {
      working = refreshed;
      json = await postOnce(working, p, body);
    }
  }
  return { json, account: working };
}

// ---------------------------------------------------------------- 账单

/**
 * 拉取一个账号在指定窗口内的账单明细。
 *
 * 两个必须绕开的服务端行为：
 *   1. `data.total` 会被一起截断（31 天窗口固定回报 3000），不可当总数用；
 *   2. 单次最多 3000 条，且**从窗口起点往新取**——直接拉一次会静默丢掉最新数据。
 *
 * 因此按「取回本页最新时间 → 作为下一轮 startTime」推进，直到不再增长。
 *
 * 返回的记录只含白名单字段，提问正文（`input`）一律丢弃。
 */
async function fetchBilling(acct, startDate, endDate, onProgress) {
  const endTime = fmtLocal(new Date(endDate));
  let startTime = fmtLocal(new Date(startDate));
  let working = acct;

  const seen = new Set();
  const rows = [];
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    const { json, account } = await authedPost(working, PATH_BILLING, {
      startTime, endTime, pageNum: 1, pageSize: PAGE_SIZE,
    });
    working = account;

    if (!isOk(json)) {
      return {
        ok: false,
        error: (json && (json.msg || json.message)) || '账单接口不可用',
        rows, account: working,
      };
    }

    const page = (json.data && json.data.data) || [];
    if (!page.length) break;

    let added = 0;
    let newest = 0;
    for (const r of page) {
      const requestId = String(r.requestId || r.request_id || '').trim();
      const requestTime = String(r.requestTime || r.request_time || '');
      if (!requestId) continue;
      const ts = Date.parse(requestTime.replace(' ', 'T'));
      if (ts > newest) newest = ts;

      const key = requestId + '|' + requestTime;
      if (seen.has(key)) continue;
      seen.add(key);
      added++;
      // 白名单提取：只保留这五个字段，正文与其余内容不进入内存结构
      rows.push({
        requestId,
        credit: num(r.credit) || 0,
        model: r.model || '',
        client: r.client || '',
        requestTime,
      });
    }

    if (onProgress) onProgress(rows.length, page.length);

    // 停滞（没有新增，或时间无法前进）即停止，避免死循环
    if (!added || !newest) break;
    const next = fmtLocal(new Date(newest));
    if (next === startTime) break;
    startTime = next;
    rounds++;
  }

  return { ok: true, rows, account: working };
}

/**
 * 拉取多个账号的账单，按窗口上限自动切分时间段。
 *
 * 返回 `{ byAccount, all, errors }`，`all` 是合并后的明细（带 accountKey 标注）。
 */
async function fetchBillingForAccounts(accounts, sinceMs, onProgress) {
  const byAccount = new Map();
  const all = [];
  const errors = [];

  const end = Date.now();
  for (const acct of accounts) {
    const collected = [];
    // 窗口切分：服务端对超过约 31 天的窗口直接返回空
    let cursor = sinceMs;
    while (cursor < end) {
      const windowEnd = Math.min(cursor + MAX_WINDOW_DAYS * 86400000, end);
      const r = await fetchBilling(acct, cursor, windowEnd, onProgress);
      if (!r.ok) {
        errors.push({ account: acct.name, uid: acct.uid, error: r.error });
        break;
      }
      collected.push(...r.rows);
      cursor = windowEnd + 1000;
    }
    byAccount.set(acct.uid, collected);
    for (const row of collected) {
      all.push({ ...row, uid: acct.uid, account: acct.name });
    }
  }

  return { byAccount, all, errors };
}

// ---------------------------------------------------------------- 积分余额

/** 到期时间解析：口径见 EXPIRY_CYCLE_OVERRIDE_DAYS / FAR_FUTURE_EXPIRY_DAYS。 */
function resolveExpireAt(raw, now) {
  const deductionEnd = num(pickValue(raw, ['DeductionEndTime', 'deductionEndTime', 'ExpiredTime', 'expiredTime']));
  const cycleEndRaw = pickValue(raw, ['CycleEndTime', 'cycleEndTime']);
  const cycleEnd = cycleEndRaw ? Date.parse(String(cycleEndRaw).replace(' ', 'T')) : null;

  let expireAt = null;
  if (deductionEnd && cycleEnd && deductionEnd - cycleEnd > EXPIRY_CYCLE_OVERRIDE_DAYS * 86400000) {
    expireAt = cycleEnd;              // DeductionEndTime 是长期占位，改用周期结束
  } else if (deductionEnd) {
    expireAt = deductionEnd;
  } else {
    expireAt = cycleEnd;
  }

  // 距今超过两年视为「长期有效」，不作为到期提醒
  if (expireAt && expireAt - now > FAR_FUTURE_EXPIRY_DAYS * 86400000) return null;
  return expireAt || null;
}

/** 把一份套餐原始记录归一化成统一结构。 */
function normalizeResource(raw, now) {
  const slice = pickValue(raw, ['SlicePeriodUsageDetails', 'slicePeriodUsageDetails']);
  const sliceFirst = Array.isArray(slice) ? slice[0] : null;

  const totalKeys = ['CycleCapacitySizePrecise', 'CycleCapacitySize', 'CycleTotalCapacity',
    'CapacitySizePrecise', 'CapacitySize', 'SlicePeriodCapacitySizePrecise', 'SlicePeriodCapacitySize'];
  const remainKeys = ['CycleCapacityRemainPrecise', 'CycleCapacityRemain', 'CycleRemainCapacity',
    'CapacityRemainPrecise', 'CapacityRemain', 'SlicePeriodCapacityRemainPrecise', 'SlicePeriodCapacityRemain'];
  const usedKeys = ['CycleCapacityUsedPrecise', 'CycleCapacityUsed', 'CycleUsedCapacity',
    'CapacityUsedPrecise', 'CapacityUsed', 'SlicePeriodCapacityUsedPrecise', 'SlicePeriodCapacityUsed'];

  const rawTotal = pickNum(raw, totalKeys) ?? pickNum(sliceFirst, totalKeys);
  const rawRemain = pickNum(raw, remainKeys) ?? pickNum(sliceFirst, remainKeys);
  const rawUsed = pickNum(raw, usedKeys) ?? pickNum(sliceFirst, usedKeys);

  const total = Math.max(0, rawTotal ?? (rawRemain !== null && rawUsed !== null ? rawRemain + rawUsed : rawRemain ?? rawUsed ?? 0));
  const remaining = Math.max(0, rawRemain ?? Math.max(0, total - (rawUsed ?? 0)));
  const used = Math.max(0, rawUsed ?? Math.max(0, total - remaining));

  const expireAt = resolveExpireAt(raw, now);
  return {
    packageCode: pickValue(raw, ['PackageCode', 'packageCode']) || '',
    packageName: pickValue(raw, ['PackageName', 'packageName']) || '',
    total, remaining, used,
    expireAt,
    expired: expireAt ? expireAt <= now : false,
    expiringSoon: expireAt ? (expireAt > now && expireAt - now <= EXPIRING_SOON_DAYS * 86400000) : false,
  };
}

/** 响应里套餐列表的嵌套位置有多种历史形态，逐个尝试。 */
function extractList(json, key) {
  const paths = key === 'Packages'
    ? [['data', 'Packages'], ['data', 'data', 'Packages'], ['data', 'Response', 'Data', 'Packages'],
      ['data', 'data', 'Response', 'Data', 'Packages'], ['data', 'packages'], ['data', 'data', 'packages']]
    : [['data', 'Accounts'], ['data', 'data', 'Accounts'], ['data', 'Response', 'Data', 'Accounts'],
      ['data', 'data', 'Response', 'Data', 'Accounts'], ['data', 'accounts'], ['data', 'data', 'accounts']];
  for (const p of paths) {
    const v = atPath(json, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** 同 PackageCode 的套餐去重合并：明细（含到期时间）优先于 summary。 */
function mergeResources(summaryList, detailList) {
  const detailCodes = new Set(detailList.map((r) => r.packageCode).filter(Boolean));
  const merged = detailList.slice();
  for (const s of summaryList) {
    if (s.packageCode && detailCodes.has(s.packageCode)) continue;   // 已有更详细的记录
    merged.push(s);
  }
  return merged;
}

/**
 * 查询单个账号的积分余额与到期时间。
 *
 * 国内版走 summary + paid + free 三路（并发），任一路未授权则刷新 token 后重试。
 */
async function fetchCredit(acct) {
  const now = Date.now();
  const today = new Date();
  const dayStart = fmtLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0));
  const dayEnd = fmtLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59));

  let working = acct;
  const call = async (p, body) => {
    const r = await authedPost(working, p, body);
    working = r.account;
    return r.json;
  };

  let [summary, paid, free] = await Promise.all([
    call(PATH_RES_SUMMARY, {}),
    call(PATH_RES_PAID, {
      PageNumber: 1, PageSize: 200, Status: [0, 3],
      PackageCodes: PAID_PACKAGE_CODES, NeedRenewInfo: true,
    }),
    call(PATH_RES_FREE, {
      PageNumber: 1, PageSize: 200, Status: [0, 3],
      SlicePeriodStartTime: dayStart, SlicePeriodEndTime: dayEnd,
      PackageCodes: FREE_PACKAGE_CODES,
    }),
  ]);

  const okSummary = isOk(summary) && extractList(summary, 'Packages').length > 0;
  const okPaid = isOk(paid) && extractList(paid, 'Accounts').length >= 0;
  const okFree = isOk(free) && extractList(free, 'Accounts').length >= 0;

  if (!okSummary && !isOk(paid) && !isOk(free)) {
    const err = summary || paid || free || {};
    return {
      ok: false,
      uid: acct.uid,
      name: acct.name,
      error: (err.msg || err.message) || '积分查询失败',
      account: working,
    };
  }

  const summaryRes = okSummary ? extractList(summary, 'Packages').map((r) => normalizeResource(r, now)) : [];
  const detailRes = [];
  if (isOk(paid)) detailRes.push(...extractList(paid, 'Accounts').map((r) => normalizeResource(r, now)));
  if (isOk(free)) detailRes.push(...extractList(free, 'Accounts').map((r) => normalizeResource(r, now)));

  const resources = mergeResources(summaryRes, detailRes);

  const totalCapacity = resources.reduce((a, r) => a + r.total, 0);
  const totalRemaining = resources.reduce((a, r) => a + r.remaining, 0);
  const withRemaining = resources.filter((r) => r.remaining > 0);
  const soonestExpireAt = withRemaining
    .map((r) => r.expireAt)
    .filter(Boolean)
    .sort((a, b) => a - b)[0] || null;

  return {
    ok: true,
    uid: acct.uid,
    name: acct.name,
    updatedAt: now,
    totalCapacity,
    totalRemaining,
    used: Math.max(0, totalCapacity - totalRemaining),
    expiringSoonRemaining: resources.filter((r) => r.expiringSoon).reduce((a, r) => a + r.remaining, 0),
    expiredRemaining: resources.filter((r) => r.expired).reduce((a, r) => a + r.remaining, 0),
    soonestExpireAt,
    expiringSoon: resources.some((r) => r.expiringSoon && r.remaining > 0),
    expired: resources.some((r) => r.expired && r.remaining > 0),
    // 只保留有剩余或即将到期的套餐，避免把几十条历史零余额记录带进看板
    resources: resources
      .filter((r) => r.remaining > 0)
      .sort((a, b) => (a.expireAt || Infinity) - (b.expireAt || Infinity)),
    account: working,
  };
}

/** 查询多个账号的积分余额。 */
async function fetchCreditForAccounts(accounts) {
  const results = [];
  for (const acct of accounts) {
    results.push(await fetchCredit(acct));
  }
  return results;
}

// ---------------------------------------------------------------- 积分活动

/** 服务端时间戳可能是秒（10 位）也可能是毫秒，统一成毫秒。 */
function normTs(v) {
  const n = num(v);
  if (!n) return 0;
  return n < 1e11 ? n * 1000 : n;
}

/** 活动类请求的头：域是 codebuddy.cn，Referer 指向增长中心。 */
function activityHeaders(acct, refererPath) {
  return {
    Authorization: `Bearer ${acct.accessToken}`,
    'X-User-Id': acct.uid,
    'X-Client-Platform': 'web',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: ACTIVITY_BASE,
    Referer: ACTIVITY_BASE + (refererPath || '/profile/growth-center'),
  };
}

/** 活动类请求，带一次 401 刷新重试。 */
async function activityRequest(acct, method, p, body) {
  const send = async (a) => {
    try {
      const res = await fetch(ACTIVITY_BASE + p, {
        method,
        headers: activityHeaders(a),
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  };

  let working = acct;
  let json = await send(working);
  if (isUnauthorized(json) && working.refreshToken) {
    const refreshed = await refreshAccount(working);
    if (refreshed) {
      working = refreshed;
      json = await send(working);
    }
  }
  return { json, account: working };
}

const errMsg = (json, fallback) =>
  (json && (json.msg || json.message)) || fallback;

/**
 * 查签到状态。
 *
 * 只用 `checkin-activity-status`：实测另一个 `checkin-status` 返回的是
 * **另一套活动**的数据（恒为 active:false / streak_days:0），拿它做回退
 * 会把「今天已签」误报成「未签」。
 */
async function fetchCheckin(acct) {
  const r = await activityRequest(acct, 'POST', PATH_CHECKIN_STATUS, {});
  if (!isOk(r.json)) {
    return {
      ok: false, uid: acct.uid, name: acct.name,
      error: errMsg(r.json, '签到状态查询失败'), account: r.account,
    };
  }
  const d = r.json.data || {};
  return {
    ok: true,
    uid: acct.uid,
    name: acct.name,
    active: d.active !== false,
    checkedIn: d.today_checked_in === true || d.todayCheckedIn === true,
    streakDays: num(d.streak_days) || 0,
    todayCredit: num(d.today_credit) || 0,
    dailyCredit: num(d.daily_credit) || 0,
    totalCredits: num(d.total_credits) || 0,
    weekDays: num(d.week_checkin_days) || 0,
    // 已签到的日期（YYYY-MM-DD），签到日历用
    checkinDates: Array.isArray(d.checkin_dates) ? d.checkin_dates.map(String) : [],
    activityName: d.activity_name || '',
    account: r.account,
  };
}

/** 执行签到。已签到则直接返回 already，不重复提交。 */
async function doCheckin(acct) {
  const before = await fetchCheckin(acct);
  if (before.ok && before.checkedIn) {
    return {
      ok: true, already: true, uid: acct.uid, name: acct.name,
      streakDays: before.streakDays, todayCredit: before.todayCredit,
      totalCredits: before.totalCredits, message: '今日已签到',
    };
  }

  const r = await activityRequest(acct, 'POST', PATH_CHECKIN_DO, {});
  const msg = errMsg(r.json, '签到失败');
  // 幂等：服务端对重复提交会回「已签到」，视为成功
  if (!isOk(r.json) && !/已签到|already|repeat/i.test(msg)) {
    return { ok: false, uid: acct.uid, name: acct.name, error: msg, account: r.account };
  }

  // 回读一次拿最新连续天数与累计积分
  const after = await fetchCheckin(acct);
  return {
    ok: true,
    already: !isOk(r.json),
    uid: acct.uid,
    name: acct.name,
    streakDays: after.ok ? after.streakDays : 0,
    todayCredit: after.ok ? after.todayCredit : 0,
    totalCredits: after.ok ? after.totalCredits : 0,
    message: isOk(r.json) ? '签到成功' : '今日已签到',
  };
}

// ---------------------------------------------------------------- 猫猫旅行

/** 旅行配置（可用地点）。 */
async function fetchTravelConfig(acct) {
  const r = await activityRequest(acct, 'GET', PATH_TRAVEL_CONFIG);
  if (!isOk(r.json)) {
    return { ok: false, error: errMsg(r.json, '旅行配置查询失败'), locations: [], account: r.account };
  }
  const d = r.json.data || {};
  const list = Array.isArray(d.locations) ? d.locations : [];
  return {
    ok: true,
    enabled: d.enabled !== false,
    locations: list.map((l) => ({ id: num(l.id) || 0, name: l.name || '' })).filter((l) => l.id > 0),
    account: r.account,
  };
}

/** 旅行状态。 */
async function fetchTravel(acct) {
  const r = await activityRequest(acct, 'GET', PATH_TRAVEL_STATUS);
  if (!isOk(r.json)) {
    return { ok: false, uid: acct.uid, name: acct.name, error: errMsg(r.json, '旅行状态查询失败'), account: r.account };
  }
  const d = r.json.data || {};
  const loc = d.location && typeof d.location === 'object' ? d.location : null;
  return {
    ok: true,
    uid: acct.uid,
    name: acct.name,
    state: String(d.state || ''),
    dailyLimitReached: d.daily_limit_reached === true,
    recordId: num(d.record_id) || 0,
    departAt: normTs(d.depart_at),
    arriveAt: normTs(d.arrive_at),
    serverNow: normTs(d.server_now),
    rewardCredit: num(d.reward_credit) || 0,
    durationHours: num(d.duration_hours) || 0,
    location: loc ? { id: num(loc.id) || 0, name: loc.name || '' } : null,
    account: r.account,
  };
}

/** 派发旅行。 */
async function departTravel(acct, locationId) {
  const r = await activityRequest(acct, 'POST', PATH_TRAVEL_DEPART, { location_id: locationId });
  if (!isOk(r.json)) {
    return { ok: false, action: 'depart', uid: acct.uid, name: acct.name,
      error: errMsg(r.json, '派发失败'), account: r.account };
  }
  const st = await fetchTravel(acct);
  return {
    ok: true, action: 'depart', uid: acct.uid, name: acct.name,
    state: st.ok ? st.state : 'traveling',
    arriveAt: st.ok ? st.arriveAt : 0,
    locationName: st.ok && st.location ? st.location.name : '',
    message: '已派出，等它到达后记得来领奖励',
  };
}

/** 领取奖励。 */
async function claimTravel(acct, recordId) {
  const body = recordId > 0 ? { record_id: recordId } : {};
  const r = await activityRequest(acct, 'POST', PATH_TRAVEL_CLAIM, body);
  const msg = errMsg(r.json, '');
  if (!isOk(r.json)) {
    // 网页端已领过 / 已到上限，都当作「无需再领」而不是失败
    if (/no unclaimed|daily_limit|已领取/i.test(msg)) {
      return { ok: true, action: 'claim', already: true, uid: acct.uid, name: acct.name, rewardCredit: 0,
        message: '今日奖励已领取过' };
    }
    return { ok: false, action: 'claim', uid: acct.uid, name: acct.name, error: msg || '领取失败', account: r.account };
  }
  const d = r.json.data || {};
  return {
    ok: true, action: 'claim', uid: acct.uid, name: acct.name,
    rewardCredit: num(d.reward_credit) || 0,
    message: '奖励已领取',
  };
}

/**
 * 一键：按状态机决定派发还是领奖。
 *
 * 状态机：idle --depart--> traveling --arrive_at 到点--> arrived --claim--> idle
 * 未知 state 一律报错——当成 idle 会误派，当成 arrived 会误领。
 */
async function runTravel(acct) {
  const st = await fetchTravel(acct);
  if (!st.ok) return st;

  if (st.state === 'arrived') {
    const c = await claimTravel(acct, st.recordId);
    return { ...c, state: 'idle' };
  }

  if (st.state === 'traveling') {
    const mins = st.arriveAt ? Math.max(0, Math.ceil((st.arriveAt - Date.now()) / 60000)) : null;
    return {
      ok: true, action: 'wait', uid: acct.uid, name: acct.name,
      state: 'traveling', arriveAt: st.arriveAt,
      locationName: st.location ? st.location.name : '',
      message: mins === null ? '正在旅行中' : `正在旅行中，约 ${mins} 分钟后到达`,
    };
  }

  if (st.state === 'idle') {
    if (st.dailyLimitReached) {
      return {
        ok: true, action: 'skip', uid: acct.uid, name: acct.name,
        state: 'idle', dailyLimit: true,
        message: '今日已派出过，明天再来',
      };
    }
    const cfg = await fetchTravelConfig(acct);
    const loc = cfg.locations[0];
    if (!loc) {
      return { ok: false, uid: acct.uid, name: acct.name, error: '没有可用地点', account: cfg.account };
    }
    return departTravel(acct, loc.id);
  }

  return {
    ok: false, uid: acct.uid, name: acct.name,
    error: `未知的旅行状态：${st.state || '(空)'}`, state: st.state,
  };
}

module.exports = {
  AUTH_DIR,
  discoverAccounts,
  fetchBilling,
  fetchBillingForAccounts,
  fetchCredit,
  fetchCreditForAccounts,
  // 积分活动
  fetchCheckin,
  doCheckin,
  fetchTravel,
  fetchTravelConfig,
  departTravel,
  claimTravel,
  runTravel,
  readSessionsFromDb,
  loadCreditHistory,
  recordCreditHistory,
  loadCheckinHistory,
  recordCheckinDates,
  refreshAccount,
  // 供测试/调试
  _internals: { normalizeResource, mergeResources, resolveExpireAt, fmtLocal, normTs },
};
