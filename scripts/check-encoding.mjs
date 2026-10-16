// 用 Node 检查源码编码是否真的损坏（PowerShell 的控制台编码会让"扫描"本身产生假阳性）。
// 判据：严格 UTF-8 解码失败，或文本里出现 U+FFFD（替换字符）——那才是真损坏。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['src', 'test', 'scripts']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(ts|py|mjs)$/.test(name)) files.push(path)
  }
}
for (const r of roots) {
  try {
    walk(r)
  } catch {
    /* 目录可能不存在 */
  }
}

let bad = 0
for (const file of files) {
  const bytes = readFileSync(file)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    console.log(`INVALID UTF-8: ${file}`)
    bad += 1
    continue
  }
  const replacements = (text.match(/\uFFFD/g) ?? []).length
  // 双重编码痕迹：UTF-8 字节被当成 GBK 解读后重存的产物。
  // ⚠️ 两条纪律：
  // 1. 标记字符一律用**码点构造**，绝不写字面量——包括本注释里也不写，
  //    否则本文件会被自己命中（自匹配假阳性）；
  // 2. 码点表**只取实测确认的**：本轮真实故障中出现的是 U+951B / U+9225 / U+9402
  //    这一带。宁可少列，也不要误报正常中文注释——第一版把 U+9286/U+752F/U+65B0
  //    之类也列了进来，结果大量合法中文（如"链"、"接"）被误判为损坏。
  const MARKS = String.fromCharCode(0x951b, 0x9225, 0x9402, 0x8a01, 0x9526)
  const markPattern = new RegExp(`[${MARKS}]`, 'g')
  const suspicious = (text.match(markPattern) ?? []).length
  if (replacements > 0 || suspicious > 0) {
    console.log(`SUSPICIOUS: ${file}  replacement=${replacements} marked=${suspicious}`)
    bad += 1
  } else {
    // 正向证据：文件里确实含合法中文注释
    const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
    console.log(`ok   ${file}  (valid utf-8, cjk chars=${cjk})`)
  }
}
console.log(`\nfiles checked: ${files.length}, problems: ${bad}`)
process.exitCode = bad === 0 ? 0 : 1
