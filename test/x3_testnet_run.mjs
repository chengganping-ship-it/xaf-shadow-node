/**
 * Stage X3 真·测试网跑通器（一次性钱包 + 真 Base Sepolia + 真 EIP-3009 签名）
 * ==============================================================================
 * 与本地 mock 的区别：这里签的是**真的 Base Sepolia domain**（chainId 84532，
 * verifyingContract = 已验证的 Circle testnet USDC），链 CSP EO 凭证可被真实 facilitator 校验。
 *
 * ⛔ 红线自检（脚本自己会验）：
 *   - 只允许 chains white[{84532 'base-sepolia', 80002 'polygon-amoy'}]
 *   - 不 POST 任何水龙头写接口（Circle 公共水龙头带 reCAPTCHA，自动化点不了也**不该**点）
 *   - 私钥只从环境变量读；缺省则生成一次性内存钱包（进程退出即消失，不落盘）
 *   - 不碰任何法币 / 主网 RPC
 *
 * 用法：
 *   1) XAF_MCP_URL=http://127.0.0.1:8787 node test/x3_testnet_run.mjs --new-wallet
 *   2) 脚本会给出收款地址 + Circle 水龙头链接，**人工点一次**（每地址每链每 2h 限 20 USDC）
 *   3) 脚本轮询链上余额，到账后自动签 EIP-3009 → 调 MCP → 打印结算结果
 *
 * 可选环境变量：
 *   XAF_TESTNET_WALLET_KEY=0x...  代码托管的一次性测试网钱包（非任何个人冷钱包）
 *   X402_FACILITATOR_URL=...      真实 facilitator（CDP 需 API key；留空则只做本地 verify）
 *   XAF_TESTNET_RPC=...           默认 https://sepolia.base.org
 */

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ⛔ 不写死 domain：一切以 `node test/verify_chain_constants.mjs` 的链上反解结果为准。
let REGISTRY;
try {
  REGISTRY = JSON.parse(readFileSync(join(HERE, "chain_registry.json"), "utf8"));
} catch {
  console.error("❌ 缺失 chain_registry.json —— 先跑 `node test/verify_chain_constants.mjs`");
  process.exit(1);
}

// 候选白皮数据（仅 RPC/水龙卷链接等），domain 信息一律从注册表取
const CHAIN_FACTS = {
  "base-sepolia": {
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    faucetUrl: "https://faucet.circle.com/",
    nativeFaucetHint: "Base Sepolia 原生 ETH：Base 官方/社区水龙头（部分需社交账号）",
  },
  "polygon-amoy": {
    chainId: 80002,
    rpc: "https://rpc-amoy.polygon.technology",
    explorer: "https://amoy.polygonscan.com",
    faucetUrl: "https://faucet.circle.com/",
    nativeFaucetHint: "Polygon Amoy 原生 POL：Polygon 官方水龙头",
  },
};

const MAINNET_IDS = new Set([1, 56, 137, 8453, 42161, 10, 59144, 501]);

const network = process.env.X402_NETWORK ?? "base-sepolia";
const reg = REGISTRY[String(CHAIN_FACTS[network]?.chainId ?? 0)];
if (!reg || reg.verified !== true) {
  console.error(`❌ ${network} 未在已验证注册表内。不允许用未经链上验证的 domain 签名。`);
  console.error(`   已验证链: ${Object.values(REGISTRY).map((c) => c.network).join(", ") || "无"}`);
  process.exit(1);
}
const chain = {
  chainId: reg.chainId,
  rpc: CHAIN_FACTS[network].rpc,
  explorer: CHAIN_FACTS[network].explorer,
  faucetUrl: CHAIN_FACTS[network].faucetUrl,
  nativeFaucetHint: CHAIN_FACTS[network].nativeFaucetHint,
  usdc: reg.asset,
  usdcName: reg.domainName, // ← 链上反解出的真 name（Base Sepolia 实测是 "USDC" 而非 "USD Coin"）
  usdcVersion: reg.domainVersion,
};

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.XAF_TESTNET_RPC ?? chain.rpc);

  // 红线：先确认这条链真的是测试网，绝不相信配置里写什么就是什么
  const net = await provider.getNetwork();
  const liveChainId = Number(net.chainId);
  if (MAINNET_IDS.has(liveChainId) || liveChainId !== chain.chainId) {
    console.error(`❌ 主网/错链熔断：RPC 返回 chainId=${liveChainId}，期望 ${chain.chainId}`);
    process.exit(1);
  }
  console.log(`✅ 已连接测试网 ${network} (chainId=${liveChainId})`);

  // USDC 合约实地校验
  const token = new ethers.Contract(chain.usdc, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  console.log(`✅ 代币校验 ${chain.usdc} = ${symbol} / ${decimals} decimals`);
  if (String(symbol) !== "USDC" || Number(decimals) !== 6) {
    console.error("❌ 合约与预期不符，中止（可能被狸猫换太子）");
    process.exit(1);
  }

  // 钱包：优先环境变量（代码托管的一次性钱包），否则生成一次性内存钱包
  const keyFromEnv = process.env.XAF_TESTNET_WALLET_KEY?.trim();
  const wallet = keyFromEnv ? new ethers.Wallet(keyFromEnv, provider) : ethers.Wallet.createRandom().connect(provider);
  const ephemeral = !keyFromEnv;
  console.log(`\n📮 测试资金来源地址: ${wallet.address}${ephemeral ? "（一次性，进程退出即弃）" : "（来自环境变量）"}`);

  let usdcBal = await token.balanceOf(wallet.address);
  let ethBal = await provider.getBalance(wallet.address);
  console.log(`   当前余额: ${ethers.formatUnits(usdcBal, decimals)} USDC | ${ethers.formatEther(ethBal)} ETH`);

  if (usdcBal === 0n) {
    // --no-wait：跳过等待，直接继续。仅用于"本地/自托管 facilitator"演示 —— 真实 facilitator
    // 会因链上余额不足而明确拒绝，这正是我们期望的红线行为，不在此绕过。
    const noWait = process.argv.includes("--no-wait");
    if (noWait) {
      console.log("\n⚠️  --no-wait 已指定：余额为 0 仍继续。真实 facilitator 会拒绝并退回 402（这是正确行为）。");
    } else {
      waitLoop: {
        console.log("\n⏳ 等待测试币到账 —— **这一步必须人工点一次**，我不替你绕过任何验证：");
        console.log(`   ${chain.faucetUrl}  →  选择 ${network}  →  粘贴上面的地址  →  Send 20 USDC`);
        console.log(`   ${chain.nativeFaucetHint}`);
        console.log("   （Circle 公共水龙头带 reCAPTCHA，脚本层面不自动领取；每地址每链每 2 小时限 20 USDC）");
        console.log("   轮询中，Ctrl+C 退出…");
        const deadline = Date.now() + 20 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15000));
          usdcBal = await token.balanceOf(wallet.address);
          ethBal = await provider.getBalance(wallet.address);
          if (usdcBal > 0n) {
            console.log(`\n✅ 到账 ${ethers.formatUnits(usdcBal, decimals)} USDC`);
            break waitLoop;
          }
          process.stdout.write(".");
        }
        console.log("\n⏳ 20 分钟未到账，保持脚本待命；到账后重跑即可。");
        process.exit(2);
      }
    }
  }

  // 目标 = MCP 节点
  const mcpUrl = process.env.XAF_MCP_URL ?? "http://127.0.0.1:8787/mcp";
  const payTo = process.env.XAF_TESTNET_PAYTO ?? "0x0000000000000000000000000000000000000000";
  const priceAtomic = process.env.XAF_PRICE_ATOMIC ?? "100000"; // $0.10 @ 6dp
  const tool = process.env.XAF_TOOL ?? "rights_precheck";

  // 拉取节点的 Payment Requirements（真握手）
  const probe = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: tool, arguments: { content: "我的插画被侵权，想做数据确权" } } }),
  });
  console.log(`\n探测 ${mcpUrl} → HTTP ${probe.status}`);
  if (probe.status !== 402) {
    console.log(probe.status === 200 ? "ℹ️  节点当前为 free 模式，直接放行（无需付费）" : `⚠️  非预期状态 ${probe.status}`);
    return;
  }
  const req = await probe.json();
  const accept = req.accepts?.[0];
  console.log(`402 需求: network=${accept?.network} chainId=${accept?.chainId} amount=${accept?.maxAmountRequired} payTo=${accept?.payTo}`);

  // ⛔ 再验一次 402 里给的 payTo/network，防止节点被污染后骗我们去主网付款
  if (MAINNET_IDS.has(Number(accept?.chainId)) || Number(accept?.chainId) !== chain.chainId) {
    console.error(`❌ 402 payload 的 chainId=${accept?.chainId} 不在测试网白名单，拒绝付款`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: accept?.payTo ?? payTo,
    value: String(accept?.maxAmountRequired ?? priceAtomic),
    validAfter: String(now - 60),
    validBefore: String(now + 300),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(
    { name: chain.usdcName, version: chain.usdcVersion, chainId: chain.chainId, verifyingContract: chain.usdc },
    TYPES,
    authorization,
  );
  console.log(`\n🔏 已签 EIP-3009 TransferWithAuthorization`);
  console.log(`   from=${authorization.from}  value=${authorization.value}  nonce=${authorization.nonce.slice(0, 12)}…`);

  const payment = Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "exact", network, payload: { signature, authorization } }),
  ).toString("base64");

  const paid = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { content: "我的插画被侵权，想做数据确权" } } }),
  });
  console.log(`\n付款后 → HTTP ${paid.status}`);
  const receiptHeader = paid.headers.get("x-payment-response");
  if (receiptHeader) {
    console.log("🧾 结算凭证:", JSON.stringify(JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")), null, 2));
  } else {
    console.log("（无 X-PAYMENT-RESPONSE：多为本地 facilitator 未核销或 strict 已拒）");
  }
  const bodyText = await paid.text();
  console.log("响应片段:", bodyText.slice(0, 400));

  if (ephemeral) console.log(`\n♻️  一次性钱包已弃用（未写入任何文件）：${wallet.address}`);
}

main().catch((e) => {
  console.error("❌ 运行失败:", e?.message ?? e);
  process.exit(1);
});
