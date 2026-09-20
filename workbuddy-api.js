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
const path = require('path');

// ---------------------------------------------------------------- 常量

/** 登录态快照目录（WorkBuddy 桌面端写入）。 */
const AUTH_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
  'CodeBuddyExtension', 'Data', 'Public', 'auth'
);

/** 接口基址：账单与积分都在 web 域下（与 token 签发域一致）。 */
const BASE = 'https://www.workbuddy.cn';

const PATH_BILLING = '/billing/meter/get-user-request-usage';
const PATH_RES_SUMMARY = '/billing/meter/get-user-resource-summary';
const PATH_RES_PAID = '/billing/meter/get-user-resource-paid-packages';
const PATH_RES_FREE = '/billing/meter/get-user-resource-free-packages';
const PATH_REFRESH = '/v2/plugin/auth/token/refresh';

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

module.exports = {
  AUTH_DIR,
  discoverAccounts,
  fetchBilling,
  fetchBillingForAccounts,
  fetchCredit,
  fetchCreditForAccounts,
  refreshAccount,
  // 供测试/调试
  _internals: { normalizeResource, mergeResources, resolveExpireAt, fmtLocal },
};
