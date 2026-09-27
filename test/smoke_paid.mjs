/**
 * Stage X3 付费链路本地验证 —— verify → settle → deliver 全闭环（零真钱、零主网）
 * ==================================================================================
 * 前置： node test/facilitator_mock.mjs 8797   （另一个终端）
 * 运行： node test/smoke_paid.mjs
 *
 * 覆盖：
 *   1. 正常付费：真 EIP-712 签名 → 402 变 200 → 拿到 X-PAYMENT-RESPONSE → 数据交付
 *   2. 重放攻击：同一 X-PAYMENT 二次使用 → nonce 已用 → 拒绝交付
 *   3. 篡改金额：签名与 value 不符 → recover 出错 → 拒绝
 *   4. 过期凭证：validBefore 已过 → 拒绝
 *   5. 金额不足：value < maxAmountRequired → 拒绝
 *   6. 收错人：to ≠ payTo → 拒绝
 *   7. 主网凭证：network=ethereum-mainnet → 本地红线先熔断，根本不到 facilitator
 *   8. facilitator 挂掉：URL 指向死端口 → 明确失败（不给数据，不静默放行）
 *   9. free / simulation 模式对比
 *
 * ⚠️ 本脚本每次运行都生成**临时丢弃钱包**，私钥只在内存里，不落盘。
 */

import worker from "../src/index.js";
import { ethers } from "ethers";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const FACILITATOR = process.env.XAF_FACILITATOR ?? "http://127.0.0.1:8797";

// ⛔ domain 绝不靠记忆：必须从 `node test/verify_chain_constants.mjs` 反解出的注册表读取。
//    2026-09-27 教训：假设 name="USD Coin" 时，客户端与 mock 共享同一错误假设 ⇒ 26/26 假绿，
//    真实合约 name() 是 "USDC"。此处的 DOMAIN_SEPARATOR 比对就是专门挡这类自证幻觉的探针。
const REGISTRY = JSON.parse(readFileSync(new URL("./chain_registry.json", import.meta.url), "utf8"));
const REG = REGISTRY["84532"];
if (!REG?.verified) {
  console.error("❌ 缺已验证的 chain_registry.json —— 先跑 `node test/verify_chain_constants.mjs`");
  process.exit(1);
}
const USDC_BASE_SEPOLIA = REG.asset;
// 一次性收款地址：每次运行随机生成（EIP-55 校验通过），进程退出即弃
const PAYTO = ethers.Wallet.createRandom().address;

let pass = 0;
let fail = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  rows.push({ status: cond ? "✅" : "❌", name, detail: String(detail).slice(0, 140) });
};

function baseEnv(overrides = {}) {
  return {
    XAF_NODE_ID: "ghost-node-00",
    XAF_TOOLSET_VERSION: "x1.0",
    XAF_MCP_PROTOCOL_VERSION: "2025-06-18",
    X402_MODE: "strict",
    X402_NETWORK: "base-sepolia",
    X402_FACILITATOR_URL: FACILITATOR,
    X402_FACILITATOR_TIMEOUT_MS: "4000",
    XAF_TESTNET_USDC: USDC_BASE_SEPOLIA,
    XAF_TESTNET_PAYTO: PAYTO,
    XAF_CHAINS_VERIFIED: '{"84532":true,"80002":false}',
    XAF_FREE_QUOTA_JSON: "{}",
    XAF_CORS_ORIGINS: "*",
    XAF_LOG_LEVEL: "info",
    ...overrides,
  };
}

// ── EIP-3009 签名工具 ──────────────────────────────────────────────────────
const WALLET = ethers.Wallet.createRandom(); // 临时钱包，进程退出即消失

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
const DOMAIN = {
  name: REG.domainName,
  version: REG.domainVersion,
  chainId: REG.chainId,
  verifyingContract: REG.asset,
};

async function buildProof({ network = "base-sepolia", value = "100000", payTo = PAYTO, ttl = 300, signer = WALLET, mutateAfterSign = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: signer.address,
    to: payTo,
    value,
    validAfter: String(now - 30),
    validBefore: String(now + ttl),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await signer.signTypedData(DOMAIN, TYPES, authorization);
  const finalAuth = mutateAfterSign ? mutateAfterSign(authorization) : authorization;
  const payload = { x402Version: 1, scheme: "exact", network, payload: { signature, authorization: finalAuth } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

async function call(env, tool, headers = {}, args = { content: "我的插画被侵权，想做数据确权" }) {
  const req = new Request("https://xaf-shadow-node.workers.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  // ⚠️ body 只能读一次：这里统一读完，后续断言直接用 json，不许再 clone
  const res = await worker.fetch(req, env, {});
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json, text };
}

console.log("\n=== XAF Stage X3 — paid path smoke (verify→settle→deliver) ===\n");
console.log(`临时收款方: ${PAYTO}`);
console.log(`临时付款钱包: ${WALLET.address}  (每次运行随机生成，进程退出即弃)\n`);

// 0. facilitator 可达性 + **domain 自证反证探针**（必须写在验签用例之前）
check(
  "domain 由链上反解且与 DOMAIN_SEPARATOR 一致",
  ethers.TypedDataEncoder.hashDomain(DOMAIN) === REG.domainSeparator,
  `local=${ethers.TypedDataEncoder.hashDomain(DOMAIN).slice(0, 18)}… chain=${REG.domainSeparator.slice(0, 18)}… name=${JSON.stringify(REG.domainName)} v=${REG.domainVersion}`,
);
let facilitatorUp = false;
try {
  const r = await fetch(`${FACILITATOR}/supported`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await r.json();
  facilitatorUp = r.ok && Array.isArray(j.kinds);
  check("facilitator /supported 可达", facilitatorUp, JSON.stringify(j.kinds ?? j).slice(0, 100));
} catch (e) {
  check("facilitator /supported 可达", false, String(e?.message ?? e));
}

// 不可达就别往下跑了。否则后面 9 条用例集体飘红，看起来像代码回归，
// 实际只是后台进程没起 ——— 一次误判的成本远高于加三行 fail-fast。
if (!facilitatorUp) {
  console.error(`\n❌ facilitator 不可达（${FACILITATOR}）—— 先另开终端执行： npm run facilitator`);
  console.error("   未继续跑付费用例，避免把「服务没起」误读成「链路坏了」。\n");
  process.exit(1);
}

// 1. 正常付费闭环
{
  const proof = await buildProof({ value: "100000" });
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": proof });
  check("有效付费 → HTTP 200", res.status === 200, `status=${res.status}`);
  check("交付真实数据", !!json?.result?.structuredContent?.priority, json?.result?.structuredContent?.priority);
  const receiptRaw = res.headers.get("x-payment-response");
  check("返回 X-PAYMENT-RESPONSE", !!receiptRaw);
  const receipt = receiptRaw ? JSON.parse(Buffer.from(receiptRaw, "base64").toString("utf8")) : {};
  check("结算已发生（含 txHash）", !!receipt?.settlement?.txHash, receipt?.settlement?.txHash);
  check("结算标为 simulated（诚实标注）", receipt?.settlement?.simulated === true, JSON.stringify(receipt?.settlement));
  check("结算网络为 base-sepolia", ["base-sepolia"].includes(receipt?.settlement?.network ?? ""), receipt?.settlement?.network ?? "");
  check("付款方被记录（匿名地址）", /^0x[0-9a-fA-F]{40}$/.test(receipt?.payer ?? ""), receipt?.payer ?? "");
  globalThis.__LAST_PROOF = proof;
}

// 2. 重放攻击
{
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": globalThis.__LAST_PROOF });
  check("重放同一凭证 → 402", res.status === 402, `status=${res.status}`);
  const body = json;
  check("拒因 nonce_already_used 或 amount 类", ["nonce_already_used", "insufficient_amount", "invalid_payment"].includes(body?.verification?.reason ?? ""), JSON.stringify(body?.verification));
}

// 3. 篡改金额（签名后改 value）
{
  const proof = await buildProof({ value: "100000", mutateAfterSign: (a) => ({ ...a, value: "1" }) });
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": proof });
  check("金额被篡改 → 402", res.status === 402, `status=${res.status}`);
  const body = json;
  check("因金额不足/验签失败被拒", ["insufficient_amount", "signature_invalid", "signer_mismatch"].includes(body?.verification?.reason ?? ""), JSON.stringify(body?.verification));
}

// 4. 过期凭证
{
  const proof = await buildProof({ ttl: -1 });
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": proof });
  check("过期凭证 → 402", res.status === 402, `status=${res.status}`);
  const body = json;
  check("拒因 payment_expired", body?.verification?.reason === "payment_expired", JSON.stringify(body?.verification));
}

// 5. 金额不足（诚实签名但少付）
{
  const proof = await buildProof({ value: "10" });
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": proof });
  check("少付 → 402", res.status === 402, `status=${res.status}`);
  const body = json;
  check("拒因 insufficient_amount", body?.verification?.reason === "insufficient_amount", JSON.stringify(body?.verification));
}

// 6. 收错人
{
  const proof = await buildProof({ payTo: "0x000000000000000000000000000000000000dEaD" });
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": proof });
  check("收款地址不符 → 402", res.status === 402, `status=${res.status}`);
  const body = json;
  check("拒因 payto_mismatch / recipient_mismatch", ["payto_mismatch", "recipient_mismatch"].includes(body?.verification?.reason ?? ""), JSON.stringify(body?.verification));
}

// 7. 主网凭证 —— 必须在本地红线熔断，不出网
{
  const proof = await buildProof({ network: "ethereum-mainnet" });
  const { res, json } = await call(baseEnv(), "rights_precheck", { "x-payment": proof });
  check("主网凭证 → 402（未出网）", res.status === 402, `status=${res.status}`);
  const body = json;
  check("命中 A-mainnet-fuse", body?.verification?.detail?.data?.redline === "A-mainnet-fuse", JSON.stringify(body?.verification));
}

// 8. facilitator 不可达 —— 必须显式失败，不能静默放行
{
  const { res, json } = await call(baseEnv({ X402_FACILITATOR_URL: "http://127.0.0.1:1" }), "rights_precheck", { "x-payment": await buildProof({ value: "100000" }) });
  check("facilitator 挂 → 402 不给数据", res.status === 402, `status=${res.status}`);
  const body = json;
  check("拒因 facilitator_unreachable", body?.verification?.reason === "facilitator_unreachable", JSON.stringify(body?.verification));
}

// 9. free / simulation 模式
{
  const free = await call(baseEnv({ X402_MODE: "free" }), "rights_precheck", {});
  check("free 模式无凭证也放行", free.res.status === 200, `status=${free.res.status}`);
  const sim = await call(baseEnv({ X402_MODE: "simulation" }), "rights_precheck", { "x-payment": await buildProof({ value: "100000" }) });
  check("simulation 模式放行并记账", sim.res.status === 200, `status=${sim.res.status}`);
  const simReceipt = JSON.parse(Buffer.from(sim.res.headers.get("x-payment-response") ?? "e30=", "base64").toString("utf8"));
  check("simulation 明确标 simulated", simReceipt?.settlement?.simulated === true, JSON.stringify(simReceipt?.settlement));
}

// 10. 未配置 facilitator 的 strict —— 明确拒绝，不假装通过
{
  const { res, json } = await call(baseEnv({ X402_FACILITATOR_URL: "" }), "rights_precheck", {});
  check("无凭证 + strict 未配 facilitator → 402", res.status === 402, `status=${res.status}`);
}

// 11. 故障注入：verify 通过但 settle 失败 —— 必须 IP 都不给一个字节数据出去。
//     这条专门盯着「接了真 facilitator 之后」的世界：真链结算会 revert、会超时、会 gas 不够，
//     届时如果这里疏忽了，就成了标准的"付了假钱、拿走真数据"。一个字节的数据都不许出去。
//     所以用一个**故意使坏的假 facilitator**把场景逼出来。
{
  const EVIL_PORT = Number(process.env.XAF_EVIL_PORT ?? 8799);
  const evil = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* 忽略 */
      }
      const route = req.url.replace(/^\/+|\/+$/g, "");
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (route === "verify") return send({ isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from, amount: "100000" });
      if (route === "settle") return send({ success: false, errorReason: "forced_settle_failure", real: true, simulated: false });
      return send({ error: "not_found" });
    });
  });
  await new Promise((r) => evil.listen(EVIL_PORT, "127.0.0.1", r));

  const proofSettled = await buildProof({ value: "100000" });
  const { res, json } = await call(baseEnv({ X402_FACILITATOR_URL: `http://127.0.0.1:${EVIL_PORT}` }), "rights_precheck", { "x-payment": proofSettled });
  check("verify 过但 settle 失败 ⇒ 402", res.status === 402, `status=${res.status}`);
  check("settle 失败 ⇒ 绝不交付数据", json?.result?.structuredContent === undefined && json?.error !== undefined, JSON.stringify(json).slice(0, 160));
  const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response") ?? "e30=", "base64").toString("utf8"));
  check("回执里如实说明 settle 失败原因", receipt?.settlement?.reason === "forced_settle_failure", JSON.stringify(receipt?.settlement ?? null).slice(0, 160));

  evil.close();
}

console.log("\n── 明细 ─────────────────────────────────────────────────────────────");
for (const r of rows) console.log(`${r.status} ${r.name}${r.detail ? `  ·  ${r.detail}` : ""}`);
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(`PASS ${pass} / FAIL ${fail} / TOTAL ${rows.length}`);
console.log(fail === 0 ? "✅ X3 付费链路本地闭环通过\n" : "❌ 存在失败用例\n");
process.exit(fail === 0 ? 0 : 1);
