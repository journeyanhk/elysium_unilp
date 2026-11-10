/**
 * PM 对照逻辑回归（纯函数，不联网）：
 * 选择器提取/比对、三类 Probe 断言（same-value / same-shape / chain-specific）。
 */
const test = require('node:test');
const assert = require('node:assert');
const pmc = require('../lib/pm-compare');

test('selectorsFromAbi：函数选择器与 tuple 展开', () => {
  const abi = [
    { type: 'function', name: 'permit2', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'ownerOf', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'modifyLiquidity', inputs: [{ type: 'tuple', components: [{ type: 'address' }, { type: 'uint24' }] }, { type: 'bytes' }], outputs: [] },
    { type: 'event', name: 'Foo', inputs: [] },
  ];
  const sels = pmc.selectorsFromAbi(abi);
  assert.equal(sels.size, 3, '只应包含函数（事件排除）');
  assert.ok(sels.has('0x12261ee7'), 'permit2() 选择器应为 0x12261ee7');
  assert.ok(sels.has('0x6352211e'), 'ownerOf(uint256) 选择器应为 0x6352211e');
});

test('extractSelectorsFromBytecode：启发式扫描能命中真实调度器条目', () => {
  // 构造：PUSH4 <sel> EQ PUSH2 xxxx JUMPI 模式
  // 结构：PUSH4(opcode 0x63) + 4 字节选择器 + EQ(0x14) ... JUMPI(0x57)
  const code = '0x' + '63' + '6352211e' + '1461abcd57' + '63' + '70a08231' + '1461abce57';
  const sels = pmc.extractSelectorsFromBytecode(code);
  assert.ok(sels.has('0x6352211e'));
  assert.ok(sels.has('0x70a08231'));
});

test('compareSelectorSets：参考链同样缺失时不算差异', () => {
  const auth = new Set(['0xaaa', '0xbbb', '0xccc']);
  const target = new Set(['0xaaa', '0xbbb']);
  const ref = new Set(['0xaaa', '0xbbb']);
  const d = pmc.compareSelectorSets(auth, target, ref, ['0xccc']);
  assert.equal(d.missingOfficial.length, 1);
  assert.equal(d.missingNotInReference.length, 0, '参考链也缺 → 不算目标链差异');
  assert.equal(d.ok, true);
});

test('compareSelectorSets：目标链缺失而参考链有 → 不通过', () => {
  const auth = new Set(['0xaaa', '0xbbb']);
  const d = pmc.compareSelectorSets(auth, new Set(['0xaaa']), new Set(['0xaaa', '0xbbb']), []);
  assert.deepEqual(d.missingNotInReference, ['0xbbb']);
  assert.equal(d.ok, false);
});

test('evaluateProbe：same-value 一致通过、不一致失败', () => {
  const spec = { name: 'permit2()', category: 'same-value' };
  const ok = pmc.evaluateProbe(spec, {
    A: { outcome: 'ok', decoded: '0xAbC' }, B: { outcome: 'ok', decoded: '0xabc' },
  }, ['A', 'B']);
  assert.equal(ok.pass, true, '地址大小写不应影响一致性判断');
  const bad = pmc.evaluateProbe(spec, {
    A: { outcome: 'ok', decoded: '0x1' }, B: { outcome: 'ok', decoded: '0x2' },
  }, ['A', 'B']);
  assert.equal(bad.pass, false);
  assert.match(bad.reasons.join(' '), /不一致/);
});

test('evaluateProbe：same-shape 要求都 revert 且选择器一致', () => {
  const spec = { name: 'ownerOf(不存在)', category: 'same-shape', expectRevert: true };
  const ok = pmc.evaluateProbe(spec, {
    A: { outcome: 'revert', selector: '0x08c379a0' }, B: { outcome: 'revert', selector: '0x08c379a0' },
  }, ['A', 'B']);
  assert.equal(ok.pass, true);
  const diff = pmc.evaluateProbe(spec, {
    A: { outcome: 'revert', selector: '0x08c379a0' }, B: { outcome: 'revert', selector: '0xdeadbeef' },
  }, ['A', 'B']);
  assert.equal(diff.pass, false);
  const notRevert = pmc.evaluateProbe(spec, {
    A: { outcome: 'ok', decoded: 'x' }, B: { outcome: 'revert', selector: '0x08c379a0' },
  }, ['A', 'B']);
  assert.equal(notRevert.pass, false);
});

test('evaluateProbe：chain-specific 校验零值/正数/地址有代码且跨链不同', () => {
  const zero = pmc.evaluateProbe({ name: 'getPositionLiquidity(不存在)', category: 'chain-specific', expect: 'zero' }, {
    A: { outcome: 'ok', decoded: '0' }, B: { outcome: 'ok', decoded: '0' },
  }, ['A', 'B']);
  assert.equal(zero.pass, true);

  const pos = pmc.evaluateProbe({ name: 'nextTokenId()', category: 'chain-specific', expect: 'positive' }, {
    A: { outcome: 'ok', decoded: '5' }, B: { outcome: 'ok', decoded: '0' },
  }, ['A', 'B']);
  assert.equal(pos.pass, false);

  const addr = pmc.evaluateProbe({ name: 'poolManager()', category: 'chain-specific', expect: 'has-code' }, {
    A: { outcome: 'ok', decoded: { address: '0xaaa', hasCode: true } },
    B: { outcome: 'ok', decoded: { address: '0xbbb', hasCode: true } },
  }, ['A', 'B'], { expectedPoolManager: { A: '0xaaa' } });
  assert.equal(addr.pass, true);

  const sameAddr = pmc.evaluateProbe({ name: 'poolManager()', category: 'chain-specific', expect: 'has-code' }, {
    A: { outcome: 'ok', decoded: { address: '0xaaa', hasCode: true } },
    B: { outcome: 'ok', decoded: { address: '0xaaa', hasCode: true } },
  }, ['A', 'B']);
  assert.equal(sameAddr.pass, false, 'chain-specific 地址跨链相同应判为异常');

  const noCode = pmc.evaluateProbe({ name: 'poolManager()', category: 'chain-specific', expect: 'has-code' }, {
    A: { outcome: 'ok', decoded: { address: '0xaaa', hasCode: false } },
    B: { outcome: 'ok', decoded: { address: '0xbbb', hasCode: true } },
  }, ['A', 'B']);
  assert.equal(noCode.pass, false);
});

test('summarize：内部实现等价性必须显式为 false（不得过度声明）', () => {
  const s = pmc.summarize({
    targets: [{ hasCode: true }],
    selectorDiffs: { A: { ok: true } },
    probes: [{ category: 'same-shape', pass: true }, { category: 'chain-specific', pass: true }],
    invariants: [{ pass: true }],
  });
  assert.equal(s.selectorSetConsistent, true);
  assert.equal(s.allProbesPass, true);
  assert.equal(s.internalEquivalenceProven, false);
  assert.match(s.note, /无法由只读手段证明/);
});
