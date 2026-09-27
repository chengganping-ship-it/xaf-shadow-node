/**
 * F1 —— 一次性 Relayer / Payer 钱包生成与水位检查
 * =========================================================
 * 目标：让「动钱」这件事只发生在一个**用完即弃**的身份上，
 *       与任何个人钱包、交易所账户、冷钱包零交集。
 *
 * 产出：`.env.relayer`（私钥唯一落地点）
 *   - 由 .gitignore 硬拦截（pattern: .env* / *.relayer）
 *   - Windows 上用 icacls 收紧到当前用户
 *   - `--rotate` 可销毁重建
 *
 * 两个角色：
 *   RELAYER = 提交交易、付 gas ⇒ 需要 Base Sepolia **原生 ETH**
 *   PAYER   = 被扣 USDC、签 EIP-3009 ⇒ 只需要 **测试网 USDC**，一个 wei ETH 都不用有
 *             （这正是 EIP-3009 `transferWithAuthorization` 的意义：gasless for payer）
 *
 * 用法：
 *   node test/gen_relayer_wallet.mjs            # 首次生成或复用现有，打印地址 + 水龙头指引
 *   node test/gen_relayer_wallet.mjs --check    # 只查余额
 *   node test/gen_relayer_wallet.mjs --rotate   # 作废旧的、生成新的
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENVF = join(ROOT, ".env.relayer");
const GITIGNORE = join(ROOT, ".gitignore");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const ROTATE = args.has("--rotate");

const RPC = process.env.XAF_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EXPLORER = "https://sepolia.basescan.org/address/{addr}";

// ── 0. .gitignore 硬拦截：缺哪条补哪条，写完立刻复核 ────────────────────────
const REQUIRED_IGNORES = [".env*", "*.relayer", "!*.relayer.example"];
function ensureGitignore() {
  const cur = existsSync(GITIGNORE) ? readFileSync(GITIGNORE, "utf8") : "";
  const lines = cur.split(/\r?\n/).filter(Boolean);
  const missing = REQUIRED_IGNORES.filter((p) => !lines.some((l) => l.trim() === p));
  if (missing.length) {
    const next = `${cur.replace(/\s*$/, "")}\n\n# F1: 一次性钱包私钥唯一落地点，永不允许进版本库\n${missing.join("\n")}\n`;
    writeFileSync(GITIGNORE, next, "utf8");
    console.log(`🔒 .gitignore 已补齐 ${missing.length} 条： ${missing.join(", ")}`);
  }
  return missing;
}

function tightenPermissions(file) {
  if (process.platform !== "win32") {
    try {
      execFileSync("chmod", ["600", file]);
      return "posix 0600";
    } catch {
      return "chmod 失败（自行加固）";
    }
  }
  try {
    // 移除继承，仅保留当前用户读写；失败也要明说出来，不假装加固成功
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { stdio: "pipe" });
    return "Windows ACL: 仅当前用户";
  } catch (e) {
    return `icacls 失败（${String(e?.message ?? e).slice(0, 60)}）— 请手动处理`;
  }
}

function gitWouldIgnore(file) {
  try {
    const out = execFileSync("git", ["check-ignore", "-v", file], { cwd: ROOT, stdio: "pipe" }).toString();
    // git check-ignore -v 输出格式：<源>:<行>:<pattern>\t<path>
    const parts = out.trim().split(/\t/);
    return parts[0] ? { ignored: true, by: parts[0] } : { ignored: true, by: out.trim() };
  } catch {
    return { ignored: false };
  }
}

// ── 1. 生成或复用 ────────────────────────────────────────────────────────────
let relayerKey = process.env.XAF_RELAYER_PRIVATE_KEY ?? null;
let payerKey = process.env.XAF_PAYER_PRIVATE_KEY ?? null;
let source = "环境变量";

if (!relayerKey && existsSync(ENVF) && !ROTATE) {
  const raw = readFileSync(ENVF, "utf8");
  const m = /^XAF_RELAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m.exec(raw);
  const p = /^XAF_PAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m.exec(raw);
  if (m) relayerKey = m[1];
  if (p) payerKey = p[1];
  source = ENVF;
}

if (!relayerKey || ROTATE) {
  ensureGitignore();
  relayerKey = `0x${randomBytes(32).toString("hex")}`;
  payerKey = `0x${randomBytes(32).toString("hex")}`;
  const body = [
    "# ⛔ 一次性测试网钱包 —— 严禁 commit、严禁分享、严禁与主网发生任何关系",
    `# generated: ${new Date().toISOString()}`,
    `# network:   Base Sepolia (chainId 84532, testnet)`,
    "",
    "XAF_RELAYER_PRIVATE_KEY=" + relayerKey,
    "XAF_PAYER_PRIVATE_KEY=" + payerKey,
    "",
  ].join("\n");
  writeFileSync(ENVF, body, "utf8");
  const perm = tightenPermissions(ENVF);
  source = "新建";
  console.log(`\n🔑 .env.relayer 已写入（${source}）：${ENVF}`);
  console.log(`   权限收紧：${perm}`);
  if (ROTATE) console.log("   ↪ --rotate：旧密钥已作废，如曾外泄请视其为一个临时性**无用**测试钱包，无需处置（里面从来没钱）");
}

const ig = ensureGitignore();
const check = gitWouldIgnore(ENVF);
console.log(`\n🔒 git 拦截复核：${check.ignored ? `✅ 命中规则 [${check.by}]` : "❌ 未被忽略 —— 立刻停下排查"}${ig.length ? `（本轮补齐 ${ig.length} 条规则）` : ""}`);
if (!check.ignored) {
  console.error("\n🛑 aborted: 私钥文件不在 .gitignore 覆盖范围，不允许继续。");
  process.exit(1);
}

// ── 2. 地址与余额 ────────────────────────────────────────────────────────────
const relayer = new ethers.Wallet(relayerKey);
const payer = payerKey ? new ethers.Wallet(payerKey) : null;

console.log("\n" + "═".repeat(72));
console.log(" F1 · 一次性测试网钱包");
console.log("═".repeat(72));
console.log(` 来源       : ${source}`);
console.log(` RELAYER    : ${relayer.address}   （提交交易、付 gas）`);
console.log(`              区块浏览器 → ${EXPLORER.replace("{addr}", relayer.address)}`);
if (payer) {
  console.log(` PAYER      : ${payer.address}   （签 EIP-3009、被扣 USDC，无需 ETH）`);
  console.log(`              区块浏览器 → ${EXPLORER.replace("{addr}", payer.address)}`);
}
console.log("═".repeat(72));

if (CHECK_ONLY) {
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(RPC);
    const net = await provider.getNetwork();
    console.log(`\n RPC        : ${RPC}  → chainId ${net.chainId} ${net.chainId === 84532n || Number(net.chainId) === 84532 ? "(Base Sepolia ✅)" : "(⛔ 非 84532，熔断)"}`);
    if (Number(net.chainId) !== 84532) process.exit(3);

    const tok = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], provider);
    const [rEth, pEth, symbol] = await Promise.all([
      provider.getBalance(relayer.address),
      payer ? provider.getBalance(payer.address) : Promise.resolve(null),
      tok.symbol().catch(() => "USDC"),
    ]);
    const rUsdc = await tok.balanceOf(relayer.address);
    const pUsdc = payer ? await tok.balanceOf(payer.address) : null;

    const f = (v, d = 18) => ethers.formatUnits(v, d);
    console.log(`\n ┌─ 水位 ─────────────────────────────────────────────`);
    console.log(` │ RELAYER  ETH   : ${f(rEth)}  ${rEth >= ethers.parseEther("0.01") ? "✅ 够 gas" : "⏳ 不足 0.01，需要领币"}`);
    console.log(` │ RELAYER  USDC  : ${f(rUsdc, 6)} ${symbol}`);
    if (payer) {
      console.log(` │ PAYER    ETH   : ${f(pEth)}  （不必需，payer 走 gasless，0 也正常）`);
      console.log(` │ PAYER    USDC  : ${f(pUsdc, 6)} ${symbol}  ${pUsdc > 0n ? "✅ 可签名支付" : "⏳ 需要领测试币"}`);
    }
    console.log(` └────────────────────────────────────────────────────`);

    const ready = rEth >= ethers.parseEther("0.01") && (!payer || pUsdc > 0n);
    console.log(`\n ${ready ? "✅ 资金就绪，可以跑 `node test/f1_realchain_run.mjs`" : "⏳ 资金未就绪 —— 按下表手动领一次（这一步必须由人点，我不替你绕过任何验证）"}`);
    if (!ready) {
      console.log(`
 ┌─ 领币清单（全部为测试网，零法币、零主网）───────────────────────────
 │ ① RELAYER 需要 Base Sepolia 原生 ETH（付 gas）
 │    · CDP Faucet       https://portal.cdp.coinbase.com/products/faucet
 │    · Alchemy Faucet   https://www.alchemy.com/faucets/base-sepolia
 │    · Chainstack       https://faucet.chainstack.com/base-sepolia-faucet
 │    → 多数站点有速率限制/人机校验，属正常；余额到帐后重跑 --check
 │
 │ ② PAYER 需要 Base Sepolia USDC
 │    · Circle Faucet    https://faucet.circle.com/  （每地址/每链/2h 限 20 USDC，带 reCAPTCHA）
 │    → reCAPTCHA 我不绕、也不代为自动领取；这恰好是我们要的人机边界
 │
 │ ⛔ 任何页面要求手机号 / 身份证 / 企业认证 / 绑卡 ⇒ 立刻停手，换下一个水龙头
 └─────────────────────────────────────────────────────────────────`);
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ 链查询失败：${String(e?.message ?? e).slice(0, 200)}`);
    console.error("   （若为本机网络问题，稍后重试即可；不影响已生成的钱包）");
    process.exit(4);
  }
}

console.log("\n下一步： node test/gen_relayer_wallet.mjs --check    # 查水位并给出精确领币清单");
