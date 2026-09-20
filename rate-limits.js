#!/usr/bin/env node
/**
 * 模型限流（429）台账：从本机客户端日志还原「哪个账号的哪个模型被限流、官方
 * 给出的恢复时刻」。
 *
 * 实现口径对齐 workbuddySwitch 的 limits.rs（日志通路），只取对本项目有用的最小集：
 *   · 来源：`~/.workbuddy/logs/<日期>/`（桌面端）与 `~/.codebuddy/logs/<日期>/`（CLI），
 *     窗口固定最近 2 天（目录名收窗 + 文件 mtime 双保险——日志会写到次日凌晨，
 *     按「最近 N 个目录」会漏掉跨天记录）。
 *   · 命中：行内含「超出频率限制」/「usage exceeds frequency limit」（中英文版本）。
 *   · 恢复时刻：直接采用日志原文 `将在 <时间> UTC+8 重置`（官方值，不自建窗口模型）。
 *   · 模型归因：429 行尾 `(convId/sessionId)` 的 sessionId 对应同文件
 *     `sessionId=<uuid>, resolved model=<m>` 行；归因不到显示「未知模型」，不猜。
 *   · 账号归因：CLI 日志取文件内 `[AuthDoInitProbe] … uid=<uuid>` 最新一条；
 *     桌面端日志的 sessionId 对应 workbuddy.db 的 sessions 表（buddyToken 主脚本
 *     已有该映射）；都拿不到时兜底当前登录账号。
 *
 * 不发任何网络请求。扫描有 60 秒内存缓存（日志不是实时关键数据，看板 60s 轮询
 * 全部命中缓存）。已过恢复时刻的条目在返回前过滤——恢复是官方承诺，到期即视为可用。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 日志来源：目录名即展示名。 */
const SOURCES = [
  { name: 'WorkBuddy', root: path.join(os.homedir(), '.workbuddy', 'logs') },
  { name: 'CodeBuddyCLI', root: path.join(os.homedir(), '.codebuddy', 'logs') },
];

/** 扫描窗口（天）：mtime 与目录名双重收窗。 */
const WINDOW_DAYS = 2;

/** 限额文案标记（Buffer 粗筛 + 行解析共用）。 */
const QUOTA_MARKERS = ['超出频率限制', 'usage exceeds frequency limit'];

/** 官方恢复时刻句式：`将在 2026-09-21 15:02:16 UTC+8 重置`（时间为 UTC+8 本地时间）。 */
const RESET_RE = /(?:将在|will reset at)\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\+8/;

/** 429 行尾的事件身份：`(requestId/sessionId)`，两段都是十六进制/UUID 形态。 */
const SESSION_REF_RE = /\(([0-9a-f]{8,})\/([0-9a-f-]{36})\)\s*\.?$/;

/** 模型解析行：`sessionId=<uuid>, resolved model=<name>`。 */
const MODEL_RE = /sessionId=([0-9a-f][0-9a-f-]{35}),\s*resolved model=([\w.\-]+)/;

/** 请求行：`requestId=<hex> … model=<name>`（[ModelProvider] Sending request）。 */
const REQUEST_MODEL_RE = /requestId=([0-9a-f]{16,})[^,\]]*?(?:,|\])?\s*$/;

/** CLI 鉴权行的 uid 字段：`[AuthDoInitProbe] … uid=<uuid>`。 */
const UID_RE = /\[AuthDoInitProbe\][^\n]*?uid=([0-9a-f][0-9a-f-]{35})/g;

/** `YYYY-MM-DD` 形态的目录名（logs 下还有 sdk、Crash-Log 等非日期目录）。 */
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 一次 429 会在业务日志写多行（本机实测 5–14 行），按 (uid, model, resetAt) 归并。 */

/**
 * `将在 2026-09-21 15:02:16 UTC+8` → 毫秒时间戳。
 * 该时间是官方给的 UTC+8 挂钟时刻，与脚本运行时区无关，固定 +08:00 解析。
 */
function parseResetAt(m) {
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** 枚举收窗内的日志文件：最近 WINDOW_DAYS 个日期目录里 mtime 未过期的 .log。 */
function collectLogFiles(root, cutoffMs, now) {
  let dateDirs = [];
  try {
    dateDirs = fs.readdirSync(root)
      .filter((d) => DATE_DIR_RE.test(d))
      .sort()
      .slice(-WINDOW_DAYS)
      .map((d) => path.join(root, d));
  } catch {
    return [];
  }

  const files = [];
  for (const dir of dateDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.log')) continue;
      const full = path.join(dir, ent.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      if (mtime < cutoffMs && mtime < now - WINDOW_DAYS * 86400000) continue;
      files.push(full);
    }
  }
  return files;
}

/**
 * 扫描一个日志文件，返回该文件的命中事件与可用的归因信息。
 *
 * 大文件先做 Buffer 级粗筛；命中后**按行序单遍扫描**——模型映射随行序更新，
 * 429 行用它之前积累的映射归因（会话中途换模型时才不会错归）。
 *
 * 归因链（对齐 workbuddySwitch limits.rs 的 workbuddy_attribution）：
 *   1. 行尾 `(requestId/sessionId)` 的 requestId → `[ModelProvider] Sending request`
 *      行里的 `requestId=…, model=…`（本次请求的真实模型，最准）；
 *   2. 退而求其次 sessionId → `resolved model=` 行（会话当前模型）；
 *   3. 都没有 → 未知模型，不猜。
 */
function scanLogFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const hit = QUOTA_MARKERS.some((m) => buf.includes(m));
  if (!hit) return null;

  const text = buf.toString('utf8');
  buf = null;   // 尽早释放

  let uid = null;
  for (const m of text.matchAll(UID_RE)) uid = m[1];   // 取最新一条

  // 按行序累积的模型映射（事件行只看它之前的状态）
  const requestModels = new Map();   // requestId → model（本次请求的真实模型）
  const sessionModels = new Map();   // sessionId → model（会话当前模型）
  const KNOWN_BAD = new Set(['auto', 'undefined', 'null', 'none', '']);
  const events = [];

  for (const line of text.split('\n')) {
    // 回显行过滤：桌面端会把工具输出/命令回显整段塞进日志，其中可能带着
    // 别处日志的 429 原文，按原样解析会产出假事件
    if (/^\[[^\]]*SandboxShell/.test(line) || /^\[[^\]]*\]\s*(ProcessOutput|sandbox attempt output)/.test(line)) continue;

    // 模型映射维护（顺序敏感）
    const reqM = line.match(/requestId=([0-9a-f]{16,})/);
    if (reqM) {
      const mo = line.match(/(?<=[,\s])model=([\w.\-]+)/);
      if (mo && !KNOWN_BAD.has(mo[1])) requestModels.set(reqM[1], mo[1]);
    }
    const sesM = line.match(MODEL_RE);
    if (sesM && !KNOWN_BAD.has(sesM[2])) sessionModels.set(sesM[1], sesM[2]);

    if (!QUOTA_MARKERS.some((mk) => line.includes(mk))) continue;
    const resetM = line.match(RESET_RE);
    if (!resetM) continue;   // 无官方恢复时刻的行不采用（防误报）
    const resetAt = parseResetAt(resetM);
    if (!resetAt) continue;

    // 事件身份：行尾 (requestId/sessionId)，退而行内 session=<uuid>
    let requestId = null;
    let sessionId = null;
    const ref = line.match(SESSION_REF_RE);
    if (ref) {
      requestId = ref[1];
      sessionId = ref[2];
    } else {
      const inline = line.match(/session=([0-9a-f][0-9a-f-]{35})/);
      if (inline) sessionId = inline[1];
    }

    // 模型归因：requestId → model 优先，sessionId → resolved model 次之
    const model = (requestId && requestModels.get(requestId))
      || (sessionId && sessionModels.get(sessionId))
      || null;

    events.push({ resetAt, sessionId, model, lineUid: uid });
  }
  return { uid, events };
}

/**
 * 全量扫描：一次返回全部账号的当前受限状态。
 *
 * opts.currentUid：归因兜底——桌面端日志里没有 uid 行、CLI 日志查不到 uid 时，
 * 兜给当前登录账号（只有当前登录者能发起请求）。由 server.js 从
 * workbuddy-api.listSwitchableAccounts() 取好后传入，本模块不依赖官方 api 文件。
 *
 * 返回 `{ scannedAt, windowDays, accounts }`，accounts 只含有受限模型的账号，
 * 每条 `{ uid, limits: [{ model, resetAt }] }`（resetAt 升序，最早恢复的在前）。
 */
function scanRateLimits({ currentUid = null } = {}) {
  const now = Date.now();
  const cutoffMs = now - WINDOW_DAYS * 86400000;

  // 聚合键：uid|model|resetAt —— 同一次 429 的多行日志天然合并
  const byKey = new Map();

  for (const src of SOURCES) {
    for (const file of collectLogFiles(src.root, cutoffMs, now)) {
      const r = scanLogFile(file);
      if (!r || !r.events.length) continue;
      for (const ev of r.events) {
        const key = `${ev.lineUid || '?'}|${ev.model || '?'}|${ev.resetAt}`;
        const prev = byKey.get(key);
        if (prev) { prev.hits++; continue; }
        byKey.set(key, {
          uid: ev.lineUid || null,
          model: ev.model || null,
          resetAt: ev.resetAt,
          source: src.name,
          hits: 1,
        });
      }
    }
  }

  // 账号归因：CLI 日志取文件内 uid 行；桌面端日志没有 uid 行，sessionId 需要
  // sessions 表映射（为免依赖官方 api 文件，这里直接兜当前登录账号）。
  const byUid = new Map();
  for (const ev of byKey.values()) {
    if (ev.resetAt <= Date.now()) continue;   // 已过官方恢复时刻，视为已恢复
    const uid = ev.uid || currentUid;
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push({ model: ev.model, resetAt: ev.resetAt, source: ev.source, hits: ev.hits });
  }

  const accounts = [...byUid.entries()].map(([uid, limits]) => {
    // 同一次 429 可能部分行归因不到模型（model=null）：若已有同 resetAt 的
    // 已知模型条目，null 条目就是同一次事件，吸收掉，避免卡片显示「未知模型」。
    const known = limits.filter((l) => l.model);
    const merged = limits.filter(
      (l) => l.model || !known.some((k) => Math.abs(k.resetAt - l.resetAt) < 1000),
    );
    return {
      uid,
      limits: merged.sort((a, b) => a.resetAt - b.resetAt),
    };
  });

  return { scannedAt: now, windowDays: WINDOW_DAYS, accounts };
}

// --------------------------------------------------------------- 60s 内存缓存

let _cache = null;

/**
 * 带缓存的扫描入口（服务端轮询用）。cacheMs 内重复调用直接返回上次结果。
 * force=true 时绕过缓存强制重扫（手动刷新用）。
 */
function getRateLimits({ cacheMs = 60000, force = false, currentUid = null } = {}) {
  if (!force && _cache && Date.now() - _cache.scannedAt < cacheMs) return _cache;
  _cache = scanRateLimits({ currentUid });
  return _cache;
}

module.exports = { getRateLimits, scanRateLimits, _internals: { parseResetAt, collectLogFiles } };
