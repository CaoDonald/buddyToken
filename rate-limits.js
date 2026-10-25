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
 *   · 账号归因（按精度排序）：
 *     1. 429 行尾 `(requestId/sessionId)` → 调用方传入的 resolveSession 回调
 *        （请求级 + 会话级：jsonl 里那条失败记录 → 回合 → 官方账单 uid。
 *         账单是账号维度的权威归属；失败回合不计费时降为时间锚——429 前本会话
 *         最后一条计费记录的 uid，会话中途切号时它会过时，由第 2 层裁决）；
 *     2. 429 行首时刻 → 调用方传入的 loginAt 回调（时刻级裁决：把项目
 *        switch-backups/ 的备份链拼成「时刻 → 登录账号」区间表，见
 *         login-timeline.js。它直接回答「429 那一刻登录的是谁」——有答案即以它
 *         为准：与第 1 层冲突则弃用第 1 层（2026-10-25 实测：08:38:52 从 157
 *         切到 183，08:39:02 的 429 被 1 层时间锚锚给 157，这层改判 183）；
 *         CLI 热切换账号（无需重启进程、每次请求重读登录态）会让 pid 探测行
 *         过时，这层也是唯一还准的本地线索：2026-10-16 实测 09:52 启动的进程
 *         09:53 被切到另一账号，10:25 的 429 只有这层能归对）；
 *     3. 行内 `[pid=N]` → 同窗口全部日志文件的 `[AuthDoInitProbe] … uid=` 表
 *        （进程级：探测行 = 进程启动时刻的登录快照。桌面端切换账号要重启、
 *         该假设成立；CLI 侧会过时，仅作前两层都拿不到时的近似）；
 *     4. 文件内最新 uid 行（旧行为）；
 *     5. 都拿不到时兜底当前登录账号（桌面端日志的 sessionId 对应 workbuddy.db
 *        的 sessions 表，buddyToken 主脚本已有该映射；此处兜当前登录者）。
 *
 * 不发任何网络请求。扫描有 60 秒内存缓存（日志不是实时关键数据，看板 60s 轮询
 * 全部命中缓存）。已过恢复时刻的条目在返回前过滤——恢复是官方承诺，到期即视为可用。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 日志来源：目录名即展示名；app 对应 auth 侧的登录文件名前缀（login-timeline 用）。 */
const SOURCES = [
  { name: 'WorkBuddy', app: 'workbuddy-desktop', root: path.join(os.homedir(), '.workbuddy', 'logs') },
  { name: 'CodeBuddyCLI', app: 'codebuddy-cli', root: path.join(os.homedir(), '.codebuddy', 'logs') },
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

/**
 * 带进程标识的鉴权行：`[pid=78076] … [AuthDoInitProbe] … uid=<uuid>`。
 * 探测行在进程启动时打一次，是「启动时刻」的登录快照——CLI 支持热切换账号，
 * 进程活着时登录态可能已经变了（2026-10-16 实测），因此这层只作近似。
 */
const PROBE_UID_RE = /\[pid=(\d+)\][^\n]*?\[AuthDoInitProbe\][^\n]*?uid=([0-9a-f][0-9a-f-]{35})/;

/** 日志行的进程标识：`[pid=78076]`。 */
const PID_RE = /\[pid=(\d+)\]/;

/** 日志行的行首时刻：`[2026/10/15 19:01:47.976]`（本机本地时间）。 */
const LINE_TS_RE = /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/;

/** 探测行粗筛标记（与 UID_RE 同源，Buffer.includes 用）。 */
const PROBE_MARKER = 'AuthDoInitProbe';

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

/**
 * 日志行首时刻 `[2026/10/15 19:01:47.976]` → 毫秒时间戳。
 * 日志写的是本机本地时间，用本地时区构造，与 jsonl 记录的 timestamp 同基准。
 * 拿不到行首时刻返回 0（调用方按「无时间锚」降级）。
 */
function parseLineTs(line) {
  const m = line.match(LINE_TS_RE);
  if (!m) return 0;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
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
 * 只有 429 或账号探测行至少其一的文件才值得读全文——纯请求日志对归因没有
 * 增量信息，跳过能省掉大部分大文件的解码开销。
 *
 * 模型归因链（对齐 workbuddySwitch limits.rs 的 workbuddy_attribution）：
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
  const hasQuota = QUOTA_MARKERS.some((m) => buf.includes(m));
  const hasProbe = buf.includes(PROBE_MARKER);
  if (!hasQuota && !hasProbe) return null;

  const text = buf.toString('utf8');
  buf = null;   // 尽早释放

  let uid = null;
  for (const m of text.matchAll(UID_RE)) uid = m[1];   // 取最新一条

  // pid → uid：该文件里各进程的登录态（进程启动时的探测行）。
  // 一个文件可跨多个进程/多个账号——按项目分文件、切换账号不换文件。
  const pidUid = new Map();

  // 按行序累积的模型映射（事件行只看它之前的状态）
  const requestModels = new Map();   // requestId → model（本次请求的真实模型）
  const sessionModels = new Map();   // sessionId → model（会话当前模型）
  const KNOWN_BAD = new Set(['auto', 'undefined', 'null', 'none', '']);
  const events = [];

  for (const line of text.split('\n')) {
    // 回显行过滤：桌面端会把工具输出/命令回显整段塞进日志，其中可能带着
    // 别处日志的 429 原文，按原样解析会产出假事件
    if (/^\[[^\]]*SandboxShell/.test(line) || /^\[[^\]]*\]\s*(ProcessOutput|sandbox attempt output)/.test(line)) continue;

    // 账号探测行（顺序不敏感：进程启动即打，一定早于同进程的 429）
    const probe = line.match(PROBE_UID_RE);
    if (probe) pidUid.set(probe[1], probe[2]);

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

    const pidM = line.match(PID_RE);
    // ts = 该行写入时刻（时间锚：resolveSession 拿它筛「429 之前」的计费记录）
    events.push({ resetAt, sessionId, requestId, model, pid: pidM ? pidM[1] : null, ts: parseLineTs(line), file });
  }
  return { uid, pidUid, events };
}

/**
 * 全量扫描：一次返回全部账号的当前受限状态。
 *
 * opts.currentUid：归因兜底——桌面端日志里没有 uid 行、CLI 日志查不到 uid 时，
 * 兜给当前登录账号（只有当前登录者能发起请求）。由 server.js 从
 * workbuddy-api.listSwitchableAccounts() 取好后传入，本模块不依赖官方 api 文件。
 * opts.resolveSession(sessionId, requestId, atTs) → uid|null：会话/请求级归因
 * 回调（第一层，最权威），pid 探测行可能过时时由它兜住。由 server.js 用
 * 「本地 jsonl 失败记录 → 回合 → 官方账单 uid」实现，本模块不发网络请求。
 * opts.loginAt(ts, app) → uid|null：时刻级归因回调（第二层）——429 发生那一刻
 * 该 app 登录的是谁。由 server.js 用「switch-backups 备份链 + 当前登录文件」
 * 实现（见 login-timeline.js），同样零网络请求。
 *
 * 返回 `{ scannedAt, windowDays, accounts }`，accounts 只含有受限模型的账号，
 * 每条 `{ uid, limits: [{ model, resetAt }] }`（resetAt 升序，最早恢复的在前）。
 */
function scanRateLimits({ currentUid = null, resolveSession = null, loginAt = null } = {}) {
  const now = Date.now();
  const cutoffMs = now - WINDOW_DAYS * 86400000;

  // 聚合键：file|pid|resetAt —— 官方一次限流会在业务日志里写多行（实测 5–14 行），
  // 有的行带 sessionId、有的不带，有的行归因不到模型；同 key 即同一次事件。
  // 账号归因放到聚合后按组做（行级 pid 需要整份文件的探测表，见下）。
  const byKey = new Map();
  // 跨文件合并的 pid → uid 表：探测行只写在启动进程当时所在项目的日志文件里，
  // 与 429 所在文件不一定是同一个（2026-10-12 实测 pid 18120 即属此列）。
  const pidUidAll = new Map();
  // file → 文件内最新 uid 行（第三层兜底）
  const fileUidOf = new Map();

  for (const src of SOURCES) {
    for (const file of collectLogFiles(src.root, cutoffMs, now)) {
      const r = scanLogFile(file);
      if (!r) continue;
      fileUidOf.set(file, r.uid);
      for (const [p, u] of r.pidUid) pidUidAll.set(p, u);
      for (const ev of r.events) {
        const key = `${file}|${ev.pid || '?'}|${ev.resetAt}`;
        let g = byKey.get(key);
        if (!g) {
          g = {
            resetAt: ev.resetAt,
            source: src.name,
            app: src.app,
            hits: 0,
            pid: ev.pid || null,
            refs: [],         // [sid, rid] 对：归因第一层用（组内可能有多个会话）
            ts: 0,            // 组内第一条带时刻的行（时间锚）
            file,
            models: new Set(),
          };
          byKey.set(key, g);
        }
        g.hits++;
        // 组内每行的 (requestId/sessionId) 都留：同一次限流可能同时打中多个会话、
        // 或同会话的多个请求，逐个尝试精确归因，哪个先命中账单用哪个
        if (ev.sessionId) {
          const rid = ev.requestId || null;
          if (!g.refs.some(([s, r]) => s === ev.sessionId && r === rid)) {
            g.refs.push([ev.sessionId, rid]);
          }
        }
        if (!g.ts && ev.ts) g.ts = ev.ts;
        if (ev.model) g.models.add(ev.model);
      }
    }
  }

  // 同官方事件合并：官方限流是「账号×模型」维度，同一账号的多进程/多会话同时
  // 被打中时恢复时刻必然相同（2026-10-13 两个 pid、2026-10-25 四个 pid 实测）。
  // 按 file|pid 拆开的组若各自归因，会因各组拿到的本地线索不同而归出不同账号，
  // 同一事件在多张账号卡片各出一条（2026-10-25 实测：15:22 恢复的 deepseek
  // 限流同时挂在 157 与 183 卡片上）。故归因前先按 (app, resetAt±1s) 合并成
  // 事件池：refs 池化逐个尝试、ts 取最早、hits 累加、models 并集、pids 全留。
  const pools = [];
  const sortedGroups = [...byKey.values()].sort((a, b) => a.resetAt - b.resetAt);
  for (const g of sortedGroups) {
    const pool = pools.find(
      (p) => p.app === g.app && Math.abs(p.resetAt - g.resetAt) < 1000,
    );
    if (!pool) {
      pools.push({ ...g, models: new Set(g.models), pids: g.pid ? [g.pid] : [] });
      continue;
    }
    pool.hits += g.hits;
    for (const [s, r] of g.refs) {
      if (!pool.refs.some(([s2, r2]) => s2 === s && r2 === r)) pool.refs.push([s, r]);
    }
    for (const m of g.models) pool.models.add(m);
    if (g.ts && (!pool.ts || g.ts < pool.ts)) pool.ts = g.ts;
    if (g.pid && !pool.pids.includes(g.pid)) pool.pids.push(g.pid);
  }

  // 账号归因（按精度降级，对事件池判定、池内共享）：
  //   1. (requestId, sessionId, ts) → resolveSession 回调（请求/会话级；失败记录
  //      挂在哪个回合、回合算谁的账，官方账单是账号维度的权威归属；时间锚兜底
  //      在切号场景会过时，由下一层裁决）
  //   2. (ts, app) → loginAt 回调（时刻级裁决；切换历史回放「429 那一刻登录的
  //      是谁」，有答案即采信：与第 1 层冲突则弃用第 1 层）
  //   3. 池内各行 pid → 跨文件的 AuthDoInitProbe 表（进程级；仅作前两层拿不到
  //      时的近似）
  //   4. 文件内最新 uid 行（旧行为）
  //   5. currentUid 兜底（桌面端日志没有 uid 行）
  const byUid = new Map();
  for (const g of pools) {
    if (g.resetAt <= Date.now()) continue;   // 已过官方恢复时刻，视为已恢复
    let uid = null;
    if (resolveSession) {
      for (const [sid, rid] of g.refs) {
        try { uid = resolveSession(sid, rid, g.ts) || null; } catch { uid = null; }
        if (uid) break;
      }
    }
    // 时刻级交叉验证：第 1 层的时间锚取「429 前本会话最后一条计费记录」的 uid，
    // 会话中途切号、新账号首个请求就 429（切号往往正是因为旧账号被限）时，锚到
    // 的仍是切号前的账号。loginAt 回放 switch-backups 备份链、直接回答「429
    // 时刻登录的是谁」，有答案即以它为准。第 1 层的账单精确匹配理论上不会与它
    // 冲突（账单 uid = 请求发出时的登录者），冲突极大概率是时间锚被切号污染。
    if (loginAt && g.ts) {
      let luid = null;
      try { luid = loginAt(g.ts, g.app) || null; } catch { luid = null; }
      if (luid && uid !== luid) uid = luid;
    }
    if (!uid && g.pids.length) {
      for (const p of g.pids) {
        uid = pidUidAll.get(p) || null;
        if (uid) break;
      }
    }
    if (!uid) uid = fileUidOf.get(g.file) || null;
    if (!uid) uid = currentUid;
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    // 同池多行可能归因出多个模型（官方一次限流按模型分别计），逐模型各出一条；
    // 全池都没解析出模型时才留「未知模型」。
    const models = g.models.size ? [...g.models] : [null];
    for (const model of models) {
      // 同账号 + 同模型 + 同恢复时刻 = 同一次限流：正常已被上方事件池合并吸收，
      // 这里只是双保险（如未来聚合口径变化再次拆开时仍不出重复行）。
      const list = byUid.get(uid);
      const dup = list.find((l) => l.model === model && Math.abs(l.resetAt - g.resetAt) < 1000);
      if (dup) { dup.hits += g.hits; continue; }
      list.push({ model, resetAt: g.resetAt, source: g.source, hits: g.hits });
    }
  }

  const accounts = [...byUid.entries()].map(([uid, limits]) => {
    // 双保险：不同组（不同 pid）的同 resetAt 事件里若仍有 null 模型条目，
    // 且同账号已有同 resetAt 的已知模型条目，吸收掉，避免卡片显示「未知模型」。
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
function getRateLimits({ cacheMs = 60000, force = false, currentUid = null, resolveSession = null, loginAt = null } = {}) {
  if (!force && _cache && Date.now() - _cache.scannedAt < cacheMs) return _cache;
  _cache = scanRateLimits({ currentUid, resolveSession, loginAt });
  return _cache;
}

module.exports = { getRateLimits, scanRateLimits, _internals: { parseResetAt, collectLogFiles } };
