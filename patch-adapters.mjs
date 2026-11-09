/**
 * 适配器补丁：把 forge 的调用点打进 dsh 的两个 LLM 适配器。
 *
 * 两种调用方式共用这一份逻辑：
 *   - index.mjs 的 apply()：插件加载时自动跑（= dsh plugin add 后重启即生效）
 *   - install.mjs：CLI 手动跑（--check / --apply / --revert）
 *
 * 整句锚点 + 字面替换 + 标记判重。锚点对不上就报 anchor-missing，
 * 宁可不打也不打歪——打歪会改坏适配器，整个 LLM 层起不来。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const BACKUP_SUFFIX = ".dsh-wire-forge.bak";

export function detectDshRoot() {
  const fromEnv = process.env.DSH_FORGE_DSH_ROOT;
  if (fromEnv) return fromEnv;
  try {
    const root = execSync("npm root -g", { encoding: "utf8", timeout: 20000 }).trim();
    return join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
  } catch (_) {
    return "";
  }
}

/** 构造两个适配器各自的补丁表。forgeUrl 是本模块（或仓库 index.mjs）的 file:// 地址。 */
export function buildTargets(dshRoot, forgeUrl) {
  const LOAD_PI = `let __forge = null;
try { __forge = await import("${forgeUrl}"); } catch (_) { /* forge 缺失时 wire 层保持原样 */ }
`;

  const LOAD_DE = `let __forgeDe = null;
try { __forgeDe = await import("${forgeUrl}"); } catch (_) { /* forge 缺失时 wire 层保持原样 */ }
`;

  const PI_TEXT = `	// [dsh-wire-forge] 对话结构伪造。只读不改，原始消息一个字不动。
	if (__forge !== null && (__forge.shouldInject(split.systemPrompt))) {
		const forged = __forge.transform(split.systemPrompt, messages, options.model);
		return piContext(forged.systemPrompt, options, forged.messages);
	}
	return piContext(split.systemPrompt, options, messages);`;

  const PI_IMAGE = `	// [dsh-wire-forge] 带图请求走独立路径，不经过 textOnlyContext，这里同样注入。
	if (__forge !== null && (__forge.shouldInject(split.systemPrompt))) {
		const forged = __forge.transform(split.systemPrompt, split.messages, options.model);
		split.systemPrompt = forged.systemPrompt;
		split.messages = forged.messages;
	}
`;

  const DE_HEAD = `	// [dsh-wire-forge] deepseek 是独立适配器，不经过 pi-ai，这里单独注入。
	// content 用 blocks 格式，本适配器的 history 是 [{type:"text",text}] 数组。
	let __hist = history;
	let __sys = options.system;
	if (__forgeDe !== null && (__forgeDe.shouldInject(__sys))) {
		const forged = __forgeDe.transform(__sys, __hist, options.model, "blocks");
		__sys = forged.systemPrompt;
		__hist = forged.messages;
	}
`;

  return [
    {
      name: "pi-ai",
      file: join(dshRoot, "dsh-llm-pi-ai", "lib", "index.js"),
      patches: [
        {
          id: "PI_LOAD",
          mark: "let __forge = null;",
          anchor: `import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";`,
          insert: LOAD_PI + `import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";`,
        },
        {
          id: "PI_TEXT",
          mark: "const forged = __forge.transform(split.systemPrompt, messages, options.model);",
          anchor: `\treturn piContext(split.systemPrompt, options, messages);\n}`,
          insert: PI_TEXT + `\n}`,
        },
        {
          id: "PI_IMAGE",
          mark: "const forged = __forge.transform(split.systemPrompt, split.messages, options.model);",
          anchor: `\tconst split = splitSystemPrompt(options);\n\tconst requestImages = await prepareRequestImages(`,
          insert: `\tconst split = splitSystemPrompt(options);\n${PI_IMAGE}\tconst requestImages = await prepareRequestImages(`,
        },
      ],
    },
    {
      name: "deepseek",
      file: join(dshRoot, "dsh-llm-deepseek", "lib", "index.js"),
      patches: [
        {
          id: "DE_LOAD",
          mark: "let __forgeDe = null;",
          anchor: `import z from "@deepseek-ai/schemastery";`,
          insert: LOAD_DE + `import z from "@deepseek-ai/schemastery";`,
        },
        {
          id: "DE_HEAD",
          mark: `const forged = __forgeDe.transform(__sys, __hist, options.model, "blocks");`,
          anchor: `function serialize(options, connection, history, images, access, onReplayDegrade, fileIds) {\n`,
          insert: `function serialize(options, connection, history, images, access, onReplayDegrade, fileIds) {\n${DE_HEAD}`,
        },
        {
          id: "DE_LOOP",
          mark: "for (const message of __hist) {",
          anchor: `for (const message of history) {\n\t\tif (message.role === "developer") {`,
          insert: `for (const message of __hist) {\n\t\tif (message.role === "developer") {`,
        },
        {
          id: "DE_SYS",
          mark: "const system = [__sys, historySystem]",
          anchor: `const system = [options.system, historySystem]`,
          insert: `const system = [__sys, historySystem]`,
        },
      ],
    },
  ];
}

function readText(file) {
  return readFileSync(file, "utf8");
}

function backupOf(file) {
  return `${file}${BACKUP_SUFFIX}`;
}

function missingOf(target) {
  const text = readText(target.file);
  return target.patches.filter((patch) => !text.includes(patch.mark)).map((patch) => patch.id);
}

/** 查状态：installed / partial 缺哪几块 / missing-file。 */
export function checkTarget(target) {
  if (!existsSync(target.file)) return { name: target.name, state: "missing-file" };
  const missing = missingOf(target);
  return { name: target.name, state: missing.length === 0 ? "installed" : "partial", missing };
}

function applyPatch(text, patch) {
  if (text.includes(patch.mark)) return { text, result: `${patch.id}=already` };
  if (!text.includes(patch.anchor)) return { text, result: `${patch.id}=anchor-missing` };
  return { text: text.replace(patch.anchor, patch.insert), result: `${patch.id}=applied` };
}

export function applyTarget(target) {
  if (!existsSync(target.file)) return { name: target.name, state: "missing-file", results: [] };
  const original = readText(target.file);
  let text = original;
  const results = [];
  for (const patch of target.patches) {
    const outcome = applyPatch(text, patch);
    text = outcome.text;
    results.push(outcome.result);
  }
  if (text !== original) {
    if (!existsSync(backupOf(target.file))) copyFileSync(target.file, backupOf(target.file));
    writeFileSync(target.file, text, "utf8");
  }
  return { name: target.name, state: text === original ? "unchanged" : "written", results };
}

/** 备份记录的是本工具动手那一刻。别的补丁工具改过同一文件时，还原会把它们的改动一起抹掉。 */
const FOREIGN_MARKS = ["[dsh-purge]", "[dsh-armor", "[dsh-v5]", "[dsh-v6]", "[dsh-v7]"];

export function revertTarget(target) {
  if (!existsSync(target.file)) return { name: target.name, state: "missing-file" };
  const text = readText(target.file);
  const foreign = FOREIGN_MARKS.filter((mark) => text.includes(mark));
  if (foreign.length > 0) return { name: target.name, state: "skipped", foreign };
  if (!existsSync(backupOf(target.file))) return { name: target.name, state: "no-backup" };
  copyFileSync(backupOf(target.file), target.file);
  return { name: target.name, state: "restored" };
}
