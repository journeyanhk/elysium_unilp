/**
 * M3.3 手动签名与广播（前端侧）—— 只做「用户手动确认 → 请求钱包签名 / 发送」，绝无自动化。
 *
 * 硬性约束（每次调用都会检查，不依赖 UI 状态）：
 *   1) 交易门禁必须已开启且存在解锁记录；
 *   2) 熔断状态必须明确为「未触发」（未知 = 拒绝）；
 *   3) 授权必须已完成**一次性消费**；
 *   4) 只使用后端构建好的交易字段（to / value / data / chainId），前端不修改 Gas、不调整滑点、不降低 minOut；
 *   5) 不自动重试、不自动加速、不替换交易 —— 任何失败都直接把错误抛给用户。
 */
import { getProvider } from './wallet';

export type SignPreconditions = {
  gateEnabled: boolean;
  unlockPath: string | null;
  killSwitchTripped: boolean | null;
  authorizationConsumed: boolean;
};

export type WalletTx = { to: string; value: string; data: string; chainId: number };

export function signingBlockedReason(p: SignPreconditions): string {
  if (!p.gateEnabled) return '交易门禁关闭：不会向钱包发起任何签名请求';
  if (!p.unlockPath) return '缺少解锁记录：不会向钱包发起任何签名请求';
  if (p.killSwitchTripped !== false) return '熔断状态未确认或已触发：不会向钱包发起任何签名请求';
  if (!p.authorizationConsumed) return '授权尚未一次性消费：不会向钱包发起任何签名请求';
  return '';
}

export function assertSigningAllowed(p: SignPreconditions): void {
  const reason = signingBlockedReason(p);
  if (reason) throw new Error(reason);
}

function requireProvider() {
  const p = getProvider();
  if (!p) throw new Error('未检测到浏览器钱包（推荐 OKX 钱包）');
  return p;
}

/**
 * 方式一：钱包**只签名**（不广播）→ 返回原始交易，交由后端核对后广播。
 * 不支持该方法的钱包会返回错误码 -32601，请改用「钱包内确认并广播」。
 */
export async function signTransactionOnly(p: SignPreconditions, tx: WalletTx): Promise<string> {
  assertSigningAllowed(p);
  const provider = requireProvider();
  try {
    const raw = (await provider.request({
      method: 'eth_signTransaction',
      params: [{ from: undefined, to: tx.to, value: `0x${BigInt(tx.value).toString(16)}`, data: tx.data, chainId: `0x${tx.chainId.toString(16)}` }],
    })) as string | { raw?: string };
    const rawTx = typeof raw === 'string' ? raw : raw?.raw;
    if (!rawTx) throw new Error('钱包未返回已签名交易');
    return rawTx;
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (code === -32601) {
      throw new Error('当前钱包不支持「只签名不广播」（eth_signTransaction），请改用「钱包内确认并广播」方式');
    }
    throw e;
  }
}

/**
 * 方式二：钱包内确认并**由钱包广播** → 返回交易哈希，后端按哈希事后核对内容。
 * 交易字段完全来自后端构建结果，前端不改动任何参数。
 */
export async function sendViaWallet(p: SignPreconditions, tx: WalletTx, from: string): Promise<string> {
  assertSigningAllowed(p);
  const provider = requireProvider();
  const hash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: tx.to, value: `0x${BigInt(tx.value).toString(16)}`, data: tx.data }],
  })) as string;
  if (!hash) throw new Error('钱包未返回交易哈希');
  return hash;
}
