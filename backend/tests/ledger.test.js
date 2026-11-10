/**
 * 建仓台账折叠回归：加仓 / 减仓 / 完全撤池 / 多次加减仓 / 同区块多事件 / 重复同步幂等。
 */
const test = require('node:test');
const assert = require('node:assert');
const { foldLedgerEvents } = require('../lib/ledger');

const ev = (block, logIndex, delta, a0, a1) => ({
  block, logIndex,
  liquidityDelta: BigInt(delta).toString(),
  amount0: BigInt(a0).toString(),
  amount1: BigInt(a1).toString(),
});

test('单次加仓', () => {
  const r = foldLedgerEvents([ev(100, 0, 1000, 10, 20)]);
  assert.equal(r.totals.deposited0, '10');
  assert.equal(r.totals.deposited1, '20');
  assert.equal(r.totals.net0, '10');
  assert.equal(r.events[0].add, true);
});

test('加仓 + 部分减仓', () => {
  const r = foldLedgerEvents([ev(100, 0, 1000, 10, 20), ev(200, 0, -400, 4, 8)]);
  assert.equal(r.totals.deposited0, '10');
  assert.equal(r.totals.withdrawn0, '4');
  assert.equal(r.totals.net0, '6');
  assert.equal(r.totals.net1, '12');
  assert.equal(r.events[1].add, false);
});

test('完全撤池后净投入为 0', () => {
  const r = foldLedgerEvents([ev(100, 0, 1000, 10, 20), ev(200, 0, -1000, 10, 20)]);
  assert.equal(r.totals.net0, '0');
  assert.equal(r.totals.net1, '0');
});

test('多次加减仓累计正确', () => {
  const r = foldLedgerEvents([
    ev(100, 0, 100, 1, 2),
    ev(150, 0, 200, 3, 4),
    ev(200, 0, -50, 1, 1),
    ev(250, 0, -100, 1, 1),
  ]);
  assert.equal(r.totals.deposited0, '4');
  assert.equal(r.totals.withdrawn0, '2');
  assert.equal(r.totals.net0, '2');
  assert.equal(r.totals.deposited1, '6');
  assert.equal(r.totals.withdrawn1, '2');
  assert.equal(r.totals.net1, '4');
});

test('同一区块多条事件按 (block, logIndex) 区分', () => {
  const r = foldLedgerEvents([ev(300, 1, 10, 1, 1), ev(300, 2, 20, 2, 2)]);
  assert.equal(r.events.length, 2);
  assert.equal(r.totals.net0, '3');
});

test('重复同步（重复事件）不改变台账', () => {
  const once = foldLedgerEvents([ev(100, 0, 1000, 10, 20), ev(200, 3, -200, 2, 4)]);
  const twice = foldLedgerEvents([
    ev(100, 0, 1000, 10, 20), ev(200, 3, -200, 2, 4),
    ev(100, 0, 1000, 10, 20), ev(200, 3, -200, 2, 4), // 重复同步
  ]);
  assert.deepEqual(twice.totals, once.totals);
  assert.equal(twice.events.length, 2);
});

test('空台账不崩溃', () => {
  const r = foldLedgerEvents([]);
  assert.equal(r.events.length, 0);
  assert.equal(r.totals.net0, '0');
  const r2 = foldLedgerEvents(undefined);
  assert.equal(r2.totals.net1, '0');
});
