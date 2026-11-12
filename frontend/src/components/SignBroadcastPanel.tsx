/**
 * M3.3 手动签名与广播面板 —— 逐笔人工确认，无任何自动化。
 *
 * 当前状态：门禁关闭（M3.2 未解锁）→ 授权 / 签名 / 广播 / 回执 步骤全部禁用，
 * 界面上会明确说明「不会向钱包发起任何签名请求」。
 * 面板本身不构造交易、不改 Gas、不改滑点：所有交易字段都来自后端 /api/tx/build。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { getProviderName, getWalletChainId, switchToElysium } from '../lib/wallet';
import { assertSigningAllowed, sendViaWallet, signTransactionOnly, signingBlockedReason } from '../lib/tx-sign';
import type { SignPreconditions } from '../lib/tx-sign';

type GateResp = {
  gate: {
    version: string; enabled: boolean; unlockPath: string | null; firstTxMode: boolean;
    killSwitchTripped: boolean | null; killSwitchReason?: string | null; stateUnavailable: boolean;
    limits: Record<string, number | boolean>;
    forbidden: string[];
  };
};

type Step = { key: string; title: string; detail: string; state: 'idle' | 'ok' | 'fail' | 'blocked' };

const j = (r: Response) => r.json();

function Btn({ children, onClick, disabled, tone = 'default' }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; tone?: 'default' | 'primary' | 'danger' }) {
  const base = 'rounded-md border px-3 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
  const tones = {
    default: 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800',
    primary: 'border-emerald-600/50 bg-emerald-600/15 text-emerald-200 hover:bg-emerald-600/25',
    danger: 'border-rose-600/50 bg-rose-600/15 text-rose-200 hover:bg-rose-600/25',
  } as const;
  return (
    <button type="button" className={`${base} ${tones[tone]}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export default function SignBroadcastPanel({ address, chainId }: { address: string; chainId: number | null }) {
  const gateQ = useQuery<GateResp>({ queryKey: ['tx-gate'], queryFn: () => fetch(api('tx/gate')).then(j), refetchInterval: 15000 });
  const poolQ = useQuery<{ pool: { tick: number; impliedKntqUsd: number } }>({ queryKey: ['pool-min'], queryFn: () => fetch(api('pool')).then(j), staleTime: 30000 });

  const [busy, setBusy] = useState('');
  const [log, setLog] = useState<{ at: string; text: string; kind: 'info' | 'ok' | 'err' }[]>([]);
  const [intent, setIntent] = useState<Record<string, unknown> | null>(null);
  const [intentId, setIntentId] = useState<number | null>(null);
  const [simulation, setSimulation] = useState<Record<string, unknown> | null>(null);
  const [gasPlan, setGasPlan] = useState<{ gasLimit: number; maxFeePerGasWei: string; maxPriorityFeePerGasWei: string; gasUsd: number } | null>(null);
  const [gasPlanError, setGasPlanError] = useState<{ code: string; reason: string } | null>(null);
  const [authorization, setAuthorization] = useState<{ authorizationId: number; bindingHash: string } | null>(null);
  const [preSign, setPreSign] = useState<Record<string, unknown> | null>(null);
  const [consumed, setConsumed] = useState<{ authorizationId: number; bindingHash: string; consumedAt: string } | null>(null);
  const [broadcast, setBroadcast] = useState<{ broadcastId: number; txHash: string; mode: string } | null>(null);
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);

  // 交易参数（首笔小额验证用；数值为链上原始单位，不做任何自动换算）
  const [kind, setKind] = useState<'approve' | 'permit2-approve' | 'mint' | 'collect' | 'remove'>('approve');
  const [amountUsd, setAmountUsd] = useState('5');
  const [tokenKey, setTokenKey] = useState('KNTQ');
  const [amountRaw, setAmountRaw] = useState('');
  const [tickLower, setTickLower] = useState('');
  const [tickUpper, setTickUpper] = useState('');
  const [liquidity, setLiquidity] = useState('');
  const [amount0Max, setAmount0Max] = useState('');
  const [amount1Max, setAmount1Max] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [signMode, setSignMode] = useState<'wallet-sign-raw' | 'wallet-sent'>('wallet-sign-raw');

  const tick = poolQ.data?.pool?.tick ?? null;
  const spacing = 200;
  const prefill = useMemo(() => {
    if (tick == null) return null;
    const lower = Math.floor((tick - 2000) / spacing) * spacing;
    return { lower, upper: lower + 4000 };
  }, [tick]);

  const gate = gateQ.data?.gate;
  const gateClosed = !gate?.enabled;
  const pre: SignPreconditions = {
    gateEnabled: Boolean(gate?.enabled),
    unlockPath: gate?.unlockPath ?? null,
    killSwitchTripped: gate ? gate.killSwitchTripped : null,
    authorizationConsumed: Boolean(consumed),
  };
  const blocked = signingBlockedReason(pre);

  function note(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
    setLog((l) => [{ at: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 40));
  }

  async function call(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const r = await fetch(api(`tx/${path}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      const ok = r.ok && data?.ok !== false;
      note(`${label}：${ok ? '成功' : `被拒绝（${data.code || data.error || r.status}）`}${data.reason ? ` — ${data.reason}` : ''}`, ok ? 'ok' : 'err');
      return { status: r.status, data };
    } catch (e) {
      note(`${label}：请求失败 — ${String((e as Error).message)}`, 'err');
      return { status: 0, data: null as Record<string, unknown> | null };
    } finally {
      setBusy('');
    }
  }

  async function doBuild() {
    const body: Record<string, unknown> = { type: kind, user: address, amountUsd: Number(amountUsd) || null };
    if (kind === 'approve') body.approve = { tokenKey, spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3', amountRaw: amountRaw || '0' };
    if (kind === 'permit2-approve') body.permit2 = { tokenKey, amountRaw: amountRaw || '0' };
    if (kind === 'mint') body.mint = { tickLower: Number(tickLower || prefill?.lower), tickUpper: Number(tickUpper || prefill?.upper), liquidity: liquidity || '0', amount0Max: amount0Max || '0', amount1Max: amount1Max || '0' };
    if (kind === 'collect') body.collect = { tokenId: tokenId || '0' };
    if (kind === 'remove') body.remove = { tokenId: tokenId || '0', liquidity: liquidity || '0' };
    const { data } = await call('build', body, '构造交易');
    if (data?.intentId) {
      setIntentId(data.intentId as number);
      setIntent((data.intent as Record<string, unknown>) ?? null);
      setSimulation(null); setGasPlan(null); setGasPlanError(null);
      setAuthorization(null); setPreSign(null); setConsumed(null); setBroadcast(null); setReceipt(null);
    }
  }

  async function doSimulate() {
    if (!intentId) return;
    const { data } = await call('simulate', { intentId, user: address }, '只读预演');
    if (data?.simulation) setSimulation(data.simulation as Record<string, unknown>);
    setGasPlan((data?.gasPlan as typeof gasPlan) ?? null);
    setGasPlanError((data?.simulation as Record<string, unknown>)?.gasPlanError as typeof gasPlanError ?? null);
  }

  async function doAuthorize() {
    if (!intentId) return;
    const { data } = await call('authorize', { intentId, hasMinOut: true }, '授权');
    if (data?.ok) setAuthorization({ authorizationId: data.authorizationId as number, bindingHash: data.bindingHash as string });
  }

  async function doPreSignCheck() {
    if (!intentId) return;
    const { data } = await call('pre-sign-check', { intentId, calldata: intent?.calldata, to: intent?.targetContract, value: '0' }, '签名前核对');
    setPreSign(data);
  }

  async function doConsume() {
    if (!intentId) return;
    const { data } = await call('consume-authorization', { intentId, calldata: intent?.calldata, to: intent?.targetContract, value: '0', actor: address }, '一次性消费授权');
    if (data?.ok) setConsumed({ authorizationId: data.authorizationId as number, bindingHash: data.bindingHash as string, consumedAt: String(data.consumedAt) });
  }

  async function doSign() {
    if (!intentId || !intent) return;
    try {
      assertSigningAllowed(pre);
    } catch (e) {
      note(String((e as Error).message), 'err');
      return;
    }
    if (!gasPlan) {
      note('缺少预演锁定的 Gas 参数（请先完成第 2 步预演，且预演必须生成 Gas 计划）——拒绝签名', 'err');
      return;
    }
    // from 与 Gas 参数全部显式传入：钱包不得自行决定账户或 Gas
    const tx = {
      from: address,
      to: String(intent.targetContract),
      value: '0',
      data: String(intent.calldata),
      chainId: Number(intent.chainId),
      gas: `0x${BigInt(gasPlan.gasLimit).toString(16)}`,
      maxFeePerGas: `0x${BigInt(gasPlan.maxFeePerGasWei).toString(16)}`,
      maxPriorityFeePerGas: `0x${BigInt(gasPlan.maxPriorityFeePerGasWei).toString(16)}`,
    };
    setBusy('钱包签名');
    try {
      if (signMode === 'wallet-sign-raw') {
        const rawTx = await signTransactionOnly(pre, tx);
        note(`钱包已签名（未广播）：${rawTx.slice(0, 20)}…，交由后端核对后广播`, 'ok');
        setBusy('');
        const { data } = await call('broadcast', { intentId, mode: 'wallet-sign-raw', rawTx, calldata: intent.calldata, to: intent.targetContract, value: '0' }, '后端核对并广播');
        if (data?.ok) setBroadcast({ broadcastId: data.broadcastId as number, txHash: data.txHash as string, mode: 'wallet-sign-raw' });
      } else {
        const txHash = await sendViaWallet(pre, tx);
        note(`钱包已广播：${txHash}`, 'ok');
        setBusy('');
        const { data } = await call('broadcast', { intentId, mode: 'wallet-sent', txHash, calldata: intent.calldata, to: intent.targetContract, value: '0' }, '后端事后核对');
        if (data?.ok) setBroadcast({ broadcastId: data.broadcastId as number, txHash, mode: 'wallet-sent' });
      }
    } catch (e) {
      note(`签名/广播失败：${String((e as Error).message)}（不会自动重试）`, 'err');
    } finally {
      setBusy('');
    }
  }

  async function doReceipt() {
    if (!broadcast) return;
    const { data } = await call('receipt', { broadcastId: broadcast.broadcastId }, '回执核对');
    if (data) setReceipt(data);
  }

  const steps: Step[] = [
    { key: 'build', title: '1. 构造交易', detail: intentId ? `intent #${intentId}` : '未构造', state: intentId ? 'ok' : 'idle' },
    { key: 'sim', title: '2. 只读预演', detail: simulation ? (simulation.ethCallOk ? 'eth_call 通过' : 'eth_call 回滚（预期）') : '未预演', state: simulation ? 'ok' : 'idle' },
    { key: 'auth', title: '3. 门禁授权', detail: authorization ? `授权 #${authorization.authorizationId}` : '未授权', state: authorization ? 'ok' : (gateClosed ? 'blocked' : 'idle') },
    { key: 'check', title: '4. 签名前核对', detail: preSign ? (preSign.ok ? '一致' : String(preSign.reason || '不一致')) : '未核对', state: preSign ? (preSign.ok ? 'ok' : 'fail') : (gateClosed ? 'blocked' : 'idle') },
    { key: 'consume', title: '5. 一次性消费授权', detail: consumed ? `已消费（${consumed.consumedAt}）` : '未消费', state: consumed ? 'ok' : (gateClosed ? 'blocked' : 'idle') },
    { key: 'sign', title: '6. 钱包手动签名', detail: consumed ? (signMode === 'wallet-sign-raw' ? '钱包只签名，不广播' : '钱包内确认并广播') : '未签名', state: broadcast ? 'ok' : (gateClosed ? 'blocked' : 'idle') },
    { key: 'receipt', title: '7. 回执核对', detail: receipt ? String(receipt.status || '') : '未核对', state: receipt ? (receipt.ok ? 'ok' : 'fail') : (gateClosed ? 'blocked' : 'idle') },
  ];

  const stateTone: Record<Step['state'], string> = {
    idle: 'border-zinc-800 text-zinc-500',
    ok: 'border-emerald-600/40 text-emerald-300',
    fail: 'border-rose-600/40 text-rose-300',
    blocked: 'border-zinc-800 text-zinc-600',
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">M3.3 手动签名与广播</h2>
          <p className="text-[11px] text-zinc-500">
            逐笔人工确认 · 无自动重发 / 无自动加速 / 无自动放宽滑点 · 不托管私钥
          </p>
        </div>
        <span className={`rounded-full border px-2 py-1 text-[11px] ${gateClosed ? 'border-amber-600/40 bg-amber-600/10 text-amber-300' : 'border-emerald-600/40 bg-emerald-600/10 text-emerald-300'}`}>
          {gateClosed ? '交易门禁关闭：不会向钱包发起任何签名请求' : `门禁已开启（${gate?.version}）`}
        </span>
      </header>

      {gate && (
        <div className="mb-3 grid gap-2 text-[11px] text-zinc-400 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 p-2">门禁版本：<span className="text-zinc-200">{gate.version}</span></div>
          <div className="rounded-lg border border-zinc-800 p-2">解锁记录：<span className="text-zinc-200">{gate.unlockPath ?? '无（不得授权/广播）'}</span></div>
          <div className="rounded-lg border border-zinc-800 p-2">熔断：<span className="text-zinc-200">{gate.killSwitchTripped === null ? '状态不可读（视为已触发）' : gate.killSwitchTripped ? '已触发' : '未触发'}</span></div>
          <div className="rounded-lg border border-zinc-800 p-2">首笔模式：<span className="text-zinc-200">{gate.firstTxMode ? '开启（≤20 USD）' : '常规'}</span></div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        {steps.map((s) => (
          <span key={s.key} className={`rounded-full border px-2 py-1 text-[11px] ${stateTone[s.state]}`}>
            {s.title} · {s.detail}
          </span>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
          <div className="text-[11px] text-zinc-400">
            钱包：<span className="text-zinc-200">{address || '未连接'}</span>
            {address && <> · {getProviderName() || '观察模式'} · 链 <span className={chainId === 99901 ? 'text-emerald-300' : 'text-amber-300'}>{chainId ?? '未知'}</span></>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={async () => { try { await switchToElysium(); note('已请求切换到 Elysium', 'ok'); } catch (e) { note(String((e as Error).message), 'err'); } }}>切换到 Elysium 链</Btn>
            <Btn onClick={async () => { const c = await getWalletChainId(); note(`钱包当前链：${c ?? '未知'}（需 99901）`, c === 99901 ? 'ok' : 'err'); }}>刷新钱包链</Btn>
          </div>
          <p className="text-[11px] text-zinc-500">交易必须由当前连接的账户签名；本面板只使用后端返回的 to / value / data，不修改任何参数。</p>
        </div>

        <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
          <div className="flex flex-wrap gap-2 text-[11px]">
            <select className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="approve">approve（ERC-20 授权）</option>
              <option value="permit2-approve">Permit2 授权</option>
              <option value="mint">组池 mint</option>
              <option value="collect">领费 collect</option>
              <option value="remove">撤池 remove</option>
            </select>
            <input className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={amountUsd} onChange={(e) => setAmountUsd(e.target.value)} placeholder="金额 USD" />
          </div>

          {(kind === 'approve' || kind === 'permit2-approve') && (
            <div className="flex flex-wrap gap-2 text-[11px]">
              <select className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={tokenKey} onChange={(e) => setTokenKey(e.target.value)}>
                <option value="KNTQ">KNTQ</option>
                <option value="WHYPE">WHYPE</option>
                <option value="USDC">USDC</option>
              </select>
              <input className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)} placeholder="授权额度（原始单位，最小够用即可）" />
            </div>
          )}

          {kind === 'mint' && (
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <input className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={tickLower} onChange={(e) => setTickLower(e.target.value)} placeholder={`tickLower（当前 tick ${tick ?? '—'}）`} />
              <input className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={tickUpper} onChange={(e) => setTickUpper(e.target.value)} placeholder="tickUpper" />
              <input className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={liquidity} onChange={(e) => setLiquidity(e.target.value)} placeholder="liquidity" />
              <input className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={amount0Max} onChange={(e) => setAmount0Max(e.target.value)} placeholder="amount0Max（KNTQ 上限）" />
              <input className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={amount1Max} onChange={(e) => setAmount1Max(e.target.value)} placeholder="amount1Max（HYPE 上限）" />
              <div className="flex items-center text-zinc-500">参考区间：{prefill ? `${prefill.lower} ~ ${prefill.upper}` : '—'}</div>
            </div>
          )}

          {(kind === 'collect' || kind === 'remove') && (
            <div className="flex flex-wrap gap-2 text-[11px]">
              <input className="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="tokenId" />
              {kind === 'remove' && <input className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1" value={liquidity} onChange={(e) => setLiquidity(e.target.value)} placeholder="撤出 liquidity" />}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Btn tone="primary" disabled={!address || !!busy} onClick={doBuild}>1 构造交易</Btn>
            <Btn disabled={!intentId || !!busy} onClick={doSimulate}>2 只读预演</Btn>
            <Btn disabled={!intentId || gateClosed || !!busy} onClick={doAuthorize}>3 门禁授权</Btn>
            <Btn disabled={!intentId || gateClosed || !!busy} onClick={doPreSignCheck}>4 签名前核对</Btn>
            <Btn disabled={!intentId || gateClosed || !!busy} onClick={doConsume}>5 消费授权</Btn>
            <Btn tone="danger" disabled={!consumed || !!busy} onClick={doSign}>6 手动签名 / 广播</Btn>
            <Btn disabled={!broadcast || !!busy} onClick={doReceipt}>7 回执核对</Btn>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
            <label className="flex items-center gap-1">
              <input type="radio" checked={signMode === 'wallet-sign-raw'} onChange={() => setSignMode('wallet-sign-raw')} />
              钱包只签名 → 后端核对后广播
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={signMode === 'wallet-sent'} onChange={() => setSignMode('wallet-sent')} />
              钱包内确认并广播 → 后端事后核对（首笔不建议：先广播后核对，无法撤回）
            </label>
          </div>

          {gasPlan && (
            <p className="text-[11px] text-zinc-400">
              已锁定 Gas：gasLimit <span className="text-zinc-200">{gasPlan.gasLimit.toLocaleString()}</span> ·
              maxFeePerGas <span className="text-zinc-200">{(Number(gasPlan.maxFeePerGasWei) / 1e9).toFixed(4)} gwei</span> ·
              maxPriorityFee <span className="text-zinc-200">{(Number(gasPlan.maxPriorityFeePerGasWei) / 1e9).toFixed(4)} gwei</span> ·
              最坏 Gas 成本 <span className="text-zinc-200">${gasPlan.gasUsd}</span>（钱包不得自行抬高）
            </p>
          )}
          {gasPlanError && <p className="text-[11px] text-rose-300">Gas 计划未生成（{gasPlanError.code}）：{gasPlanError.reason} — 无法签名</p>}
          {blocked && <p className="text-[11px] text-amber-300">当前被拦截：{blocked}</p>}
          {gate && gate.killSwitchTripped && <p className="text-[11px] text-rose-300">熔断已触发：{gate.killSwitchReason || '原因未记录'} — 需人工复核后清除。</p>}
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 p-3">
          <div className="mb-1 text-[11px] font-medium text-zinc-300">执行记录</div>
          <div className="max-h-48 space-y-1 overflow-auto text-[11px]">
            {log.length === 0 && <p className="text-zinc-600">尚无操作。</p>}
            {log.map((l, i) => (
              <p key={i} className={l.kind === 'ok' ? 'text-emerald-300' : l.kind === 'err' ? 'text-rose-300' : 'text-zinc-400'}>
                [{l.at}] {l.text}
              </p>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 p-3">
          <div className="mb-1 text-[11px] font-medium text-zinc-300">首笔实盘检查清单（人工逐项确认）</div>
          <ul className="space-y-1 text-[11px] text-zinc-400">
            <li>· 本金 5–10 USD，绝对上限 20 USD；Gas 另备 HYPE</li>
            <li>· 首笔只做：最小 approve → 最小 mint；collect / remove 另行单独执行</li>
            <li>· 每笔都重新走：构造 → 预演 → 授权 → 核对 → 消费 → 签名 → 广播 → 回执</li>
            <li>· 回执核对：status、实际 Gas、实际扣款、ModifyLiquidity、tokenId、ownerOf、余额</li>
            <li>· 任何一步失败：立即停止，人工复核（禁止自动重发）</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
