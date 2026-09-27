/**
 * 链条注册表生成器 —— 从**链上**反事实 YES 修正依赖 box；不靠记忆、不靠文档粘贴。
 *
 * 为什么必须存在这个文件？
 *   2026-09-27 实测：按 Circle 文档，我以为 Base Sepolia USDC 的 EIP-712 domain 是
 *   {name:"USD Coin", version:"2"}，本地客户端与本地 facilitator 用同一个假设，
 *   于是"验签通过"、"26/26 全绿"——**全是自证幻觉**。
 *   真实合约的 name() 是 "USDC"，版本 2。链上 DOMAIN_SEPARATOR() 一眼证伪。
 *   若真带着错误 domain 去结算，每笔都会因 invalid-signature revert，本地测试永远发现不了。
 *
 * 做法：
 *   1. eth_chainId  → 确认测试网
 *   2. eth_getCode  → 确认合约存在
 *   3. symbol() / decimals() / name() → 读真实元数据
 *   4. DOMAIN_SEPARATOR() → 用候选 (name, version) 组合暴力比对，命中即采用；**全不中则熔断**
 *
 * 产出： test/chain_registry.json（被 facilitator_mock / x3 跑通器消费）
 *
 * 运行： node test/verify_chain_constants.mjs
 */

import { ethers } from "ethers";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "chain_registry.json");

const MAINNET_IDS = new Set([1, 56, 137, 8453, 42161, 10, 59144, 501]);

const CANDIDATES = [
  { network: "base-sepolia", chainId: 84532, rpc: "https://sepolia.base.org", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { network: "polygon-amoy", chainId: 80002, rpc: "https://rpc-amoy.polygon.technology", asset: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
];

const ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function version() view returns (string)",
];

const VERSION_CANDIDATES = ["2", "1", "2.1", "2.2", "3"];

async function probe(c) {
  const label = `[${c.network}]`;
  try {
    const provider = new ethers.JsonRpcProvider(c.rpc);
    const net = await provider.getNetwork();
    const live = Number(net.chainId);
    if (MAINNET_IDS.has(live)) {
      console.log(`❌ ${label} RPC 返回主网 chainId=${live}，熔断`);
      return null;
    }
    if (live !== c.chainId) {
      console.log(`⏭️  ${label} RPC chainId=${live} 与期望 ${c.chainId} 不符，跳过`);
      return null;
    }

    const code = await provider.getCode(c.asset);
    if (!code || code === "0x") {
      console.log(`❌ ${label} ${c.asset} 无合约代码（空地址），熔断`);
      return null;
    }

    const token = new ethers.Contract(c.asset, ABI, provider);
    const [symbol, decimals, name, sep] = await Promise.all([
      token.symbol(),
      token.decimals(),
      token.name(),
      token.DOMAIN_SEPARATOR(),
    ]);
    console.log(`✅ ${label} ${symbol} decimals=${decimals} name()=${JSON.stringify(name)}`);

    // 反解 domain：候选 name × 候选 version，逐个与链上 DOMAIN_SEPARATOR 比对
    let matched = null;
    const namePool = [name, "USD Coin", "USDC"];
    for (const n of namePool) {
      for (const v of VERSION_CANDIDATES) {
        const ds = ethers.TypedDataEncoder.hashDomain({
          name: n,
          version: v,
          chainId: live,
          verifyingContract: c.asset,
        });
        if (ds === sep) {
          matched = { name: n, version: v };
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      console.log(`❌ ${label} 无法反解 domain（链上 DOMAIN_SEPARATOR=${sep.slice(0, 18)}…），**禁止**使用该链`);
      return null;
    }
    console.log(`✅ ${label} domain 已反解：name=${JSON.stringify(matched.name)} version=${matched.version}（与 DOMAIN_SEPARATOR 一致）`);

    return {
      network: c.network,
      chainId: live,
      rpc: c.rpc,
      asset: c.asset,
      symbol,
      decimals: Number(decimals),
      nameForOnchain: String(name),
      domainName: matched.name,
      domainVersion: matched.version,
      domainSeparator: sep,
      verified: true,
      verifiedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.log(`⏭️  ${label} 探测失败（多为网络不可达）：${String(e?.message ?? e).slice(0, 90)}`);
    return null;
  }
}

const rows = [];
for (const c of CANDIDATES) {
  const r = await probe(c);
  if (r) rows.push(r);
}

const registry = Object.fromEntries(rows.map((r) => [String(r.chainId), r]));
writeFileSync(OUT, JSON.stringify(registry, null, 2), "utf8");
console.log(`\n📝 已写出 ${OUT}`);
console.log(`   已验证可用链: ${rows.length ? rows.map((r) => `${r.network}(${r.chainId})`).join(", ") : "无"}`);
console.log("⛔ 未通过验证的链不会进入注册表 ⇒ 节点不会宣称支持它们");
