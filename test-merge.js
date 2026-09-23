/**
 * cloud-sync.js 合并规则的回归验证。
 *
 * 重点不是覆盖率，而是守住那条铁律：**合并只增不减**——每个用例都在断言
 * 「合并后本地原有的东西一个字都没变」。改动 cloud-sync.js 的合并逻辑后请跑一遍。
 *
 * 零依赖、不联网、不碰真实数据文件，直接跑：
 *   node test-merge.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const cs = require('./cloud-sync');

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.log('  \u2717 ' + name + ' \u2192 ' + e.message);
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\n[1] planTurnMerge 回合合并');

t('本地没有 → 远端照单全收', () => {
  const r = cs.planTurnMerge({}, [
    { turn_key: 'b', n: 2, in_tokens: 20, tot_tokens: 20, t1: 200, machine_id: 'M2' },
  ]);
  assert.strictEqual(Object.keys(r.added).length, 1);
  assert.strictEqual(r.added.b.in, 20, '字段名要映射回本地契约的 in');
  assert.strictEqual(r.added.b.mch, 'M2');
});

t('本地已有 → 一律保留本地，绝不覆盖（哪怕远端 tot 更大）', () => {
  const local = { a: { n: 1, in: 10, tot: 10, t1: 100, mch: 'M1' } };
  const before = clone(local);
  const r = cs.planTurnMerge(local, [
    { turn_key: 'a', tot_tokens: 999, machine_id: 'M2' },
  ]);
  assert.strictEqual(r.added.a, undefined, '不该出现在新增里');
  assert.strictEqual(local.a.tot, 10, '本地值必须原样不动');
  assert.deepStrictEqual(local, before, '本地结构逐字段不变');
});

t('同键多机且本地没有 → 取 tot 最大，并列取 machine_id 字典序小（规则必须确定）', () => {
  const r = cs.planTurnMerge({}, [
    { turn_key: 'x', tot_tokens: 5, machine_id: 'M2' },
    { turn_key: 'x', tot_tokens: 50, machine_id: 'M3' },
    { turn_key: 'x', tot_tokens: 50, machine_id: 'M1' },
  ]);
  assert.strictEqual(r.added.x.tot, 50);
  assert.strictEqual(r.added.x.mch, 'M1');
});

t('回合键大小写归一（与 TokenData.lookup 同口径）', () => {
  const local = { 'abc-123': { tot: 1 } };
  const r = cs.planTurnMerge(local, [{ turn_key: 'ABC-123', tot_tokens: 99, machine_id: 'M2' }]);
  assert.strictEqual(r.added['abc-123'], undefined, '大小写不同也认作同一个回合');
});

t('steps 明细原样带回，空数组则不产出 d 字段', () => {
  const r = cs.planTurnMerge({}, [
    { turn_key: 'y', tot_tokens: 1, machine_id: 'M2', steps: [[1, 'bash', 2, 3, 4, 5]] },
    { turn_key: 'z', tot_tokens: 1, machine_id: 'M2', steps: null },
  ]);
  assert.deepStrictEqual(r.added.y.d, [[1, 'bash', 2, 3, 4, 5]]);
  assert.strictEqual('d' in r.added.z, false);
});

console.log('\n[2] planBillMerge 账单合并');

t('新行：uid 文本翻译成本机字段下标（跨机下标会错位，这是核心）', () => {
  const p = cs.planBillMerge([], ['uid-A'], [
    { request_id: 'r2', credit: 3, model: 'm2', client: 'c', request_time: 200, uid: 'uid-Z', machine_id: 'M2' },
  ]);
  assert.strictEqual(p.bill.length, 1);
  assert.strictEqual(p.bill[0][5], 1, 'uid-Z 应追加为下标 1');
  assert.deepStrictEqual(p.uids, ['uid-A', 'uid-Z']);
});

t('已有行：credit 取较大值、机器只补空、其余不动', () => {
  const localBill = [['r1', 1, 'm', 'c', 100, 0]];
  const localUids = ['uid-A'];
  const before = clone(localBill);
  const p = cs.planBillMerge(localBill, localUids, [
    { request_id: 'r1', credit: 2, model: 'X', client: 'X', request_time: 999, uid: 'uid-A', machine_id: 'M2' },
  ]);
  assert.strictEqual(p.bill.length, 1, '不该多出重复行');
  assert.strictEqual(p.bill[0][1], 2, '积分取 max(1,2)');
  assert.strictEqual(p.bill[0][6], 'M2', '机器为空时补上');
  assert.strictEqual(p.bill[0][2], 'm', '模型保持本地值');
  assert.strictEqual(before[0][1], 1, '原数组不该被就地改写');
});

t('已有行：积分不会被远端更小的值改小', () => {
  const p = cs.planBillMerge([['r1', 9, 'm', 'c', 100, 0]], ['u'], [
    { request_id: 'r1', credit: 1, model: 'm', client: 'c', request_time: 100, uid: 'u', machine_id: 'M2' },
  ]);
  assert.strictEqual(p.bill[0][1], 9);
});

t('已有行：本地机器归属不被远端覆盖（本机反查更可信）', () => {
  const p = cs.planBillMerge([['r1', 1, 'm', 'c', 100, 0, 'M1']], ['u'], [
    { request_id: 'r1', credit: 1, model: 'm', client: 'c', request_time: 100, uid: 'u', machine_id: 'M2' },
  ]);
  assert.strictEqual(p.bill[0][6], 'M1');
});

t('旧格式 6 列数据（无机器位）仍能安全合并', () => {
  const p = cs.planBillMerge([['r1', 1, 'm', 'c', 100, 0]], ['u'], []);
  assert.strictEqual(p.bill[0].length, 6, '不主动补位，保持原样');
  assert.strictEqual(p.bill[0][6], undefined, '第 7 位读作 undefined');
});

t('结果按时间升序（与 report.js 的排序口径一致）', () => {
  const p = cs.planBillMerge([], [], [
    { request_id: 'b', request_time: 300, uid: 'u' },
    { request_id: 'a', request_time: 100, uid: 'u' },
  ]);
  assert.deepStrictEqual(p.bill.map((r) => r[0]), ['a', 'b']);
});

console.log('\n[3] planHistMerge 余额历史');

t('同账号同天保留本地（ts 表示当天首次观察时刻，比不出新鲜度）', () => {
  const h = cs.planHistMerge({ u1: [[1000, 500]] }, [
    { uid: 'u1', ts: 2000, remaining: 400 },
  ]);
  assert.strictEqual(h.hist.u1.length, 1);
  assert.strictEqual(h.hist.u1[0][1], 500, '保留本地的 500');
});

t('不同天则追加，并保持时间升序', () => {
  const h = cs.planHistMerge({ u1: [[90000000, 500]] }, [
    { uid: 'u1', ts: 1000, remaining: 400 },
  ]);
  assert.strictEqual(h.hist.u1.length, 2);
  assert.strictEqual(h.hist.u1[0][0], 1000, '更早的排前面');
});

t('本地没有的账号照样收下（集合取并集）', () => {
  const h = cs.planHistMerge({}, [{ uid: 'u2', ts: 5000, remaining: 100 }]);
  assert.strictEqual(h.hist.u2.length, 1);
});

console.log('\n[4] planAcctMerge 账号余额');

t('余额取官方 updatedAt 更新的一条', () => {
  const a = cs.planAcctMerge(
    [{ uid: 'u1', remaining: 100, updatedAt: 1000, login: { app: 'local' } }],
    [{ uid: 'u1', remaining: 50, official_updated_at: 2000, login: { app: 'remote' } }]
  );
  assert.strictEqual(a.acct[0].remaining, 50);
});

t('login 永远保留本机值（远端登录态属于那台机器）', () => {
  const a = cs.planAcctMerge(
    [{ uid: 'u1', remaining: 100, updatedAt: 1000, login: { app: 'local' } }],
    [{ uid: 'u1', remaining: 50, official_updated_at: 2000, login: { app: 'remote' } }]
  );
  assert.deepStrictEqual(a.acct[0].login, { app: 'local' });
});

t('远端快照更旧 → 整条不动', () => {
  const a = cs.planAcctMerge(
    [{ uid: 'u1', remaining: 100, updatedAt: 5000 }],
    [{ uid: 'u1', remaining: 1, official_updated_at: 1000 }]
  );
  assert.strictEqual(a.acct[0].remaining, 100);
  assert.strictEqual(a.updated, 0);
});

t('远端有本机没登录的账号 → 收下但 login 置空', () => {
  const a = cs.planAcctMerge([], [{ uid: 'u9', remaining: 7, official_updated_at: 1, login: { app: 'x' } }]);
  assert.strictEqual(a.acct.length, 1);
  assert.strictEqual(a.acct[0].login, null);
});

console.log('\n[5] planTitleMerge 会话标题');

t('本地有则保留，本地空才用远端', () => {
  const r = cs.planTitleMerge({ s1: '本地标题' }, [
    { session_id: 's1', title: '远端标题' },
    { session_id: 's2', title: '新标题' },
  ]);
  assert.strictEqual(r.ti.s1, '本地标题');
  assert.strictEqual(r.ti.s2, '新标题');
});

console.log('\n[6] 只增不减守门（铁律）');

t('一轮完整合并后：本地原有键一个不少、值逐字段不变', () => {
  const local = {
    t: { k1: { n: 1, in: 5, tot: 5, t0: 10, t1: 20, m: 'a', s: 's', src: 'x', p: '/p', lat: 1, latn: 1 } },
    ti: { s1: '标题' },
    bill: [['r1', 1, 'm', 'c', 100, 0]],
    uids: ['uid-A'],
    acct: [{ uid: 'uid-A', remaining: 10, updatedAt: 1, login: { app: 'local' } }],
    hist: { 'uid-A': [[1000, 10]] },
  };
  const before = clone(local);

  // 模拟远端带着一堆新数据 + 与本地冲突的数据回来
  const turnPlan = cs.planTurnMerge(local.t, [
    { turn_key: 'k1', tot_tokens: 9999, machine_id: 'M2' },
    { turn_key: 'k2', tot_tokens: 77, machine_id: 'M2' },
  ]);
  Object.assign(local.t, turnPlan.added);

  const billPlan = cs.planBillMerge(local.bill, local.uids, [
    { request_id: 'r1', credit: 99, request_time: 100, uid: 'uid-A', machine_id: 'M2' },
    { request_id: 'r2', credit: 5, request_time: 200, uid: 'uid-B', machine_id: 'M2' },
  ]);
  local.bill = billPlan.bill;
  local.uids = billPlan.uids;

  const acctPlan = cs.planAcctMerge(local.acct, [
    { uid: 'uid-A', remaining: 1, official_updated_at: 99999, login: { app: 'remote' } },
  ]);
  local.acct = acctPlan.acct;

  const histPlan = cs.planHistMerge(local.hist, [{ uid: 'uid-A', ts: 1000, remaining: 1 }]);
  local.hist = histPlan.hist;

  const tiPlan = cs.planTitleMerge(local.ti, [{ session_id: 's1', title: '远端' }]);
  local.ti = tiPlan.ti;

  // ---- 断言
  assert.ok(Object.keys(local.t).length >= Object.keys(before.t).length, '回合数只增不减');
  for (const k of Object.keys(before.t)) {
    assert.deepStrictEqual(local.t[k], before.t[k], `回合 ${k} 的值被改动了`);
  }
  assert.strictEqual(local.ti.s1, before.ti.s1, '标题被改动了');
  for (const k of Object.keys(before.hist)) {
    assert.ok(local.hist[k].length >= before.hist[k].length, '历史点数只增不减');
  }
  assert.ok(local.bill.length >= before.bill.length, '账单条数只增不减');
  assert.ok(local.uids.length >= before.uids.length, '账号表只增不减');
  assert.ok(local.acct.some((a) => a.uid === 'uid-A'), '账号没被删掉');
  // 账单积分只增不减
  assert.ok(billPlan.bill.every((r) => Number(r[1]) >= 0));
  const r1 = billPlan.bill.find((r) => r[0] === 'r1');
  assert.ok(Number(r1[1]) >= Number(before.bill[0][1]), '积分不能被改小');
});

console.log('\n[7] 本地文件与配置的边界');

t('能解析真实的 token-usage-data.js（只读，不写）', () => {
  const loaded = cs.loadDataFile(cs.DATA_FILE);
  assert.ok(loaded, '应能读到数据文件');
  assert.ok(loaded.data.t && typeof loaded.data.t === 'object', 't 应是对象');
  assert.ok(loaded.data.meta && typeof loaded.data.meta.turns === 'number', 'meta.turns 应是数字');
  assert.ok(loaded.header.indexOf('window.__TOKEN_DATA__') === -1, 'header 不该含数据标记');
});

t('没配 sync-config.json 时 isEnabled() 为 false（纯本地模式不受影响）', () => {
  const exists = fs.existsSync(cs.CONFIG_FILE);
  if (exists) {
    console.log('      （本机已有 sync-config.json，跳过该断言）');
    return;
  }
  assert.strictEqual(cs.isEnabled(), false);
  assert.strictEqual(cs.loadConfig(), null);
});

t('localDay 按本地时区切日（与 workbuddy-api 的 localDate 同口径）', () => {
  const d = new Date(2026, 8, 23, 23, 30, 0);   // 2026-09-23 23:30 本地时间
  assert.strictEqual(cs.localDay(d.getTime()), '2026-09-23');
});

console.log('\n[8] 写回格式往返 + 未配置时的边界（异步）');

(async () => {
  const os = require('os');
  const path = require('path');

  await (async () => {
    const name = '写回格式往返（saveDataFile → loadDataFile 数据不变）';
    try {
      const loaded = cs.loadDataFile(cs.DATA_FILE);
      const tmp = path.join(os.tmpdir(), `bt-check-${process.pid}.js`);
      const header = '/* 头部注释应当原样保留 */\n';
      // saveDataFile 没导出，用同样的写法拼一份再读回来，验证契约一致
      fs.writeFileSync(tmp, header + 'window.__TOKEN_DATA__=' + JSON.stringify(loaded.data) + ';\n', 'utf8');
      const back = cs.loadDataFile(tmp);
      fs.rmSync(tmp, { force: true });
      assert.ok(back, '应能读回');
      assert.strictEqual(back.header, header, '头部注释原样保留');
      assert.deepStrictEqual(back.data, loaded.data, '数据往返后逐字段一致');
      pass++;
      console.log('  \u2713 ' + name);
    } catch (e) {
      fail++;
      console.log('  \u2717 ' + name + ' \u2192 ' + e.message);
    }
  })();

  await (async () => {
    const name = '未配置云同步时 runCloudSync 静默跳过且不落盘';
    try {
      if (cs.isEnabled()) {
        console.log('      （本机已启用云同步，跳过该断言）');
      } else {
        const stateExisted = fs.existsSync(cs.STATE_FILE);
        const before = fs.statSync(cs.DATA_FILE).mtimeMs;
        const r = await cs.runCloudSync({ dryRun: true });
        const after = fs.statSync(cs.DATA_FILE).mtimeMs;
        assert.strictEqual(r.skipped, true, '应返回 skipped');
        assert.strictEqual(before, after, '数据文件不该被改动');
        // state 文件可能已被早前的真实同步生成过，只在它本来不存在时才断言「没被新建」
        if (!stateExisted) {
          assert.strictEqual(fs.existsSync(cs.STATE_FILE), false, '不该平白生成 sync-state.json');
        }
        pass++;
        console.log('  \u2713 ' + name);
      }
    } catch (e) {
      fail++;
      console.log('  \u2717 ' + name + ' \u2192 ' + e.message);
    }
  })();

  console.log(`\n结果：${pass} 通过 · ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
