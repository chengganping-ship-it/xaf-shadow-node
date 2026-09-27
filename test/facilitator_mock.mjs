/**
 * 本地 x402 Facilitator（测试用，绝不用于生产上线）
 * =========================================================
 * 两种模式（RELAYER_MODE）：
 *   mock（默认）：verify 是真 EIP-712 验签；settle 只是登记 nonce + 造一个假 txHash，
 *                明确标 simulated:true —— **链上什么都没发生**。
 *   live       ：verify 同上；settle 调 src/relayer.js 把 transferWithAuthorization
 *                **真实广播到测试网**，返回真 txHash + 浏览器链接。
 *
 * ⛔ 只监听 127.0.0.1；⛔ 不做任何主网/法币动作；⛔ 重启即丢 nonce 内存表
 *    （live 模式的最终防重放在链上：USDC 的 _authorizationStates）
 *
 * 运行：
 *   node test/facilitator_mock.mjs [port]                    # mock
 *   RELAYER_MODE=live node test/facilitator_mock.mjs [port]   # 真链结算
 */

import { createServer } from "node:http";
import { ethers } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const port = Number(process.argv[2] ?? 8797);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENVF = join(ROOT, ".env.relayer");

const EXPLORERS = { 84532: "https://sepolia.basescan.org", 80002: "https://amoy.polygonscan.com" };

// ⛔ 绝不在这里写死 domain 假设 —— 一切以链上验证过的注册表为准。
//    注册表由 `node test/verify_chain_constants.mjs` 生成：用 name()×version 组合
//    与链上 DOMAIN_SEPARATOR() 逐位比对，命中才写入。
let REGISTRY;
try {
  REGISTRY = JSON.parse(readFileSync(join(HERE, "chain_registry.json"), "utf8"));
} catch {
  console.error("❌ 缺失 chain_registry.json —— 先跑 `node test/verify_chain_constants.mjs`");
  console.error("   拒绝启动：没有经过链上验证的 domain，验签结果一律不可信。");
  process.exit(1);
}

const CHAINS = Object.fromEntries(
  Object.entries(REGISTRY)
    .filter(([, c]) => c.verified === true)
    .map(([id, c]) => [
      c.network,
      { chainId: Number(id), asset: c.asset, name: c.domainName, version: c.domainVersion, decimals: c.decimals },
    ]),
);

if (Object.keys(CHAINS).length === 0) {
  console.error("❌ 注册表里没有任何已验证的链，拒绝启动");
  process.exit(1);
}

// ── F1：真链结算所需的 Relayer（懒加载，mock 模式永远不碰私钥）────────────────
// 跨平台：cmd.exe 不支持 `ENV=x node`，所以模式开关走 argv（默认 mock，绝不误开真广播）
const ARGV_LIVE = process.argv.includes("--live");
const RELAYER_MODE = String(process.env.RELAYER_MODE ?? (ARGV_LIVE ? "live" : "mock")).toLowerCase(); // mock | live
let relayerPromise = null; // 记忆化 promise：并发调用不能重复建 instance（曾导致初始化日志打印两次）

function loadDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !m[1].startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

async function ensureRelayer() {
  if (RELAYER_MODE !== "live") return null;
  if (!relayerPromise) relayerPromise = buildRelayer(); // 只建一次，失败也不缓存成功态
  return relayerPromise;
}

async function buildRelayer() {

  const fileEnv = loadDotEnv(ENVF);
  const merged = { ...fileEnv, ...process.env };
  const key = merged.XAF_RELAYER_PRIVATE_KEY;
  if (!key) {
    console.error(`❌ RELAYER_MODE=live 需要私钥；找不到 ${ENVF} 里的 XAF_RELAYER_PRIVATE_KEY`);
    console.error("   先跑： node test/gen_relayer_wallet.mjs");
    process.exit(1);
  }
  const net = process.env.X402_NETWORK ?? "base-sepolia";
  const chain = CHAINS[net];
  if (!chain) {
    console.error(`❌ 网络 ${net} 不在已验证注册表中`);
    process.exit(1);
  }
  const reg = REGISTRY[String(chain.chainId)] ?? {};
  const { createRelayer } = await import("../src/relayer.js");
  const relayer = await createRelayer({
    chainId: chain.chainId,
    rpcUrl: reg.rpc ?? process.env.XAF_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
    asset: chain.asset,
    decimals: chain.decimals,
    privateKey: key,
    explorerTx: `${EXPLORERS[chain.chainId] ?? "https://sepolia.basescan.org"}/tx/{hash}`,
    gasFloorEth: Number(process.env.XAF_GAS_FLOOR_ETH ?? 0.01),
    maxFeeGwei: Number(process.env.XAF_MAX_FEE_GWEI ?? 5),
  });
  console.log(`[facilitator-live] ⛓ Relayer ${relayer.address} @ ${relayer.network}(chainId ${relayer.chainId})`);
  return relayer;
}

const usedNonces = new Set(); // 仅进程内存：严格意义的重放防护在链上由 _authorizationStates 完成
const settledTxs = new Map();

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

function domainFor(network, assetOverride) {
  const c = CHAINS[network];
  if (!c) return null;
  return {
    name: c.name,
    version: c.version,
    chainId: c.chainId,
    verifyingContract: assetOverride ?? c.asset,
  };
}

async function handleVerify(body) {
  const { paymentPayload, paymentRequirements } = body ?? {};
  const accept = paymentRequirements?.accepts?.[0];
  const auth = paymentPayload?.payload?.authorization;
  const signature = paymentPayload?.payload?.signature;

  if (!accept) return { isValid: false, invalidReason: "missing_requirements" };
  if (!auth || !signature) return { isValid: false, invalidReason: "missing_payload" };

  const net = paymentPayload.network ?? accept.network;
  if (accept.network !== net) return { isValid: false, invalidReason: "network_mismatch" };

  const domain = domainFor(net, accept.asset);
  if (!domain) return { isValid: false, invalidReason: "unsupported_network" };

  // 跳过了的密码学：真实 recover —— 错签名/错 domain/错金额都会 recover 出另一个地址或直接抛错
  let recovered = null;
  try {
    recovered = ethers.verifyTypedData(domain, TYPES, auth, signature);
  } catch {
    return { isValid: false, invalidReason: "signature_invalid" };
  }
  if (recovered.toLowerCase() !== String(auth.from).toLowerCase()) {
    return { isValid: false, invalidReason: "signer_mismatch", payer: recovered };
  }

  if (String(auth.to).toLowerCase() !== String(accept.payTo).toLowerCase()) {
    return { isValid: false, invalidReason: "recipient_mismatch", payer: recovered };
  }

  let paid;
  try {
    paid = BigInt(String(auth.value));
  } catch {
    return { isValid: false, invalidReason: "value_unparseable", payer: recovered };
  }
  const need = BigInt(String(accept.maxAmountRequired));
  if (paid < need) return { isValid: false, invalidReason: "insufficient_amount", payer: recovered, need: need.toString(), paid: paid.toString() };

  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now) return { isValid: false, invalidReason: "not_yet_valid", payer: recovered };
  if (Number(auth.validBefore) <= now) return { isValid: false, invalidReason: "payment_expired", payer: recovered };

  const nonceKey = `${net}:${String(auth.from).toLowerCase()}:${String(auth.nonce).toLowerCase()}`;
  if (usedNonces.has(nonceKey)) return { isValid: false, invalidReason: "nonce_already_used", payer: recovered };

  // live 模式的最终防重放在**链上**：内存表会随重启丢失，USDC 的 _authorizationStates 不会。
  // 拿不到链上状态时 fail-closed（拒绝），绝不退化成"查不到就放行"。
  const R = await ensureRelayer();
  if (R) {
    try {
      if (await R.authorizationUsed(auth.from, auth.nonce)) {
        return { isValid: false, invalidReason: "authorization_already_used_onchain", payer: recovered };
      }
    } catch (e) {
      return { isValid: false, invalidReason: "onchain_state_unavailable", detail: String(e?.message ?? e).slice(0, 200) };
    }
  }

  return { isValid: true, payer: recovered, amount: paid.toString() };
}

async function handleSettle(body) {
  const v = await handleVerify(body);
  if (!v.isValid) return { success: false, errorReason: v.invalidReason };

  const { paymentPayload, paymentRequirements } = body ?? {};
  const auth = paymentPayload?.payload?.authorization;
  const signature = paymentPayload?.payload?.signature;
  const nonceKey = `${paymentPayload.network}:${String(auth.from).toLowerCase()}:${String(auth.nonce).toLowerCase()}`;

  // ── live：真实广播到测试网 ───────────────────────────────────────────────
  const R = await ensureRelayer();
  if (R) {
    try {
      const out = await R.submit({ auth, signature });
      usedNonces.add(nonceKey);
      settledTxs.set(out.txHash, { payer: v.payer, amount: v.amount, network: paymentPayload.network, ts: Date.now(), real: true });
      return {
        success: true,
        transaction: out.txHash,
        network: paymentPayload.network,
        chainId: R.chainId,
        payer: v.payer,
        amount: v.amount,
        // ✅ 真链结算：这里的 txHash 可以在区块浏览器上查到
        real: true,
        simulated: false,
        explorerUrl: out.explorerUrl,
        blockNumber: out.blockNumber,
        gasUsed: out.gasUsed,
      };
    } catch (e) {
      // 广播前的前置检查（过期/已用/余额不足/gas 水位/dry-run 预判）都会走到这里
      return {
        success: false,
        errorReason: e?.code ?? "settle_failed",
        detail: e?.message ?? String(e),
        revert: e?.extra?.revert ?? null,
        hint: e?.extra?.faucet ? "Relayer gas 不足 —— 先给 Relayer 地址领测试网 ETH" : undefined,
        real: true,
        simulated: false,
      };
    }
  }

  // ── mock：模拟上链，一个 wei 都不动 ──────────────────────────────────────
  usedNonces.add(nonceKey);
  const tx = ethers.keccak256(ethers.toUtf8Bytes(`${nonceKey}:${Date.now()}`));
  settledTxs.set(tx, { payer: v.payer, amount: v.amount, network: paymentPayload.network, ts: Date.now() });

  return {
    success: true,
    transaction: tx,
    network: paymentPayload.network,
    payer: v.payer,
    // 明确标注：这是本地模拟结算，链上什么都没发生
    simulated: true,
    real: false,
    warning: "LOCAL_SIMULATED_SETTLEMENT — no chain transaction was broadcast",
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const send = (obj, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const route = req.url.replace(/^\/+|\/+$/g, "");
    // health 是唯一开放的 GET：给人和脚本查 relayer 水位（安全阀要求的余额监控数据源）
    if (req.method === "GET") {
      if (route !== "health") return send({ error: "not_found" }, 404);
      if (RELAYER_MODE !== "live") {
        return send({ mode: "mock", note: "模拟结算：链上什么都没发生", verifiedChains: Object.keys(CHAINS) });
      }
      try {
        return send({ mode: "live", relayer: await (await ensureRelayer()).health() });
      } catch (e) {
        return send({ mode: "live", relayerError: e?.code ?? String(e), detail: e?.message }, 503);
      }
    }
    if (req.method !== "POST") return send({ error: "method_not_allowed" }, 405);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return send({ error: "bad_json" }, 400);
    }
    if (route === "supported") {
      return send({
        kinds: Object.entries(CHAINS).map(([network, c]) => ({ network, extra: { asset: c.asset, decimals: c.decimals, chainId: c.chainId } })),
      });
    }
    if (route === "verify") return send(await handleVerify(body));
    if (route === "settle") return send(await handleSettle(body));
    return send({ error: "not_found" }, 404);
  });
});

server.listen(port, "127.0.0.1", async () => {
  const mode = RELAYER_MODE === "live" ? "LIVE CHAIN SETTLEMENT (testnet only)" : "LOCAL SIMULATION ONLY";
  console.log(`[facilitator] http://127.0.0.1:${port}  (verify/settle/supported · ${mode})`);
  if (RELAYER_MODE === "live") {
    try {
      const h = await (await ensureRelayer()).health();
      console.log(`   relayer ${h.address}  ETH=${h.eth}  gasFloor=${h.gasFloorEth}  ${h.ok ? "✅" : "⏳ gas 不足，需先领币"}`);
      for (const a of h.alerts) console.log(`   [${a.level}] ${a.code}: ${a.message}`);
    } catch (e) {
      console.log(`   ⚠️ relayer 初始化失败：${e?.message ?? e}`);
    }
  }
});
