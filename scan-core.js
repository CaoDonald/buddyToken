/**
 * 扫描单核：jsonl 会话文件 → 回合/请求/标题。
 *
 * 由 token-usage-report.js 与其 worker（scan-worker.js）共同加载，
 * 保证「worker 并行路径」与「串行兜底路径」跑的是同一份扫描逻辑。
 * 本模块只依赖 Node 标准库，无 npm 依赖。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

/**
 * 扫描单个 jsonl 会话文件。
 *
 * 返回 `{ reqs, turns, titles }`，其中 reqs/turns 是可结构化克隆的纯数据
 * （时间为 Date 对象，postMessage 能原样保留）；titles 是 Map（sessionId → 标题）。
 */
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

  // ---- 响应耗时推算状态（口径详见 token-usage-report.js 文件头）----
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

module.exports = { walk, scanFile, toDate, pick, validLatency, TITLE_LINE_RE };