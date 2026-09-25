'use strict';
/**
 * 日志模块：把 console 输出同步落盘到 logs/ 目录。
 *
 * 用法：入口脚本里 `require('./app-logger')`（自生效，无导出）。
 * console.log/info/warn/error 在原样输出到 stdout/stderr 的同时，
 * 追加写入 logs/buddytoken-YYYYMMDD.log（按天分文件）。
 *
 * 设计取舍：
 *   - 只拦截 console.*，不碰 process.stdout——server.js 用 execFile 捕获
 *     子进程输出靠的仍是标准流，不受影响；
 *   - 同步追加（appendFileSync）：本项目日志频率很低，换不来异步队列的复杂度；
 *   - 不做轮转/清理：按天分文件体积很小，日志是排障凭据，全部保留；
 *   - 落盘失败（目录不可写等）静默吞掉，绝不影响主流程。
 *
 * logs/ 含账号 uid 等隐私，已在 .gitignore 排除，--reset 的删除白名单
 * 也不含它（日志不是数据产物）。
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = path.join(__dirname, 'logs');

/** 本地时间戳：YYYY-MM-DD HH:mm:ss */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 当天日志文件：logs/buddytoken-20260925.log（按本地日期切分）。 */
function logFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `buddytoken-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
}

function append(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile(), text);
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

function formatLine(level, args) {
  let msg;
  try {
    msg = util.format(...args);
  } catch {
    msg = '[unformattable log arguments]';
  }
  return `[${stamp()}] [${level}] ${msg}\n`;
}

// 避免重复安装（server 与子进程各自独立加载互不影响，这里只防同进程内重复 require）
if (!global.__BT_LOGGER_INSTALLED__) {
  global.__BT_LOGGER_INSTALLED__ = true;

  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const wrap = (level, origFn) => (...args) => {
    append(formatLine(level, args));
    origFn(...args);
  };

  console.log = wrap('log', orig.log);
  console.info = wrap('info', orig.info);
  console.warn = wrap('warn', orig.warn);
  console.error = wrap('error', orig.error);
}
