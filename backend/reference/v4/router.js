'use strict';
/**
 * 独立参考实现 · 路由器 calldata 解码（用于确定 Swap 的**真实执行模式**，取代此前「本地模型反选模式」的做法）
 *
 * 已支持：
 *  - Uniswap Universal Router `execute(bytes commands, bytes[] inputs, uint256 deadline)`（选择器 0x3593564c）
 *    → 单条 V4_SWAP 命令（command 0x10）→ 单个 swap action（0x06/0x07/0x08/0x09）
 *  - V4Router 的价格限制语义：官方源码 V4Router.sol `_swap()` 固定传入
 *      zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
 *    （来源：https://github.com/Uniswap/v4-periphery/blob/main/src/V4Router.sol）
 *  - 兼容旧版「按滑点推导限价」的语义：getNextSqrtPriceFromOutput / getNextSqrtPriceFromInput
 *    （用于「限价不敏感」检查：两种限价解释给出完全相同结果时，该样本才可入库）
 *
 * 无法确定执行路径的交易（未知路由器 / 多跳 / 同交易多笔 swap / 解码失败）一律**排除并单独统计**，不猜测。
 */
const { decodeAbiParameters, keccak256, toHex } = require('viem');
const SPM = require('./sqrtpricemath');
const TickMath = require('./tickmath');

const UR_EXECUTE_SELECTOR = '0x3593564c'; // execute(bytes,bytes[],uint256)
const UR_COMMAND_V4_SWAP = 0x10;

const ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
  SWEEP: 0x14,
  WRAP: 0x15,
  UNWRAP: 0x16,
};
const SWAP_ACTIONS = new Set([ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SWAP_EXACT_IN, ACTION.SWAP_EXACT_OUT_SINGLE, ACTION.SWAP_EXACT_OUT]);
/** Universal Router 顶层命令中会引发「其它池/协议」成交的命令（V2/V3 swap 与 V4_SWAP）→ 出现第二个即为路由拆单，排除 */
const OTHER_SWAP_COMMANDS = new Set([0x00, 0x01, 0x08, 0x09, 0x10]);
const NON_SWAP_ACTIONS = new Set(Object.entries(ACTION).filter(([k]) => !k.startsWith('SWAP_')).map(([, v]) => v));

const POOL_KEY_TYPE = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const PATH_KEY_TYPE = { type: 'tuple', components: [
  { name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }] };

function samePoolKey(a, b) {
  return String(a.currency0).toLowerCase() === String(b.currency0).toLowerCase()
    && String(a.currency1).toLowerCase() === String(b.currency1).toLowerCase()
    && Number(a.fee) === Number(b.fee)
    && Number(a.tickSpacing) === Number(b.tickSpacing)
    && String(a.hooks).toLowerCase() === String(b.hooks).toLowerCase();
}

function poolKeyFromPath(currencyInOrOut, pathKey) {
  const a = String(currencyInOrOut).toLowerCase();
  const b = String(pathKey.intermediateCurrency).toLowerCase();
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0: c0, currency1: c1, fee: Number(pathKey.fee), tickSpacing: Number(pathKey.tickSpacing), hooks: pathKey.hooks };
}

/**
 * 解码交易 calldata，得到该笔 Swap 的真实执行参数。
 * @returns {{ok:true, router:'universal-router', command, action, actionName, mode:'exactIn'|'exactOut',
 *            amount:bigint, slippageLimit:bigint, zeroForOne:boolean, poolKey:object, hookData:string}
 *          |{ok:false, reason:string}}
 */
function decodeRouterSwap(input, poolKeyExpected) {
  if (!input || input.length < 10) return { ok: false, reason: 'empty-calldata' };
  const selector = input.slice(0, 10).toLowerCase();
  if (selector !== UR_EXECUTE_SELECTOR) return { ok: false, reason: `unknown-router-selector:${selector}` };
  let commands; let inputs; let deadline;
  try {
    [commands, inputs, deadline] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }], '0x' + input.slice(10));
  } catch (e) {
    return { ok: false, reason: 'execute-decode-failed' };
  }
  void deadline;
  const cmds = (commands.slice(2).match(/../g) || []).map((c) => parseInt(c, 16));
  const v4Idx = cmds.map((c, i) => (c === UR_COMMAND_V4_SWAP ? i : -1)).filter((i) => i >= 0);
  if (v4Idx.length === 0) return { ok: false, reason: `command-not-v4swap:${cmds.map((c) => '0x' + c.toString(16)).join(',')}` };
  if (v4Idx.length > 1) return { ok: false, reason: `multi-v4swap-command:${v4Idx.length}` };
  if (cmds.some((c, i) => i !== v4Idx[0] && OTHER_SWAP_COMMANDS.has(c))) return { ok: false, reason: `multi-command-swap:${cmds.map((c) => '0x' + c.toString(16)).join(',')}` };
  const cmdIdx = v4Idx[0];
  if (inputs.length !== cmds.length) return { ok: false, reason: `commands-inputs-mismatch:${cmds.length}/${inputs.length}` };

  let actions; let params;
  try {
    [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[cmdIdx]);
  } catch (e) {
    return { ok: false, reason: 'v4swap-decode-failed' };
  }
  const actBytes = actions.slice(2).match(/../g) || [];
  const swapIdx = actBytes.map((a, i) => [parseInt(a, 16), i]).filter(([a]) => SWAP_ACTIONS.has(a));
  const others = actBytes.map((a) => parseInt(a, 16)).filter((a) => !SWAP_ACTIONS.has(a));
  if (swapIdx.length !== 1) return { ok: false, reason: `swap-actions:${swapIdx.length}` };
  if (others.some((a) => !NON_SWAP_ACTIONS.has(a))) return { ok: false, reason: `unknown-actions:${others.map((a) => '0x' + a.toString(16)).join(',')}` };
  if (params.length !== actBytes.length) return { ok: false, reason: 'actions-params-length-mismatch' };

  const [action, idx] = swapIdx[0];
  const actionName = Object.entries(ACTION).find(([, v]) => v === action)[0];
  const raw = params[idx];

  // 路由器版本差异：不同 v4-periphery 版本的 struct 字段不同（新版多 minHopPriceX36）。
  // 逐个候选布局尝试解码；解码结果仍需与链上事件自洽（池、方向、数量），由调用方校验。
  const PATH_KEYS = [
    [{ name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }],
    [{ name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }],
  ];
  const layouts = [];
  for (const pk of PATH_KEYS) {
    const pathArr = { type: 'tuple[]', components: pk };
    layouts.push(
      { tag: 'single', action, types: [POOL_KEY_TYPE, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], kind: 'single' },
      { tag: 'single+minhop', action, types: [POOL_KEY_TYPE, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bytes' }], kind: 'single' },
      { tag: 'single+minhop-nohook', action, types: [POOL_KEY_TYPE, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }], kind: 'single' },
      { tag: 'path', action, types: [{ type: 'address' }, pathArr, { type: 'uint128' }, { type: 'uint128' }], kind: 'path' },
      { tag: 'path+minhop-mid', action, types: [{ type: 'address' }, pathArr, { type: 'uint256[]' }, { type: 'uint128' }, { type: 'uint128' }], kind: 'path' },
      { tag: 'path+minhop-tail', action, types: [{ type: 'address' }, pathArr, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256[]' }], kind: 'path' },
    );
  }
  const tryLayouts = layouts.filter((l) => (action === ACTION.SWAP_EXACT_IN_SINGLE || action === ACTION.SWAP_EXACT_OUT_SINGLE ? l.kind === 'single' : l.kind === 'path'));

  let out = null;
  const decodeErrors = [];
  // 部分路由器版本把 action 参数包了一层（首字为偏移 0x20）→ 同时尝试「原样」与「跳过首字」两种变体
  const blobs = [{ tag: 'raw', blob: raw }];
  if (raw.length > 66) blobs.push({ tag: 'skip1word', blob: '0x' + raw.slice(2 + 64) });
  outer:
  for (const L of tryLayouts) {
   for (const B of blobs) {
    let d;
    try { d = decodeAbiParameters(L.types, B.blob); } catch (e) { decodeErrors.push(`${L.tag}/${B.tag}`); continue; }
    if (L.kind === 'single') {
      const hookIdx = L.types.length - 1;
      const [pk, zfo, amt, limit] = d;
      const hookData = L.types[hookIdx].type === 'bytes' ? d[hookIdx] : '0x';
      out = { poolKey: pk, zeroForOne: Boolean(zfo), amount: BigInt(amt), slippageLimit: BigInt(limit), hookData, layout: `${L.tag}/${B.tag}` };
    } else {
      const amtIdx = L.tag === 'path+minhop-mid' ? 3 : 2;
      const limIdx = amtIdx + 1;
      const [cur, path] = d;
      const amt = d[amtIdx]; const limit = d[limIdx];
      if (path.length !== 1) { decodeErrors.push(`${L.tag}:multi-hop:${path.length}`); continue; }
      const pk = poolKeyFromPath(cur, path[0]);
      const zeroForOne = action === ACTION.SWAP_EXACT_IN
        ? String(cur).toLowerCase() === String(pk.currency0).toLowerCase()
        : String(cur).toLowerCase() !== String(pk.currency0).toLowerCase();
      out = { poolKey: pk, zeroForOne, amount: BigInt(amt), slippageLimit: BigInt(limit), hookData: path[0].hookData ?? '0x', layout: `${L.tag}/${B.tag}` };
    }
    break outer;
   }
  }
  if (!out) return { ok: false, reason: `swap-params-decode-failed(${decodeErrors.join('|') || 'none'})` };
  const { poolKey, zeroForOne, amount, slippageLimit, hookData, layout } = out;
  const mode = action === ACTION.SWAP_EXACT_IN_SINGLE || action === ACTION.SWAP_EXACT_IN ? 'exactIn' : 'exactOut';

  if (!samePoolKey(poolKey, poolKeyExpected)) return { ok: false, reason: 'pool-key-mismatch' };
  return {
    ok: true, router: 'universal-router', command: UR_COMMAND_V4_SWAP, commands: cmds.map((c) => '0x' + c.toString(16)).join(','), action, actionName, mode, layout,
    amount: BigInt(amount), slippageLimit: BigInt(slippageLimit), zeroForOne: Boolean(zeroForOne),
    poolKey, hookData,
  };
}

/** V4Router 实际使用的限价（官方源码固定值） */
function routerSentinelLimit(zeroForOne) {
  return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1n : TickMath.MAX_SQRT_PRICE - 1n;
}

/** 兼容旧版语义：按滑点推导的限价（exactIn 用 amountOutMinimum；exactOut 用 amountInMaximum） */
function slippageDerivedLimit({ mode, zeroForOne, slippageLimit, sqrtPriceX96, liquidity }) {
  if (mode === 'exactIn') {
    if (slippageLimit === 0n) return routerSentinelLimit(zeroForOne);
    return SPM.getNextSqrtPriceFromOutput(BigInt(sqrtPriceX96), BigInt(liquidity), slippageLimit, zeroForOne);
  }
  if (slippageLimit >= (1n << 128n) - 1n) return routerSentinelLimit(zeroForOne);
  return SPM.getNextSqrtPriceFromInput(BigInt(sqrtPriceX96), BigInt(liquidity), slippageLimit, zeroForOne);
}

module.exports = { UR_EXECUTE_SELECTOR, UR_COMMAND_V4_SWAP, ACTION, decodeRouterSwap, routerSentinelLimit, slippageDerivedLimit, samePoolKey };
