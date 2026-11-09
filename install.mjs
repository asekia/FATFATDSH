/**
 * dsh-wire-forge CLI：检查 / 补打 / 回滚适配器补丁，以及安装内核。
 *
 * 正常情况下**不需要跑它**——插件加载时 index.mjs 的 apply() 会自动打补丁。
 * 这个 CLI 只在三种场合用：
 *   --check    升级后确认补丁还在不在
 *   --apply    手动补回（不想重启两次时）
 *   --revert   干净回退
 *   --kernel   把仓库自带的内核装到 ~/.dsh/armor.md（插件自举也会种，CLI 用于手动刷新）
 *
 * 用法：
 *   node install.mjs --check
 *   node install.mjs --apply
 *   node install.mjs --revert
 *   node install.mjs --kernel
 *
 * --dsh <路径> 指定 dsh 的 node_modules/@deepseek-ai 目录；不给则自动探测。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectDshRoot, buildTargets, checkTarget, applyTarget, revertTarget } from "./patch-adapters.mjs";

const SELF = dirname(fileURLToPath(import.meta.url));

function argOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const DSH_ROOT = argOf("--dsh", process.env.DSH_FORGE_DSH_ROOT || detectDshRoot());

function forgeModuleUrl() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  const installed = join(home, "profiles", argOf("--profile", process.env.DSH_FORGE_PROFILE || "default"), "node_modules", "dsh-wire-forge", "index.mjs");
  const target = existsSync(installed) ? installed : join(SELF, "index.mjs");
  return `file:///${target.replace(/\\/g, "/")}`;
}

function installKernel() {
  const src = join(SELF, "docs", "armor.md");
  if (!existsSync(src)) {
    console.log("docs/armor.md 不在包里，跳过内核安装");
    return;
  }
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  const dst = join(home, "armor.md");
  const incoming = readFileSync(src, "utf8");
  if (existsSync(dst) && readFileSync(dst, "utf8") === incoming) {
    console.log(`kernel: 已是当前版本 ${dst}`);
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, incoming, "utf8");
  console.log(`kernel: 已写入 ${dst}`);
}

function formatCheck(outcome) {
  if (outcome.state === "installed") return `${outcome.name}: installed`;
  if (outcome.state === "missing-file") return `${outcome.name}: missing-file`;
  return `${outcome.name}: partial  缺 ${outcome.missing.join(",")}`;
}

function run() {
  if (process.argv.includes("--kernel")) {
    installKernel();
    return;
  }
  if (DSH_ROOT === "") {
    console.log("找不到 dsh 安装目录，用 --dsh <路径> 指定 node_modules/@deepseek-ai");
    return;
  }
  const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--revert") ? "revert" : "check";
  console.log(`dsh=${DSH_ROOT}`);
  const targets = buildTargets(DSH_ROOT, forgeModuleUrl());
  for (const target of targets) {
    if (mode === "apply") {
      const outcome = applyTarget(target);
      console.log(outcome.results?.length ? `${outcome.name}: ${outcome.results.join("  ")}` : `${outcome.name}: ${outcome.state}`);
    } else if (mode === "revert") {
      const outcome = revertTarget(target);
      console.log(outcome.foreign ? `${outcome.name}: 已跳过——文件里有其他工具的 ${outcome.foreign.join(" ")}` : `${outcome.name}: ${outcome.state}`);
    } else {
      console.log(formatCheck(checkTarget(target)));
    }
  }
}

run();
