/**
 * XAF Phase X — Stage F1：自托管 Testnet Relayer（真链结算）
 * =====================================================================
 * 这是「钱真的动」的那一层：接收 x402 的 settle 请求，把 payer 签好的
 * EIP-3009 `TransferWithAuthorization`  authorization 真实广播到 Base Sepolia。
 *
 * 为什么能代付 gas：
 *   EIP-3009 里 `receiveWithAuthorization` 要求 msg.sender == to（收款方自己提交），
 *   而 `transferWithAuthorization` 允许**任意第三方**提交 —— value 由 from 出、gas 由
 *   提交者（= Relayer）出。所以 payer 只需要有测试网 USDC，**不需要 ETH**。
 *   ⛔ 主网上这套逻辑会让 Relayer 变成替人垫 gas 的冤大头 + 事实上的资金通道实体，
 *      所以本文件所有可执行路径都被「测试网白名单 + 主网黑名单」双重熔断焊死：
 *      不是靠自觉，而是拿不到白名单外的 chainId 就根本构造不出 Relayer 实例。
 *
 * ⛔ 红线（代码级，不是注释级）
 *   1. createRelayer() 建连后立刻读链上 chainId，与期望值不等 ⇒ 抛错；
 *      落在 MAINNET_BLOCKLIST ⇒ 抛错。这是**双保险**：配置错 + RPC 被指到主网都拦得住。
 *   2. 私钥只从这个函数的入参进来，永不打日志、永不写盘、永不出进程边界。
 *   3. ETH 低于 gasFloorEth ⇒ 拒绝广播（拒绝才是安全行为，比把 tx 发出去再 revert 强）。
 *   4. 广播前先 estimateGas + eth_call dry-run ⇒ 会 revert 的交易一个字节 gas 都不烧。
 *
 * 依赖：ethers v6。**仅本地/自托管运行，绝不被 src/index.js 引用**（Worker 包里不能有它）。
 */

import { ethers } from "ethers";

/** 允许结算的网络 —— 只有测试网。想加链？先跑 test/verify_chain_constants.mjs 验证 domain。 */
export const TESTNET_ALLOWLIST = { 84532: "base-sepolia", 80002: "polygon-amoy" };

/** 主网/高价值公链黑名单：任何环节读到这些 chainId 一律熔断。 */
export const MAINNET_BLOCKLIST = new Set([
  1, // Ethereum
  56, // BSC
  137, // Polygon PoS
  8453, // Base
  42161, // Arbitrum One
  10, // OP Mainnet
  59144, // Linea
  501, // Solana(非 EVM，占位防误配)
  81457, // Blast
  5000, // Mantle
  1101, // Polygon zkEVM
]);

export class RelayerSafetyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "RelayerSafetyError";
    this.code = code;
    this.extra = extra;
  }
  toJSON() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

export function assertTestnetChain(chainId, where = "chainId") {
  const id = Number(chainId);
  if (MAINNET_BLOCKLIST.has(id)) {
    throw new RelayerSafetyError("mainnet_fuse", `🛑 ${where}=${id} 属于主网/黑名单链，已熔断`, { chainId: id });
  }
  if (!TESTNET_ALLOWLIST[id]) {
    throw new RelayerSafetyError("network_not_allowed", `⛔ ${where}=${id} 不在测试网白名单`, {
      allowed: Object.entries(TESTNET_ALLOWLIST).map(([k, v]) => `${k}(${v})`),
    });
  }
  return id;
}

const TOKEN_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

/**
 * 把 x402 payload 里的签名统一成 v/r/s。
 * 支持两种形态：完整 65 字节 hex；或 { v, r, s } 对象。
 */
export function normalizeSignature(signature) {
  if (signature && typeof signature === "object" && signature.r && signature.s) {
    const v = Number(signature.v);
    return { v: v < 27 ? v + 27 : v, r: String(signature.r), s: String(signature.s) };
  }
  const hex = String(signature ?? "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new RelayerSafetyError("bad_signature_shape", "签名必须是 65 字节 hex 或 {v,r,s}", {
      gotLength: hex.length,
    });
  }
  const v = parseInt(hex.slice(128, 130), 16);
  return { v: v < 27 ? v + 27 : v, r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}` };
}

/**
 * 还原 revert 数据 —— 用于「探究合约到底怎么反对我」。
 * 返回结构化结果，raw 永远保留，不猜、不美化。
 */
export function classifyRevert(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data ?? null;
  if (!data) return { kind: "unknown", reason: String(err?.shortMessage ?? err?.message ?? err).slice(0, 300), raw: null };
  if (data === "0x") return { kind: "plain_revert", selector: "0x", raw: data };

  try {
    if (data.startsWith("0x08c379a0")) {
      // Error(string)
      const abi = ethers.AbiCoder.defaultAbiCoder();
      const text = abi.decode(["string"], `0x${data.slice(10)}`)[0];
      return { kind: "Error(string)", reason: text, raw: data };
    }
    if (data.startsWith("0x4e487b71")) {
      // Panic(uint256)
      const abi = ethers.AbiCoder.defaultAbiCoder();
      const code = abi.decode(["uint256"], `0x${data.slice(10)}`)[0];
      return { kind: "Panic", reason: `panic 0x${code.toString(16)}`, raw: data };
    }
  } catch {
    /* 解码失败就落到下面当裸 selector 处理 */
  }
  return { kind: "custom_error", selector: data.slice(0, 10), raw: data };
}

/** 签名相关 revert 的关键词 —— 只用于「分类标签」，判定的硬证据是差分对照，不是关键词。 */
const SIGNATURE_REVERT_HINTS = ["invalid signature", "signature", "authorization is used", "AuthorizationUsed"];

export function revertLooksSignatureRelated(rv) {
  const blob = `${rv.kind} ${rv.reason ?? ""} ${rv.selector ?? ""}`.toLowerCase();
  return SIGNATURE_REVERT_HINTS.some((h) => blob.includes(h.toLowerCase()));
}

/**
 * 创建 Relayer 实例。
 * @param {object} cfg
 * @param {number} cfg.chainId        必须是 TESTNET_ALLOWLIST 里的（如 84532）
 * @param {string} cfg.rpcUrl         测试网 RPC
 * @param {string} cfg.asset          USDC proxy 地址（domain 用 proxy；ABI 走 proxy 亦可，会 delegatecall 转发）
 * @param {number} cfg.decimals       必须从链上校验过的注册表来，不要手填
 * @param {string} cfg.privateKey     一次性 Relayer 私钥（0x + 64hex），仅入参，不落盘
 * @param {string} [cfg.explorerTx]   浏览器模板，含 {hash} 占位
 * @param {number} [cfg.gasFloorEth]  ETH 低于此值拒绝广播（安全阀）
 * @param {number} [cfg.maxFeeGwei]   单次 gas price 上限，防公共 RPC 抖动把钱烧穿
 */
export async function createRelayer(cfg) {
  const chainId = assertTestnetChain(cfg.chainId, "relayer.chainId");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(cfg.privateKey ?? ""))) {
    throw new RelayerSafetyError("bad_private_key", "私钥格式不是 0x+64hex —— 拒绝启动（也拒绝让它在日志里露脸）");
  }
  if (!/^https?:\/\//i.test(String(cfg.rpcUrl ?? ""))) {
    throw new RelayerSafetyError("bad_rpc_url", "rpcUrl 必须是 http(s)");
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  // 运行时第一道闸：RPC 真实返回的 chainId 必须与期望一致，不一致说明配置或 RPC 被指错地方了
  const live = Number((await provider.getNetwork()).chainId);
  assertTestnetChain(live, "rpc.chainId");
  if (live !== chainId) {
    throw new RelayerSafetyError("rpc_chain_mismatch", `RPC 返回 chainId=${live}，但配置为 ${chainId} —— 拒绝广播`, {
      expected: chainId,
      got: live,
    });
  }

  const wallet = new ethers.Wallet(cfg.privateKey, provider);
  const token = new ethers.Contract(cfg.asset, TOKEN_ABI, wallet);
  const decimals = Number(cfg.decimals ?? 6);
  const gasFloor = ethers.parseEther(String(cfg.gasFloorEth ?? 0.01));
  const maxFeeWei = ethers.parseUnits(String(cfg.maxFeeGwei ?? 5), "gwei");
  const explorerTx = cfg.explorerTx ?? "";

  return {
    chainId,
    address: wallet.address,
    asset: cfg.asset,
    decimals,
    network: TESTNET_ALLOWLIST[chainId],

    /** 余额与水位：低于阈值会在 alerts 里吐出来，调用方负责报警 */
    async health() {
      const [eth, symbol] = await Promise.all([
        provider.getBalance(wallet.address),
        token.symbol().catch(() => "USDC"),
      ]);
      const usdc = await token.balanceOf(wallet.address);
      const alerts = [];
      if (eth < gasFloor) {
        alerts.push({
          level: "critical",
          code: "relayer_gas_below_floor",
          message: `Relayer ETH ${ethers.formatEther(eth)} < 下限 ${ethers.formatEther(gasFloor)}，拒绝广播`,
        });
      } else if (eth < gasFloor * 3n) {
        alerts.push({ level: "warn", code: "relayer_gas_low", message: `Relayer ETH 只剩 ${ethers.formatEther(eth)}，建议补水` });
      }
      return {
        address: wallet.address,
        chainId,
        network: TESTNET_ALLOWLIST[chainId],
        eth: ethers.formatEther(eth),
        assetSymbol: symbol,
        relayerAssetBalance: ethers.formatUnits(usdc, decimals),
        gasFloorEth: ethers.formatEther(gasFloor),
        ok: alerts.every((a) => a.level !== "critical"),
        alerts,
      };
    },

    async payerState(from) {
      const bal = await token.balanceOf(from);
      return { address: from, balanceAtomic: bal.toString(), balance: ethers.formatUnits(bal, decimals) };
    },

    async authorizationUsed(from, nonce) {
      return await token.authorizationState(from, nonce);
    },

    buildCalldata(auth, signature) {
      const { v, r, s } = normalizeSignature(signature);
      return token.interface.encodeFunctionData("transferWithAuthorization", [
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        v,
        r,
        s,
      ]);
    },

    /**
     * Dry-run：用 eth_call 在**真实节点的最新区块状态**上跑一遍。
     * 不广播、不花 gas。合约自己在链上执行这段代码，revert 原因 = 合约本人的意见。
     * @returns {{wouldSucceed:boolean, revert:object|null, calldata:string, gasEstimate:string|null}}
     */
    async dryRun({ auth, signature }) {
      const calldata = this.buildCalldata(auth, signature);
      try {
        const out = await provider.call({ to: cfg.asset, from: wallet.address, data: calldata });
        let gas = null;
        try {
          gas = (await provider.estimateGas({ to: cfg.asset, from: wallet.address, data: calldata })).toString();
        } catch {
          /* estimate 失败不影响 call 的结论 */
        }
        return { wouldSucceed: true, revert: null, calldata, gasEstimate: gas, returnData: out };
      } catch (e) {
        return { wouldSucceed: false, revert: classifyRevert(e), calldata, gasEstimate: null };
      }
    },

    /**
     * 真·广播。前置条件不满足就抛错，绝不带着「大概能过」的态度发交易。
     * @returns {{txHash:string, blockNumber:number, gasUsed:string, explorerUrl:string, real:true}}
     */
    async submit({ auth, signature }) {
      // ① 时间窗
      const now = Math.floor(Date.now() / 1000);
      if (Number(auth.validBefore) <= now) {
        throw new RelayerSafetyError("authorization_expired", "authorization 已过期，广播必 revert", {
          validBefore: Number(auth.validBefore),
          now,
        });
      }
      if (Number(auth.validBefore) < now + 30) {
        // 太接近过期：Base Sepolia 出块 2s，但从 delay 到打包仍可能翻车，提前提醒
        console.warn(`[relayer] ⚠️ authorization 仅剩 ${Number(auth.validBefore) - now}s 到期，有打包失败风险`);
      }

      // ② nonce 未被用过
      if (await token.authorizationState(auth.from, auth.nonce)) {
        throw new RelayerSafetyError("authorization_already_used", "该 nonce 已被用过（或已取消），拒绝重复结算");
      }

      // ③ payer 余额
      const payerBal = await token.balanceOf(auth.from);
      if (payerBal < BigInt(String(auth.value))) {
        throw new RelayerSafetyError(
          "payer_insufficient_funds",
          `payer 余额 ${ethers.formatUnits(payerBal, decimals)} < 需付 ${ethers.formatUnits(auth.value, decimals)}`,
          { payer: auth.from, need: String(auth.value), have: payerBal.toString() },
        );
      }

      // ④ Relayer gas 水位（安全阀）
      const eth = await provider.getBalance(wallet.address);
      if (eth < gasFloor) {
        throw new RelayerSafetyError(
          "relayer_gas_below_floor",
          `Relayer ETH ${ethers.formatEther(eth)} < 下限 ${ethers.formatEther(gasFloor)}，拒绝广播 —— 先去水龙头领测试网 ETH`,
          { address: wallet.address, faucet: true },
        );
      }

      // ⑤ 先 dry-run，会 revert 就别烧 gas
      const { v, r, s } = normalizeSignature(signature);
      const calldata = token.interface.encodeFunctionData("transferWithAuthorization", [
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        v,
        r,
        s,
      ]);
      const pre = await this.dryRun({ auth, signature });
      if (!pre.wouldSucceed) {
        const err = new RelayerSafetyError("preflight_revert", "节点 dry-run 判定这笔交易会 revert，未广播、未花 gas");
        err.extra.revert = pre.revert;
        throw err;
      }

      // ⑥ 费率：给公共 RPC 的 feeData 套个上限，防抖动把测试币烧光
      const fee = await provider.getFeeData();
      const maxFee = fee.maxFeePerGas && fee.maxFeePerGas < maxFeeWei ? fee.maxFeePerGas : maxFeeWei;
      const tip = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.01", "gwei");

      const tx = await token.transferWithAuthorization(
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        v,
        r,
        s,
        { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip > maxFee ? maxFee : tip },
      );

      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        throw new RelayerSafetyError("tx_reverted_onchain", "交易已上链但被 revert", { txHash: tx.hash });
      }

      return {
        real: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: receipt.gasPrice?.toString() ?? null,
        calldata,
        explorerUrl: explorerTx ? explorerTx.replace("{hash}", receipt.hash) : "",
      };
    },
  };
}

export default createRelayer;
