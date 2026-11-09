/**
 * M1 运行时写操作拦截器（前端侧安全边界）。
 * 任何「构造签名交易」的代码路径（组池 / 领费 / 撤池 / Approve / Permit2 / 桥接）必须先调用 assertWritesEnabled()。
 * M1/M2 阶段保持 false；M3 交易开关通过后才按合约逐个开启（后端对应 backend/lib/tx-guard.js）。
 */
export const WRITES_ENABLED = false;

export function assertWritesEnabled(): never {
  throw new Error('M1 只读模式：已阻止签名/写操作（交易开关在 M3 经安全审查后开放）');
}

export function writesDisabledReason(): string {
  return WRITES_ENABLED ? '' : 'M1 只读模式：不请求任何钱包签名，交易功能将在 M3 开放';
}
