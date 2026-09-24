#!/usr/bin/env node
/**
 * 配置体检（config doctor）：入口脚本（server.js / token-usage-report.js，即两个
 * bat 实际跑的东西）启动前自动扫一遍本目录的 JSON 配置文件——
 *
 *   · auto-config.json  自动化开关与周期：缺失或缺字段 → 按默认值补全并写回
 *   · sync-config.json  云同步凭证：缺失 → 生成带说明的模板（enabled=false 起步）
 *   · sync-state.json   本机标识：缺失或没有 machineId → 自动生成
 *
 * 原则：
 *   · 已有值一律不覆盖（包括坏 JSON——那是用户自己改出来的，只提醒不代改）；
 *   · 只补「缺的」，不动「有的」；
 *   · 数据产物（token-usage-data.js / checkin-history.json / credit-history.json）
 *     不是配置，不在这里管——它们有自己的追加合并规则。
 *
 * 与 server.js 的默认值必须保持一致：server.js 的 loadAutoConfig 有运行时兜底，
 * 这里负责「把默认值落到文件里让人看得见改得着」，两边数字不同会互相打架。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

/** auto-config.json 的字段与默认值（与 server.js 顶部常量保持同步）。 */
const AUTO_DEFAULTS = {
  checkin: false,   // 每日签到
  travel: false,    // 猫猫旅行
  switch: false,    // 自动切换账号（到期积分优先用）
  refresh: false,   // 定时刷新积分
  intervalMinutes: { checkin: 360, travel: 30, switch: 60, refresh: 30 },  // 分钟
  jitterPercent: 10,        // 周期随机抖动幅度 ±%
  switchHorizonDays: 14,    // 距到期 N 天内才触发自动切换
  switchCooldownHours: 24,  // 自动切换成功后的冷却（小时）
};

const AUTO_FILE = path.join(ROOT, 'auto-config.json');

/**
 * 体检结果：返回需要用户处理的提醒（空数组 = 一切正常）。
 * 每条提醒已经在函数内打印过，返回值仅供调用方汇总。
 */
function runConfigDoctor() {
  const notes = [];
  ensureAutoConfig(notes);
  ensureSyncConfig(notes);
  ensureSyncState(notes);
  return notes;
}

/** auto-config.json：缺失或缺字段 → 补默认值写回；坏 JSON → 只提醒。 */
function ensureAutoConfig(notes) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 文件存在但解析失败：绝不覆盖（里面可能有用户手写的参数），提醒手工处理
      const msg = 'auto-config.json 不是合法 JSON，已跳过自动修复，请手工检查';
      console.log(`[配置体检] ⚠ ${msg}`);
      notes.push(msg);
      return;
    }
    raw = null;
  }

  if (!raw || typeof raw !== 'object') {
    // 全新文件：写完整骨架，开关全 false 起步，行为与现状一致
    const tpl = {
      _comment: [
        '自动化任务配置。开关由看板页面「⋯ 更多」菜单写入，周期与阈值可手改，改完保存即生效（约 1 秒内自动重载）。',
        '字段：checkin 签到 / travel 猫猫旅行 / switch 自动切换账号 / refresh 定时刷积分。',
        'intervalMinutes 单位为分钟；switchHorizonDays 距到期多少天才切；switchCooldownHours 切换后的冷却小时数。',
      ],
      ...AUTO_DEFAULTS,
    };
    try {
      fs.writeFileSync(AUTO_FILE, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
      console.log('[配置体检] 已生成 auto-config.json（所有自动化开关默认关闭）');
    } catch { /* 写不进去不影响主流程，loadAutoConfig 有运行时兜底 */ }
    return;
  }

  // 已有文件：只补缺失的字段，绝不覆盖已有值
  const merged = JSON.parse(JSON.stringify(raw));
  if (!merged.intervalMinutes || typeof merged.intervalMinutes !== 'object') merged.intervalMinutes = {};
  for (const k of Object.keys(AUTO_DEFAULTS)) {
    if (merged[k] === undefined) merged[k] = AUTO_DEFAULTS[k];
  }
  for (const k of Object.keys(AUTO_DEFAULTS.intervalMinutes)) {
    if (merged.intervalMinutes[k] === undefined) merged.intervalMinutes[k] = AUTO_DEFAULTS.intervalMinutes[k];
  }
  if (JSON.stringify(merged) !== JSON.stringify(raw)) {
    try {
      fs.writeFileSync(AUTO_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      console.log('[配置体检] auto-config.json 缺失的字段已按默认值补全（已有值未动）');
    } catch { /* 同上 */ }
  }
}

/** sync-config.json：缺失 → 复用 cloud-sync 的模板；缺 url/anonKey → 提醒。 */
function ensureSyncConfig(notes) {
  let cloudSync;
  try {
    cloudSync = require('./cloud-sync');   // 顶层无副作用（main 有 require.main 保护）
  } catch {
    return;   // 极端情况（文件缺失等）不该挡住主流程
  }
  cloudSync.ensureConfigTemplate();   // 文件已存在时它内部直接返回 false，不碰

  const cfg = cloudSync.loadConfig();
  if (!cfg) return;   // 读不到时 cloud-sync 侧本来就会静默跳过云同步

  if (cfg.enabled && (!cfg.url || !cfg.anonKey)) {
    const msg = 'sync-config.json 已开启云同步（enabled=true）但 url 或 anonKey 为空，'
      + '云同步不会生效——填好这两项，或把 enabled 改回 false';
    console.log(`[配置体检] ⚠ ${msg}`);
    notes.push(msg);
  } else if (!cfg.enabled && (!cfg.url || !cfg.anonKey)) {
    const msg = '云同步未配置（sync-config.json 的 url / anonKey 为空）——不用云同步可忽略；要启用见文件内说明';
    console.log(`[配置体检] · ${msg}`);
    notes.push(msg);
  }
}

/** sync-state.json：缺失或没有 machineId → 自动生成本机标识。 */
function ensureSyncState(notes) {
  try {
    const cloudSync = require('./cloud-sync');
    const id = cloudSync.getMachineId();   // 缺失时它自己生成并落盘，不触发网络
    if (!id) {
      const msg = 'sync-state.json 缺少 machineId 且自动生成失败，多端云同步无法区分本机';
      console.log(`[配置体检] ⚠ ${msg}`);
      notes.push(msg);
    }
  } catch { /* 同上，不影响主流程 */ }
}

module.exports = { runConfigDoctor };

if (require.main === module) {
  const notes = runConfigDoctor();
  if (!notes.length) console.log('[配置体检] 全部正常');
  process.exit(0);
}