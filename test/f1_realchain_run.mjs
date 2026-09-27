/**
 * XAF Phase X — Stage F1 真链结算闭环验证
 * ==================================================================
 * 目标：证明「Client 签名 → Relayer 代广播 → 链上状态变更 → 真 txHash」确实成立。
 *
 * 难点：此刻钱包余额是 0。没钱也要拿到硬证据 —— 办法是**差分 dry-run**：
 *   把同一笔 authorization 用不同方式签名，交给**真实 Base Sepolia 节点**用 eth_call 执行。
 *   USDC 合约自己的 revert 原因就是它对这笔签名的意见：
 *     · 有效签名 + 余额 0        → 晚阶段 revert（转账/余额），说明**签名已被合约接受**
 *     · 换错签名者/换错 domain   → "invalid signature"，说明合约**确实在验签**
 *     · validBefore 已过         → "authorization is expired"
 *     · validAfter 未到          → "authorization is not yet valid"
 *   两边一对照，就把"签名对不对"和"钱够不够"彻底分开。这不是自证：
 *   结论由**链上合约字节码**给出，不由我本地的假设给出。
 *
 * 用法：
 *   node test/f1_realchain_run.mjs            # 差分 dry-run + 守卫测试（零资金可跑）
 *   node test/f1_realchain_run.mjs --full     # 额外跑广播闭环（需要资金，缺钱会明确跳过）
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { createRelayer, RelayerSafetyError } from "../src/relayer.js";
import worker from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENVF = join(ROOT, ".env.relayer");
const FULL = process.argv.includes("--full");
const FACIL_PORT = Number(process.env.XAF_F1_FACILITATOR_PORT ?? 8897);
const FACILITATOR = `http://127.0.0.1:${FACIL_PORT}`;

// ── 0. 注册表（拒绝任何手写的链上常量）──────────────────────────────────────
const REGISTRY = JSON.parse(readFileSync(join(HERE, "chain_registry.json"), "utf8"));
const REG = REGISTRY["84532"];
if (!REG?.verified) {
  console.error("❌ 缺已验证注册表 —— 先跑 `node test/verify_chain_constants.mjs`");
  process.exit(1);
}

// ── 1. 一次性钱包（私钥唯一来源：.env.relayer，gitignore 硬拦截）─────────────
function loadDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const fileEnv = loadDotEnv(ENVF);
const RELAYER_KEY = process.env.XAF_RELAYER_PRIVATE_KEY ?? fileEnv.XAF_RELAYER_PRIVATE_KEY;
const PAYER_KEY = process.env.XAF_PAYER_PRIVATE_KEY ?? fileEnv.XAF_PAYER_PRIVATE_KEY;
if (!RELAYER_KEY || !PAYER_KEY) {
  console.error(`❌ 找不到一次性钱包 —— 先跑 \`node test/gen_relayer_wallet.mjs\`（期望文件：${ENVF}）`);
  process.exit(1);
}

const payer = new ethers.Wallet(PAYER_KEY);
const impostor = ethers.Wallet.createRandom(); // 冒充者：专门用于反证
const PAYTO = ethers.Wallet.createRandom().address; // 一次性收款地址
const VALUE = "100000"; // 0.1 USDC (6 decimals)

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
const DOMAIN = { name: REG.domainName, version: REG.domainVersion, chainId: REG.chainId, verifyingContract: REG.asset };

// ⛔ 反例 domain：就是 X3 那次写错的版本。留在这里不是为了纪念，是把它钉在测试里。
const BAD_DOMAIN = { ...DOMAIN, name: "USD Coin" };

function newAuthorization({ ttl = 600, skew = 30, before } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    from: payer.address,
    to: PAYTO,
    value: VALUE,
    validAfter: String(now - skew),
    validBefore: String(before ?? now + ttl),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
}

async function sign(auth, wallet = payer, domain = DOMAIN) {
  return await wallet.signTypedData(domain, TYPES, auth);
}

// ── 断言器 ──────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const evidence = [];
const check = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  const row = { status: cond ? "✅" : "❌", name, detail: String(detail).slice(0, 300) };
  evidence.push(row);
  console.log(` ${row.status} ${name}${detail ? `\n     ${String(detail).slice(0, 300)}` : ""}`);
};

console.log("\n" + "═".repeat(78));
console.log(" XAF · Stage F1 —— 真链结算闭环验证 (Base Sepolia, testnet only)");
console.log("═".repeat(78));
console.log(` asset    : ${REG.asset}  (symbol=${REG.symbol} decimals=${REG.decimals})`);
console.log(` domain   : name=${JSON.stringify(REG.domainName)} version=${REG.domainVersion}`);
console.log(` payer    : ${payer.address}`);
console.log(` payTo    : ${PAYTO}`);

// ── 2. 建 Relayer（此处就带双重链熔断）──────────────────────────────────────
let relayer;
try {
  relayer = await createRelayer({
    chainId: REG.chainId,
    rpcUrl: REG.rpc ?? "https://sepolia.base.org",
    asset: REG.asset,
    decimals: REG.decimals,
    privateKey: RELAYER_KEY,
    explorerTx: "https://sepolia.basescan.org/tx/{hash}",
    gasFloorEth: Number(process.env.XAF_GAS_FLOOR_ETH ?? 0.01),
    maxFeeGwei: Number(process.env.XAF_MAX_FEE_GWEI ?? 5),
  });
  console.log(` relayer  : ${relayer.address}\n`);
} catch (e) {
  console.error(`❌ Relayer 初始化失败：${e?.code ?? ""} ${e?.message ?? e}`);
  process.exit(1);
}

const health = await relayer.health();
console.log(" ┌─ Relayer 水位（安全阀数据源）──────────────────────────────────");
console.log(` │ ETH  : ${health.eth}   (gas 下限 ${health.gasFloorEth})`);
console.log(` │ 链   : ${health.network} chainId=${health.chainId}`);
for (const a of health.alerts) console.log(` │ [${a.level}] ${a.code}: ${a.message}`);
console.log(" └────────────────────────────────────────────────────────────\n");

const payerState = await relayer.payerState(payer.address);
console.log(` payer 余额：${payerState.balance} ${REG.symbol}\n`);

const funded = health.ok && payerState.balanceAtomic !== "0";

// ── 3. 差分 dry-run —— 让合约本人说话 ───────────────────────────────────────
console.log("── A. 差分 dry-run（eth_call 在真实节点上执行合约字节码，不花 gas）──\n");

const base = newAuthorization();
const goodSig = await sign(base);
const A1 = await relayer.dryRun({ auth: base, signature: goodSig });
check(
  "A1 有效签名 ⇒ 未被理由为签名的 revert 拒绝",
  !A1.wouldSucceed ? !/invalid signature|authorization is used|Signature/i.test(`${A1.revert?.kind} ${A1.revert?.reason ?? ""}`) : true,
  A1.wouldSucceed ? "✅ 完全可执行（payer 已有余额）" : `合约返回 ${A1.revert?.kind}: ${A1.revert?.reason ?? A1.revert?.selector}  ⇒ 晚阶段（余额/转账）才失败，说明签名已被合约接受`,
);

const wrongSignerSig = await sign(base, impostor);
const A2 = await relayer.dryRun({ auth: base, signature: wrongSignerSig });
check(
  "A2 冒充者签名 ⇒ 合约报签名无效（对照组）",
  /invalid signature|Signature/i.test(`${A2.revert?.kind} ${A2.revert?.reason ?? ""}`),
  `${A2.revert?.kind}: ${A2.revert?.reason ?? A2.revert?.selector ?? JSON.stringify(A2.revert)}`,
);

const badDomainSig = await sign(base, payer, BAD_DOMAIN);
const A3 = await relayer.dryRun({ auth: base, signature: badDomainSig });
check(
  "A3 错 domain（name=\"USD Coin\"，X3 那次的自证幻觉）⇒ 合约报签名无效",
  /invalid signature|Signature/i.test(`${A3.revert?.kind} ${A3.revert?.reason ?? ""}`),
  `${A3.revert?.kind}: ${A3.revert?.reason ?? A3.revert?.selector ?? JSON.stringify(A3.revert)}`,
);

check(
  "A1 与 A3 必须给出不同结果（否则证明力为零）",
  JSON.stringify(A1.revert) !== JSON.stringify(A3.revert) || A1.wouldSucceed !== A3.wouldSucceed,
  `A1=${A1.revert?.reason ?? "ok"} | A3=${A3.revert?.reason ?? "ok"}`,
);

const expiredAuth = newAuthorization({ before: Math.floor(Date.now() / 1000) - 10 });
const S4 = await sign(expiredAuth);
const A4 = await relayer.dryRun({ auth: expiredAuth, signature: S4 });
check("A4 过期凭证 ⇒ 合约报 authorization is expired", /expired/i.test(`${A4.revert?.reason ?? ""}`), `${A4.revert?.kind}: ${A4.revert?.reason ?? A4.revert?.selector}`);

const futureAuth = newAuthorization();
futureAuth.validAfter = String(Math.floor(Date.now() / 1000) + 3600);
const S5 = await sign(futureAuth);
const A5 = await relayer.dryRun({ auth: futureAuth, signature: S5 });
check("A5 未生效凭证 ⇒ 合约报 not yet valid", /not yet valid/i.test(`${A5.revert?.reason ?? ""}`), `${A5.revert?.kind}: ${A5.revert?.reason ?? A5.revert?.selector}`);

// ── 4. submit() 守卫：没钱时应当拒绝广播，一个字节 gas 都不烧 ─────────────────
console.log("\n── B. 广播守卫（验证 fail-closed，而不是 fail-silent）──\n");
const provider = new ethers.JsonRpcProvider(REG.rpc ?? "https://sepolia.base.org");
const nonceBefore = await provider.getTransactionCount(relayer.address, "latest");

async function expectGuard(label, auth, signature, wantCode) {
  try {
    await relayer.submit({ auth, signature });
    check(label, false, "⚠️ 竟然放行 —— 这是安全问题");
  } catch (e) {
    check(label, e?.code === wantCode, `code=${e?.code}  ${String(e?.message ?? e).slice(0, 160)}`);
  }
}

await expectGuard("B1 余额不足 ⇒ payer_insufficient_funds 且不广播", newAuthorization(), await sign(newAuthorization()), "payer_insufficient_funds");
await expectGuard("B2 过期凭证 ⇒ authorization_expired 且不广播", expiredAuth, S4, "authorization_expired");

const nonceAfter = await provider.getTransactionCount(relayer.address, "latest");
check("B3 上述失败均未广播（relayer nonce 未变）", nonceBefore === nonceAfter, `before=${nonceBefore} after=${nonceAfter}`);

// ── 5. 真广播闭环（缺专项资金就必须明确跳过，不允许假装完成）──────────────────
console.log("\n── C. 真实广播闭环 ──\n");
let txInfo = null;

if (!FULL || !funded) {
  const why = !FULL ? "未传 --full" : "资金未就绪";
  console.log(` ⏳ 跳过真广播（${why}）。`);
  console.log(`    前置：Relayer ETH ≥ ${health.gasFloorEth}（现状 ${health.eth}）且 Payer ${REG.symbol} > 0（现状 ${payerState.balance}）`);
  if (FULL) {
    console.log("\n    给 Relayer 领 gas（任选一个，都无需提交任何个人证件）：");
    console.log("      · Bware Labs   https://bwarelabs.com/faucets/base-sepolia     0.025 ETH/天，仅需验证码，无需注册");
    console.log("      · Superchain   https://console.optimism.io/faucet             0.05 ETH/天（需视当前规则）");
    console.log("      · PoW Faucet   https://ethereum-ecosystem.com/                浏览器算力换币，无需登录");
    console.log("    给 Payer 领测试 USDC：");
    console.log("      · Circle       https://faucet.circle.com/                     选 Base Sepolia；带 reCAPTCHA，我代为自动领取的口子一律不碰");
    console.log("    ⛔ 任何页面索要手机号 / 身份证 / 企业认证 / 主网余额 ⇒ 立刻停止，换下一个。");
  }
} else {
  const auth = newAuthorization();
  const signature = await sign(auth);
  try {
    txInfo = await relayer.submit({ auth, signature });
    check("C1 真实广播成功", /^0x[0-9a-fA-F]{64}$/.test(txInfo.txHash), `tx=${txInfo.txHash} block=${txInfo.blockNumber} gas=${txInfo.gasUsed}`);
    check("C2 authorization 已被链上标记为已用", await relayer.authorizationUsed(auth.from, auth.nonce) === true, `nonce=${auth.nonce}`);
    const after = await relayer.payerState(auth.to);
    check("C3 收款方余额增加", Number(after.balance) > 0, `payTo=${after.address} balance=${after.balance}`);
    console.log(`\n 🔗 ${txInfo.explorerUrl}`);
  } catch (e) {
    check("C1 真实广播成功", false, `${e?.code ?? ""} ${String(e?.message ?? e).slice(0, 200)}${e?.extra?.revert ? ` revert=${JSON.stringify(e.extra.revert)}` : ""}`);
  }
}

/** 端到端：外部 Agent 视角 —— 不带钱被 402 拦，带钱被放行并结算 */
async function runHttpLoop({ expectSuccess = false } = {}) {
  console.log("\n── D. 端到端（Worker ↔ live facilitator ↔ 真实 Base Sepolia）──\n");
  console.log(`    期望结果：${expectSuccess ? "200 + 真 txHash（已注资）" : "402 且不交付一个字节（未注资 → fail-closed 检验）"}\n`);
  const child = spawn(process.execPath, [join(HERE, "facilitator_mock.mjs"), String(FACIL_PORT)], {
    env: { ...process.env, RELAYER_MODE: "live", XAF_GAS_FLOOR_ETH: process.env.XAF_GAS_FLOOR_ETH ?? "0.01" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`   ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`   ${d}`));

  // 等 facilitator 起来
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${FACILITATOR}/health`);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const auth = newAuthorization();
  const signature = await sign(auth);
  const proof = Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature, authorization: auth } }),
  ).toString("base64");

  const env = {
    XAF_NODE_ID: "ghost-node-00",
    XAF_TOOLSET_VERSION: "x1.0",
    XAF_MCP_PROTOCOL_VERSION: "2025-06-18",
    X402_MODE: "strict",
    X402_NETWORK: "base-sepolia",
    X402_FACILITATOR_URL: FACILITATOR,
    X402_FACILITATOR_TIMEOUT_MS: "15000",
    XAF_TESTNET_USDC: REG.asset,
    XAF_TESTNET_PAYTO: PAYTO,
    XAF_CHAINS_VERIFIED: '{"84532":true}',
    XAF_FREE_QUOTA_JSON: "{}",
    XAF_CORS_ORIGINS: "*",
    XAF_LOG_LEVEL: "info",
  };

  const mkReq = (withPay) =>
    new Request("https://xaf-shadow-node.workers.dev/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(withPay ? { "x-payment": proof } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rights_precheck", arguments: { content: "我的插画被侵权，想做数据确权" } } }),
    });

  const noPay = await worker.fetch(mkReq(false), env, {});
  check("D1 无支付凭证 ⇒ 402", noPay.status === 402, `status=${noPay.status}`);

  const paid = await worker.fetch(mkReq(true), env, {});
  const paidJson = await paid.json().catch(() => null);
  const receiptHeader = paid.headers.get("x-payment-response");
  const receipt = receiptHeader ? JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) : null;
  const settledTx = receipt?.settlement?.txHash;

  if (expectSuccess) {
    check("D2 带凭证 ⇒ 200 且数据交付", paid.status === 200 && !!paidJson?.result, `status=${paid.status}`);
    check("D3 结算回执带真 txHash 且非模拟", !!settledTx && receipt?.settlement?.simulated === false, JSON.stringify(receipt?.settlement ?? null).slice(0, 220));
    if (settledTx) console.log(`\n 🔗 链上证据： https://sepolia.basescan.org/tx/${settledTx}`);
  } else {
    check("D2 未注资 ⇒ 402（不放行）", paid.status === 402, `status=${paid.status}`);
    check("D3 未注资 ⇒ 一个字节数据都不交付", paidJson?.result?.structuredContent === undefined, JSON.stringify(paidJson ?? null).slice(0, 200));
    check(
      "D4 拒因如实告知（不是含糊失败）",
      ["payer_insufficient_funds", "relayer_gas_below_floor"].includes(receipt?.settlement?.reason ?? ""),
      `reason=${receipt?.settlement?.reason ?? null}`,
    );
  }

  const replay = await worker.fetch(mkReq(true), env, {});
  check("D5 同一凭证重放 ⇒ 拒绝", replay.status === 402, `status=${replay.status}`);

  child.kill();
}

// ── 5b. 端到端 HTTP 闭环 —— 无论有没有钱都跑。
//        没钱时也必须「402 + 一个字节数据都不给」，这是 fail-closed 的实战检验，
//        不是我在单元守卫里自己说了算。
await runHttpLoop({ expectSuccess: funded && FULL });

// ── 6. 证据落盘 ─────────────────────────────────────────────────────────────
const outFile = join(ROOT, "..", "reports", "f1_evidence.json");
writeFileSync(
  outFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      network: { chainId: REG.chainId, name: REG.network, rpc: REG.rpc, asset: REG.asset, symbol: REG.symbol, decimals: REG.decimals },
      domain: { name: REG.domainName, version: REG.domainVersion, separator: REG.domainSeparator },
      relayer: { address: relayer.address, eth: health.eth, ok: health.ok },
      payer: { address: payer.address, balance: payerState.balance },
      funded,
      fullAttempted: FULL,
      tx: txInfo,
      summary: { pass, fail },
      checks: evidence,
    },
    null,
    2,
  ),
  "utf8",
);

console.log("\n" + "═".repeat(78));
console.log(` 结果： PASS ${pass} / FAIL ${fail}     证据： ${outFile}`);
console.log("═".repeat(78) + "\n");
process.exit(fail === 0 ? 0 : 1);
