/**
 * M3.1 只读 RPC 护栏 —— review 验收条件：预演管线只能使用只读方法，
 * 绝不能出现 eth_sendTransaction / eth_sendRawTransaction / personal_sign / eth_signTypedData / wallet_* 等写或签名方法。
 *
 * 用法：M3 预演管线一律通过 guardedRpc(method, params) 发起请求；
 * 任何未列入只读白名单的方法都会在**发出请求之前**抛错，并记录到进程内计数器（供审计）。
 */

/** 允许的只读 RPC 方法（白名单，新增方法必须显式评审） */
const READ_ONLY_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getProof',
  'net_version',
  'web3_clientVersion',
]);

/** 明确禁止的方法（即使将来误加入白名单也必须拒绝） */
const FORBIDDEN_METHODS = new Set([
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'personal_ecRecover',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_sendCalls',
  'wallet_signTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_requestAccounts',
  'eth_accounts',
  'eth_submitWork',
  'eth_newFilter',
]);

const FORBIDDEN_PREFIXES = ['personal_', 'wallet_', 'eth_sign'];

const attempts = { allowed: 0, blocked: 0, blockedMethods: {} };

function isForbiddenMethod(method) {
  const m = String(method || '');
  if (FORBIDDEN_METHODS.has(m)) return true;
  return FORBIDDEN_PREFIXES.some((p) => m.startsWith(p));
}

function assertReadOnlyRpc(method) {
  const m = String(method || '');
  if (!m) throw new Error('RPC 护栏拒绝：方法名为空');
  if (isForbiddenMethod(m)) {
    attempts.blocked += 1;
    attempts.blockedMethods[m] = (attempts.blockedMethods[m] || 0) + 1;
    const e = new Error(`RPC 护栏拒绝：${m} 属于写/签名方法，M3 只读阶段禁止调用`);
    e.code = 'RPC_FORBIDDEN';
    throw e;
  }
  if (!READ_ONLY_METHODS.has(m)) {
    attempts.blocked += 1;
    attempts.blockedMethods[m] = (attempts.blockedMethods[m] || 0) + 1;
    const e = new Error(`RPC 护栏拒绝：${m} 不在只读方法白名单内（新增方法需显式评审）`);
    e.code = 'RPC_NOT_ALLOWED';
    throw e;
  }
  attempts.allowed += 1;
  return true;
}

/** 只读 RPC 调用（带护栏 + 重试）。返回 JSON-RPC result。 */
async function guardedRpc(rpcUrl, method, params = [], { timeoutMs = 30000, retries = 3 } = {}) {
  assertReadOnlyRpc(method);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json();
      if (json.error) throw new Error(`RPC 错误：${JSON.stringify(json.error)}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

function rpcGuardStats() {
  return { allowed: attempts.allowed, blocked: attempts.blocked, blockedMethods: { ...attempts.blockedMethods } };
}

module.exports = {
  READ_ONLY_METHODS,
  FORBIDDEN_METHODS,
  assertReadOnlyRpc,
  isForbiddenMethod,
  guardedRpc,
  rpcGuardStats,
};
