/**
 * 扫描 worker：由 token-usage-report.js 用 worker_threads 创建。
 *
 * 接收一批 jsonl 文件（含 source），逐个调用 scan-core.scanFile 扫描，
 * 结果用 postMessage 传回主线程（结构化克隆，Date/Map 均原样保留）。
 *
 * 与串行路径共用 scan-core.js，保证两条路输出完全一致。
 */

const { parentPort, workerData } = require('worker_threads');
const { scanFile } = require('./scan-core');

const files = (workerData && workerData.files) || [];
const results = { reqs: [], turns: [], titles: [] };

(async () => {
  for (const item of files) {
    try {
      const { reqs, turns, titles } = await scanFile(item.path, item.source);
      results.reqs.push(...reqs);
      results.turns.push(...turns);
      for (const [k, v] of titles) results.titles.push([k, v]);
    } catch {
      // 单个文件失败只跳过，不给整个 worker 拖后腿（与串行路径的 try/catch 语义一致）
    }
  }
  parentPort.postMessage(results);
})();