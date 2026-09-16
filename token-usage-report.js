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
 *   字段口径（已对全量数据实测校验，7857 条无一例外）：
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
 *
 * 看板数据是「增量合并」写入的（默认）
 *   生成前会读取已有的 token-usage-data.js，把历次同步过、但本次本地已扫不到的
 *   回合原样保留。jsonl 会话记录被清理时，历史 token 数据不会凭空消失。
 *   同名回合以本次扫描为准（正在进行的会话会在后续同步里被补齐）。
 *   想丢弃历史、只保留本次扫描结果，加 --no-merge。
 *
 * 回合（turn）口径
 *   providerData.conversationRequestId 是「回合 ID」，粒度比 messageId 粗：
 *   一次用户提问 = 一个回合，但 agent 会在其中发起多次 API 请求（实测均 7.65 次）。
 *   积分看板按回合 ID 与本脚本产出的 token 数据对齐，因此 --emit-js 会按
 *   conversationRequestId 把整回合的 token 求和，与一行积分一一对应。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');

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

async function scanFile(file, source) {
  const reqs = [];
  const turns = [];
  const fname = path.basename(file, '.jsonl');
  const projdir = path.basename(path.dirname(file));

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (let line of rl) {
    if (!line.includes('"usage"') && !line.includes('"tokenDelta"')) continue;
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    line = line.trim();
    if (!line) continue;

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

    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;

    reqs.push({
      time: toDate(d.timestamp),
      source,
      model: pick(pd, 'model') || m.model || 'unknown',
      project: d.cwd || projdir,
      session: d.sessionId || fname,
      requestId: pick(pd, 'messageId') || m.id || d.id || '',
      // 回合 ID：粒度比 messageId 粗，一次用户提问对应一个回合（内含多次 API 请求）
      conversationRequestId: pd.conversationRequestId || '',
      kind: d.type || '',
      tool: d.name || '',
      inputTokens: inp,
      outputTokens: out,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
      totalTokens: u.total_tokens || (inp + out),
    });
  }

  return { reqs, turns };
}

// ---------------------------------------------------------------- 汇总收集

async function collect(since) {
  const allReqs = [];
  const allTurns = [];
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
      const { reqs, turns } = await scanFile(f, s.name);
      breqs.push(...reqs);
      bturns.push(...turns);
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

  return { allReqs, allTurns, stats };
}

// ------------------------------------------------ 看板数据（按回合聚合）

/**
 * 按 conversationRequestId 聚合，生成积分看板消费的 window.__TOKEN_DATA__。
 *
 * 一个回合 = 一次用户提问 = agent 串行发起的一批 API 请求，此处把整回合的
 * token 求和，以便与积分流水「一行积分 = 一个回合」一一对齐。
 * 键统一小写，查表侧同样归一化，避免大小写差异导致漏配。
 */
function buildTokenDataJs(reqs, light) {
  const turns = new Map();

  for (const r of reqs) {
    const key = String(r.conversationRequestId || '').trim().toLowerCase();
    if (!key) continue; // 无回合 ID 的请求无法与积分关联

    let t = turns.get(key);
    if (!t) {
      t = { n: 0, in: 0, out: 0, cr: 0, cc: 0, tot: 0, t0: 0, t1: 0,
            m: '', s: r.session, src: r.source, p: r.project, best: -1, d: [] };
      turns.set(key, t);
    }
    t.n++;
    t.in  += r.inputTokens;
    t.out += r.outputTokens;
    t.cr  += r.cacheReadTokens;
    t.cc  += r.cacheCreationTokens;
    t.tot += r.totalTokens;

    const ms = r.time ? r.time.getTime() : 0;
    if (ms) {
      if (!t.t0 || ms < t.t0) t.t0 = ms;
      if (ms > t.t1) t.t1 = ms;
    }
    // 回合代表模型：取消耗最大的那次请求，比取第一次更贴近成本归因
    if (r.totalTokens > t.best) { t.best = r.totalTokens; t.m = r.model; }
    if (!light) t.d.push([ms, r.tool || '', r.inputTokens, r.outputTokens, r.cacheReadTokens]);
  }

  const out = {};
  for (const [k, t] of turns) {
    const o = { n: t.n, in: t.in, out: t.out, cr: t.cr, cc: t.cc, tot: t.tot,
                t0: t.t0, t1: t.t1, m: t.m, s: t.s, src: t.src, p: t.p };
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
    t: out,
  };
}

/**
 * 读取已有的 token-usage-data.js，用于增量合并。
 * 文件不存在、被截断、或格式不对都返回 null（当作首次生成）。
 */
function loadExistingTokenData(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    const d = JSON.parse(raw.slice(i, j + 1));
    return d && d.t && typeof d.t === 'object' ? d : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 主流程

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
  fs.mkdirSync(outdir, { recursive: true });

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

  const { allReqs: reqs, allTurns: turns, stats } = await collect(since);

  // ---------------------------------------------------------- 明细 CSV
  reqs.sort((a, b) => (a.time ? a.time.getTime() : 0) - (b.time ? b.time.getTime() : 0));

  const csvPath = path.join(outdir, 'token-usage-detail.csv');
  const lines = [];
  lines.push(['时间', '来源', '模型', '项目目录', '会话ID', '回合ID', '请求ID', '类型', '工具',
              '输入token', '输出token', '缓存读token', '缓存写token', '合计token'].join(','));
  for (const r of reqs) {
    lines.push([
      fmtTime(r.time), r.source, r.model, r.project, r.session,
      r.conversationRequestId, r.requestId,
      r.kind, r.tool, r.inputTokens, r.outputTokens, r.cacheReadTokens,
      r.cacheCreationTokens, r.totalTokens,
    ].map(esc).join(','));
  }
  // \uFEFF = UTF-8 BOM，保证 Excel 双击打开中文不乱码
  fs.writeFileSync(csvPath, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

  // ---------------------------------------------------------- 看板数据（积分关联用）
  let jsPath = null;
  if (emitJs) {
    const name = args['js-out'] || 'token-usage-data.js';
    jsPath = path.isAbsolute(name) ? name : path.join(outdir, name);
    const data = buildTokenDataJs(reqs, light);
    const freshTurns = data.meta.turns;

    // 增量合并：把历次同步过、但本次本地 jsonl 里已不存在的回合保留下来，
    // 避免会话记录被清理后旧数据凭空消失。同名回合以本次扫描为准
    // （正在进行的会话会在后续同步里被补齐）。
    let kept = 0;
    if (!args['no-merge']) {
      const old = loadExistingTokenData(jsPath);
      if (old) {
        for (const [k, v] of Object.entries(old.t)) {
          if (data.t[k]) continue;
          data.t[k] = v;
          kept++;
          data.meta.reqs += v.n || 0;
          if (v.t0 && (!data.meta.from || v.t0 < data.meta.from)) data.meta.from = v.t0;
          if (v.t1 && v.t1 > data.meta.to) data.meta.to = v.t1;
        }
        data.meta.turns = Object.keys(data.t).length;
        data.meta.kept = kept;
        data.meta.merged = kept > 0;
      }
    }

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

  // 回合指标
  if (turns.length) {
    W('## 八、回合指标（turn-metrics，交叉验证用）');
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

  W('## 九、明细文件');
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
