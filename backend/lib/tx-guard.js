/**
 * 统一写操作拦截器（M1 安全边界）——review 要求：writeEnabled 必须是运行时边界，不能只是配置字段。
 *
 * 任何未来构造「签名交易」的代码路径（组池 / 领费 / 撤池 / Approve / Permit2 / 桥接 / UniversalRouter）
 * 都必须先调用 assertWriteEnabled(key)，否则抛出。M1/M2 阶段全部 writeEnabled=false。
 * 开启条件（逐合约、逐阶段）见 docs/M0-VERIFICATION.md §6。
 */
const { CONTRACTS, POOLS } = require('../config/whitelist');

const WRITE_UNLOCK_STAGE = 'M3'; // 交易开关通过后才可能开启

function assertWriteEnabled(key) {
  const target = CONTRACTS[key] || POOLS[key];
  if (!target) throw new Error(`写操作拦截：未知目标「${key}」，不在白名单内`);
  if (!target.writeEnabled) {
    throw new Error(`写操作拦截：当前为只读阶段（${WRITE_UNLOCK_STAGE} 前禁止写操作），「${key}」的 writeEnabled=false`);
  }
  return true;
}

function isWriteEnabled(key) {
  const target = CONTRACTS[key] || POOLS[key];
  return !!(target && target.writeEnabled);
}

module.exports = { assertWriteEnabled, isWriteEnabled, WRITE_UNLOCK_STAGE };
