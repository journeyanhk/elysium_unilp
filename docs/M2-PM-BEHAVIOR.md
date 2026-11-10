# M2 — PositionManager 只读行为对照报告（P0-2 重写版）

生成时间：2026-11-10T02:45:10.231Z

> 只读对照（eth_getCode / eth_call），不发送任何交易。权威选择器集合来自 **官方已部署合约的 ABI（Sourcify 验证源）**；字节码 PUSH4 扫描仅作辅助。
> 结论口径：只读手段只能证明「接口面 + 只读行为 + 错误语义」一致，**不能证明内部实现（存储布局/事件顺序/gas/写路径）等价**。

## 1. 目标与代码存在性

| 部署 | 地址 | 有代码 | 体积(B) | 代码哈希 | 扫描到的选择器数 |
|---|---|---|---|---|---|
| Elysium PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | ✅ | 19965 | `0xad189c3ce2621a5f…` | 37 |
| 官方 PositionManager（ETH） | `0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e` | ✅ | 23877 | `0x77e36c08b19959a3…` | 37 |
| 官方 PositionManager（Base） | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` | ✅ | 23877 | `0x243f9e091ddf11c7…` | 37 |

## 2. 函数选择器集合（官方 ABI vs 目标字节码）

官方 ABI 函数选择器总数：**39**

| 目标 | 官方 ABI 选择器 | 目标扫到其中 | 官方缺失 | 扫描独有(辅助) | vs 参考链差异 | 结论 |
|---|---|---|---|---|---|---|
| Elysium | 39 | 37 | 2（参考链也缺 2） | 0 | 仅本方 0 / 仅参考 0 | ✅ 一致 |
| Ethereum | 39 | 37 | 2（参考链也缺 2） | 0 | 仅本方 0 / 仅参考 0 | ✅ 一致 |
| Base | 39 | 37 | 2（参考链也缺 2） | 0 | 仅本方 0 / 仅参考 0 | ✅ 一致 |

> 说明：字节码 PUSH4 扫描是**启发式**（会把内部调用用的选择器常量一并扫出），因此「扫描独有」不是错误；真正的判据是（a）官方 ABI 的每个函数选择器都能在目标字节码中找到，（b）目标与参考链在同一启发式下的扫描差集为空。

- ❌ Elysium 缺失官方函数选择器：`0xf7020405`, `0x002a3e3a`
- ❌ Ethereum 缺失官方函数选择器：`0xf7020405`, `0x002a3e3a`
- ❌ Base 缺失官方函数选择器：`0xf7020405`, `0x002a3e3a`

## 3. 只读 Probe（解码后断言，逐项 pass/fail）

| 探测 | 分类 | 断言 | 结论 | 各链结果（解码值 / revert 选择器） |
|---|---|---|---|---|
| permit2() | same-value | equal | ✅ PASS | Elysium: 0x000000000022D473030F116dDEE9F6B43aC78BA3<br>Ethereum: 0x000000000022D473030F116dDEE9F6B43aC78BA3<br>Base: 0x000000000022D473030F116dDEE9F6B43aC78BA3 |
| ownerOf(不存在) | same-shape | revert | ✅ PASS | Elysium: revert 0x08c379a0<br>Ethereum: revert 0x08c379a0<br>Base: revert 0x08c379a0 |
| getPoolAndPositionInfo(不存在) | chain-specific | zero-shape | ✅ PASS | Elysium: {"poolKey":{"currency0":"0x0000000000000000000000000000000000000000","currency1":"0x0000000000000000000000000000000000000000","fee":0,"tickSpacing":0,"hooks":"0x0000000000000000000000000000000000000000"},"info":"0","isZeroShape":true}<br>Ethereum: {"poolKey":{"currency0":"0x0000000000000000000000000000000000000000","currency1":"0x0000000000000000000000000000000000000000","fee":0,"tickSpacing":0,"hooks":"0x0000000000000000000000000000000000000000"},"info":"0","isZeroShape":true}<br>Base: {"poolKey":{"currency0":"0x0000000000000000000000000000000000000000","currency1":"0x0000000000000000000000000000000000000000","fee":0,"tickSpacing":0,"hooks":"0x0000000000000000000000000000000000000000"},"info":"0","isZeroShape":true} |
| getPositionLiquidity(不存在) | chain-specific | zero | ✅ PASS | Elysium: 0<br>Ethereum: 0<br>Base: 0 |
| nextTokenId() | chain-specific | positive | ✅ PASS | Elysium: 5966<br>Ethereum: 505450<br>Base: 3211428 |
| poolManager() | chain-specific | has-code | ✅ PASS | Elysium: {"address":"0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1","hasCode":true}<br>Ethereum: {"address":"0x000000000004444c5dc75cB358380D2e3dE08A90","hasCode":true}<br>Base: {"address":"0x498581fF718922c3f8e6A244956aF099B2652b2b","hasCode":true} |
| modifyLiquidities(空 actions) | same-shape | revert | ✅ PASS | Elysium: revert 0x3b99b53d<br>Ethereum: revert 0x3b99b53d<br>Base: revert 0x3b99b53d |
| modifyLiquidities(未知 action) | same-shape | revert | ✅ PASS | Elysium: revert 0x3b99b53d<br>Ethereum: revert 0x3b99b53d<br>Base: revert 0x3b99b53d |
| modifyLiquidities(合法编码/头寸不存在) | same-shape | revert | ✅ PASS | Elysium: revert 0x08c379a0<br>Ethereum: revert 0x08c379a0<br>Base: revert 0x08c379a0 |
| multicall(bytes[]) | same-shape | revert | ✅ PASS | Elysium: revert 0x38bbd576<br>Ethereum: revert 0x38bbd576<br>Base: revert 0x38bbd576 |


## 4. 不变量

- ✅ permit2() 三链返回值一致：`{"Elysium":"0x000000000022D473030F116dDEE9F6B43aC78BA3","Ethereum":"0x000000000022D473030F116dDEE9F6B43aC78BA3","Base":"0x000000000022D473030F116dDEE9F6B43aC78BA3"}`

## 5. 结论（分开陈述，避免过度声明）

- 选择器集合一致（官方 ABI 权威集合）：**通过**
- 错误选择器语义一致（same-shape）：**通过**
- same-value 不变量（permit2 等）：**通过**
- chain-specific 只读函数（类型 + 目标关系）：**通过**
- 内部实现等价性：**无法由只读调用证明**（存储布局、事件顺序、gas、写路径状态变更均不在只读证明范围内）
- 因此 PositionManager 在 M3 前保持 `pending-official` + `writeEnabled=false`；写路径（mint/collect/burn）行为仍待 M3 用真实小额交易验证。

## 附录：原始数据（JSON）

```json
{
 "targets": [
  {
   "name": "Elysium",
   "label": "Elysium PositionManager",
   "pm": "0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518",
   "hasCode": true,
   "size": 19965,
   "codeHash": "0xad189c3ce2621a5f4953f3f3c08bc25f6bfb514b5b8b2ec427d23902342c94e7",
   "scannedSelectors": 37
  },
  {
   "name": "Ethereum",
   "label": "官方 PositionManager（ETH）",
   "pm": "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
   "hasCode": true,
   "size": 23877,
   "codeHash": "0x77e36c08b19959a30dde46dec9abe6208e371ff2f56884a56fe1e1a53615528b",
   "scannedSelectors": 37
  },
  {
   "name": "Base",
   "label": "官方 PositionManager（Base）",
   "pm": "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
   "hasCode": true,
   "size": 23877,
   "codeHash": "0x243f9e091ddf11c7c04e28059fdbbf1bab82b72d414fafb8e096c097aaeb622a",
   "scannedSelectors": 37
  }
 ],
 "selectorDiffs": {
  "Elysium": {
   "commonOfficial": 37,
   "missingOfficial": [
    "0xf7020405",
    "0x002a3e3a"
   ],
   "extraScanned": [],
   "vsReference": {
    "onlyTarget": [],
    "onlyReference": []
   },
   "ok": true
  },
  "Ethereum": {
   "commonOfficial": 37,
   "missingOfficial": [
    "0xf7020405",
    "0x002a3e3a"
   ],
   "extraScanned": [],
   "vsReference": {
    "onlyTarget": [],
    "onlyReference": []
   },
   "ok": true
  },
  "Base": {
   "commonOfficial": 37,
   "missingOfficial": [
    "0xf7020405",
    "0x002a3e3a"
   ],
   "extraScanned": [],
   "vsReference": {
    "onlyTarget": [],
    "onlyReference": []
   },
   "ok": true
  }
 },
 "probes": [
  {
   "name": "permit2()",
   "category": "same-value",
   "expect": "equal",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "ok",
     "decoded": "0x000000000022D473030F116dDEE9F6B43aC78BA3"
    },
    {
     "chain": "Ethereum",
     "outcome": "ok",
     "decoded": "0x000000000022D473030F116dDEE9F6B43aC78BA3"
    },
    {
     "chain": "Base",
     "outcome": "ok",
     "decoded": "0x000000000022D473030F116dDEE9F6B43aC78BA3"
    }
   ]
  },
  {
   "name": "ownerOf(不存在)",
   "category": "same-shape",
   "expect": "revert",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "revert",
     "selector": "0x08c379a0",
     "reason": "execution reverted: NOT_MINTED"
    },
    {
     "chain": "Ethereum",
     "outcome": "revert",
     "selector": "0x08c379a0",
     "reason": "execution reverted: NOT_MINTED"
    },
    {
     "chain": "Base",
     "outcome": "revert",
     "selector": "0x08c379a0",
     "reason": "execution reverted: NOT_MINTED"
    }
   ]
  },
  {
   "name": "getPoolAndPositionInfo(不存在)",
   "category": "chain-specific",
   "expect": "zero-shape",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "ok",
     "decoded": {
      "poolKey": {
       "currency0": "0x0000000000000000000000000000000000000000",
       "currency1": "0x0000000000000000000000000000000000000000",
       "fee": 0,
       "tickSpacing": 0,
       "hooks": "0x0000000000000000000000000000000000000000"
      },
      "info": "0",
      "isZeroShape": true
     }
    },
    {
     "chain": "Ethereum",
     "outcome": "ok",
     "decoded": {
      "poolKey": {
       "currency0": "0x0000000000000000000000000000000000000000",
       "currency1": "0x0000000000000000000000000000000000000000",
       "fee": 0,
       "tickSpacing": 0,
       "hooks": "0x0000000000000000000000000000000000000000"
      },
      "info": "0",
      "isZeroShape": true
     }
    },
    {
     "chain": "Base",
     "outcome": "ok",
     "decoded": {
      "poolKey": {
       "currency0": "0x0000000000000000000000000000000000000000",
       "currency1": "0x0000000000000000000000000000000000000000",
       "fee": 0,
       "tickSpacing": 0,
       "hooks": "0x0000000000000000000000000000000000000000"
      },
      "info": "0",
      "isZeroShape": true
     }
    }
   ]
  },
  {
   "name": "getPositionLiquidity(不存在)",
   "category": "chain-specific",
   "expect": "zero",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "ok",
     "decoded": "0"
    },
    {
     "chain": "Ethereum",
     "outcome": "ok",
     "decoded": "0"
    },
    {
     "chain": "Base",
     "outcome": "ok",
     "decoded": "0"
    }
   ]
  },
  {
   "name": "nextTokenId()",
   "category": "chain-specific",
   "expect": "positive",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "ok",
     "decoded": "5966"
    },
    {
     "chain": "Ethereum",
     "outcome": "ok",
     "decoded": "505450"
    },
    {
     "chain": "Base",
     "outcome": "ok",
     "decoded": "3211428"
    }
   ]
  },
  {
   "name": "poolManager()",
   "category": "chain-specific",
   "expect": "has-code",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "ok",
     "decoded": {
      "address": "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1",
      "hasCode": true
     }
    },
    {
     "chain": "Ethereum",
     "outcome": "ok",
     "decoded": {
      "address": "0x000000000004444c5dc75cB358380D2e3dE08A90",
      "hasCode": true
     }
    },
    {
     "chain": "Base",
     "outcome": "ok",
     "decoded": {
      "address": "0x498581fF718922c3f8e6A244956aF099B2652b2b",
      "hasCode": true
     }
    }
   ]
  },
  {
   "name": "modifyLiquidities(空 actions)",
   "category": "same-shape",
   "expect": "revert",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "reason": "execution reverted"
    },
    {
     "chain": "Ethereum",
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "reason": "execution reverted"
    },
    {
     "chain": "Base",
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "reason": "execution reverted"
    }
   ]
  },
  {
   "name": "modifyLiquidities(未知 action)",
   "category": "same-shape",
   "expect": "revert",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "reason": "execution reverted"
    },
    {
     "chain": "Ethereum",
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "reason": "execution reverted"
    },
    {
     "chain": "Base",
     "outcome": "revert",
     "selector": "0x3b99b53d",
     "reason": "execution reverted"
    }
   ]
  },
  {
   "name": "modifyLiquidities(合法编码/头寸不存在)",
   "category": "same-shape",
   "expect": "revert",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "revert",
     "selector": "0x08c379a0",
     "reason": "execution reverted: NOT_MINTED"
    },
    {
     "chain": "Ethereum",
     "outcome": "revert",
     "selector": "0x08c379a0",
     "reason": "execution reverted: NOT_MINTED"
    },
    {
     "chain": "Base",
     "outcome": "revert",
     "selector": "0x08c379a0",
     "reason": "execution reverted: NOT_MINTED"
    }
   ]
  },
  {
   "name": "multicall(bytes[])",
   "category": "same-shape",
   "expect": "revert",
   "pass": true,
   "reasons": [],
   "rows": [
    {
     "chain": "Elysium",
     "outcome": "revert",
     "selector": "0x38bbd576",
     "reason": "execution reverted"
    },
    {
     "chain": "Ethereum",
     "outcome": "revert",
     "selector": "0x38bbd576",
     "reason": "execution reverted"
    },
    {
     "chain": "Base",
     "outcome": "revert",
     "selector": "0x38bbd576",
     "reason": "execution reverted"
    }
   ]
  }
 ],
 "invariants": [
  {
   "name": "permit2() 三链返回值一致",
   "pass": true,
   "values": {
    "Elysium": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "Ethereum": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "Base": "0x000000000022D473030F116dDEE9F6B43aC78BA3"
   }
  }
 ],
 "summary": {
  "selectorSetConsistent": true,
  "errorSemanticsConsistent": true,
  "sameValueInvariantsConsistent": true,
  "chainSpecificTargetsValid": true,
  "allProbesPass": true,
  "internalEquivalenceProven": false,
  "note": "只读对照只能证明接口面、只读行为与错误语义一致；内部实现等价性与写路径状态变更无法由只读手段证明",
  "targetsWithCode": true
 }
}
```