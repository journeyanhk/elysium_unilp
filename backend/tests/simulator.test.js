/**
 * 模拟器边界回归：gas 错误分类、撤池后预计余额口径、尘埃阈值。
 */
const test = require('node:test');
const assert = require('node:assert');
const { gasNoteFromError, projectedBalances, DUST } = require('../lib/simulator');

test('gasNoteFromError：余额不足单独提示且不误报编码问题', () => {
  const note = gasNoteFromError(new Error('insufficient funds for gas * price + value: address 0x1 have 0 want 1000'));
  assert.match(note, /余额不足/);
  assert.match(note, /编码本身有效/);
  assert.doesNotMatch(note, /回滚/);
});

test('gasNoteFromError：执行回滚与其它错误区分', () => {
  assert.match(gasNoteFromError(new Error('execution reverted: ERC20: transfer amount exceeds allowance')), /回滚/);
  const other = gasNoteFromError({ shortMessage: 'timeout' });
  assert.match(other, /timeout/);
});

test('projectedBalances：只加收入、不扣 gas，并带口径说明', () => {
  const r = projectedBalances({ before0: 10n ** 18n, before1: 5n * 10n ** 18n, out0: 2n * 10n ** 18n, out1: 10n ** 18n, fee0: 10n ** 15n, fee1: 2n * 10n ** 15n });
  assert.equal(r.after.hype, (3n * 10n ** 18n + 10n ** 15n).toString());
  assert.equal(r.after.kntq, (6n * 10n ** 18n + 2n * 10n ** 15n).toString());
  assert.equal(r.delta.hype, (2n * 10n ** 18n + 10n ** 15n).toString());
  assert.match(r.note, /未扣除 Gas/);
});

test('projectedBalances：零手续费也正确', () => {
  const r = projectedBalances({ before0: 0n, before1: 0n, out0: 1n, out1: 2n });
  assert.equal(r.after.hype, '1');
  assert.equal(r.after.kntq, '2');
});

test('尘埃阈值：1e12 wei（1e-6 代币）', () => {
  assert.equal(DUST, 10n ** 12n);
});
