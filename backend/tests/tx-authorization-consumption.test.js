/**
 * M3.2 第四轮评审 P0-2：授权的一次性消费机制（真实数据库）。
 *
 * 覆盖：
 *   [x] 授权必须按 intent + bindingHash + 用户地址 匹配，不能只按 intentId 取最近一条
 *   [x] 消费一次成功；重复消费被拒绝（返回 0 行）
 *   [x] 消费后该授权不再出现在「可消费」查询中
 *   [x] 非 allowed 记录不可消费
 *   [x] 用户不匹配 / 绑定哈希不匹配 → 查不到授权
 */
const test = require('node:test');
const assert = require('node:assert');

const { dbQuery } = require('@surf-ai/sdk/db');
const { dbQuerySafe } = require('../lib/db');
const {
  recordAttempt, loadLatestAuthorization, loadConsumedAuthorization, consumeAuthorization,
} = require('../lib/tx-gate-state');
const { CHAIN, CONTRACTS } = require('../config/whitelist');

const USER = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const PM = CONTRACTS.positionManager.address;
const BINDING_HASH = '0x' + 'a1'.repeat(32);
const BINDING = { intentId: '9001', chainId: CHAIN.id, to: PM, value: '0', calldataHash: '0x' + 'b2'.repeat(32) };

let dbUp = false;
const createdIds = [];

test.before(async () => {
  try {
    await dbQuery('SELECT 1');
    dbUp = true;
  } catch {
    console.warn('⚠️ 数据库不可用，授权消费测试将跳过');
  }
});

test.after(async () => {
  if (!dbUp) return;
  // 清理测试夹具（仅删除本测试创建的记录，避免污染真实审计与额度统计）
  if (createdIds.length) {
    await dbQuery(`DELETE FROM tx_gate_attempts WHERE id = ANY($1::int[])`, [createdIds]);
  }
  try { await dbQuerySafe('ROLLBACK'); } catch { /* 会话清理 */ }
});

async function makeAllowedFixture({ intentId = 9001, bindingHash = BINDING_HASH, user = USER, ok = true } = {}) {
  const req = { key: 'positionManager', selector: '0xdd46508f', intentType: 'mint', intentId, amountUsd: 5, user };
  const decision = ok
    ? { ok: true, gateVersion: 'test-fixture', binding: BINDING, bindingHash }
    : { ok: false, code: 'GATE_CLOSED', reason: '测试用拒绝记录', gateVersion: 'test-fixture' };
  const id = await recordAttempt(req, decision);
  createdIds.push(id);
  return id;
}

test('可消费授权必须按 intent + bindingHash + 用户匹配', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const id = await makeAllowedFixture({ intentId: 9010 });
  const byAll = await loadLatestAuthorization({ intentId: 9010, bindingHash: BINDING_HASH, user: USER });
  assert.ok(byAll, '三个条件都匹配时应能取到授权');
  assert.equal(byAll.attemptId, id);
  assert.equal(byAll.status, 'authorized');
  assert.equal(String(byAll.bindingHash).toLowerCase(), BINDING_HASH);

  assert.equal(await loadLatestAuthorization({ intentId: 9010, bindingHash: '0x' + 'cc'.repeat(32), user: USER }), null, '绑定哈希不匹配 → 不得返回授权');
  assert.equal(await loadLatestAuthorization({ intentId: 9010, bindingHash: BINDING_HASH, user: OTHER }), null, '用户不匹配 → 不得返回授权');
  assert.equal(await loadLatestAuthorization({ intentId: 999999 }), null, '不存在的 intent → 不得返回授权');
});

test('消费一次成功，重复消费被拒绝（一次性）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const id = await makeAllowedFixture({ intentId: 9011 });
  const first = await consumeAuthorization({ attemptId: id, actor: 'user-test' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.consumedBy, 'user-test');
  assert.ok(first.consumedAt, '必须记录消费时间');

  const second = await consumeAuthorization({ attemptId: id, actor: 'user-test' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /已被消费/);

  // 消费后不再出现在「可消费」查询中，但可在「已消费」查询中找到
  assert.equal(await loadLatestAuthorization({ intentId: 9011, user: USER }), null);
  const consumed = await loadConsumedAuthorization({ intentId: 9011 });
  assert.ok(consumed);
  assert.equal(consumed.id, id);

  // 数据库中的状态字段确实是 consumed
  const { rows } = await dbQuery('SELECT authorization_status, consumed_at, consumed_by FROM tx_gate_attempts WHERE id = $1', [id]);
  assert.equal(rows[0].authorization_status, 'consumed');
  assert.equal(rows[0].consumed_by, 'user-test');
  assert.ok(rows[0].consumed_at);
});

test('非 allowed 记录不可消费', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const id = await makeAllowedFixture({ intentId: 9012, ok: false });
  const r = await consumeAuthorization({ attemptId: id, actor: 'user-test' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不存在|不可消费/);
});

test('消费不存在的授权 id → 拒绝（不报错）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const r = await consumeAuthorization({ attemptId: 999999999, actor: 'user-test' });
  assert.equal(r.ok, false);
});

test('授权记录写入时带 user_addr 与 authorization_status（静态+落库检查）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const id = await makeAllowedFixture({ intentId: 9013 });
  const { rows } = await dbQuery('SELECT user_addr, authorization_status, decision FROM tx_gate_attempts WHERE id = $1', [id]);
  assert.equal(String(rows[0].user_addr).toLowerCase(), USER.toLowerCase());
  assert.equal(rows[0].authorization_status, 'authorized');
  assert.equal(rows[0].decision, 'allowed');
});

test('路由静态检查：存在一次性消费接口，且消费是条件更新（不是先查后改）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  assert.match(src, /'\/consume-authorization'/);
  const state = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tx-gate-state.js'), 'utf8');
  const fn = state.slice(state.indexOf('async function consumeAuthorization'));
  assert.match(fn, /UPDATE tx_gate_attempts/);
  assert.match(fn, /authorization_status IS NULL OR authorization_status = 'authorized'/, '消费必须是带条件的原子更新');
  assert.match(fn, /RETURNING id/, '必须返回受影响行以判断是否消费成功');
});
