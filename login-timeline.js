#!/usr/bin/env node
/**
 * 「时刻 → 登录账号」回放器（限流归因的第二层，server.js 注进 rate-limits）。
 *
 * 为什么需要它：CLI 支持热切换账号（无需重启、每次请求重读登录态），日志里的
 * `[AuthDoInitProbe] … uid=` 只是**进程启动时刻**的快照，进程活着时登录态可能
 * 已经变了。2026-10-16 实测：某进程 09:52 启动（快照 = 账号 A），09:53 被切到
 * 账号 B，10:25 的 429 是 B 撞的——按快照归因就归错了。
 *
 * 数据源（全部本地文件，不发网络请求）：
 *   · 项目 `switch-backups/<app>-<UTC时刻>.info` —— buddyToken 每次切换账号前
 *     备份的原登录文件：**文件名 = 切换时刻，内容 uid = 切换前账号**。
 *   · auth 目录当前 `<app>.info` —— 当前登录账号。
 *
 * 区间重建：备份按时刻升序 B0..Bn，B_i 时刻从 B_i.内容 切到 B_{i+1}.内容
 * （最后一次切到当前 uid）。所以 [B_i, B_{i+1}) 期间登录 = B_{i+1} 的内容；
 * [B_n, now) = 当前 uid。查询只读「区间右端那一个备份」的内容 + 一次目录列举，
 * 无需缓存也很快。
 *
 * 保守边界：
 *   · 早于最早备份的时刻返回 null（不猜），由调用方继续降级。
 *   · 最后区间要求登录文件「与最后一次备份同时被写」（mtime 在备份时刻 +5 分钟
 *     内）——否则说明最后一次备份之后还有未经本工具记录的写入（比如桌面端
 *     被手动换过账号），当前 uid 不足以代表整段区间，返回 null。
 *
 * 局限：只覆盖经 buddyToken 服务的切换；CLI 自己登录（不经服务）不留备份。
 * 本机 2026-10-13 后无此类痕迹（auth 目录无新登录快照、切换链完整），故实际
 * 可用性良好；断链时会退到调用方自己的降级链。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// AUTH_DIR 与 app→登录文件名的映射以 workbuddy-api.js 为准（单一权威来源）。
// 它加载失败时本模块恒返回 null，归因自然降级，不影响其它功能。
let AUTH_DIR = null;
let APP_AUTH_FILES = null;
try {
  ({ AUTH_DIR, APP_AUTH_FILES } = require('./workbuddy-api.js'));
} catch { /* 常量拿不到 → loginAt 恒 null */ }

/**
 * 备份文件名：`<app>-2026-10-16T02-27-02-032Z.info`（ISO 时刻，冒号点换成横杠；
 * 见 workbuddy-api.js 的 switchAppAccount）。
 */
const BACKUP_RE = /^(workbuddy-desktop|codebuddy-cli)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.info$/;

/** 从 .info 文本里提取 uid（只读明文 uid 段，不解密、不碰 token）。 */
const UID_RE = /"uid"\s*:\s*"([0-9a-f-]{36})"/i;

/** 最后区间的时效容忍：登录文件 mtime 与最后一次备份相差在此之内视为「同时写入」。 */
const LAST_WRITE_GRACE_MS = 5 * 60 * 1000;

function uidOfFile(f) {
  try {
    const m = fs.readFileSync(f, 'utf8').match(UID_RE);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

/**
 * @param {string} root buddyToken 项目根（switch-backups/ 所在目录）
 */
function makeLoginTimeline(root) {
  const backupDir = path.join(root, 'switch-backups');

  /** 该 app 的备份列表（按时刻升序）：只解析文件名，不读内容。 */
  function backupsOf(app) {
    let names = [];
    try { names = fs.readdirSync(backupDir); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = n.match(BACKUP_RE);
      if (!m || m[1] !== app) continue;
      const ts = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7], +m[8]);
      if (Number.isFinite(ts)) out.push({ ts, file: n });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * ts 时刻该 app 的登录账号。
   * @param {number} ts 毫秒时刻（429 行首时刻）
   * @param {string} app 'codebuddy-cli' | 'workbuddy-desktop'
   * @returns {string|null} uid
   */
  return function loginAt(ts, app) {
    if (!ts || !app || !AUTH_DIR || !APP_AUTH_FILES || !APP_AUTH_FILES[app]) return null;
    const list = backupsOf(app);
    if (!list.length) return null;   // 没有备份链，无从判断

    // 二分：「最后一个不晚于 ts 的备份」
    let lo = 0, hi = list.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ts <= ts) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx < 0) return null;   // 早于最早备份，不猜

    // [B_idx, 下一个) 期间的登录 = 下一个备份的内容（= 下个时刻被切走的那个账号）
    if (idx < list.length - 1) return uidOfFile(path.join(backupDir, list[idx + 1].file));

    // 最后区间 [B_n, now)：登录文件须与 B_n 同时被写，否则当前 uid 代表不了整段
    const loginFile = path.join(AUTH_DIR, APP_AUTH_FILES[app]);
    let mtime = 0;
    try { mtime = fs.statSync(loginFile).mtimeMs; } catch { return null; }
    if (mtime > list[idx].ts + LAST_WRITE_GRACE_MS) return null;
    return uidOfFile(loginFile);
  };
}

module.exports = { makeLoginTimeline };
