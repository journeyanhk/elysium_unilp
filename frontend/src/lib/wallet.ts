/**
 * 钱包连接（只读用途，M1）：
 * - 只做 eth_requestAccounts / eth_chainId / wallet_switchEthereumChain
 * - 不发起任何签名（不调用 personal_sign / eth_signTypedData / eth_sendTransaction）
 * - 也可以完全不连钱包：直接粘贴地址进入「观察模式」
 */

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { isOkxWallet?: boolean; isMetaMask?: boolean };
    okxwallet?: { ethereum?: Eip1193Provider };
  }
}

export const ELYSIUM_CHAIN_ID = 99901;
export const ELYSIUM_CHAIN_ID_HEX = '0x1863D';

export function getProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  return window.okxwallet?.ethereum ?? window.ethereum ?? null;
}

export function getProviderName(): string {
  if (typeof window === 'undefined') return '';
  if (window.okxwallet?.ethereum) return 'OKX Wallet';
  const eth = window.ethereum;
  if (eth?.isOkxWallet) return 'OKX Wallet';
  if (eth?.isMetaMask) return 'MetaMask';
  return eth ? '浏览器钱包' : '';
}

export async function connectWallet(): Promise<{ address: string; chainId: number | null }> {
  const p = getProvider();
  if (!p) throw new Error('未检测到浏览器钱包（推荐安装 OKX 钱包，或直接粘贴地址使用观察模式）');
  const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts || !accounts[0]) throw new Error('钱包未返回地址');
  let chainId: number | null = null;
  try {
    chainId = parseInt((await p.request({ method: 'eth_chainId' })) as string, 16);
  } catch { /* 忽略 */ }
  return { address: accounts[0], chainId };
}

export async function getWalletChainId(): Promise<number | null> {
  const p = getProvider();
  if (!p) return null;
  try {
    return parseInt((await p.request({ method: 'eth_chainId' })) as string, 16);
  } catch {
    return null;
  }
}

/** 请求钱包切换到 Elysium（只弹网络切换确认，不是签名） */
export async function switchToElysium(): Promise<void> {
  const p = getProvider();
  if (!p) throw new Error('未检测到浏览器钱包');
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ELYSIUM_CHAIN_ID_HEX }] });
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (code === 4902 || code === -32603) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: ELYSIUM_CHAIN_ID_HEX,
          chainName: 'Elysium',
          nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
          rpcUrls: ['https://rpc.elysium.kinetiq.xyz'],
        }],
      });
    } else {
      throw e;
    }
  }
}

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
