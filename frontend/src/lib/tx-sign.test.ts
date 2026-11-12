/**
 * M3.3 前端签名拦截测试（review P0-1 / P0-2）。
 *
 * 运行：cd frontend && bun test
 * 重点：任何校验不通过都**不得**调用钱包方法（用假钱包统计调用次数）。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { sendViaWallet, signTransactionOnly, validateSigningRequest, validateSigningStatic } from './tx-sign';
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
