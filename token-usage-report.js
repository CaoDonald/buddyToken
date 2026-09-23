#!/usr/bin/env node
/**
 * Token 消耗统计脚本（纯 Node.js 实现，零依赖）
 * ===============================================
 * 扫描 WorkBuddy 桌面端 / CodeBuddy CLI 的本地会话记录，输出：
 *   1. 逐条请求的 token 明细（CSV）
 *   2. 多维度汇总（按来源 / 日期 / 模型 / 会话 / 工具）
 *
 * 数据来源
 *   WorkBuddy     : %USERPROFILE%\.workbuddy\projects\<工作区>\<sessionId>.jsonl
 *   CodeBuddy CLI : %USERPROFILE%\.codebuddy\projects\<项目>\<sessionId>.jsonl
 *
 * 口径说明
 *   每一条带 message.usage 的记录 = 一次模型 API 请求。
 *   按 providerData.messageId（缺失时回退 message.id / 记录 id）去重。
 *
 *   字段口径（已对全量数据逐条实测校验，无一例外）：
 *     total_tokens = input_tokens + output_tokens      恒成立
 *     cache_read_input_tokens <= input_tokens           恒成立（命中缓存的子集）
 *   即 input_tokens 已经是「该次请求的全量上下文」，cache_read 只是它的
 *   构成拆解、不是额外增量，二者不可相加。所以：
 *     总输入 = input_tokens
 *     未命中缓存部分 = input_tokens - cache_read_input_tokens
 *     缓存命中率 = cache_read_input_tokens / input_tokens
 *
 *   由于每次请求都要重发全量上下文，input_tokens 在同会话内会逐次累加，
 *   这是 API 的真实计费口径，不是重复计数。
 *
 * 用法
 *   node token-usage-report.js                     # 全量统计
 *   node token-usage-report.js --days 7            # 最近 7 天
 *   node token-usage-report.js --since 2026-09-01  # 起始日期
 *   node token-usage-report.js -o D:\out           # 指定输出目录
 *   node token-usage-report.js --emit-js           # 额外生成看板数据 token-usage-data.js
 *   node token-usage-report.js --emit-js --light   # 同上，省略每步明细（文件约小一半）
 *   node token-usage-report.js --emit-js --no-merge # 关闭增量合并，纯全量覆盖
 *   node token-usage-report.js --emit-js --only=credits            # 刷官方账单/余额 + 顺带重扫本地会话
 *   node token-usage-report.js --emit-js --only=credits --uid <uid> # 只刷某个账号的积分（看板卡片上的刷新），同样带重扫
 *   node token-usage-report.js --reset             # 清空所有数据（删除本脚本产出的数据文件）
 *
 * 看板数据是「增量合并」写入的（默认）
 *   生成前会读取已有的 token-usage-data.js，把历次同步过、但本次本地已扫不到的
 *   回合原样保留。jsonl 会话记录被清理时，历史 token 数据不会凭空消失。
 *   同名回合以本次扫描为准（正在进行的会话会在后续同步里被补齐）。
 *   想丢弃历史、只保留本次扫描结果，加 --no-merge。
 *
 * 清空数据（--reset）
 *   删除本脚本产出的全部数据文件，回到「从未同步过」的状态：
 *     token-usage-data.js / token-usage-detail.csv / token-usage-summary.md
 *     credit-history.json（余额趋势）/ checkin-history.json（签到纪录）
 *   只按这份固定清单删除，不使用通配符。以下内容不受影响：
 *     · switch-backups/ —— 账号切换的凭证备份，删了就没法回滚
 *     · 手工导入的 *.xlsx 账单、项目里其它任何文件
 *     · ~/.workbuddy、~/.codebuddy 下的原始 jsonl 会话记录（不属于本项目）
 *   清除后重新同步即可再生成；看板侧的浏览器快照需在看板里单独清空。
 *
 * 官方账单拉取窗口
 *   默认跟随 --days（兜底 7 天）。已有数据里账单一条都没有时视为「初始化」，
 *   自动改为一次性拉全部历史（近 1 年，30 天窗口由 API 层自动切分），之后的
 *   同步回到常规窗口只做增量。--official-days 显式指定时优先于以上规则。
 *
 * 回合（turn）口径
 *   providerData.conversationRequestId 是「回合 ID」，粒度比 messageId 粗：
 *   一次用户提问 = 一个回合，但 agent 会在其中发起多次 API 请求（实测均值 7~8 次）。
 *   积分看板按回合 ID 与本脚本产出的 token 数据对齐，因此 --emit-js 会按
 *   conversationRequestId 把整回合的 token 求和，与一行积分一一对应。
 *
 * 会话标题（ti 字段）
 *   会话记录里有一条客户端自己生成的标题记录，不需要额外调模型：
 *     {"timestamp":…,"type":"ai-title","aiTitle":"…","sessionId":…,"cwd":…}
 *   每个会话一条，sessionId 与回合的 s 字段同源、可直接关联。标题是会话级
 *   而非回合级，所以 --emit-js 把它写成顶层的 ti 映射（{会话ID: 标题}），
 *   而不是塞进每个回合重复存。本地已扫不到的会话，其标题同样会被增量保留。
 *   客户端尚未生成标题的新会话会缺失，消费方需按「无标题」处理。
 *
 * 响应耗时口径（latencyMs）
 *   会话记录里没有现成的耗时字段，但记录是按 agent 循环顺序写入的：
 *     用户提交 ──> function_call @ts      （模型响应完成的时刻）
 *                   └─ 工具执行 ──> function_call_result @ts
 *                                    └─> function_call @ts
 *   因此「本次响应完成 − 上一次工具完成」即该次请求的纯模型耗时，
 *   工具执行时间被干净地排除在外。回合内首个请求以用户消息的时间戳为起点。
 *
 *   注意两条：① 它是「单次 API 请求」耗时，不是用户感知的等待时间——用户实际
 *   等的是整个回合（含工具执行）；② 时间戳是记录写入时刻，含网络、排队与完整
 *   流式输出，换网络环境数值会变。窗口外的值（<0.5s / >1h）记为 0 表示无效。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');

// 官方接口封装（拉账单 / 查积分余额）。读取失败时降级为纯本地扫描，
// 不影响脚本原有行为。见 workbuddy-api.js。
let wbApi = null;
try {
  wbApi = require('./workbuddy-api');
} catch { /* 文件缺失时静默降级 */ }

const HOME = os.homedir();

const SOURCES = [
  { name: 'WorkBuddy',    base: path.join(HOME, '.workbuddy', 'projects') },
  { name: 'CodeBuddyCLI', base: path.join(HOME, '.codebuddy',  'projects') },
];

// ---------------------------------------------------------------- 工具函数

function toDate(ts) {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') {
    const v = ts > 1e11 ? ts : ts * 1000;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof ts === 'string') {
    const d = new Date(ts.replace('Z', '+00:00'));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v) return v;
  }
  return null;
}

/**
 * 响应耗时有效性窗口。
 *   < 0.5s 多半是记录异常或没有可用起点；> 1h 多半是会话被中断后残留。
 * 落在窗口外的记为 0（无效），由消费方当作「无数据」处理。
 */
function validLatency(ms) {
  return ms > 500 && ms < 3600000 ? ms : 0;
}

function fmtTime(d) {
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

function hbar(v, vmax, width = 28) {
  if (vmax <= 0) return '';
  const k = Math.round((v / vmax) * width);
  return '#'.repeat(Math.max(k, v > 0 ? 1 : 0));
}

/** CSV 字段转义：含逗号 / 引号 / 换行的字段加双引号 */
function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 递归收集目录下所有 .jsonl */
function walk(dir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 解析单个会话文件

/**
 * 会话标题记录的行首特征。用锚定正则而不是 includes('ai-title')：工具输出
 * 正文里完全可能出现这两个词，那种行里往往还带着 usage，误判会丢记录。
 */
const TITLE_LINE_RE = /^\uFEFF?\{(?:"id":"[^"]*",)?"timestamp":\d+,"type":"ai-title"/;

async function scanFile(file, source) {
  const reqs = [];
  const turns = [];
  const titles = new Map();   // sessionId → 客户端生成的会话标题
  const fname = path.basename(file, '.jsonl');
  const projdir = path.basename(path.dirname(file));

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  // ---- 响应耗时推算状态（口径详见文件头）----
  // agent 循环是严格串行的：模型响应 → 工具执行 → 下一次模型响应。
  //   function_call 记录的时间戳    = 该次模型响应完成的时刻
  //   function_call_result 的时间戳 = 该次工具执行完成的时刻
  // 所以「本次响应完成 - 上一次工具完成」就是纯粹的模型侧耗时，工具执行被排除。
  // 回合内首个请求以用户消息的时间戳为起点。
  let anchor = 0;         // 最近一次「等待起点」；0 表示尚无可用起点
  const seen = new Map(); // messageId → 已产出的请求，用于合并同一次响应的流式分片

  for await (let line of rl) {
    // 会话标题：客户端在首轮对话后写入的独立记录，不带 usage，得单独收下
    if (TITLE_LINE_RE.test(line)) {
      const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      try {
        const d = JSON.parse(raw.trim());
        if (d.type === 'ai-title' && d.sessionId && d.aiTitle && !titles.has(d.sessionId)) {
          titles.set(d.sessionId, String(d.aiTitle));
        }
      } catch { /* 坏行忽略 */ }
      continue;
    }

    const hasUsage = line.includes('"usage"');
    const hasDelta = line.includes('"tokenDelta"');
    if (!hasUsage && !hasDelta &&
        !line.includes('"function_call_result"') && !line.includes('"role":"user"')) continue;

    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    line = line.trim();
    if (!line) continue;

    // 工具结果 / 用户消息：只用来推进响应起点。这类记录可能内含几十 KB 的工具
    // 输出，整行 JSON.parse 既慢又没必要——timestamp 一定在行首，正则取即可。
    if (!hasUsage && !hasDelta) {
      const tm = /"timestamp":\s*(\d+)/.exec(line.slice(0, 300));
      if (tm) anchor = Number(tm[1]);
      continue;
    }

    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    // ---- 回合指标 ----
    if (d.type === 'turn-metrics') {
      turns.push({
        time: toDate(d.timestamp),
        source,
        session: d.sessionId || fname,
        cwd: d.cwd || projdir,
        durationMs: d.durationMs || 0,
        tokenDelta: d.tokenDelta || 0,
      });
      continue;
    }

    // ---- 单次请求 ----
    const m = d.message;
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const u = m.usage;
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue;

    const pd = d.providerData && typeof d.providerData === 'object' ? d.providerData : {};
    const ms = typeof d.timestamp === 'number' ? d.timestamp : 0;
    const key = pick(pd, 'messageId') || m.id || d.id || '';

    // 同一次响应可能分多条写入（reasoning / 正文 / 工具调用）。token 取首条
    // （与既有的 messageId 去重口径一致），但完成时刻要取最晚的那条，
    // 否则会把耗时算到第一个分片为止，系统性低估。
    const dup = key ? seen.get(key) : null;
    if (dup) {
      if (ms && ms > dup._ms) {
        dup._ms = ms;
        dup.time = toDate(ms);
        dup.latencyMs = dup.anchorMs ? validLatency(ms - dup.anchorMs) : 0;
      }
      continue;
    }

    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;

    const r = {
      time: toDate(ms),
      source,
      model: pick(pd, 'model') || m.model || 'unknown',
      project: d.cwd || projdir,
      session: d.sessionId || fname,
      requestId: key,
      // 回合 ID：粒度比 messageId 粗，一次用户提问对应一个回合（内含多次 API 请求）
      conversationRequestId: pd.conversationRequestId || '',
      kind: d.type || '',
      tool: d.name || '',
      inputTokens: inp,
      outputTokens: out,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
      totalTokens: u.total_tokens || (inp + out),
      // 本次响应的纯模型耗时（已排除工具执行）；0 = 无法推算
      latencyMs: anchor && ms ? validLatency(ms - anchor) : 0,
      // 该次等待的起点（用户提交或上一次工具完成）。单个请求用不到它，
      // 但回合级「用户等了多久」要靠 min(anchorMs) → max(anchorMs + latencyMs)
      // 才算得准：只取首末响应时间戳会漏掉首个请求自身的耗时。
      anchorMs: anchor,
      _ms: ms,
    };
    if (key) seen.set(key, r);
    reqs.push(r);
    if (ms) anchor = ms;
  }

  // 内部分片合并字段不对外暴露
  for (const r of reqs) delete r._ms;

  return { reqs, turns, titles };
}

// ---------------------------------------------------------------- 汇总收集

async function collect(since) {
  const allReqs = [];
  const allTurns = [];
  const allTitles = new Map();   // sessionId → 会话标题（不受 --since 影响）
  const stats = [];

  for (const s of SOURCES) {
    if (!fs.existsSync(s.base)) continue;

    const files = walk(s.base);
    let nbytes = 0;
    const breqs = [];
    const bturns = [];

    for (const f of files) {
      let sz = 0;
      try {
        sz = fs.statSync(f).size;
      } catch {
        continue;
      }
      nbytes += sz;
      if (sz === 0) continue;
      const { reqs, turns, titles } = await scanFile(f, s.name);
      breqs.push(...reqs);
      bturns.push(...turns);
      for (const [k, v] of titles) if (!allTitles.has(k)) allTitles.set(k, v);
    }

    // 去重（同一请求在会话内可能被写多条）
    const seen = new Set();
    const uniq = [];
    for (const r of breqs) {
      if (r.requestId) {
        const key = r.session + '\u0000' + r.requestId;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (since && r.time && r.time < since) continue;
      uniq.push(r);
    }

    allReqs.push(...uniq);
    allTurns.push(...bturns);
    stats.push({ name: s.name, base: s.base, files: files.length, bytes: nbytes, reqs: uniq.length });
  }

  return { allReqs, allTurns, stats, titles: allTitles };
}

// ------------------------------------------------ 看板数据（按回合聚合）

/**
 * 读云同步的本机标识（云同步未启用时返回 null）。
 *
 * 只在启用时给回合挂 mch 字段：几万个回合每个多一个 36 字符的 UUID，会让数据
 * 文件平白涨好几 MB，纯本地用户没有理由付这个代价。
 *
 * cloud-sync.js 缺失或读配置失败一律返回 null，绝不影响本地流程。
 */
function loadCloudMachine() {
  try {
    const cs = require('./cloud-sync');
    if (!cs.isEnabled()) return null;
    const cfg = cs.loadConfig();
    return { id: cs.getMachineId(), name: (cfg && cfg.machineName) || os.hostname() };
  } catch {
    return null;
  }
}

/**
 * 把云同步带来的字段补进产物：机器名册、账单行的机器归属（第 7 位）。
 *
 * 账单本身属于账号维度、没有机器概念，靠「request_id 与回合的
 * conversationRequestId 同源」这一点反查。查不到的（CLI 会话、其他机器用同账号
 * 发出的请求、会话已被清理）留空，看板上归入「未标注」。
 *
 * 只补空、不覆盖：从云端拉回来的机器归属比本机反查更权威（它记录了真正的产生方）。
 * 机器名册则相反——本次的本机名要覆盖掉旧值（用户可能改过 machineName）。
 */
function applyCloudMachineInfo(data, prev, cloud) {
  const machines = { ...((prev && prev.machines) || {}) };
  if (cloud) machines[cloud.id] = cloud.name;
  if (Object.keys(machines).length) data.machines = machines;

  const turns = data.t || {};
  for (const r of data.bill || []) {
    if (!Array.isArray(r) || !r[0]) continue;
    if (r[6] !== undefined && r[6] !== null) continue;   // 已有归属（含云端拉回的）不动
    const t = turns[String(r[0]).toLowerCase()];
    if (t && t.mch) r[6] = t.mch;
  }
}

/**
 * 按 conversationRequestId 聚合，生成积分看板消费的 window.__TOKEN_DATA__。
 *
 * 一个回合 = 一次用户提问 = agent 串行发起的一批 API 请求，此处把整回合的
 * token 求和，以便与积分流水「一行积分 = 一个回合」一一对齐。
 * 键统一小写，查表侧同样归一化，避免大小写差异导致漏配。
 *
 * cloud 非空时（云同步已启用）给每个回合打上 mch（机器标识），看板据此按机器筛选。
 */
function buildTokenDataJs(reqs, light, titles, cloud) {
  const turns = new Map();

  for (const r of reqs) {
    const key = String(r.conversationRequestId || '').trim().toLowerCase();
    if (!key) continue; // 无回合 ID 的请求无法与积分关联

    let t = turns.get(key);
    if (!t) {
      t = { n: 0, in: 0, out: 0, cr: 0, cc: 0, tot: 0, t0: 0, t1: 0,
            m: '', s: r.session, src: r.source, p: r.project, best: -1, d: [],
            // 模型侧耗时：lat 为有效之和、latn 为有效条数。不依赖步骤明细，
            // 所以 --light 下依然可用（只是少了逐请求分布）。
            lat: 0, latn: 0,
            // 机器标识：云同步启用时才有值（未启用保持空串，不占体积）
            mch: cloud ? cloud.id : '' };
      turns.set(key, t);
    }
    t.n++;
    t.in  += r.inputTokens;
    t.out += r.outputTokens;
    t.cr  += r.cacheReadTokens;
    t.cc  += r.cacheCreationTokens;
    t.tot += r.totalTokens;
    if (r.latencyMs > 0) { t.lat += r.latencyMs; t.latn++; }

    const ms = r.time ? r.time.getTime() : 0;
    if (ms) {
      if (!t.t0 || ms < t.t0) t.t0 = ms;
      if (ms > t.t1) t.t1 = ms;
    }
    // 回合代表模型：取消耗最大的那次请求，比取第一次更贴近成本归因
    if (r.totalTokens > t.best) { t.best = r.totalTokens; t.m = r.model; }
    if (!light) {
      // 第 6 位是本次请求的模型耗时 ms（0 = 无法推算）。旧数据只有 5 位，
      // 消费方读下标 5 时要做「undefined 即无数据」的兼容。
      t.d.push([ms, r.tool || '', r.inputTokens, r.outputTokens, r.cacheReadTokens,
                r.latencyMs || 0]);
    }
  }

  const out = {};
  for (const [k, t] of turns) {
    const o = { n: t.n, in: t.in, out: t.out, cr: t.cr, cc: t.cc, tot: t.tot,
                t0: t.t0, t1: t.t1, m: t.m, s: t.s, src: t.src, p: t.p,
                lat: t.lat, latn: t.latn };
    // 机器标识只在有值时写：未启用云同步就不该让每个回合多挂一个空字段
    if (t.mch) o.mch = t.mch;
    if (!light) o.d = t.d.sort((a, b) => a[0] - b[0]);
    out[k] = o;
  }

  let from = 0, to = 0;
  for (const r of reqs) {
    const ms = r.time ? r.time.getTime() : 0;
    if (!ms) continue;
    if (!from || ms < from) from = ms;
    if (ms > to) to = ms;
  }

  // 会话标题只保留真的出现在本批回合里的会话，避免数据文件里挂着无数据的键
  const ti = {};
  if (titles && titles.size) {
    for (const t of turns.values()) {
      const v = t.s ? titles.get(t.s) : null;
      if (v) ti[t.s] = v;
    }
  }

  return {
    v: 1,
    gen: Date.now(),
    meta: {
      turns: turns.size,
      reqs: reqs.length,
      from, to,
      sources: [...new Set(reqs.map((r) => r.source))],
      light: !!light,
    },
    // 回合数据（云同步启用时每个回合带 mch）
    t: out,
    // 机器名册：看板把 machine_id 显示成可读名字用。云端拉回的其它机器由
    // cloud-sync.js 补进来，这里只登记本机自己。
    machines: cloud ? { [cloud.id]: cloud.name } : {},
    ti,
  };
}

/**
 * 读取已有的 token-usage-data.js，用于增量合并。
 * 文件不存在、被截断、或格式不对都返回 null（当作首次生成）。
 *
 * 注意这里不校验 t 是否存在：`--only=credits` 允许在数据文件缺失时从空骨架
 * 起步（见 syncCreditsOnly），且本地重扫失败时其产物可能只有官方字段。若因
 * 缺 t 就判为无效，紧随其后的 `--only=tokens` 会读不到这些账单，把刚拉回来
 * 的官方数据整块丢掉。需要 t 的调用方自行判空（如 main 里的增量合并用 `old.t || {}`）。
 */
function loadExistingTokenData(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    const d = JSON.parse(raw.slice(i, j + 1));
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 官方数据

/**
 * 把套餐明细按名称聚合成一行，避免几十个零散赠包刷屏。
 * 到期时间取该组内最早的一个（最紧迫的先提醒）。
 */
function groupPackages(resources) {
  const map = new Map();
  for (const r of resources) {
    const key = r.packageName || r.packageCode || '未知套餐';
    let cur = map.get(key);
    if (!cur) {
      cur = { name: key, code: r.packageCode || '', total: 0, remaining: 0, count: 0, expireAt: null };
      map.set(key, cur);
    }
    cur.total += r.total;
    cur.remaining += r.remaining;
    cur.count++;
    if (r.expireAt && (!cur.expireAt || r.expireAt < cur.expireAt)) cur.expireAt = r.expireAt;
  }
  return [...map.values()]
    .map((p) => ({ ...p, total: Math.round(p.total), remaining: Math.round(p.remaining) }))
    .sort((a, b) => (a.expireAt || Infinity) - (b.expireAt || Infinity));
}

/**
 * 拉取官方账单与各账号积分余额。
 *
 * onlyUid 只拉指定账号（看板卡片上的「刷新」按钮走这条路）；其余账号的账单
 * 与余额由调用方在合并时原样保留，不在这里处理。
 *
 * 全程「可失败」：任何一步出错都只打印警告并返回 null，绝不中断本地扫描
 * 与数据产出——看板拿不到官方数据时，仍可按原有方式手动导入 Excel。
 */
async function fetchOfficial(days, onlyUid) {
  if (!wbApi) return null;

  let accounts;
  try {
    accounts = wbApi.discoverAccounts();
  } catch (e) {
    console.warn('  [官方] 账号发现失败：' + e.message);
    return null;
  }
  const allCount = accounts.length;
  if (onlyUid) accounts = accounts.filter((a) => a.uid === onlyUid);
  if (!accounts.length) {
    console.warn(onlyUid
      ? `  [官方] 未找到账号 ${onlyUid} 的登录态，跳过刷新`
      : '  [官方] 本机未找到登录态，跳过自动同步（仍可手动导入账单 Excel）');
    return null;
  }
  const isFull = days >= FULL_HISTORY_DAYS;
  console.log(onlyUid
    ? `  [官方] 只刷新账号 ${accounts[0].name}，` +
      (isFull ? `拉取全部历史（近 ${days} 天，按 30 天窗口切分）…` : `拉取最近 ${days} 天账单…`)
    : `  [官方] 发现 ${accounts.length} 个账号，` +
      (isFull
        ? `账单还是空的，首次拉取全部历史（近 ${days} 天，按 30 天窗口切分）…`
        : `拉取最近 ${days} 天账单…`));

  const since = Date.now() - days * 86400000;
  let billing;
  try {
    billing = await wbApi.fetchBillingForAccounts(accounts, since);
  } catch (e) {
    console.warn('  [官方] 账单拉取失败：' + e.message);
    return null;
  }
  for (const e of billing.errors) {
    console.warn(`  [官方] ${e.account} 账单拉取失败：${e.error}`);
  }

  let credits = [];
  try {
    credits = await wbApi.fetchCreditForAccounts(accounts);
  } catch (e) {
    console.warn('  [官方] 积分余额查询失败：' + e.message);
  }
  for (const c of credits.filter((x) => !x.ok)) {
    console.warn(`  [官方] ${c.name} 积分查询失败：${c.error}`);
  }
  // 余额快照：官方只给当前值，趋势得自己攒（同账号同天只留最后一条）
  try {
    if (credits.some((c) => c.ok)) wbApi.recordCreditHistory(credits);
  } catch { /* 快照失败不影响主流程 */ }

  // 账号下标表：账单行只存下标，避免把 uid 重复写进每一条记录
  const uids = accounts.map((a) => a.uid);
  const idxOf = new Map(uids.map((uid, i) => [uid, i]));

  // 紧凑行：[请求ID, 积分, 模型, 客户端, 时间戳ms, 账号下标]
  const bill = billing.all.map((r) => [
    r.requestId,
    r.credit,
    r.model,
    r.client,
    Date.parse(r.requestTime.replace(' ', 'T')) || 0,
    idxOf.has(r.uid) ? idxOf.get(r.uid) : -1,
  ]);

  // 登录态：本机快照信息（app 来源与凭证有效期），与官方接口无关。
  // 只放 app 名和时间戳，不含任何 token；旧数据/离线场景缺席，消费方按无数据处理。
  const loginByUid = new Map(
    accounts.filter((a) => Array.isArray(a.apps) && a.apps.length)
      .map((a) => [a.uid, { app: a.apps[0].app, apps: a.apps }])
  );

  const accountList = credits.filter((c) => c.ok).map((c) => ({
    uid: c.uid,
    name: c.name,
    total: Math.round(c.totalCapacity),
    remaining: Math.round(c.totalRemaining),
    used: Math.round(c.used),
    soonestExpireAt: c.soonestExpireAt,
    expiringSoon: c.expiringSoon,
    expiringSoonRemaining: Math.round(c.expiringSoonRemaining),
    expired: c.expired,
    expiredRemaining: Math.round(c.expiredRemaining),
    updatedAt: c.updatedAt,
    packages: groupPackages(c.resources),
    login: loginByUid.get(c.uid) || null,
  }));

  if (!accountList.length && !bill.length) return null;

  const creditTotal = bill.reduce((a, r) => a + r[1], 0);
  console.log(`  [官方] 账单 ${fmt(bill.length)} 条 · 积分 ${creditTotal.toFixed(2)} · ` +
    `账号余额 ${accountList.length} 个`);

  return {
    accounts: accountList,
    uids,
    bill,
    meta: {
      generatedAt: Date.now(),
      windowDays: days,
      accountCount: accounts.length,
      billRows: bill.length,
      creditTotal,
      errors: billing.errors,
    },
  };
}

/**
 * 官方数据的增量合并（本地回合早就是增量合并，官方这边必须一致）。
 *
 * 为什么必须合并：官方接口只能按窗口拉取，窗口外的账单根本不在响应里。
 * 直接替换（旧的 `data.bill = official.bill`）会让每次同步都把窗口外的历史
 * 抹掉——只要同步过一次近 7 天，更早的账单就永久消失了。
 *
 * 合并规则：
 *   · bill 按 RequestID 去重，历史行先入表、本次同名行覆盖它（本次为准）
 *   · uids 是账号下标表，行里只存下标，所以必须重排：本次账号保持原顺序在前，
 *     历史行用到的旧账号按需追加到后面，否则历史行的账号归属会指错人
 *   · acct（余额）是当前快照、不是累加量，直接取本次结果
 *
 * canMerge=false（--no-merge）时退回纯覆盖，用于明确要丢弃历史重开的场景。
 *
 * partialUid 是「只刷一个账号」：此时 fresh 只含该账号的数据，acct 必须按 uid
 * 覆盖到旧快照上——直接取本次结果会把其余账号的余额卡片整块抹掉。
 */
function mergeOfficialData(prev, fresh, canMerge, partialUid) {
  const freshBill = Array.isArray(fresh.bill) ? fresh.bill : [];
  const freshUids = Array.isArray(fresh.uids) ? fresh.uids : [];
  const prevBill = canMerge && prev && Array.isArray(prev.bill) ? prev.bill : [];
  const prevUids = canMerge && prev && Array.isArray(prev.uids) ? prev.uids : [];

  const uids = [...freshUids];
  const idxOf = new Map(uids.map((uid, i) => [uid, i]));
  const mapUid = (uid) => {
    if (!idxOf.has(uid)) {
      idxOf.set(uid, uids.length);
      uids.push(uid);
    }
    return idxOf.get(uid);
  };

  const byId = new Map();
  for (const r of prevBill) {
    if (!Array.isArray(r) || !r[0]) continue;
    // 老下标 → 老 uid → 新下标；老行没有账号归属（-1）时保持未知
    const uid = r[5] >= 0 ? prevUids[r[5]] : null;
    const row = [r[0], r[1], r[2], r[3], r[4], uid ? mapUid(uid) : -1];
    // 第 7 位是云同步的机器归属，重建行时必须原样带上——漏掉的话每跑一次同步
    // 就把云端拉回来的机器标注丢一层，看板「按机器」的统计会慢慢失真。
    if (r[6] !== undefined) row.push(r[6]);
    byId.set(String(r[0]), row);
  }
  let added = 0;
  for (const r of freshBill) {
    if (!Array.isArray(r) || !r[0]) continue;
    const id = String(r[0]);
    if (!byId.has(id)) added++;
    byId.set(id, r);
  }

  const bill = [...byId.values()].sort((a, b) => (a[4] || 0) - (b[4] || 0));
  const keptRows = bill.length - added;

  // 余额快照：整体刷新直接取本次；只刷一个账号时按 uid 覆盖，其余账号沿用旧快照
  let accounts = fresh.accounts;
  let accountCount = fresh.meta && fresh.meta.accountCount;
  if (partialUid) {
    const byUid = new Map();
    for (const a of (canMerge && prev && Array.isArray(prev.acct)) ? prev.acct : []) {
      if (a && a.uid) byUid.set(a.uid, a);
    }
    for (const a of fresh.accounts) byUid.set(a.uid, a);
    accounts = [...byUid.values()];
    // 账号总数描述的是「本机一共有几个账号」，单账号刷新时不该被改成 1
    accountCount = (prev && prev.official && prev.official.accountCount) || accounts.length;
  }

  return {
    accounts,
    uids,
    bill,
    meta: {
      ...fresh.meta,
      accountCount,
      billRows: bill.length,        // 合并后的总条数
      creditTotal: bill.reduce((s, r) => s + (Number(r[1]) || 0), 0),
      addedRows: added,             // 本次新增
      keptRows,                     // 历史保留
    },
  };
}

// ---------------------------------------------------------------- 只刷新官方数据

/**
 * 官方数据「全量拉取」窗口（天）。
 *
 * 「初始化」＝已有数据文件里账单一条都没有（首次生成、--no-official 离线首跑、
 * 或官方同步一直失败）。此时若仍按默认 7 天拉，窗口外的历史账单永远不会被补回
 * ——增量合并只保留已经拉到的行，没拉到的等于永久丢失。所以初始化时一次拉全量：
 * 窗口取 1 年，足以覆盖本机有记录以来的账单；服务端「窗口 >31 天返回空」的
 * 限制由 workbuddy-api.js 按 30 天自动切分兜住（1 年 ≈ 13 段，乘以账号数就是
 * 首次同步要发的请求数，直接决定耗时；3 年要 37 段，正是 28 秒的来源）。
 * 之后每次同步只需拉最近几天做增量。
 * 要补更早的账单，用 --official-days 显式指定更大的窗口（只此一次，拉回来的
 * 行会被增量合并保留下来）。
 */
const FULL_HISTORY_DAYS = 365;

/**
 * 官方数据拉取窗口：优先显式参数；账单还是空的（初始化）时取全量窗口；
 * 否则跟随本地扫描范围，最后兜底 7 天。
 *
 * prevData：已有的 token-usage-data.js 数据（读不到为 null），用它的 bill
 * 行数判断是否初始化。null（文件不存在＝首次生成）同样视为初始化。
 */
function resolveOfficialDays(args, days, prevData) {
  if (args['official-days']) return parseInt(args['official-days'], 10);
  const prevBill = prevData && Array.isArray(prevData.bill) ? prevData.bill : [];
  if (!prevBill.length) return FULL_HISTORY_DAYS;
  return days > 0 ? days : 7;
}

/**
 * 只刷新官方账单与积分余额（`--only=credits`）。
 *
 * 不重写 CSV 与汇总报告，但会顺带重扫本地会话——「按账号刷积分」和「Token
 * 扫描」虽是两个维度，可 Token 数字一旦停在旧时点，看板上模型分布就会像丢
 * 了数据（2026-09-22 实际踩过：卡片刷新后 glm-5.3 显示 1.85M，实际已 5.1M）。
 * 全量扫描只要几秒，跟着积分一起刷掉，保证两种刷新看到的数字一致。
 *
 * uid 非空时只刷新该账号（看板账号卡片上的「刷新」按钮）：账单按 RequestID
 * 合并、余额按 uid 覆盖，其余账号的账单与余额原样保留。
 */
async function syncCreditsOnly({ outdir, jsOut, args, days, noMerge, uid, light }) {
  if (!wbApi) {
    console.error('缺少 workbuddy-api.js，无法同步官方数据');
    process.exit(1);
  }
  // 云同步已启用时，本条路径产出的回合也要带机器标识（否则「🔄 刷积分」跑完
  // 会把带 mch 的回合换成不带 mch 的，看板按机器筛选就断了）
  const cloud = loadCloudMachine();

  const name = jsOut || 'token-usage-data.js';
  const jsPath = path.isAbsolute(name) ? name : path.join(outdir, name);

  // 数据文件不存在＝首次使用（刚 clone、或刚清过产物）：按初始化处理，用空骨架
  // 继续往下走，让 resolveOfficialDays 自动改拉全部历史（见其注释里的 null 分支）。
  // 本地 Token 部分由下面的重扫补上；若重扫失败，产物会暂时只有官方字段。
  // 骨架里的 t / ti 不能省：后续「🔄 同步 Token」要靠读这个文件把官方字段带
  // 回去，而它按「有没有 t 判断是不是有效数据文件」，缺了就会把账单整块丢掉。
  const existing = loadExistingTokenData(jsPath);
  const data = existing || { meta: { turns: 0 }, ti: {}, t: {} };

  // 已有账单一条都没有＝初始化：自动改拉全部历史，之后的同步再回到常规窗口
  const officialDays = resolveOfficialDays(args, days, data);
  const official = await fetchOfficial(officialDays, uid);
  if (!official) {
    console.error(uid
      ? `账号 ${uid} 刷新失败，数据文件保持不变。`
      : '官方数据拉取失败，数据文件保持不变。');
    process.exit(1);
  }

  // 增量合并：窗口外的历史账单原样保留（本地回合由下面的重扫更新）
  const merged = mergeOfficialData(data, official, !noMerge, uid);
  data.acct = merged.accounts;
  data.uids = merged.uids;
  data.bill = merged.bill;
  data.official = merged.meta;
  // 余额历史同样要刷新（快照已在 fetchOfficial 里记过）
  try {
    const h = wbApi.loadCreditHistory();
    if (h && h.byUid) data.hist = h.byUid;
  } catch { /* 无历史时省略 */ }

  // 顺带重扫本地会话，把 Token 部分也带到最新。合并规则与主流程一致：
  // 同名回合以本次扫描为准，本地已清理但历史同步过的回合原样保留。
  // 扫描失败不影响官方数据落盘（降级为只更新积分，回到旧行为）。
  let keptTurns = 0;
  try {
    const since = days > 0 ? new Date(Date.now() - days * 86400000) : null;
    const { allReqs, titles } = await collect(since);
    const local = buildTokenDataJs(allReqs, light, titles, cloud);
    if (noMerge) {
      data.t = local.t;
      data.ti = local.ti || {};
    } else {
      for (const [k, v] of Object.entries(local.t)) data.t[k] = v;
      for (const [k, v] of Object.entries(local.ti || {})) data.ti[k] = v;
      for (const [k, v] of Object.entries(existing ? (existing.t || {}) : {})) {
        if (!data.t[k]) { data.t[k] = v; keptTurns++; }
      }
      for (const [k, v] of Object.entries(existing ? (existing.ti || {}) : {})) {
        if (!data.ti[k]) data.ti[k] = v;
      }
    }
    // 重算 meta：沿用旧文件的累计值会跟合并后的回合表对不上
    let reqs = 0, from = null, to = null;
    for (const v of Object.values(data.t)) {
      reqs += v.n || 0;
      if (v.t0 && (from === null || v.t0 < from)) from = v.t0;
      if (v.t1 && (to === null || v.t1 > to)) to = v.t1;
    }
    data.meta.reqs = reqs;
    data.meta.turns = Object.keys(data.t).length;
    if (from) data.meta.from = from;
    if (to) data.meta.to = to;
    // 会话 → 账号映射：与官方接口无关，但顺手一起刷新
    try {
      const su = wbApi.readSessionsFromDb();
      if (su && Object.keys(su).length) data.su = su;
    } catch { /* 读库失败不影响主流程 */ }
    console.log(`  [本地] 重扫 ${fmt(Object.keys(local.t).length)} 个回合` +
      (keptTurns ? ` + 历史保留 ${fmt(keptTurns)} 个` : '') +
      ` = ${fmt(data.meta.turns)} 个`);
  } catch (e) {
    console.warn(`  [本地] 重扫失败，Token 数据保持原样：${e.message}`);
  }

  // 刷新数据生成时间：existing 沿用旧文件的 gen，不重置的话看板的
  // 「数据 X 小时前生成」会停在很久以前，让人误以为同步没生效
  data.gen = Date.now();

  // 机器名册与账单机器位：补空不覆盖（云端拉回来的归属更权威）
  applyCloudMachineInfo(data, existing, cloud);

  const scope = `账号 ${(official.accounts[0] && official.accounts[0].name) || uid}（其余账号保留）`;
  const head = '/* 由 token-usage-report.js 自动生成，请勿手工编辑 */\n' +
    `/* ${fmtTime(new Date())} · 刷新官方账单` +
    (uid ? `（只刷 ${scope}）` : '') +
    ` + 重扫本地 · ` +
    (officialDays >= FULL_HISTORY_DAYS ? `账单初始化全量，近 ${officialDays} 天 · ` : `账单近 ${officialDays} 天 · `) +
    `本次新增 ${fmt(merged.meta.addedRows)} 条 + 历史保留 ${fmt(merged.meta.keptRows)} 条 ` +
    `= 账单 ${fmt(merged.bill.length)} 条 · 账号 ${merged.accounts.length} 个 · ` +
    `回合 ${fmt(data.meta.turns)} 个 */\n`;
  fs.writeFileSync(jsPath, head + 'window.__TOKEN_DATA__=' + JSON.stringify(data) + ';\n', 'utf8');

  console.log('');
  console.log(uid
    ? `  已刷新 ${scope} 的积分，并重扫了本地会话`
    : '  已刷新官方数据，并重扫了本地会话');
  console.log(`  账单增量合并：本次新增 ${fmt(merged.meta.addedRows)} 条 + ` +
    `历史保留 ${fmt(merged.meta.keptRows)} 条 = ${fmt(merged.bill.length)} 条，窗口外的历史未丢弃`);
  console.log(`  看板数据 : ${jsPath}`);
}

// ---------------------------------------------------------------- 主流程

/**
 * 清空数据：删除本脚本产出的数据文件（清单见文件头「清空数据」一节）。
 *
 * 只删下面这份固定清单，不做通配符匹配、不递归删目录——清空是破坏性操作，
 * 宁可漏删也不误删。清单外的文件一律不碰。
 *
 * 路径基准是 outdir（默认脚本所在目录，与 --emit-js 的产出一致）。
 */
function resetDataFiles(outdir, jsOut) {
  const jsName = jsOut || 'token-usage-data.js';
  const targets = [
    path.isAbsolute(jsName) ? jsName : path.join(outdir, jsName),
    path.join(outdir, 'token-usage-detail.csv'),
    path.join(outdir, 'token-usage-summary.md'),
    path.join(outdir, 'credit-history.json'),
    path.join(outdir, 'checkin-history.json'),
  ];

  const removed = [], missing = [];
  let bytes = 0;
  for (const f of targets) {
    let size = 0;
    try {
      size = fs.statSync(f).size;
    } catch {
      missing.push(f);              // 本来就不存在：跳过，不算失败
      continue;
    }
    try {
      fs.rmSync(f, { force: true });
      removed.push(path.basename(f));
      bytes += size;
    } catch (e) {
      console.error(`  删除失败：${path.basename(f)} —— ${e.message}`);
      process.exitCode = 1;
    }
  }

  if (removed.length) {
    console.log(`已清空 ${removed.length} 个数据文件（释放 ${(bytes / 1048576).toFixed(1)} MB）：`);
    for (const n of removed) console.log('  ✓ ' + n);
  } else {
    console.log('没有可清空的数据文件（本来就没同步过）。');
  }
  if (missing.length) {
    console.log(`  跳过 ${missing.length} 个不存在的文件：` +
      missing.map((f) => path.basename(f)).join('、'));
  }
  console.log('  保留：switch-backups/ 账号备份、手工导入的 Excel、' +
    '原始会话记录（~/.workbuddy、~/.codebuddy 未改动）。');
  console.log('  重新同步即可再生成这些数据文件。');
}

async function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        days: { type: 'string' },
        since: { type: 'string' },
        outdir: { type: 'string', short: 'o' },
        'emit-js': { type: 'boolean' },
        'light': { type: 'boolean' },
        'no-merge': { type: 'boolean' },
        'js-out': { type: 'string' },
        'no-official': { type: 'boolean' },
        'official-days': { type: 'string' },
        only: { type: 'string' },
        uid: { type: 'string' },
        reset: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) {
    console.error('参数错误：' + e.message);
    process.exit(1);
  }

  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
    return;
  }

  const days = args.days ? parseInt(args.days, 10) : 0;
  const outdir = args.outdir ? path.resolve(args.outdir) : __dirname;
  const emitJs = !!args['emit-js'];
  const light  = !!args.light;

  const only = (args.only || '').trim();
  if (only && only !== 'credits' && only !== 'tokens') {
    console.error('--only 只支持 credits（只刷积分）或 tokens（只扫本地会话）');
    process.exit(1);
  }

  // --uid：只刷新某个账号（看板账号卡片的「刷新」按钮）。它只对「只刷积分」
  // 有意义——扫描本地会话是按目录而非按账号组织的，没有「只扫某账号」这回事。
  const uid = (args.uid || '').trim();
  if (uid && !/^[0-9a-zA-Z_-]{1,64}$/.test(uid)) {
    console.error('--uid 格式不合法（只接受字母、数字、下划线、连字符）');
    process.exit(1);
  }
  if (uid && only !== 'credits') {
    console.error('--uid 只能与 --only=credits 一起使用（只刷新单个账号的积分）');
    process.exit(1);
  }

  // 清空：只删数据文件，不扫描也不生成。放在 mkdirSync 之前短路，
  // 这样清空不会顺手把目录建出来，也不受 --only / --days 等参数影响。
  if (args.reset) {
    console.log('== 清空数据 ==');
    resetDataFiles(outdir, args['js-out']);
    return;
  }

  fs.mkdirSync(outdir, { recursive: true });

  // 只刷新积分：不扫本地、不重写 CSV 与报告，走独立路径后直接结束
  if (only === 'credits') {
    await syncCreditsOnly({
      outdir,
      jsOut: args['js-out'],
      args,
      days,
      noMerge: !!args['no-merge'],
      uid,
      light,
    });
    return;
  }

  const now = new Date();
  let since = null;
  if (args.since) {
    since = new Date(args.since + 'T00:00:00');
    if (isNaN(since.getTime())) {
      console.error('--since 日期格式应为 YYYY-MM-DD');
      process.exit(1);
    }
  } else if (days > 0) {
    since = new Date(now.getTime() - days * 86400000);
  }

  const { allReqs: reqs, allTurns: turns, stats, titles } = await collect(since);

  // ---------------------------------------------------------- 明细 CSV
  reqs.sort((a, b) => (a.time ? a.time.getTime() : 0) - (b.time ? b.time.getTime() : 0));

  const csvPath = path.join(outdir, 'token-usage-detail.csv');
  const lines = [];
  lines.push(['时间', '来源', '模型', '项目目录', '会话ID', '回合ID', '请求ID', '类型', '工具',
              '输入token', '输出token', '缓存读token', '缓存写token', '合计token',
              '响应耗时ms'].join(','));
  for (const r of reqs) {
    lines.push([
      fmtTime(r.time), r.source, r.model, r.project, r.session,
      r.conversationRequestId, r.requestId,
      r.kind, r.tool, r.inputTokens, r.outputTokens, r.cacheReadTokens,
      r.cacheCreationTokens, r.totalTokens, r.latencyMs || '',
    ].map(esc).join(','));
  }
  // \uFEFF = UTF-8 BOM，保证 Excel 双击打开中文不乱码
  fs.writeFileSync(csvPath, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

  // ---------------------------------------------------------- 看板数据（积分关联用）
  let jsPath = null;
  if (emitJs) {
    const name = args['js-out'] || 'token-usage-data.js';
    jsPath = path.isAbsolute(name) ? name : path.join(outdir, name);
    // 云同步启用时：回合带机器标识、产物带机器名册（未启用则都为无，不占体积）
    const cloud = loadCloudMachine();
    const data = buildTokenDataJs(reqs, light, titles, cloud);
    const freshTurns = data.meta.turns;

    // 旧文件只读一次：官方账单合并、本地回合增量、--only=tokens 保留官方字段都要用
    const prev = loadExistingTokenData(jsPath);

    // `--only=tokens` 不管官方数据，但也不能把它抹掉：
    // 本次构建只含本地部分，需把旧文件里的官方字段原样带回。
    if (only === 'tokens') {
      if (prev) {
        if (prev.acct) data.acct = prev.acct;
        if (prev.uids) data.uids = prev.uids;
        if (prev.bill) data.bill = prev.bill;
        if (prev.official) data.official = prev.official;
        if (prev.su) data.su = prev.su;
        if (prev.hist) data.hist = prev.hist;
        // 机器名册也要带回：本次只扫本地，不带回就等于把云端拉回来的其他机器抹掉了
        if (prev.machines) data.machines = { ...prev.machines, ...(data.machines || {}) };
      }
    }

    // 账号归属：会话 ID → 账号 uid。
    // 本地 jsonl 里没有账号字段，这份映射来自 WorkBuddy 的 SQLite 库；
    // 与官方接口无关，所以放在官方同步块之外，接口挂了也能拿到。
    if (wbApi) {
      try {
        const su = wbApi.readSessionsFromDb();
        if (su && Object.keys(su).length) data.su = su;
      } catch { /* 读库失败不影响主流程 */ }
    }

    // 官方账单与积分余额：自动同步。任一步失败都只降级，不影响本地数据产出。
    // `--only=tokens` 时跳过，这样「只扫本地」不会覆盖掉已有的官方数据。
    if (only !== 'tokens' && wbApi && !args['no-official']) {
      // prev 为 null（首次生成）或账单为空时 resolveOfficialDays 会返回全量窗口，
      // 与「同步积分」按钮的初始化行为保持一致
      const officialDays = resolveOfficialDays(args, days, prev);
      const official = await fetchOfficial(officialDays);
      if (official) {
        // 增量合并：窗口外的历史账单保留下来，只往里补新拉到的
        const merged = mergeOfficialData(prev, official, !args['no-merge']);
        data.acct = merged.accounts;
        data.uids = merged.uids;
        data.bill = merged.bill;
        data.official = merged.meta;
        if (merged.meta.keptRows) {
          console.log(`  [官方] 账单增量合并：本次新增 ${fmt(merged.meta.addedRows)} 条 + ` +
            `历史保留 ${fmt(merged.meta.keptRows)} 条 = ${fmt(merged.bill.length)} 条`);
        }
        // 余额历史（趋势图用）：按 uid 存 [[ts, remaining], ...]
        try {
          const h = wbApi.loadCreditHistory();
          if (h && h.byUid) data.hist = h.byUid;
        } catch { /* 无历史时省略该字段 */ }
      }
    }

    // 增量合并：把历次同步过、但本次本地 jsonl 里已不存在的回合保留下来，
    // 避免会话记录被清理后旧数据凭空消失。同名回合以本次扫描为准
    // （正在进行的会话会在后续同步里被补齐）。
    let kept = 0;
    if (!args['no-merge']) {
      const old = prev;
      if (old) {
        // old.t 可能不存在（旧文件由 --only=credits 从空骨架写出），按空表处理
        for (const [k, v] of Object.entries(old.t || {})) {
          if (data.t[k]) continue;
          data.t[k] = v;
          kept++;
          data.meta.reqs += v.n || 0;
          if (v.t0 && (!data.meta.from || v.t0 < data.meta.from)) data.meta.from = v.t0;
          if (v.t1 && v.t1 > data.meta.to) data.meta.to = v.t1;
        }
        // 标题同样增量保留：本地 jsonl 已清理的会话，其标题也该跟着留下
        if (old.ti) {
          for (const [k, v] of Object.entries(old.ti)) {
            if (!data.ti[k]) data.ti[k] = v;
          }
        }
        data.meta.turns = Object.keys(data.t).length;
        data.meta.kept = kept;
        data.meta.merged = kept > 0;
      }
    }

    // 机器名册与账单机器位（补空不覆盖：云端拉回来的归属比本机反查更权威）
    applyCloudMachineInfo(data, prev, cloud);

    const head = '/* 由 token-usage-report.js 自动生成，请勿手工编辑 */\n' +
                 `/* ${fmtTime(new Date())} · 本次扫描 ${fmt(freshTurns)} 个回合` +
                 (kept ? ` + 历史保留 ${fmt(kept)} 个` : '') +
                 ` = ${fmt(data.meta.turns)} · 请求 ${fmt(data.meta.reqs)}` +
                 `${light ? ' · 已省略每步明细' : ''} */\n`;
    fs.writeFileSync(jsPath, head + 'window.__TOKEN_DATA__=' + JSON.stringify(data) + ';\n', 'utf8');
    if (kept) {
      console.log(`  （增量合并：保留了 ${fmt(kept)} 个本地已不存在、但历史上同步过的回合）`);
    }
  }

  // ---------------------------------------------------------- 汇总报告
  const L = [];
  const W = (s = '') => L.push(s);

  W('# Token 消耗报告');
  W();
  W(`- 生成时间：${fmtTime(now)}`);
  W(`- 统计范围：${since ? '自 ' + fmtDate(since) + ' 起' : '全部历史'}`);
  W(`- 请求条数：**${fmt(reqs.length)}**`);
  W();

  W('## 一、数据源');
  W();
  W('| 来源 | 目录 | 会话文件 | 体积 | 有效请求 |');
  W('| --- | --- | ---: | ---: | ---: |');
  for (const s of stats) {
    W(`| ${s.name} | \`${s.base.replace(HOME, '~')}\` | ${s.files} | ${(s.bytes / 1048576).toFixed(1)} MB | ${fmt(s.reqs)} |`);
  }
  W();

  if (reqs.length === 0) {
    W('> 未发现任何带 usage 的请求记录。');
    const mdPath = path.join(outdir, 'token-usage-summary.md');
    fs.writeFileSync(mdPath, L.join('\n'), 'utf8');
    console.log(L.join('\n'));
    return;
  }

  const agg = (keyFn) => {
    const d = new Map();
    for (const r of reqs) {
      const k = keyFn(r);
      if (k === null || k === undefined) continue;
      let c = d.get(k);
      if (!c) {
        c = { n: 0, in: 0, out: 0, cr: 0, cc: 0, tot: 0 };
        d.set(k, c);
      }
      c.n++;
      c.in  += r.inputTokens;
      c.out += r.outputTokens;
      c.cr  += r.cacheReadTokens;
      c.cc  += r.cacheCreationTokens;
      c.tot += r.totalTokens;
    }
    return d;
  };

  const tot = reqs.reduce((a, r) => {
    a.n++;
    a.in += r.inputTokens;
    a.out += r.outputTokens;
    a.cr += r.cacheReadTokens;
    a.cc += r.cacheCreationTokens;
    a.tot += r.totalTokens;
    return a;
  }, { n: 0, in: 0, out: 0, cr: 0, cc: 0, tot: 0 });

  W('## 二、总览');
  W();
  W('| 指标 | 数值 |');
  W('| --- | ---: |');
  W(`| 请求次数 | ${fmt(tot.n)} |`);
  W(`| 输入 token（全量上下文） | ${fmt(tot.in)} |`);
  W(`| &nbsp;&nbsp;其中：命中缓存 | ${fmt(tot.cr)} |`);
  W(`| &nbsp;&nbsp;其中：未命中缓存 | ${fmt(tot.in - tot.cr)} |`);
  W(`| 输出 token | ${fmt(tot.out)} |`);
  W(`| **合计 token（input+output）** | **${fmt(tot.tot)}** |`);
  if (tot.n) W(`| 单次请求均值 | ${fmt(tot.tot / tot.n)} |`);
  if (tot.in) W(`| 缓存命中率 | ${((100 * tot.cr) / tot.in).toFixed(1)}% |`);
  W();

  // 按来源
  const bySrc = agg((r) => r.source);
  W('## 三、按来源');
  W();
  W('| 来源 | 请求 | 输入 | 输出 | 其中缓存读 | 合计 | 占比 |');
  W('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [k, c] of [...bySrc].sort((a, b) => b[1].tot - a[1].tot)) {
    const pct = ((100 * c.tot) / (tot.tot || 1)).toFixed(1);
    W(`| ${k} | ${fmt(c.n)} | ${fmt(c.in)} | ${fmt(c.out)} | ${fmt(c.cr)} | ${fmt(c.tot)} | ${pct}% |`);
  }
  W();

  // 按日期
  const byDay = agg((r) => fmtDate(r.time));
  W('## 四、按日期');
  W();
  W('| 日期 | 请求 | 输入 | 输出 | 合计 | 缓存命中率 |');
  W('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [k, c] of [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 60)) {
    const h = c.in ? ((100 * c.cr) / c.in).toFixed(1) : '0.0';
    W(`| ${k} | ${fmt(c.n)} | ${fmt(c.in)} | ${fmt(c.out)} | ${fmt(c.tot)} | ${h}% |`);
  }
  W();

  // 按模型
  const byModel = agg((r) => r.model);
  const vmax = Math.max(0, ...[...byModel.values()].map((c) => c.tot));
  W('## 五、按模型');
  W();
  W('| 模型 | 请求 | 输入 | 输出 | 合计 | 分布 |');
  W('| --- | ---: | ---: | ---: | ---: | --- |');
  for (const [k, c] of [...byModel].sort((a, b) => b[1].tot - a[1].tot)) {
    W(`| ${k} | ${fmt(c.n)} | ${fmt(c.in)} | ${fmt(c.out)} | ${fmt(c.tot)} | \`${hbar(c.tot, vmax)}\` |`);
  }
  W();

  // 按会话
  const bySess = agg((r) => r.session);
  const meta = new Map(reqs.map((r) => [r.session, r.project]));
  W('## 六、消耗最高的 25 个会话');
  W();
  W('| # | 会话ID | 项目 | 请求 | 合计 token |');
  W('| ---: | --- | --- | ---: | ---: |');
  [...bySess]
    .sort((a, b) => b[1].tot - a[1].tot)
    .slice(0, 25)
    .forEach(([k, c], i) => {
      W(`| ${i + 1} | \`${k}\` | ${meta.get(k) || ''} | ${fmt(c.n)} | ${fmt(c.tot)} |`);
    });
  W();

  // 按工具
  const byTool = agg((r) => r.tool || '(无工具/纯文本)');
  W('## 七、按调用工具');
  W();
  W('| 工具 | 请求 | 输入 | 输出 | 合计 | 单次均值 |');
  W('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [k, c] of [...byTool].sort((a, b) => b[1].tot - a[1].tot).slice(0, 30)) {
    W(`| ${k} | ${fmt(c.n)} | ${fmt(c.in)} | ${fmt(c.out)} | ${fmt(c.tot)} | ${fmt(c.tot / (c.n || 1))} |`);
  }
  W();

  // 模型响应耗时（请求级）
  const latReqs = reqs.filter((r) => r.latencyMs > 0);
  if (latReqs.length) {
    const latMap = new Map();
    for (const r of latReqs) {
      let c = latMap.get(r.model);
      if (!c) { c = { n: 0, sum: 0, out: 0, l: [] }; latMap.set(r.model, c); }
      c.n++;
      c.sum += r.latencyMs;
      c.out += r.outputTokens;
      c.l.push(r.latencyMs);
    }

    W('## 八、模型响应时间');
    W();
    W('> **口径**：单次 API 请求的端到端耗时 =「模型响应完成时刻 − 上一次工具执行');
    W('> 完成时刻」，**已排除工具执行时间**，但含网络往返、排队与完整流式输出。');
    W('> 它不是用户感知的等待时间——用户等的是整个回合（含工具执行），见下一章。');
    W('> 时间戳取的是记录写入时刻，换网络环境数值会变。');
    W();
    const latAll = latReqs.map((r) => r.latencyMs).sort((a, b) => a - b);
    W(`- 有效样本：${fmt(latReqs.length)} / ${fmt(reqs.length)} 条请求` +
      `（其余 ${fmt(reqs.length - latReqs.length)} 条无法推算耗时）`);
    W(`- 整体：均值 ${(latAll.reduce((a, b) => a + b, 0) / latAll.length / 1000).toFixed(1)}s` +
      ` · P50 ${(latAll[Math.floor(latAll.length / 2)] / 1000).toFixed(1)}s` +
      ` · P90 ${(latAll[Math.floor(latAll.length * 0.9)] / 1000).toFixed(1)}s`);
    W();
    W('| 模型 | 样本 | 均值 | P50 | P90 | 有效吞吐 |');
    W('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const [k, c] of [...latMap].sort((a, b) => b[1].n - a[1].n)) {
      c.l.sort((a, b) => a - b);
      // 有效吞吐 = Σ输出token / Σ耗时，含首字延迟的影响，是偏保守的速度口径
      const thru = c.sum > 0 ? (c.out / c.sum) * 1000 : 0;
      W(`| ${k}${c.n < 30 ? ' *' : ''} | ${fmt(c.n)} | ${(c.sum / c.n / 1000).toFixed(1)}s | ` +
        `${(c.l[Math.floor(c.l.length / 2)] / 1000).toFixed(1)}s | ` +
        `${(c.l[Math.floor(c.l.length * 0.9)] / 1000).toFixed(1)}s | ${thru.toFixed(1)} tok/s |`);
    }
    W();
    if ([...latMap.values()].some((c) => c.n < 30)) {
      W('> `*` 样本不足 30 条，数字仅供参考。对比不同模型时请优先看同一输出规模下的');
      W('> 表现——输出 token 量是耗时的主要驱动因素。');
      W();
    }
  }

  // 回合指标
  if (turns.length) {
    W('## 九、回合指标（turn-metrics，交叉验证用）');
    W();
    W('> **口径差异（重要）**：`turn-metrics.tokenDelta` 统计的是「本回合新增内容」的');
    W('> 增量，而 `usage.input_tokens` 是每次请求重发的全量上下文。两者数字差异大是');
    W('> 正常的，不可相加或直接比较。**计费口径请以第二章的 usage 为准**；');
    W('> tokenDelta 更适合衡量真实产出规模与耗时。');
    W();
    const tsum = turns.reduce((a, t) => a + t.tokenDelta, 0);
    const tdur = turns.reduce((a, t) => a + t.durationMs, 0);
    W(`- 回合数：${fmt(turns.length)}`);
    W(`- token 增量合计：${fmt(tsum)}`);
    W(`- 累计耗时：${(tdur / 3600000).toFixed(1)} 小时`);
    // 回合级口径：把每回合的模型耗时之和与该回合「用户实际经历」的跨度相比，
    // 回答「等的时间里有多少花在模型上」。
    // 跨度 = max(等待起点 + 耗时) − min(等待起点)：起点是用户提交时刻、终点是
    // 最后一次响应完成时刻，因此含首个请求自身的耗时。若改用首末响应时间戳相减，
    // 会漏掉首个请求，占比被显著高估。
    const perTurn = new Map();
    for (const r of reqs) {
      const k = r.conversationRequestId;
      if (!k || !r.anchorMs) continue;
      let g = perTurn.get(k);
      if (!g) { g = { lat: 0, n: 0, start: 0, end: 0 }; perTurn.set(k, g); }
      if (r.latencyMs > 0) {
        g.lat += r.latencyMs;
        g.n++;
        const end = r.anchorMs + r.latencyMs;
        if (end > g.end) g.end = end;
      }
      if (!g.start || r.anchorMs < g.start) g.start = r.anchorMs;
    }
    const ratios = [];
    for (const g of perTurn.values()) {
      if (!g.n || !g.start || g.end <= g.start) continue;
      const span = g.end - g.start;
      // 跨度超过 6 小时的回合基本是会话中断后 anchor 被污染的残留，
      // 会让分母虚高；占比 >1 说明推算有舍入误差。两者都不参与统计。
      if (span > 6 * 3600000) continue;
      const r = g.lat / span;
      if (r > 1.02) continue;
      ratios.push(Math.min(r, 1));
    }
    if (ratios.length) {
      ratios.sort((a, b) => a - b);
      const q = (x) => (ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * x))] * 100).toFixed(1);
      W(`- 模型耗时占回合跨度：中位 **${q(0.5)}%**（四分位 ${q(0.25)}% ~ ${q(0.75)}%）` +
        `｜${fmt(ratios.length)} 个可测算回合`);
      W(`- 跨度 = 用户提交 → 最后一次响应完成（不含用户输入时间），其余为工具执行。`);
      W(`  分布很宽：纯读文件类回合接近 100%，跑长命令或等外部接口的回合可低到 30% 以下。`);
    }
    W();
    W('| 日期 | 回合 | token增量 |');
    W('| --- | ---: | ---: |');
    const byd = new Map();
    for (const t of turns) {
      const k = fmtDate(t.time) || '未知';
      let c = byd.get(k);
      if (!c) {
        c = { n: 0, tok: 0 };
        byd.set(k, c);
      }
      c.n++;
      c.tok += t.tokenDelta;
    }
    for (const [k, c] of [...byd].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30)) {
      W(`| ${k} | ${fmt(c.n)} | ${fmt(c.tok)} |`);
    }
    W();
  }

  W('## 十、明细文件');
  W();
  W(`- \`${path.basename(csvPath)}\`  （逐条请求，可用 Excel 打开做透视）`);
  W();

  const mdPath = path.join(outdir, 'token-usage-summary.md');
  fs.writeFileSync(mdPath, L.join('\n'), 'utf8');

  // ---------------------------------------------------------- 控制台简版
  const bar = '='.repeat(62);
  const hit = tot.in ? ((100 * tot.cr) / tot.in).toFixed(1) : '0.0';
  console.log(bar);
  console.log(`请求 ${fmt(tot.n)} 次 | 合计 token ${fmt(tot.tot)}`);
  console.log(`输入 ${fmt(tot.in)} (缓存命中 ${hit}%) | 输出 ${fmt(tot.out)}`);
  console.log(bar);
  for (const s of stats) {
    console.log(`  ${s.name.padEnd(13)} 会话文件 ${String(s.files).padEnd(6)} 请求 ${fmt(s.reqs)}`);
  }
  console.log('-'.repeat(62));
  console.log('  按来源:');
  for (const [k, c] of [...bySrc].sort((a, b) => b[1].tot - a[1].tot)) {
    console.log(`    ${k.padEnd(13)} ${fmt(c.tot)}`);
  }
  console.log('-'.repeat(62));
  console.log('  按模型:');
  for (const [k, c] of [...byModel].sort((a, b) => b[1].tot - a[1].tot).slice(0, 10)) {
    console.log(`    ${k.padEnd(24)} ${fmt(c.tot)}`);
  }
  console.log(bar);
  console.log('明细 CSV : ' + csvPath);
  console.log('汇总报告 : ' + mdPath);
  if (jsPath) console.log('看板数据 : ' + jsPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
