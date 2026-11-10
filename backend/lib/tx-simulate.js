/**
 * M3.1 只读预演（dry-run）—— 全部通过 lib/tx-rpc-guard.js 的只读 RPC 护栏发起，
 * 只允许 eth_call / eth_estimateGas / eth_getBalance / eth_getCode / eth_getStorageAt / eth_getLogs / eth_getBlockByNumber 等方法。
 *
 * **不签名、不广播、不构造交易**：本模块没有任何 send/sign 调用路径。
 */
const { guardedRpc } = require('./tx-rpc-guard');
const { CHAIN } = require('../config/whitelist');

const RPC_URL = process.env.ELYSIUM_RPC || CHAIN.rpcEndpoints[0].url;
const ERC20_ALLOWANCE_ABI = '0xdd62ed3e'; // allowance(address,address)
const PERMIT2_ALLOWANCE_ABI = '0x927da105'; // allowance(address,address,address)

function pad32(addr) {
  return String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function blockInfo() {
  const bnHex = await guardedRpc(RPC_URL, 'eth_blockNumber');
  const bn = parseInt(bnHex, 16);
  const block = await guardedRpc(RPC_URL, 'eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
  return { number: bn, hash: block && block.hash, timestamp: block ? parseInt(block.timestamp, 16) : null };
}

/** 只读预检：原生币余额、目标合约是否存在、代币授权额度（ERC20 / Permit2） */
async function precheck({ user, targetContract, token, permit2Spender }) {
  const out = { nativeBalanceWei: null, targetHasCode: null, allowance: null, permit2Allowance: null, errors: [] };
  try {
    out.nativeBalanceWei = BigInt(await guardedRpc(RPC_URL, 'eth_getBalance', [user, 'latest'])).toString();
  } catch (e) { out.errors.push(`余额读取失败：${e.message}`); }
  try {
    const code = await guardedRpc(RPC_URL, 'eth_getCode', [targetContract, 'latest']);
    out.targetHasCode = code && code !== '0x';
  } catch (e) { out.errors.push(`代码读取失败：${e.message}`); }
  if (token) {
    try {
      const data = ERC20_ALLOWANCE_ABI + pad32(user) + pad32(permit2Spender || targetContract);
      const res = await guardedRpc(RPC_URL, 'eth_call', [{ to: token, data }, 'latest']);
      out.allowance = BigInt(res === '0x' ? '0x0' : res).toString();
    } catch (e) { out.errors.push(`授权读取失败：${e.message}`); }
  }
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
async function simulate({ user, targetContract, calldata, localEstimate = null, token = null, permit2Spender = null, gasPriceGwei = null }) {
  const block = await blockInfo();
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
    const res = await guardedRpc(RPC_URL, 'eth_call', [{ from: user, to: targetContract, data: calldata }, 'latest']);
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
    const gasHex = await guardedRpc(RPC_URL, 'eth_estimateGas', [{ from: user, to: targetContract, data: calldata }]);
    result.gasEstimate = BigInt(gasHex).toString();
  } catch (e) {
    result.gasEstimate = null;
    result.gasEstimateError = String(e.message || '').slice(0, 300);
  }

  // 3) Gas 价格
  try {
    const gp = gasPriceGwei != null ? gasPriceGwei : Number(BigInt(await guardedRpc(RPC_URL, 'eth_gasPrice'))) / 1e9;
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

  // 5) 只读预检
  result.precheck = await precheck({ user, targetContract, token, permit2Spender });

  // 6) 与本地估算偏差
  if (localEstimate && localEstimate.amountOut != null && result.ethCallOk) {
    result.deviation = { note: '本地估算与链上 eth_call 的差异（eth_call 不返回金额，仅记录两者以便人工核对）', localAmountOut: String(localEstimate.amountOut) };
  }

  return result;
}

module.exports = { simulate, precheck, blockInfo, RPC_URL };
