/**
 * kernel-mount —— 把 ~/.dsh/armor.md 钉到 system prompt 第 0 位。
 *
 * 只做一件事：读文件、挂 section。不依赖 dsh-armor-bundle，不碰 purge。
 * 文件首行的 <!-- armor-kernel --> 哨兵随正文一起进 prompt，
 * 触发 dsh-wire-forge.shouldInject() 返回真，forge 随之注入。
 *
 * 挂载方式：install.mjs --armored 会往 profile 的 cordis.patch.yml
 * 插一行 `name: 'file:///<此文件>'`，cordis 按路径加载即可，不需要 npm。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

export const name = 'kernel-mount'

const ORDER = -2000
const SECTION = 'operator:armor-kernel'

function dshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv !== '') return fromEnv
  const base = String(process.env.USERPROFILE || process.env.HOME || '').trim()
  return base === '' ? '' : path.join(base, '.dsh')
}

function resolveFile(config) {
  if (typeof config.file === 'string' && config.file.trim() !== '') return config.file
  const home = dshHome()
  return home === '' ? '' : path.join(home, 'armor.md')
}

function readBody(config) {
  if (typeof config.text === 'string' && config.text.trim() !== '') return config.text
  const file = resolveFile(config)
  if (file === '') return ''
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/** 插件加载时自检：~/.dsh/armor.md 不存在就从仓库 docs/armor.md 种一份过去。 */
function ensureKernel(config) {
  const file = resolveFile(config)
  if (file === '') return
  if (fs.existsSync(file)) return
  try {
    const bundled = path.join(dirname(fileURLToPath(import.meta.url)), 'docs', 'armor.md')
    if (fs.existsSync(bundled)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.copyFileSync(bundled, file)
      return
    }
  } catch {
    /* 种不进去就等 readBody 落到空，下次启动再试 */
  }
}

export function apply(ctx, config = {}) {
  if (ctx === undefined || ctx.systemPrompt === undefined
    || typeof ctx.systemPrompt.section !== 'function') {
    console.warn('[kernel-mount] systemPrompt 服务不可用，跳过')
    return
  }
  ensureKernel(config)
  const text = readBody(config)
  if (text === '') {
    console.warn('[kernel-mount] 正文为空，跳过（file=' + resolveFile(config) + '）')
    return
  }
  const order = Number.isFinite(config.order) ? config.order : ORDER
  ctx.systemPrompt.section({ name: SECTION, order, text })
  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info('[kernel-mount] 已挂载 ' + text.length + ' 字')
  }
}
