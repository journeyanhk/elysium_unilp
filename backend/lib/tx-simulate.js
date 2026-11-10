/**
 * M3.1 只读预演（dry-run）—— 全部通过 lib/tx-rpc-guard.js 的只读 RPC 护栏发起，
 * 只允许 eth_call / eth_estimateGas / eth_getBalance / eth_getCode / eth_getStorageAt / eth_getLogs / eth_getBlockByNumber 等方法。
 *
 * **不签名、不广播、不构造交易**：本模块没有任何 send/sign 调用路径。
 */
const { guardedRpc } = require('./tx-rpc-guard');
const { CHAIN, CONTRACTS } = require('../config/whitelist');

/** 只读函数选择器（常量） */
const SEL = {
  ownerOf: '0x6352211e',
  getPositionLiquidity: '0x1efeed33',
  getPoolAndPositionInfo: '0x7ba03aad',
  balanceOf: '0x70a08231',
  allowance2: '0xdd62ed3e', // ERC-20 allowance(owner, spender)
  allowance3: '0x927da105', // Permit2 allowance(owner, token, spender)
};
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const RPC_URL = process.env.ELYSIUM_RPC || CHAIN.rpcEndpoints[0].url;
const ERC20_ALLOWANCE_ABI = '0xdd62ed3e'; // allowance(address,address)
const PERMIT2_ALLOWANCE_ABI = '0x927da105'; // allowance(address,address,address)

function pad32(addr) {
  return String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
function pad32num(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}
function toBig(hex) {
  try { return BigInt(hex === '0x' || hex == null ? '0x0' : hex); } catch { return null; }
}

async function blockInfo(rpc = null) {
  const call = (method, params) => (rpc ? rpc(method, params) : guardedRpc(RPC_URL, method, params));
  const bnHex = await call('eth_blockNumber');
  const bn = parseInt(bnHex, 16);
  const block = await call('eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
  return { number: bn, hash: block && block.hash, timestamp: block ? parseInt(block.timestamp, 16) : null };
}

/**
 * 只读预检（P0-3 修订）：完整覆盖余额与两级授权，不依赖 eth_call 回滚字符串推断。
 *
 * mint：token0/token1 的余额 + ERC-20→Permit2 授权 + Permit2→PositionManager 授权（原生币走余额）
 * remove / collect：ownerOf / getPositionLiquidity / getPoolAndPositionInfo
 *
 * 结果写入 tx_simulations.precheck 与 tx_audit.payload，并给出明确的失败分类。
 */
async function precheck({ user, targetContract, intent, rpc = null }) {
  const call = (method, params) => (rpc ? rpc(method, params) : guardedRpc(RPC_URL, method, params));
  const out = {
    block: null,
    blockHash: null,
    nativeBalanceWei: null,
    targetHasCode: null,
    tokens: {},
    position: null,
    issues: [],
  };

  const block = await blockInfo(rpc);
  out.block = block.number;
  out.blockHash = block.hash;

  try {
    out.nativeBalanceWei = toBig(await call('eth_getBalance', [user, 'latest'])).toString(); // 统一十进制
  } catch (e) { out.issues.push({ code: 'BALANCE_READ_FAILED', detail: String(e.message).slice(0, 160) }); }
  try {
    const code = await call('eth_getCode', [targetContract, 'latest']);
    out.targetHasCode = Boolean(code && code !== '0x');
    if (!out.targetHasCode) out.issues.push({ code: 'TARGET_NO_CODE', detail: `目标合约 ${targetContract} 无代码` });
  } catch (e) { out.issues.push({ code: 'CODE_READ_FAILED', detail: String(e.message).slice(0, 160) }); }

  const type = intent && intent.type;
  const params = (intent && intent.params) || {};

  // —— mint：两种货币的余额与两级授权 ——
  if (type === 'mint' && intent.poolKey) {
    const required = { currency0: BigInt(params.amount0Max || 0), currency1: BigInt(params.amount1Max || 0) };
    for (const side of ['currency0', 'currency1']) {
      const token = intent.poolKey[side];
      const need = required[side];
      const entry = { token, required: need.toString(), isNative: token === ZERO_ADDR };
      try {
        if (entry.isNative) {
          entry.balance = out.nativeBalanceWei;
          if (out.nativeBalanceWei != null && BigInt(out.nativeBalanceWei) < need) {
            out.issues.push({ code: 'NATIVE_BALANCE_LOW', detail: `${side} 原生币余额 ${out.nativeBalanceWei} < 需要 ${need}` });
          }
        } else {
          const bal = toBig(await call('eth_call', [{ to: token, data: SEL.balanceOf + pad32(user) }, 'latest']));
          entry.balance = bal == null ? null : bal.toString();
          if (bal == null) out.issues.push({ code: 'TOKEN_BALANCE_READ_FAILED', detail: `${side} balanceOf 读取失败` });
          else if (bal < need) out.issues.push({ code: 'TOKEN_BALANCE_LOW', detail: `${side} 代币余额 ${bal} < 需要 ${need}` });

          const erc20Allow = toBig(await call('eth_call', [{ to: token, data: SEL.allowance2 + pad32(user) + pad32(CONTRACTS.permit2.address) }, 'latest']));
          entry.erc20AllowanceToPermit2 = erc20Allow == null ? null : erc20Allow.toString();
          if (erc20Allow != null && erc20Allow < need) {
            out.issues.push({ code: 'ERC20_ALLOWANCE_LOW', detail: `${side} 对 Permit2 的 ERC-20 授权 ${erc20Allow} < 需要 ${need}` });
          }

          const p2Allow = toBig(await call('eth_call', [{
            to: CONTRACTS.permit2.address,
            data: SEL.allowance3 + pad32(user) + pad32(token) + pad32(CONTRACTS.positionManager.address),
          }, 'latest']));
          entry.permit2AllowanceToPM = p2Allow == null ? null : p2Allow.toString();
          if (p2Allow != null && p2Allow < need) {
            out.issues.push({ code: 'PERMIT2_ALLOWANCE_LOW', detail: `${side} Permit2→PositionManager 授权 ${p2Allow} < 需要 ${need}` });
          }
        }
      } catch (e) {
        out.issues.push({ code: 'TOKEN_PRECHECK_FAILED', detail: `${side}: ${String(e.message).slice(0, 160)}` });
      }
      out.tokens[side] = entry;
    }
  }

  // —— remove / collect：头寸归属与流动性 ——
  if ((type === 'remove' || type === 'collect') && params.tokenId != null) {
    const tokenId = BigInt(params.tokenId);
    const pm = CONTRACTS.positionManager.address;
    const pos = { tokenId: tokenId.toString(), owner: null, liquidity: null, poolId: null, tickLower: null, tickUpper: null };
    try {
      const ownerRes = await call('eth_call', [{ to: pm, data: SEL.ownerOf + pad32num(tokenId) }, 'latest']);
      pos.owner = '0x' + String(ownerRes).slice(-40);
      if (pos.owner.toLowerCase() !== String(user).toLowerCase()) {
        out.issues.push({ code: 'TOKEN_NOT_OWNER', detail: `头寸 ${tokenId} 持有人是 ${pos.owner}，不是 ${user}` });
      }
    } catch (e) {
      out.issues.push({ code: 'POSITION_NOT_FOUND', detail: `头寸 ${tokenId} 不存在或读取失败：${String(e.message).slice(0, 160)}` });
    }
    try {
      const liq = toBig(await call('eth_call', [{ to: pm, data: SEL.getPositionLiquidity + pad32num(tokenId) }, 'latest']));
      pos.liquidity = liq == null ? null : liq.toString();
      const want = params.liquidity != null ? BigInt(params.liquidity) : 0n;
      if (liq != null && type === 'remove' && want > 0n && liq < want) {
        out.issues.push({ code: 'LIQUIDITY_INSUFFICIENT', detail: `头寸流动性 ${liq} < 申请撤出 ${want}` });
      }
    } catch (e) {
      out.issues.push({ code: 'LIQUIDITY_READ_FAILED', detail: String(e.message).slice(0, 160) });
    }
    try {
      const info = await call('eth_call', [{ to: pm, data: SEL.getPoolAndPositionInfo + pad32num(tokenId) }, 'latest']);
      pos.poolAndPositionInfo = String(info).slice(0, 200);
    } catch (e) {
      out.issues.push({ code: 'POOL_AND_POSITION_INFO_FAILED', detail: String(e.message).slice(0, 160) });
    }
    out.position = pos;
  }

  out.ok = out.issues.length === 0;
  return out;
}

/**
 * 执行只读预演。
 * @param {object} p
 * @param {string} p.user
 * @param {string} p.targetContract
 * @param {string} p.calldata
 * @param {object} [p.localEstimate]  本地估算结果（用于偏差比对）
 * @param {string} [p.token]          预检用代币地址
 * @param {string} [p.permit2Spender]
 * @param {number} [p.gasPriceGwei]   不传则从链上取
 */
async function simulate({ user, targetContract, calldata, localEstimate = null, token = null, permit2Spender = null, gasPriceGwei = null, intent = null, rpc = null }) {
  const call = (method, params) => (rpc ? rpc(method, params) : guardedRpc(RPC_URL, method, params));
  const block = await blockInfo(rpc);
  const result = {
    simBlockNumber: block.number,
    simBlockHash: block.hash,
    stateBlockNumber: block.number,
    rpcEndpoint: RPC_URL,
    ethCallOk: null,
    ethCallResult: null,
    revertReason: null,
    gasEstimate: null,
    gasPriceGwei: null,
    gasUsd: null,
    precheck: null,
    localEstimate,
    deviation: null,
  };

  // 1) eth_call（只读执行，绝不广播）
  try {
    const res = await call('eth_call', [{ from: user, to: targetContract, data: calldata }, 'latest']);
    result.ethCallOk = true;
    result.ethCallResult = res;
  } catch (e) {
    result.ethCallOk = false;
    const msg = String(e.message || '');
    // 常见回滚语义：余额不足 / NotApproved / DeadlinePassed / 其它
    if (/NotApproved|Unauthorized|allowance/i.test(msg)) result.revertReason = '授权不足或未授权';
    else if (/insufficient|exceeds balance|balance/i.test(msg)) result.revertReason = '余额不足';
    else if (/Deadline|expired/i.test(msg)) result.revertReason = 'deadline 过期';
    else if (/execution reverted/.test(msg) && /"data":"0x"/.test(msg)) {
      result.revertReason = '链上回滚（未返回原因字符串）——常见原因：余额不足 / 未授权（ERC-20 或 Permit2）/ 参数越界';
    } else result.revertReason = msg.slice(0, 300);
  }

  // 2) Gas 估算（只读）
  try {
    const gasHex = await call('eth_estimateGas', [{ from: user, to: targetContract, data: calldata }]);
    result.gasEstimate = BigInt(gasHex).toString();
  } catch (e) {
    result.gasEstimate = null;
    result.gasEstimateError = String(e.message || '').slice(0, 300);
  }

  // 3) Gas 价格
  try {
    const gp = gasPriceGwei != null ? gasPriceGwei : Number(BigInt(await call('eth_gasPrice'))) / 1e9;
    result.gasPriceGwei = Number(gp.toFixed(6));
  } catch (e) { result.gasPriceGwei = null; }

  // 4) Gas 成本（USD）——需要原生币美元价
  if (result.gasEstimate && result.gasPriceGwei != null) {
    try {
      const { getPrices } = require('./prices');
      const prices = await getPrices();
      const hypeUsd = prices && prices.HYPE ? prices.HYPE.usd : null;
      if (hypeUsd != null) {
        const gasNative = (Number(result.gasEstimate) * result.gasPriceGwei) / 1e9;
        result.gasUsd = Number((gasNative * hypeUsd).toFixed(6));
        result.nativeUsd = hypeUsd;
      }
    } catch { result.gasUsd = null; }
  }

  // 5) 只读预检（完整余额与两级授权 / 头寸归属；结果含明确失败分类）
  result.precheck = await precheck({ user, targetContract, intent, rpc });

  // 6) 与本地估算偏差
  if (localEstimate && localEstimate.amountOut != null && result.ethCallOk) {
    result.deviation = { note: '本地估算与链上 eth_call 的差异（eth_call 不返回金额，仅记录两者以便人工核对）', localAmountOut: String(localEstimate.amountOut) };
  }

  return result;
}

/**
 * P0-2（M3.1 review）：预演用户必须与 intent 用户一致，禁止用他人地址模拟。
 * 返回最终使用的 from 地址；不一致时抛错（路由转换为 403）。
 */
function checkSimulationUser(intentUser, requestedUser) {
  if (!intentUser) throw new Error('intent 缺少用户地址，无法预演');
  if (requestedUser != null && String(requestedUser).toLowerCase() !== String(intentUser).toLowerCase()) {
    const e = new Error(`simulate user 与 intent user 不一致（intent=${intentUser}, 请求=${requestedUser}）`);
    e.code = 'SIM_USER_MISMATCH';
    throw e;
  }
  return intentUser;
}

module.exports = { simulate, precheck, blockInfo, checkSimulationUser, RPC_URL, SEL };
