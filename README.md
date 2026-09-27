# XAF Shadow Node · Stage X1 边缘网关

把 XAF 的确权/线索/估值能力**边缘化**为一个匿名、无状态、按次计费的 MCP Server，跑在 Cloudflare Workers 免费层上。

```
外部 Agent / MCP 客户端
        │  POST /mcp  (JSON-RPC 2.0, stateless)
        ▼
┌──────────────────────────────────────────────┐
│ index.js        路由 · CORS · 错误信封 · 日志 │
│  └─ jsonrpc.js  解析 → 校验 → 分派            │
│      └─ x402.js 测试网支付门禁（402 握手）     │
│          └─ pricing.js  定价 + PaymentReq     │
│              └─ safety.js  🔒 四条硬红线       │
│          └─ core/                            │
│              ├─ rights.js       rights_precheck      │
│              ├─ leads.js        c2c_lead_sniff       │
│              └─ valuation.js    portfolio_valuation   │
└──────────────────────────────────────────────┘
        无任何持久层 / 无 IP·UA 落盘 / 无任何数据导出
```

## 端点

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | 存活探针，返回当前结算网络与 x402 模式 |
| GET | `/ready` | 就绪探针 + 红线自检结果 + 计量后端状态 |
| GET | `/manifest` · `/.well-known/mcp.json` | 节点自检清单（供 Agent 工具目录收录） |
| GET | `/pricing` | 定价表 + 免费额度口径 |
| POST | `/mcp` · `/rpc` · `/` | JSON-RPC 2.0 唯一入口 |
| GET | `/sse` | **405**（本节点 stateless HTTP-only，不支持 SSE 粘性会话） |

## 三条 Tool

| Tool | 价格 | 事实源 | 输出要点 |
|------|------|--------|----------|
| `rights_precheck` | $0.10 | `scripts/xaf_infinity/digital_rights_engine.py` | 资产类别、意向分 HOT/WARM/COLD、痛点、推荐登记通道、SKU 报价、合规（违规承诺词 / PII 脱敏） |
| `c2c_lead_sniff` | $0.05 | CAND-04 五组关键词 + 负向排除 | 每条消息的组级命中、平台识别（闲鱼/小红书/Fiverr…）、分级、推荐话术阶段、管线金额估算 |
| `portfolio_valuation` | $0.20 | TrackB `ASSET_INVENTORY` 许可价值带 | CNY/USD 区间与期望值、testnet USDC 最小单位、集中度风险、变现排序 |

## Stage X3：付费链路（verify → settle → deliver）

三层分工，各司其职：

```
Client (Agent)                 Worker 边缘节点                Facilitator
   │  ① POST /mcp 无凭证            │                            │
   │ ─────────────────────────────► │                            │
   │  ② 402 + PaymentRequirements   │                            │
   │ ◄───────────────────────────── │                            │
   │  ③ 本地红线预检（主网/法币熔断） │                            │
   │                                │  ④ POST /verify ─────────► │ 真 EIP-712 验签
   │                                │ ◄── isValid ────────────── │ 金额/时效/nonce
   │  ⑤ 工具执行 = 数据             │  ⑥ POST /settle ─────────► │ 广播 testnet 交易
   │ ◄──── 200 + X-PAYMENT-RESPONSE │ ◄── txHash ─────────────── ┤
```

- **Worker 侧**（`src/facilitator.js`）只做 HTTP：verify / settle / supported，含超时与失败收敛，**不内置任何链上密码学库**（免费层体积友好，也符合 x402 标准形态）。
- **facilitator 侧**（`test/facilitator_mock.mjs`）用 ethers 做**真实 EIP-3009 `TransferWithAuthorization` 验签**：recover 出 payer、比 recipient/amount/时间窗/nonce；nonce 内存去重防重放。`settle` 明确返回 `simulated: true` —— **链上什么都没发生，这一点不掩饰**。

### 链上已核实的事实

| 项 | 值 | 证据 |
|---|---|---|
| Base Sepolia chainId | `0x14a34` / 84532 | `eth_chainId` @ https://sepolia.base.org |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `eth_getCode` 非空、`symbol()=USDC`、`decimals()=6` |
| Polygon Amoy USDC | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | ⏳ 本机 RPC 不可达，**未实地验证**，节点默认不宣称支持 |

> ⚠️ 曾把 USDC 写成 `0x036CbD...8b39E1D6`，在 Base Sepolia 上是**空合约**。是 `eth_getCode` 把它抓出来的 —— 这条留给后来人：链上常量必须验证，不能凭印象。

## Stage F1：自托管 Testnet Relayer（真链结算）

X3 的 `settle` 是模拟的；F1 补上最后一步 —— **真的把交易广播到 Base Sepolia**。

```
payer 签 EIP-3009  →  Worker  →  Facilitator  →  src/relayer.js  →  eth_sendRawTransaction
                                                                     Base Sepolia USDC
                                                                (transferWithAuthorization)
```

关键点：**payer 一个 wei ETH 都不需要有**。EIP-3009 的 `transferWithAuthorization` 允许任意第三方提交，
value 由 from 出、gas 由提交者（Relayer）出 —— 这就是「gasless payer」。
（`receiveWithAuthorization` 则要求 msg.sender == to，不适用这种 relayer 形态。）

```bash
npm run wallet            # 生成一次性 relayer + payer 钱包，私钥只落 .env.relayer（gitignore 硬拦截）
npm run wallet:check      # 查水位，缺钱时给出可用的水龙头清单
npm run facilitator:live  # 起本地 facilitator，settle 走真广播
npm run f1                # 差分 dry-run + 守卫 + 端到端 fail-closed（零资金也能跑）
npm run f1:full           # 额外执行真实广播（需要资金，缺钱会明确跳过，不假装成功）
```

### 为什么零资金也能拿到硬证据

用 `eth_call` 把同一笔 authorization 以不同方式签名，交给**真实 Base Sepolia 节点**执行合约字节码。
revert 原因就是合约本人的意见：

| 用例 | 合约返回的 revert | 说明 |
|---|---|---|
| 有效签名 | `ERC20: transfer amount exceeds balance` | 只在**最后一步转账**才失败 ⇒ **签名已被合约接受** |
| 冒充者签名 | `FiatTokenV2: invalid signature` | 对照组：合约确实在验签 |
| 错 domain（name=`"USD Coin"`） | `FiatTokenV2: invalid signature` | X3 那次自证幻觉，被钉在测试里 |
| validBefore 已过 | `FiatTokenV2: authorization is expired` | 时间窗语义由合约执行 |
| validAfter 未到 | `FiatTokenV2: authorization is not yet valid` | 同上 |

### USDC 是 proxy，两个地址别搞混

- **EIP-712 的 `verifyingContract` = proxy 地址** `0x036CbD…3dCF7e`（域分隔符由它算得）
- **ABI/字节码 = implementation** `0xd74cc5d4…2c5b5`（`transferWithAuthorization` 等选择器只在这份里）

## 测试矩阵

| 命令 | 覆盖 | 结果 |
|---|---|---|
| `npm run smoke` | 基础：端点 / MCP 握手 / 3 个 Tool / 错误信封 / 4 条红线熔断 | **56/56** |
| `npm run facilitator` + `npm run smoke:paid` | 付费闭环：正常付费、重放、篡改金额、过期、少付、收错人、主网凭证、facilitator 宕机、**verify 过但 settle 失败必须不给数据** | **30/30** |
| `npm run serve` + `curl` | 真实 HTTP（200 / 402 / CORS / 安全头） | 见下 |
| `npm run x3:testnet` | 真链：连 Base Sepolia、校验 USDC、一次性钱包、真 EIP-3009 签名、交付数据 | 见下 |
| `npm run f1` | F1：5 项差分 dry-run + 3 项广播守卫 + 端到端 fail-closed | **14/14** |
| `npm run f1:full` | 在上述基础上真实广播并返回 txHash（需资金） | ⏳ 待注资 |

```bash
curl -X POST http://127.0.0.1:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 部署（需要 Cloudflare 凭据）

```bash
wrangler deploy                    # 产出匿名 https://xaf-shadow-node.<subdomain>.workers.dev
```

`X402_MODE` 三档：`free`（默认，收录期）→ `simulation` → `strict`（Stage X3 打开）。
任何情况下 `X402_NETWORK` 只允许 `base-sepolia` / `polygon-amoy`，写主网会**全站 503 密封**。

## 红线自检清单

- [x] 主网熔断：`assertTestnet()` + `MAINNET_CHAINS` 黑名单，非法即抛
- [x] 法币网关熔断：`assertNoFiatGateway()` 扫描任意 URL/凭证
- [x] 违规承诺熔断：沿用 `RightsSafetyValve.FORBIDDEN_CLAIMS`
- [x] 隐私熔断：手机号/身份证/邮箱/银行卡/微信号自动脱敏
- [x] 零真实身份：不记录 `CF-Connecting-IP` / `User-Agent` / Cookie
- [x] 零持久层：无 KV/D1/R2 绑定，请求之间无任何记忆
- [x] 无 push、未改动既有代码（本目录为纯新增）
