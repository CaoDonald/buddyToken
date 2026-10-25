#!/usr/bin/env node
/**
 * 会话 → 账号归属解析器（限流归因的权威层，由 server.js 注入 rate-limits）。
 *
 * 链路（按精度降序，取第一个成功者）：
 *   1. 429 请求的 requestId → 本地 jsonl 里那条失败记录（providerData.error.requestID
 *      即 429 行尾 `(requestId/sessionId)` 的第一段）→ 该记录自身的
 *      conversationRequestId → 官方账单 requestId → uid。429 请求本身就是那次
 *      请求，它挂在哪个回合、回合算谁的账，全程有官方账单背书；会话中途切号
 *      （同一 jsonl 里混着多个账号的记录）也能正确定位。
 *   2. 时间锚兜底：同会话里「不晚于 429 时刻的最后一条计费记录」的 uid。
 *      失败回合不计费、账单查不到时启用；仍按 429 时刻锚定，不会把切号之后的
 *      记录用来解释切号之前的限流。但它解释不了「切号之后新账号首个请求就 429」
 *      ——新账号在本会话还没有计费记录，锚到的必是切号前的账号（2026-10-25
 *      实测），由 rate-limits 的 loginAt 层按时刻登录态裁决修正。
 *   3. 都拿不到 → null，由调用方继续降级（pid 探测行 / 文件 uid 行 / 当前登录）。
 *
 * 为什么不用「会话第一条命中记录」：jsonl 是消息树结构，文件行序不是时间序
 * （实测同一会话的第一条命中记录可能落在会话中后期），用它解释早期限流会归错。
 *
 * 缓存两级：`sessionId|requestId` → uid（同一会话的不同限流事件可能分属不同账号，
 * 不能只按会话缓存）；命中的 uid 永久有效，判空只缓存 60 秒——429 刚发生时
 * jsonl 或账单可能尚未落盘，过一会儿要能重新解析。账单表（requestId → uid）
 * 跟数据文件 60 秒。解析失败一律返回 null，不抛异常。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 判空结果的缓存时长：429 刚发生时数据可能还没落盘，稍后要能重新解析。 */
const NULL_TTL_MS = 60000;

/**
 * @param {string} root buddyToken 数据文件所在目录（token-usage-data.js）
 */
function makeSessionResolver(root) {
  const sessionCache = new Map();   // `sid|rid` → { uid, at }
  let billByRid = null;             // requestId(小写) → uid
  let billLoadedAt = 0;

  function billTable() {
    if (billByRid && Date.now() - billLoadedAt < 60000) return billByRid;
    billByRid = new Map();
    billLoadedAt = Date.now();
    try {
      const text = fs.readFileSync(path.join(root, 'token-usage-data.js'), 'utf8');
      const m = text.match(/window\.__TOKEN_DATA__=(\{[\s\S]*\});?\s*$/);
      if (!m) return billByRid;
      const d = JSON.parse(m[1]);
      const uids = Array.isArray(d.uids) ? d.uids : [];
      for (const r of d.bill || []) {
        if (Array.isArray(r) && r[0] && r[5] >= 0 && uids[r[5]]) {
          billByRid.set(String(r[0]).toLowerCase(), uids[r[5]]);
        }
      }
    } catch { /* 读不到就全走降级，由调用方兜底 */ }
    return billByRid;
  }

  function sessionFile(sid) {
    for (const r of [path.join(os.homedir(), '.codebuddy', 'projects'),
                     path.join(os.homedir(), '.workbuddy', 'projects')]) {
      let dirs;
      try { dirs = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
      for (const e of dirs) {
        if (!e.isDirectory()) continue;
        const f = path.join(r, e.name, sid + '.jsonl');
        try { if (fs.statSync(f).isFile()) return f; } catch { /* 不在这个项目目录 */ }
      }
    }
    return null;
  }

  /**
   * @param {string} sid 会话 ID（429 行尾第二段）
   * @param {string} [rid] 429 请求的 requestId（行尾第一段；有则精确匹配）
   * @param {number} [atTs] 429 发生的毫秒时刻（时间锚，用于兜底路径）
   * @returns {string|null} uid
   */
  return function resolveSession(sid, rid, atTs) {
    if (!sid) return null;
    const key = `${sid}|${rid || atTs || ''}`;
    const cached = sessionCache.get(key);
    if (cached && (cached.uid || Date.now() - cached.at < NULL_TTL_MS)) return cached.uid;

    let uid = null;
    try {
      const f = sessionFile(sid);
      if (f) {
        const tbl = billTable();
        let anchorUid = null;
        let anchorTs = -1;
        const text = fs.readFileSync(f, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.includes('conversationRequestId')) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          const pd = o.providerData || {};
          const crUid = pd.conversationRequestId
            ? tbl.get(String(pd.conversationRequestId).toLowerCase())
            : undefined;

          // 1) 精确匹配：这条就是 429 记录，按它自己的回合查账单
          if (rid && pd.error && String(pd.error.requestID || '').toLowerCase() === String(rid).toLowerCase()) {
            if (crUid) { uid = crUid; break; }
          }
          // 2) 时间锚：记住不晚于 429 时刻的最后一条计费记录
          if (crUid && (!atTs || o.timestamp <= atTs) && o.timestamp > anchorTs) {
            anchorTs = o.timestamp;
            anchorUid = crUid;
          }
        }
        if (!uid) uid = anchorUid;
      }
    } catch { /* 单个会话解析失败不影响其他 */ }
    sessionCache.set(key, { uid, at: Date.now() });
    return uid;
  };
}

module.exports = { makeSessionResolver };
