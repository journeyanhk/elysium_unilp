# M2 — PositionManager 行为级对照报告

生成时间：2026-11-10T02:12:48.169Z

> 本报告只做只读对照（eth_getCode / eth_call），不发送任何交易；结论用于决定 PositionManager 是否可以从「仅只读」推进到 M3 写操作评估。

## 1. 字节码对照

| 部署 | 地址 | 体积(B) | solc | 元数据(B) | 选择器数 |
|---|---|---|---|---|---|
| Elysium PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | 19965 | 0.8.26 | 10 | 37 |
| 官方 PositionManager（ETH） | `0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e` | 23877 | 0.8.26 | 10 | 37 |
| 官方 PositionManager（Base） | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` | 23877 | 0.8.26 | 10 | 37 |

## 2. 函数选择器集合差集

**Elysium vs Ethereum**：共有 37，仅 Elysium 0，仅 Ethereum 0

**Elysium vs Base**：共有 37，仅 Elysium 0，仅 Base 0

## 3. 只读行为对照（同一 calldata）

| 调用 | Elysium | Ethereum | Base |
|---|---|---|---|
| ownerOf(不存在) | revert `0x08c379a0` | revert `0x08c379a0` | revert `0x08c379a0` |
| getPoolAndPositionInfo(不存在) | ok `0x0000000000000000…` | ok `0x0000000000000000…` | ok `0x0000000000000000…` |
| getPositionLiquidity(不存在) | ok `0x0000000000000000…` | ok `0x0000000000000000…` | ok `0x0000000000000000…` |
| nextTokenId() | ok `0x0000000000000000…` | ok `0x0000000000000000…` | ok `0x0000000000000000…` |
| permit2() | ok `0x0000000000000000…` | ok `0x0000000000000000…` | ok `0x0000000000000000…` |
| poolManager() | ok `0x0000000000000000…` | ok `0x0000000000000000…` | ok `0x0000000000000000…` |
| modifyLiquidities(空 actions) | revert `0x3b99b53d` | revert `0x3b99b53d` | revert `0x3b99b53d` |
| modifyLiquidities(未知 action) | revert `0x3b99b53d` | revert `0x3b99b53d` | revert `0x3b99b53d` |
| multicall(bytes[]) | revert `0x38bbd576` | revert `0x38bbd576` | revert `0x38bbd576` |

## 4. 不变量

- ✅ permit2() 返回值一致（三链）：`{"Elysium":"0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3","Ethereum":"0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3","Base":"0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3"}`

## 5. 结论与边界

- 选择器集合与只读行为（含 revert 错误选择器）用于判断「接口面 + 错误语义」是否一致；
- **体积差异与内部实现（存储布局、事件发射顺序、gas 消耗）仍无法通过只读手段完全证明等价**；
- 因此 PositionManager 在 M3 前保持 `pending-official` + `writeEnabled=false`；
- M3 首次真实操作仍需：小额、手动签名、单步确认、可撤销、保留滑点上限与失败保护。

## 附录：原始数据（JSON）

```json
{
 "targets": [
  {
   "name": "Elysium",
   "pm": "0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518",
   "size": 19965,
   "solc": "0.8.26",
   "selectorCount": 37
  },
  {
   "name": "Ethereum",
   "pm": "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
   "size": 23877,
   "solc": "0.8.26",
   "selectorCount": 37
  },
  {
   "name": "Base",
   "pm": "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
   "size": 23877,
   "solc": "0.8.26",
   "selectorCount": 37
  }
 ],
 "diffs": {
  "vsEthereum": {
   "onlyElysium": [],
   "onlyOther": [],
   "common": 37
  },
  "vsBase": {
   "onlyElysium": [],
   "onlyOther": [],
   "common": 37
  }
 },
 "probes": [
  {
   "name": "ownerOf(不存在)",
   "results": {
    "Elysium": {
     "outcome": "revert",
     "selector": "0x08c379a0",
     "message": "execution reverted: NOT_MINTED"
    },
    "Ethereum": {
     "outcome": "revert",
     "selector": "0x08c379a0",
     "message": "execution reverted: NOT_MINTED"
    },
    "Base": {
     "outcome": "revert",
     "selector": "0x08c379a0",
     "message": "execution reverted: NOT_MINTED"
    }
   }
  },
  {
   "name": "getPoolAndPositionInfo(不存在)",
   "results": {
    "Elysium": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
     "resultLen": 386
    },
    "Ethereum": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
     "resultLen": 386
    },
    "Base": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
     "resultLen": 386
    }
   }
  },
  {
   "name": "getPositionLiquidity(不存在)",
   "results": {
    "Elysium": {
     "outcome": "ok",
     "result": "0x0000000000000000000000000000000000000000000000000000000000000000",
     "resultLen": 66
    },
    "Ethereum": {
     "outcome": "ok",
     "result": "0x0000000000000000000000000000000000000000000000000000000000000000",
     "resultLen": 66
    },
    "Base": {
     "outcome": "ok",
     "result": "0x0000000000000000000000000000000000000000000000000000000000000000",
     "resultLen": 66
    }
   }
  },
  {
   "name": "nextTokenId()",
   "results": {
    "Elysium": {
     "outcome": "ok",
     "result": "0x0000000000000000000000000000000000000000000000000000000000001641",
     "resultLen": 66
    },
    "Ethereum": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000000000000000000000000000007b659",
     "resultLen": 66
    },
    "Base": {
     "outcome": "ok",
     "result": "0x0000000000000000000000000000000000000000000000000000000000310074",
     "resultLen": 66
    }
   }
  },
  {
   "name": "permit2()",
   "results": {
    "Elysium": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3",
     "resultLen": 66
    },
    "Ethereum": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3",
     "resultLen": 66
    },
    "Base": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3",
     "resultLen": 66
    }
   }
  },
  {
   "name": "poolManager()",
   "results": {
    "Elysium": {
     "outcome": "ok",
     "result": "0x000000000000000000000000e2e105d3f7209a9da11f83ccf3e7398a753823f1",
     "resultLen": 66
    },
    "Ethereum": {
     "outcome": "ok",
     "result": "0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90",
     "resultLen": 66
    },
    "Base": {
     "outcome": "ok",
     "result": "0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b",
     "resultLen": 66
    }
   }
  },
  {
   "name": "modifyLiquidities(空 actions)",
   "results": {
    "Elysium": {
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "message": "execution reverted"
    },
    "Ethereum": {
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "message": "execution reverted"
    },
    "Base": {
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "message": "execution reverted"
    }
   }
  },
  {
   "name": "modifyLiquidities(未知 action)",
   "results": {
    "Elysium": {
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "message": "execution reverted"
    },
    "Ethereum": {
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "message": "execution reverted"
    },
    "Base": {
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "message": "execution reverted"
    }
   }
  },
  {
   "name": "multicall(bytes[])",
   "results": {
    "Elysium": {
     "outcome": "revert",
     "selector": "0x38bbd576",
     "message": "execution reverted"
    },
    "Ethereum": {
     "outcome": "revert",
     "selector": "0x38bbd576",
     "message": "execution reverted"
    },
    "Base": {
     "outcome": "revert",
     "selector": "0x38bbd576",
     "message": "execution reverted"
    }
   }
  }
 ],
 "invariants": [
  {
   "name": "permit2() 返回值一致（三链）",
   "pass": true,
   "values": {
    "Elysium": "0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3",
    "Ethereum": "0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3",
    "Base": "0x000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3"
   }
  }
 ]
}
```