/**
 * M3.3 手动签名与广播（前端侧）—— 只做「用户手动确认 → 请求钱包签名 / 发送」，绝无自动化。
 *
 * 硬性约束（每次调用都会检查，不依赖 UI 状态；不通过则**不会弹出钱包**）：
 *   1) 交易门禁已开启且存在解锁记录；
 *   2) 熔断状态明确为「未触发」（未知 = 拒绝）；
 *   3) 授权已完成**一次性消费**；
 *   4) 签名请求必须显式携带 `from`，且 `from` 必须等于钱包当前账户（大小写不敏感）；
 *   5) `chainId` 必须是 99901，且与钱包当前链一致；
 *   6) Gas 参数（gasLimit / maxFeePerGas / maxPriorityFeePerGas）必须来自后端预演锁定值，
 *      前端不修改、不省略、不交由钱包自行决定；
 *   7) 不自动重试、不自动加速、不替换交易 —— 任何失败都直接把错误抛给用户。
 *
 * 后端仍会做二次校验（签名恢复地址 + Gas 参数与授权绑定比对），前端检查只是第一道闸。
 */
import { getProvider } from './wallet';

export const ELYSIUM_CHAIN_ID = 99901;

export type SignPreconditions = {
  gateEnabled: boolean;
  unlockPath: string | null;
  killSwitchTripped: boolean | null;
  authorizationConsumed: boolean;
};

export type WalletTx = {
  from: string;
  to: string;
  value: string;
  data: string;
  chainId: number;
  gas: string; // hex，来自后端预演锁定的 gasLimit
  maxFeePerGas: string; // hex，来自后端预演锁定值
  maxPriorityFeePerGas: string; // hex，来自后端预演锁定值
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

/**
 * 第一道校验（纯函数，**不接触钱包**）：门禁前置条件 + 交易字段完整性 + 链 ID。
 * 这一层不通过时，连只读查询都不会发起。
 */
export function validateSigningStatic(pre: SignPreconditions, tx: WalletTx): string {
  const blocked = signingBlockedReason(pre);
  if (blocked) return blocked;
  if (!tx) return '缺少待签名交易——拒绝签名';
  if (!tx.from || !ADDR_RE.test(tx.from)) return '签名请求缺少发送方（from）——拒绝：不允许钱包自行决定账户';
  if (Number(tx.chainId) !== ELYSIUM_CHAIN_ID) return `签名请求 chainId ${tx.chainId} 不是 Elysium（${ELYSIUM_CHAIN_ID}）——拒绝签名`;
  if (!tx.to || !ADDR_RE.test(tx.to)) return '签名请求缺少收款合约地址——拒绝签名';
  if (!tx.data || !HEX_RE.test(tx.data)) return '签名请求缺少 calldata——拒绝签名';
  for (const [name, v] of [['gas', tx.gas], ['maxFeePerGas', tx.maxFeePerGas], ['maxPriorityFeePerGas', tx.maxPriorityFeePerGas]] as const) {
    if (!v || !HEX_RE.test(v)) return `签名请求缺少 ${name}（Gas 参数必须使用后端预演锁定值，不允许钱包自行决定）——拒绝签名`;
  }
  return '';
}

/**
 * 完整校验（纯函数，可测试）：在第一道校验基础上，核对钱包当前账户与当前链。
 * 返回 '' 表示允许；否则返回拒绝原因。任何一条不满足都必须在**请求签名之前**拒绝。
 */
export function validateSigningRequest(ctx: {
  pre: SignPreconditions;
  tx: WalletTx;
  walletAccount: string | null;
  walletChainId: number | null;
}): string {
  const staticReason = validateSigningStatic(ctx.pre, ctx.tx);
  if (staticReason) return staticReason;

  const tx = ctx.tx;
  if (!ctx.walletAccount) return '未连接钱包账户——拒绝签名';
  if (!eq(tx.from, ctx.walletAccount)) {
    return `签名请求的发送方 ${tx.from} 与钱包当前账户 ${ctx.walletAccount} 不一致——拒绝签名`;
  }
  if (ctx.walletChainId == null) return '无法读取钱包当前链——拒绝签名';
  if (Number(ctx.walletChainId) !== Number(tx.chainId)) {
    return `钱包当前链 ${ctx.walletChainId} 与交易链 ${tx.chainId} 不一致——请先切换网络`;
  }
  return '';
}

export function assertSigningRequest(ctx: Parameters<typeof validateSigningRequest>[0]): void {
  const reason = validateSigningRequest(ctx);
  if (reason) throw new Error(reason);
}

/**
 * 服务端最新状态快照（每次签名前必须重新读取，不得使用页面旧状态）。
 * 对应后端：GET /api/tx/gate、POST /api/tx/pre-sign-audit（服务端会写入审计快照）。
 */
export type GateSnapshot = {
  enabled: boolean;
  unlockPath: string | null;
  killSwitchTripped: boolean | null;
  stateUnavailable?: boolean;
  firstTxMode?: boolean;
};

export type AuthorizationSnapshot = {
  status: string;
  bindingHash: string | null;
  consumedAt: string | null;
  consumeAgeSec: number | null;
  maxConsumeAgeSec: number;
} | null;

/**
 * 用**服务端最新快照**判定是否允许请求钱包签名（纯函数，可测试）。
 * 任何一项不满足都必须拒绝，且调用方不得向钱包发起任何请求。
 */
export function evaluateFreshSignGate(input: {
  gate: GateSnapshot | null | undefined;
  authorization: AuthorizationSnapshot;
  preSign: { ok?: boolean; reason?: string | null; bindingHash?: string | null } | null | undefined;
  /** 服务端返回的签名载荷（signing.bindingHash 与 snapshot.bindingHash 必须与授权一致） */
  signing?: { bindingHash?: string | null } | null;
  snapshotBindingHash?: string | null;
  expectedBindingHash?: string | null;
  requestedMode?: 'wallet-sign-raw' | 'wallet-sent';
}): { ok: boolean; reason: string | null; pre: SignPreconditions; mode: 'wallet-sign-raw' | 'wallet-sent'; bindingHash: string | null } {
  const g = input.gate;
  const auth = input.authorization;
  const preSign = input.preSign;
  const pre: SignPreconditions = {
    gateEnabled: Boolean(g?.enabled),
    unlockPath: g?.unlockPath ?? null,
    killSwitchTripped: g ? (g.killSwitchTripped ?? null) : null,
    authorizationConsumed: Boolean(auth && auth.status === 'consumed'),
  };
  const deny = (reason: string) => ({ ok: false, reason, pre, mode: 'wallet-sign-raw' as const, bindingHash: null });

  if (!g) return deny('无法读取最新门禁状态（拒绝签名）');
  if (!g.enabled) return deny('交易门禁关闭（拒绝签名）');
  if (!g.unlockPath) return deny('缺少解锁记录（拒绝签名）');
  if (g.killSwitchTripped !== false) return deny('熔断状态异常或已触发（未知 = 拒绝）');
  if (g.stateUnavailable) return deny('门禁持久化状态不可读（拒绝签名）');
  if (!auth) return deny('该 intent 没有授权记录（拒绝签名）');
  if (auth.status !== 'consumed') return deny(`授权状态为 ${auth.status}（未完成一次性消费，拒绝签名）`);
  if (auth.consumeAgeSec == null) return deny('授权消费时间缺失（拒绝签名）');
  if (auth.consumeAgeSec > auth.maxConsumeAgeSec) {
    return deny(`授权消费已过去 ${auth.consumeAgeSec}s（上限 ${auth.maxConsumeAgeSec}s），必须重新走完整流程`);
  }
  if (input.expectedBindingHash && auth.bindingHash && !eq(input.expectedBindingHash, auth.bindingHash)) {
    return deny('服务端授权绑定哈希与本地记录不一致（状态已变化，拒绝签名）');
  }
  if (!preSign || preSign.ok !== true) {
    return deny(`签名前核对未通过：${preSign?.reason || '未执行核对'}（拒绝签名）`);
  }
  if (preSign.bindingHash && auth.bindingHash && !eq(preSign.bindingHash, auth.bindingHash)) {
    return deny('签名前核对返回的绑定哈希与授权不一致（拒绝签名）');
  }
  // 三处绑定哈希必须一致：签名载荷 / 快照 / 授权（review 观察项 2）
  const hashes = [input.signing?.bindingHash, input.snapshotBindingHash, auth.bindingHash].filter((h) => h != null && h !== '');
  if (hashes.length > 1 && hashes.some((h) => !eq(h, hashes[0]))) {
    return deny('签名载荷 / 快照 / 授权的绑定哈希不一致（状态已变化，拒绝签名）');
  }
  const bindingHash = hashes.length ? hashes[0] : null;

  // 首笔模式：只允许「钱包只签名 → 后端核对 → 后端广播」
  const firstTx = g.firstTxMode === true;
  const mode = firstTx ? 'wallet-sign-raw' : (input.requestedMode ?? 'wallet-sign-raw');
  return { ok: true, reason: null, pre, mode, bindingHash };
}

function requireProvider() {
  const p = getProvider();
  if (!p) throw new Error('未检测到浏览器钱包（推荐 OKX 钱包）');
  return p;
}

/** 读取钱包当前账户与链（只读方法，不触发签名） */
export async function readWalletAccountAndChain(): Promise<{ account: string | null; chainId: number | null }> {
  const p = requireProvider();
  let account: string | null = null;
  let chainId: number | null = null;
  try {
    const accounts = (await p.request({ method: 'eth_accounts' })) as string[];
    account = accounts && accounts[0] ? accounts[0] : null;
  } catch { account = null; }
  try {
    chainId = parseInt((await p.request({ method: 'eth_chainId' })) as string, 16);
  } catch { chainId = null; }
  return { account, chainId };
}

/** 校验通过后才向钱包发起请求；from 与 Gas 参数均为显式传入 */
async function guardAndPrepare(pre: SignPreconditions, tx: WalletTx) {
  // 第一道：完全不接触钱包（缺 from / 缺 Gas / 链 ID 不符 → 连只读查询都不发起）
  const staticReason = validateSigningStatic(pre, tx);
  if (staticReason) throw new Error(staticReason);
  const { account, chainId } = await readWalletAccountAndChain();
  assertSigningRequest({ pre, tx, walletAccount: account, walletChainId: chainId });
  return { account: account as string, chainId: chainId as number };
}

/**
 * 方式一：钱包**只签名**（不广播）→ 返回原始交易，交由后端核对后广播。
 * 不支持该方法的钱包会返回错误码 -32601，请改用「钱包内确认并广播」。
 */
export async function signTransactionOnly(pre: SignPreconditions, tx: WalletTx): Promise<string> {
  await guardAndPrepare(pre, tx);
  const provider = requireProvider();
  try {
    const raw = (await provider.request({
      method: 'eth_signTransaction',
      params: [{
        from: tx.from,
        to: tx.to,
        value: `0x${BigInt(tx.value).toString(16)}`,
        data: tx.data,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        chainId: `0x${tx.chainId.toString(16)}`,
      }],
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
 * 注意：此方式先广播、后核对，内容错误无法撤回；首笔实盘建议只使用方式一。
 */
export async function sendViaWallet(pre: SignPreconditions, tx: WalletTx): Promise<string> {
  await guardAndPrepare(pre, tx);
  const provider = requireProvider();
  const hash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: tx.from,
      to: tx.to,
      value: `0x${BigInt(tx.value).toString(16)}`,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    }],
  })) as string;
  if (!hash) throw new Error('钱包未返回交易哈希');
  return hash;
}
