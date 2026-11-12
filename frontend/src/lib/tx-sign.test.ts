/**
 * M3.3 前端签名拦截测试（review P0-1 / P0-2）。
 *
 * 运行：cd frontend && bun test
 * 重点：任何校验不通过都**不得**调用钱包方法（用假钱包统计调用次数）。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { evaluateFreshSignGate, sendViaWallet, signTransactionOnly, validateSigningRequest, validateSigningStatic } from './tx-sign';
import type { SignPreconditions, WalletTx } from './tx-sign';

const ACCOUNT = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';
const OTHER = '0x1111111111111111111111111111111111111111';
const PM = '0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518';

type Call = { method: string; params?: unknown };
const calls: Call[] = [];
let accounts: string[] = [ACCOUNT];
let chainIdHex = '0x1863D';

const fakeProvider = {
  request: async (args: { method: string; params?: unknown }) => {
    calls.push({ method: args.method, params: args.params });
    if (args.method === 'eth_accounts') return accounts;
    if (args.method === 'eth_chainId') return chainIdHex;
    if (args.method === 'eth_signTransaction') return '0x02f870018080';
    if (args.method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
    throw new Error(`未预期的方法：${args.method}`);
  },
};

// 安装假钱包（getProvider 读取 window.okxwallet / window.ethereum）
(globalThis as unknown as { window: unknown }).window = { ethereum: fakeProvider };

const OPEN: SignPreconditions = { gateEnabled: true, unlockPath: 'user-informed-acceptance', killSwitchTripped: false, authorizationConsumed: true };

function tx(over: Partial<WalletTx> = {}): WalletTx {
  return {
    from: ACCOUNT, to: PM, value: '0', data: '0xdd46508f' + '11'.repeat(32), chainId: 99901,
    gas: '0xc350', maxFeePerGas: '0x1dcd6500', maxPriorityFeePerGas: '0x1dcd6500', ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  accounts = [ACCOUNT];
  chainIdHex = '0x1863D';
});

describe('P0-1 发送方绑定', () => {
  test('from 缺失 → 拒绝，且不弹钱包', async () => {
    await expect(signTransactionOnly(OPEN, tx({ from: '' }))).rejects.toThrow(/缺少发送方/);
    expect(calls.length).toBe(0);
  });

  test('from 与钱包当前账户不同 → 拒绝，且不请求签名', async () => {
    await expect(signTransactionOnly(OPEN, tx({ from: OTHER }))).rejects.toThrow(/不一致/);
    expect(calls.some((c) => c.method === 'eth_signTransaction')).toBe(false);
    expect(calls.every((c) => ['eth_accounts', 'eth_chainId'].includes(c.method))).toBe(true);
  });

  test('from 大小写差异 → 正常通过（统一小写比较）', () => {
    const reason = validateSigningRequest({ pre: OPEN, tx: tx({ from: ACCOUNT.toUpperCase().replace('0X', '0x') }), walletAccount: ACCOUNT.toLowerCase(), walletChainId: 99901 });
    expect(reason).toBe('');
  });

  test('签名恢复地址与 intent 用户不一致 → 后端拒绝（见 backend tests：SENDER_MISMATCH）', () => {
    // 前端只能保证「请求里写明了 from」；最终以签名恢复结果为准（后端二次校验）
    expect(validateSigningRequest({ pre: OPEN, tx: tx(), walletAccount: ACCOUNT, walletChainId: 99901 })).toBe('');
  });

  test('chainId 不是 99901 / 钱包链不一致 → 拒绝，且不请求签名', async () => {
    await expect(signTransactionOnly(OPEN, tx({ chainId: 1 }))).rejects.toThrow(/Elysium/);
    expect(calls.length).toBe(0); // 链 ID 不符在第一道校验就被拦下：不接触钱包
    chainIdHex = '0x1';
    await expect(signTransactionOnly(OPEN, tx())).rejects.toThrow(/钱包当前链/);
    expect(calls.length).toBeGreaterThan(0); // 只读查询允许，但不含任何签名方法
    expect(calls.every((c) => ['eth_accounts', 'eth_chainId'].includes(c.method))).toBe(true);
  });

  test('签名请求显式携带 from（不是 undefined）', async () => {
    const raw = await signTransactionOnly(OPEN, tx());
    expect(raw).toBe('0x02f870018080');
    const signCall = calls.find((c) => c.method === 'eth_signTransaction');
    expect(signCall).toBeTruthy();
    const param = (signCall?.params as Array<Record<string, unknown>>)[0];
    expect(param.from).toBe(ACCOUNT);
    expect(param.to).toBe(PM);
  });
});

describe('P0-2 Gas 参数绑定', () => {
  test('Gas 参数缺失 → 拒绝，且不弹钱包', async () => {
    for (const bad of [{ gas: '' }, { maxFeePerGas: '' }, { maxPriorityFeePerGas: '' }] as Array<Partial<WalletTx>>) {
      calls.length = 0;
      await expect(signTransactionOnly(OPEN, tx(bad))).rejects.toThrow(/Gas 参数/);
      expect(calls.length).toBe(0); // 第一道校验：连只读查询都不发起
    }
  });

  test('签名请求显式携带 gas / maxFeePerGas / maxPriorityFeePerGas', async () => {
    await signTransactionOnly(OPEN, tx());
    const param = (calls.find((c) => c.method === 'eth_signTransaction')?.params as Array<Record<string, unknown>>)[0];
    expect(param.gas).toBe('0xc350');
    expect(param.maxFeePerGas).toBe('0x1dcd6500');
    expect(param.maxPriorityFeePerGas).toBe('0x1dcd6500');
  });

  test('钱包自行广播路径同样显式携带 Gas 参数与 from', async () => {
    const hash = await sendViaWallet(OPEN, tx());
    expect(hash).toBe('0x' + 'ab'.repeat(32));
    const param = (calls.find((c) => c.method === 'eth_sendTransaction')?.params as Array<Record<string, unknown>>)[0];
    expect(param.from).toBe(ACCOUNT);
    expect(param.gas).toBe('0xc350');
    expect(param.maxFeePerGas).toBe('0x1dcd6500');
  });
});

describe('P0-1（第二轮）签名前必须重新读取服务端状态', () => {
  const freshGate = { enabled: true, unlockPath: 'user-informed-acceptance', killSwitchTripped: false, stateUnavailable: false, firstTxMode: true };
  const freshAuth = { status: 'consumed', bindingHash: '0x' + 'aa'.repeat(32), consumedAt: new Date().toISOString(), consumeAgeSec: 10, maxConsumeAgeSec: 180 };
  const freshPre = { ok: true, reason: null, bindingHash: '0x' + 'aa'.repeat(32) };

  test('全部新鲜且一致 → 允许签名', () => {
    const v = evaluateFreshSignGate({ gate: freshGate, authorization: freshAuth, preSign: freshPre, expectedBindingHash: freshAuth.bindingHash });
    expect(v.ok).toBe(true);
    expect(v.pre.authorizationConsumed).toBe(true);
  });

  test('页面旧状态显示未熔断，但服务端最新状态已熔断 → 拒绝', () => {
    const v = evaluateFreshSignGate({ gate: { ...freshGate, killSwitchTripped: true }, authorization: freshAuth, preSign: freshPre });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/熔断/);
  });

  test('门禁状态读取失败（null / 不可读）→ 拒绝', () => {
    expect(evaluateFreshSignGate({ gate: null, authorization: freshAuth, preSign: freshPre }).ok).toBe(false);
    expect(evaluateFreshSignGate({ gate: { ...freshGate, stateUnavailable: true }, authorization: freshAuth, preSign: freshPre }).reason).toMatch(/不可读/);
    expect(evaluateFreshSignGate({ gate: { ...freshGate, enabled: false }, authorization: freshAuth, preSign: freshPre }).reason).toMatch(/门禁关闭/);
  });

  test('页面旧状态显示已消费，但服务端授权已失效 / 未消费 → 拒绝', () => {
    expect(evaluateFreshSignGate({ gate: freshGate, authorization: null, preSign: freshPre }).reason).toMatch(/没有授权记录/);
    expect(evaluateFreshSignGate({ gate: freshGate, authorization: { ...freshAuth, status: 'authorized' }, preSign: freshPre }).reason).toMatch(/未完成一次性消费/);
    expect(evaluateFreshSignGate({ gate: freshGate, authorization: { ...freshAuth, consumeAgeSec: 400 }, preSign: freshPre }).reason).toMatch(/重新走完整流程/);
    expect(evaluateFreshSignGate({ gate: freshGate, authorization: { ...freshAuth, consumeAgeSec: null }, preSign: freshPre }).reason).toMatch(/消费时间缺失/);
  });

  test('pre-sign-check 重新失败 → 拒绝', () => {
    const v = evaluateFreshSignGate({ gate: freshGate, authorization: freshAuth, preSign: { ok: false, reason: '交易内容与授权绑定不一致' } });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/签名前核对未通过/);
    expect(evaluateFreshSignGate({ gate: freshGate, authorization: freshAuth, preSign: null }).ok).toBe(false);
  });

  test('服务端绑定哈希与本地记录不一致（状态已变化）→ 拒绝', () => {
    const v = evaluateFreshSignGate({ gate: freshGate, authorization: freshAuth, preSign: freshPre, expectedBindingHash: '0x' + 'bb'.repeat(32) });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/不一致/);
  });

  test('签名载荷 / 快照 / 授权 三处绑定哈希必须一致（观察项 2）', () => {
    const H = '0x' + 'aa'.repeat(32);
    const okV = evaluateFreshSignGate({
      gate: freshGate, authorization: freshAuth, preSign: freshPre,
      signing: { bindingHash: H }, snapshotBindingHash: H,
    });
    expect(okV.ok).toBe(true);
    expect(okV.bindingHash).toBe(H);
    const bad = evaluateFreshSignGate({
      gate: freshGate, authorization: freshAuth, preSign: freshPre,
      signing: { bindingHash: '0x' + 'cc'.repeat(32) }, snapshotBindingHash: H,
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/绑定哈希不一致/);
  });

  test('签名请求显式声明 type=0x2（不允许钱包降级为 legacy）', async () => {
    await signTransactionOnly(OPEN, tx());
    const call = calls.find((c) => c.method === 'eth_signTransaction');
    expect(call).toBeDefined();
    const params = (call!.params as Record<string, unknown>[])[0];
    expect(params.type).toBe('0x2');
    expect(params.from).toBe(ACCOUNT);
    expect(params.maxFeePerGas).toBe('0x1dcd6500');
    expect(params.gas).toBe('0xc350');
    // 方式二（钱包广播）同样显式声明类型
    await sendViaWallet(OPEN, tx());
    const send = calls.find((c) => c.method === 'eth_sendTransaction');
    expect((send!.params as Record<string, unknown>[])[0].type).toBe('0x2');
  });

  test('首笔模式：强制 wallet-sign-raw（wallet-sent 被禁用）', () => {
    const v = evaluateFreshSignGate({ gate: freshGate, authorization: freshAuth, preSign: freshPre, requestedMode: 'wallet-sent' });
    expect(v.ok).toBe(true);
    expect(v.mode).toBe('wallet-sign-raw');
    const v2 = evaluateFreshSignGate({ gate: { ...freshGate, firstTxMode: false }, authorization: freshAuth, preSign: freshPre, requestedMode: 'wallet-sent' });
    expect(v2.mode).toBe('wallet-sent');
  });

  test('钱包账户在页面加载后切换 / 钱包链改变 → 拒绝（第二道校验）', () => {
    // 页面记录的 from 是旧账户，钱包当前账户已切换
    expect(validateSigningRequest({ pre: { ...OPEN }, tx: tx({ from: OTHER }), walletAccount: ACCOUNT, walletChainId: 99901 })).toMatch(/不一致/);
    // 钱包链被切换
    expect(validateSigningRequest({ pre: { ...OPEN }, tx: tx(), walletAccount: ACCOUNT, walletChainId: 1 })).toMatch(/钱包当前链/);
  });
});

describe('门禁前置条件（不通过则不弹钱包）', () => {
  test('门禁关闭 / 无解锁记录 / 熔断未知 / 未消费授权 → 一律拒绝且不调用钱包', async () => {
    const cases: Array<Partial<SignPreconditions>> = [
      { gateEnabled: false },
      { unlockPath: null },
      { killSwitchTripped: null },
      { killSwitchTripped: true },
      { authorizationConsumed: false },
    ];
    for (const c of cases) {
      calls.length = 0;
      await expect(signTransactionOnly({ ...OPEN, ...c }, tx())).rejects.toThrow(/不会向钱包发起任何签名请求/);
      expect(calls.length).toBe(0);
    }
  });

  test('未连接钱包账户 → 拒绝', async () => {
    accounts = [];
    await expect(signTransactionOnly(OPEN, tx())).rejects.toThrow(/未连接钱包账户/);
    expect(calls.every((c) => c.method !== 'eth_signTransaction')).toBe(true);
  });

  test('第一道校验为纯函数：缺 from / 缺 Gas / 链 ID 不符 均不接触钱包', () => {
    expect(validateSigningStatic(OPEN, tx({ from: '' }))).toMatch(/缺少发送方/);
    expect(validateSigningStatic(OPEN, tx({ gas: '' }))).toMatch(/Gas 参数/);
    expect(validateSigningStatic(OPEN, tx({ chainId: 1 }))).toMatch(/Elysium/);
    expect(validateSigningStatic({ ...OPEN, gateEnabled: false }, tx())).toMatch(/门禁关闭/);
    expect(validateSigningStatic(OPEN, tx())).toBe('');
  });
});

describe('静态检查：面板签名前必须重新读取服务端状态', () => {
  test('doSign 内先做新鲜状态核对，再调用钱包签名方法', () => {
    const src = require('node:fs').readFileSync(new URL('../components/SignBroadcastPanel.tsx', import.meta.url), 'utf8');
    const start = src.indexOf('async function doSign()');
    const body = src.slice(start, src.indexOf('async function doReceipt()'));
    const iFresh = body.indexOf('fetchFreshSignState(');
    const iGate = body.indexOf('evaluateFreshSignGate(');
    const iSign = body.indexOf('signTransactionOnly(');
    const iSend = body.indexOf('sendViaWallet(');
    expect(iFresh).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iFresh);
    expect(iSign).toBeGreaterThan(iGate);
    expect(iSend).toBeGreaterThan(iGate);
    // 拒绝路径必须 return（不弹钱包）
    expect(body).toMatch(/if \(!verdict\.ok[\s\S]{0,400}?return;/);
    // 签名载荷必须来自服务端返回的 signing，而不是页面状态
    expect(body).toMatch(/audit\.signing/);
  });

  test('首笔模式下 wallet-sent 选项被禁用（服务端同时强制）', () => {
    const src = require('node:fs').readFileSync(new URL('../components/SignBroadcastPanel.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/disabled=\{gate\?\.firstTxMode === true\}/);
    const bc = require('node:fs').readFileSync(new URL('../../../backend/lib/tx-broadcast.js', import.meta.url), 'utf8');
    expect(bc).toMatch(/MODE_DISABLED_IN_FIRST_TX/);
  });
});
