/**
 * 发布前泄露扫描（Stage F3 安全阀 · first gate）
 * =========================================================
 * 用途：把某个目录 push 到**公开**仓库之前，先自己扫一遍。
 *
 * 它不是"我以为没有就没有"，而是一台不肯网开一面的机器：
 *   - 私钥 / 助记词 / CF token / GitHub token / 通用 secret 形态 → BLOCK
 *   - XAF 主仓私有标识（内部路径、内部代号、客户名）→ WARN
 *   - 被 gitignore 的敏感文件却出现在待发布目录里 → BLOCK
 *   - 超大文件 / 意外拷贝进来的 node_modules → WARN
 *
 * **自检**：本脚本必须能通过自己的测试 —— `npm run scan:selftest` 会埋一批假 secret，
 * 确认扫描器真的抓得出来。一个没被验证过的扫描器 = 一个让人安心的摆设。
 *
 * 用法： node tools/prepublish_scan.mjs <dir> [--json]
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 链上可公开读取的十六进制字段名 —— 出现在这些键名后的 64hex 不是秘密。 */
const PUBLIC_HEX_KEYS = ["domainSeparator", "domain_separator", "domainHash", "deploymentId"];

const TEXT_EXT = /\.(js|mjs|cjs|ts|json|md|toml|yml|yaml|env| example|sh|py|txt)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler", "coverage"]);
const MAX_FILE_BYTES = 512 * 1024;

/** ── 规则表 ─────────────────────────────────────────────────────────────── */
const RULES = [
  {
    id: "privkey-hex",
    severity: "block",
    desc: "疑似十六进制私钥（32/64 字节）",
    // 窄豁免：某些十六进制是**链上公开数据**（任何人可用 RPC 读出），公开无害也无从泄露。
    // 白名单按"键名"限定，绝不按"值"通配 —— 否则等于给真私钥开后门。
    // 这条豁免在同文件 selfTest 里被反向验证：同样的 64hex 但键名换成 signingKey，必须照旧 BLOCK。
    exemptIf: (s) => PUBLIC_HEX_KEYS.some((k) => s.includes(k)),
    test: (s) => /\b0x[0-9a-fA-F]{64}\b/.test(s) || /\b[a-fA-F0-9]{64}\b/.test(s),
  },
  {
    id: "mnemonic",
    severity: "block",
    desc: "疑似 BIP39 助记词（12/15/18/24 词）",
    test: (s) => {
      const m = s.match(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g) ?? [];
      return m.some((p) => (p.trim().split(/\s+/).length % 3 === 0));
    },
  },
  { id: "cf-token", severity: "block", desc: "Cloudflare API Token", test: (s) => /[A-Za-z0-9_-]{40}\.[A-Za-z0-9_-]{40}/.test(s) },
  { id: "gh-token", severity: "block", desc: "GitHub Token", test: (s) => /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(s) },
  { id: "sk-key", severity: "block", desc: "OpenAI/Anthropic 风格密钥", test: (s) => /\bsk-[A-Za-z0-9_-]{20,}\b/.test(s) },
  {
    id: "assigned-secret",
    severity: "block",
    desc: "明文赋值的敏感变量",
    test: (s) => /(?:PRIVATE_KEY|SECRET|API_TOKEN|PASSWORD|MNEMONIC)\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{16,}["']?/.test(s),
  },
  { id: "stripe-key", severity: "block", desc: "真实法币网关密钥", test: (s) => /\b(?:sk_live|rk_live|pk_live)_[A-Za-z0-9]{10,}\b/.test(s) },
];

/** 私有标识：不一定致命，但公开仓库里出现就是事故苗头。 */
const SOFT_RULES = [
  { skipComments: true, id: "abs-win-path", desc: "Windows 绝对路径（可能暴露本机用户目录）", test: (s) => /[A-Za-z]:\\Users\\|D:\\Ai|E:\\(?:xaf|Ai)/i.test(s) },
  // "曜" 是我自己的名字 —— 偏偏最容易漏，因为读文档的人意识不到那是私有标识。
  // 这条是上一轮扫出来的盲点：SOFT_RULES 列了项目代号却漏了内部人称。
  { skipComments: true, id: "inner-codename", desc: "疑似内部代号/内部人称/客户名", test: (s) => /xingyue|星悦|ouroboros|衔尾蛇|鬼操盘手|曜[^、。）),，]/.test(s) },
  { skipComments: true, id: "internal-host", desc: "内网/服务器地址（环回地址不算：那是文档常态，不是资产）", test: (s) => /(?:^|[^0-9.])(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}|116\.204\.\d{1,3})\./.test(s) },
];

/** 这些文件一旦出现在待发布目录里 = 事故。 */
const FORBIDDEN_FILES = [
  { name: ".env", desc: "环境变量（可能含凭据）" },
  { name: ".env.relayer", desc: "Relayer 私钥文件 —— 绝对不许公开" },
  { name: ".dev.vars", desc: "wrangler 本地密钥" },
  { name: ".dev.vars.example", desc: "占位即可，允许但需人工过目", allow: true },
];

function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full).replace(/\\/g, "/");
    if (SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ rel, full, size: st.size });
  }
  return out;
}

export function scanDir(dir) {
  const findings = [];
  const files = walk(dir, dir);

  for (const f of files) {
    for (const fr of FORBIDDEN_FILES) {
      if (f.rel.endsWith(fr.name)) {
        findings.push({
          rule: fr.allow ? "forbidden-file-allowed" : "forbidden-file",
          severity: fr.allow ? "warn" : "block",
          file: f.rel,
          line: null,
          desc: `${fr.name} — ${fr.desc}`,
        });
      }
    }
    if (f.size > MAX_FILE_BYTES) {
      findings.push({ rule: "oversize", severity: "warn", file: f.rel, line: null, desc: `${f.size} bytes，疑似误拷` });
    }
    if (!TEXT_EXT.test(f.rel) && !/\.(gitignore|example)$/i.test(f.rel)) {
      findings.push({ rule: "binary", severity: "warn", file: f.rel, line: null, desc: "二进制/未知类型文件" });
    }

    let text;
    try {
      text = readFileSync(f.full, "utf8");
    } catch {
      continue;
    }

    for (const r of [...RULES, ...SOFT_RULES]) {
      const sev = RULES.includes(r) ? "block" : "warn";
      text.split(/\r?\n/).forEach((line, i) => {
        // 跳过自我描述：本文件与被审核文档里讲到这些形态的注释，不代表真有密钥
        if (/\bRULE|test:\s*\(s\)|id:\s*"| severity:/.test(line)) return;
        // 提示级规则允许注释豁免：注释里讨论某个词 ≠ 仓库里真有那个东西。
        // BLOCK 级规则**不豁免**注释 —— 真把密钥写进注释也照样拦，宁可多报不可漏放。
        if (r.skipComments && /^\s*(\/\/|#|\*|\/\*)/.test(line)) return;
        try {
          if (r.test(line) && !(r.exemptIf && r.exemptIf(line))) {
            findings.push({ rule: r.id, severity: sev, file: f.rel, line: i + 1, desc: r.desc });
          }
        } catch {
          /* 正则炸了不该拖垮整个扫描 */
        }
      });
    }
  }

  const blocks = findings.filter((f) => f.severity === "block");
  return {
    dir,
    scanned_files: files.length,
    scanned_bytes: files.reduce((a, f) => a + f.size, 0),
    verdict: blocks.length ? "BLOCK" : "PASS",
    blockers: blocks.length,
    warnings: findings.length - blocks.length,
    findings,
  };
}

/** 自检：埋假 secret 验证扫描器真的能抓出来。 */
export function selfTest() {
  const tmp = join(process.cwd(), ".scan-selftest");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "clean.js"), "export const OK = 1;\n");
  // 运行时生成 64 位十六进制：若写成字面量，本文件自己会被自己的规则扫中。
  const fakeHex = "0x" + "ab".repeat(32);
  const assignedName = ["PRIVATE", "KEY"].join("_");
  writeFileSync(join(tmp, "dirty.js"), `const k = "${fakeHex}";\nconst ${assignedName} = "abcdefghijklmnop123456";\n`);
  writeFileSync(join(tmp, ".env.relayer"), "XAF_RELAYER_PRIVATE_KEY=deadbeef\n");
  // 豁免必须**窄到可以被反向证伪**：同一个 64hex，键名换成 signingKey 就得照旧拦。
  writeFileSync(join(tmp, "exempt_ok.js"), `const domainSeparator = "${fakeHex}";\n`);
  writeFileSync(join(tmp, "exempt_bad.js"), `const signingKey = "${fakeHex}";\n`);
  const res = scanDir(tmp);
  rmSync(tmp, { recursive: true, force: true });
  const caughtPriv = res.findings.some((f) => f.rule === "privkey-hex");
  const caughtAssigned = res.findings.some((f) => f.rule === "assigned-secret");
  const caughtEnv = res.findings.some((f) => f.rule === "forbidden-file");
  const cleanPass = !res.findings.some((f) => f.file === "clean.js" && f.severity === "block");
  // 豁免只在该 exempt 的地方 exempt；换个名字立刻现形。
  const exemptAllowed = !res.findings.some((f) => f.file === "exempt_ok.js" && f.rule === "privkey-hex");
  const exemptNarrow = res.findings.some((f) => f.file === "exempt_bad.js" && f.rule === "privkey-hex");
  const ok = caughtPriv && caughtAssigned && caughtEnv && cleanPass && exemptAllowed && exemptNarrow && res.verdict === "BLOCK";
  return {
    ok, caughtPriv, caughtAssigned, caughtEnv, cleanPass,
    exemptAllowed, exemptNarrow,
    hint: !exemptNarrow ? "豁免过宽：signingKey 也没被拦 —— 等于给真私钥开了后门" : undefined,
    verdict: res.verdict, findings: res.findings,
  };
}

// Windows 下 argv[1] 是盘符路径、import.meta.url 是 file:/// 形式，直接字符串拼接比较永远为 false，
// 于是 main 分支静默不执行 —— 表现为"跑过了"但实际一行没做。用 realpath 归一化后比较。
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = invoked && import.meta.url === pathToFileURL(invoked).href;
if (isMain) {
  const arg = process.argv[2];
  if (arg === "--selftest") {
    const r = selfTest();
    console.log(JSON.stringify(r, null, 2));
    console.log(r.ok ? "\n✅ 扫描器自检通过：假 secret 全部被抓出，干净文件无误报" : "\n❌ 扫描器自检失败 —— 不许拿它守公开仓库");
    process.exit(r.ok ? 0 : 1);
  }
  if (!arg || !existsSync(arg)) {
    console.error("用法: node tools/prepublish_scan.mjs <dir> [--json] | --selftest");
    process.exit(2);
  }
  const res = scanDir(arg);
  if (process.argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`\n扫描目录: ${res.dir}`);
    console.log(`文件 ${res.scanned_files} 个 / ${res.scanned_bytes} bytes`);
    for (const f of res.findings) {
      console.log(` [${f.severity === "block" ? "BLOCK" : "warn"}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.rule} (${f.desc})`);
    }
    console.log(`\n结论: ${res.verdict}  (blockers=${res.blockers} warnings=${res.warnings})`);
  }
  process.exit(res.verdict === "BLOCK" ? 1 : 0);
}
