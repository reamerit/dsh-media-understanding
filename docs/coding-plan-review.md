# Coding Plan 复审报告 + 预安装记录

> 复审对象：[`docs/coding-plan.md`](./coding-plan.md)（2026-XX 版）
> 复审方式：① 对**本机真实环境**逐项实测；② 对计划中每个 DSH API 断言，在**已安装的 DSH 0.2.0-rc.2 源码**中定位证据；③ 对 C4 的 ffmpeg / faster-whisper 断言做端到端冒烟验证。
> 复审日期：2026-10-15（本机时间）
>
> ⚠️ **硬件已扩容并在本机复验**：本机由 1 核 / 4 GB 变更为 **2×Xeon Gold 5118 = 8 核 / 64 GB、无 GPU**，`python` 3.14 已提升为默认。**§9 是扩容后的复验结果与最新基准，优先于 §3/§4 中与硬件相关的结论**（§4.4 的"python 默认 3.15"、§4.5 的内存/页面文件约束均已被取代）。
>
> **一句话结论**：计划的**四个阻断级判断（C1/C2/C3/C4）方向全部正确**，技术路线可以照走；但**环境描述、版本号、若干 API 名字和一处依赖钉版本是错的**——按原文实施会在 Phase 1 就因 peer 版本不匹配被插件管理器拒绝，并在 Phase 2 撞上本报告 §4.1 的运行时崩溃。所需软件**已全部预装并验证通过**（§4）。

---

## 0. 结论摘要

| 类别 | 数量 | 说明 |
|---|---|---|
| 阻断级错误（不改就无法实施） | 6 | §1.1–§1.6 |
| 事实性错误（实测证伪/修正） | 4 | §2.1–§2.4 |
| 环境描述失真 | 整表 | §3 |
| 已核实为正确的关键判断 | 4 | §5（C1/C2/C3/C4） |
| 已完成的预安装 | 5 项 | §4 |

**最重要的三条**：

1. **§1.1 版本错配**：计划按 `0.1.7-rc.2` 写 peerDependencies，本机运行时是 **`0.2.0-rc.2`**。DSH 的兼容性判定**只**看 peerDependencies ↔ 运行时版本（`dsh-app-boot/lib/index.js:286-300`），`satisfies('0.2.0-rc.2','^0.1.7-rc.2') === false` ⇒ 装载时直接被判 `incompatible-version` 拒绝。
2. **§2.1 av 钉版本错了**：计划钉 `av<17`，**正确是 `av<19`**。移除 `metadata_errors` 的是 **PyAV 19.0.0**（[官方 changelog](https://pyav.basswood.io/docs/stable/development/changelog.html)），不是 17。已实测 `av 19.0.1` 崩、`av 18.1.0` 通。按原文钉 `av<17` 会白白降两个大版本。
3. **§4.1 本机运行时崩溃（计划完全未预见）**：本机 `MSVCP140.dll` 是 2019 年的 **14.22.27821.0**，导致 `ctranslate2` 与 `onnxruntime` 一调用就 `0xC0000005` **硬崩溃（连 Python 异常都没有）**。装上 VC++ 2015-2022 可再发行组件（→ 14.44.35211.0）后恢复。**没有这一步，Phase 2 会得到"python 无故消失/无输出退出"这种极难定位的现象。**

---

## 1. 阻断级纠正（必须先改）

### 1.1 版本错配：`0.1.7-rc.2` → `0.2.0-rc.2`

本机实测版本（`@deepseek-ai/dsh/package.json` 等）：

| 包 | 计划假设 | 本机实际 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.1.7-rc.2` | **`0.2.0-rc.2`** |
| `@deepseek-ai/dsh-llm` | `^0.1.7-rc.2` | **`0.2.0-rc.2`** |
| `@deepseek-ai/dsh-tools` | `^0.1.7-rc.2` | **`0.2.0-rc.2`** |
| `@deepseek-ai/dsh-attachment` | `^0.1.7-rc.2` | **`0.2.0-rc.2`** |
| `@deepseek-ai/dsh-subprocess` | `^0.1.7-rc.2` | **`0.2.0-rc.2`** |
| `@deepseek-ai/cordis` | `^4.0.2` | `4.0.4` ✅（不参与兼容性判定） |

**判定机制（源码证据）**：`dsh-app-boot/lib/index.js:286-301` 取运行时版本、用 `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })` 逐条核对 peerDependencies，不满足即 `incompatible-version`（`dsh-plugin-manager/lib/index.js:1490-1491`，错误文案见 `dsh-app-boot/lib/index.js:322`）。**第 294 行决定只筛 DSH 自己的包**：

```js
if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
```

⇒ `@deepseek-ai/cordis`、`@huanlin/...` 等**不参与**判定。另外 `workspace:^` / `workspace:~` / `workspace:*` 会被当作"等于当前运行时"，永远通过（`:295-299`）——这是官方单仓内插件的惯用法。

已用本机 `semver@7.8.5` 直接验证：

```
satisfies('0.2.0-rc.2', '^0.1.7-rc.2')  === false    ← 计划原文的写法，会被拒
satisfies('0.2.0-rc.2', '^0.1.7')       === false
satisfies('0.2.0-rc.2', '>=0.2.0-rc.2') === true     ← ★ 最终采用
satisfies('0.2.0-rc.2', '^0.2.0-rc.2')  === true
satisfies('0.2.0-rc.2', '^0.2.0')       === false    ← 写成 ^0.2.0 同样不行
satisfies('0.2.0-rc.2', '>=0.2.0-rc2')  === false    ← ★★ 少一个点就不匹配！
satisfies('0.2.0-rc.2', '>=0.2.0-rc.1') === true     ← 会连 rc.1 一起放行，不够严
```

> ⚠️ **两个必须记住的细节**：
> 1. `^0.2.0` **不行**——`0.2.0-rc.2` 是预发布版本，不在 `^0.2.0` 范围内；范围里必须**显式带预发布标签**。
> 2. **`rc2` ≠ `rc.2`**：写成 `>=0.2.0-rc2`（无点）时 semver 把它当成单个标识符 `rc2`，而运行时是 `rc.2`（`rc` + `2`），比较结果 **false** ⇒ 反而判不兼容。**必须写 `>=0.2.0-rc.2`。**

**改法（已定口径）**：`package.json` 中 5 个 `@deepseek-ai/dsh-*` peer 全部用 **`>=0.2.0-rc.2`**。

> 取舍：`>=` 没有上界，`0.3.0`/`1.0.0` 也会放行。若将来要挡住破坏性大版本，收紧为 `>=0.2.0-rc.2 <0.3.0`。
> 逃生通道：确实需要时可用 `dsh plugin allow-version`（或插件管理器）为**确切版本**授予豁免（`dsh-app-boot/lib/index.js:322` 的错误文案里写明了）。

> **本机现成范本**：`C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-better-sidebar\package.json` 是唯一真实第三方插件，其做法可直接照抄：`dsh: { bundle: { patch: "./cordis.patch.yml" }, client?, manifestVersion: 1 }`；所有 `@deepseek-ai/dsh-*` peer 用 `^0.2.0-rc.2`；`devDependencies` 逐个精确钉 `0.2.0-rc.2`（供本地类型检查/构建）；`@deepseek-ai/schemastery` 放在 **dependencies**（不是 peer）。

### 1.2 `dsh.compatibility.dshReleases` 字段不存在

计划 §3 的 package.json 里写了：

```jsonc
"dsh": { "compatibility": { "dshReleases": { "0.1.7-rc.2": "compatible" } } }  // ❌ 无此字段
```

对 `.pnpm` 下**全部** package.json grep `dshReleases`：**零命中**。真实清单形状（见本机唯一第三方插件 `dsh-better-sidebar@0.26.0/package.json`）：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "manifestVersion": 1
}
```

唯一的兼容性豁免通道是 profile 目录下的 `compatibility.json`（`dsh-app-boot/lib/index.js:328`）——不建议用，直接改对版本更干净。

### 1.3 `ctx.llm.resolveModel` 名字错误 → `resolveModelInfo`

这是计划 §1 C2 里要**直接抄进代码**的片段，抄了必然 `TypeError: not a function`。

| 断言 | 判定 | 证据 |
|---|---|---|
| `ctx.llm.resolveModel(provider, model, signal)` | **FALSE** | 服务上只有 `resolveModelInfo(provider, model, signal?)`：`dsh-llm/lib/types/index.d.ts:360`（实现 `lib/index.js:2098`）。`resolveModel` 只存在于抽象适配器 `LlmAdapter`（同文件 `:171`），插件拿不到适配器实例。 |

**正确写法**（逐字对齐 `dsh-acp/lib/index.js:84`）：

```ts
const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
const canSeeImages = info.inputModalities?.includes('image') === true
```

`inputModalities?: readonly ModelModality[]`（`'text' | 'image'`）见 `dsh-llm/lib/types/types.d.ts:212-217,301,314`。

**计划没写、但实现必须知道的一点**：`execute` 时怎么拿到"当前 provider/model"？

```ts
// 逐字对齐 dsh-tool-fs/lib/index.js:898-904
const routed  = exec.agent?.session.requestHeader()?.config
const provider = routed?.provider ?? exec.agent?.options.provider
const model    = routed?.model    ?? exec.agent?.options.model
```

（`exec.agent` 见 `dsh-tools/lib/types/index.d.ts:229`；`Agent.options.{provider,model}` 见 `dsh-agent/lib/types/runtime-types.d.ts:21-30,139-141`；`requestHeader()` 见 `dsh-session/lib/types/index.d.ts:259`。）
工作区 cwd 用 `exec.agent?.session.header.cwd`（`dsh-session/lib/types/types.d.ts:69`）。

### 1.4 `ctx.subprocess` 的三处细节要改

计划 C3 的整体方向对（`resolveExecutable` + `spawn`），但三个细节会写出 bug：

| # | 计划原文 | 实际 | 证据 |
|---|---|---|---|
| a | `stderr: { maxBytes: 1<<20 }` 然后"stderr 收进 spill 文件" | **不传 `spill` 就没有 spill 文件** | `SubprocessCollect = { maxBytes: number; spill?: { maxBytes: number } }`，`dsh-subprocess/lib/types/types.d.ts:39-47` |
| b | `const outcome = await handle.done`，从中取 stdout/stderr/spill | **`done` 只给退出事实**：`SubprocessOutcome = { exitCode: number\|null; signal: NodeJS.Signals\|null }` | 同文件 `:107-112`（注释明确写 "NO output"）。取输出要 `handle.collected.stderr?.readFrom(0)` → `{ text, nextOffset, lossy, spillPath? }`（`:113-147`） |
| c | 输出路径"放受管临时目录（`ctx` 提供的 home/temp 路径）" | **不存在这种 ctx 服务** | 实测无此 service。可用：`node:os` 的 `tmpdir()` + `mkdtempSync`；`exec.agent?.session.header.cwd`；或库包 `@deepseek-ai/dsh-home-paths`（`resolveDshHome`/`dshHomePath`/`dshCachePath`，是**库不是 ctx 服务**）。另外 spill 文件是**故意保留**不自动删的（`dsh-subprocess-local/lib/output.js:10-21`），帧图和 spill 都要自己清 |

其余（`argv`/`cwd`/`stdio`/`graceMs` 必填，`signal`/`env` 可选，`spawn` 是**同步**返回 handle，`resolveExecutable(command, env?, signal?)`）计划写的都对（`types.d.ts:69-99`、`index.d.ts:88,102`）。注意 **`SubprocessSpawnSpec` 没有 `timeoutMs`**——超时得靠 `signal` 自己做。多出的 `env` 很有用（可传 `HF_HOME`/`HF_HUB_OFFLINE` 给 worker）。

### 1.5 `inject` 写死了 4 个服务会让插件整体装不上

计划：`export const inject = ['tools','llm','attachments','subprocess']`。这要求 4 个服务**全部存在**，否则插件不加载。本机 profile 里 `dsh-attachment-*` / `dsh-subprocess-*` 确实装了，但正确姿势是"可选能力、用时再查"，照抄 `dsh-tool-fs`（`lib/index.js:1176-1206`）：

```ts
export const inject = ['tools']                    // 只强制真正必需的
ctx.inject(['attachments'], c => { /* 注册需要附件能力的工具 */ })
// execute 内再 ctx.get('attachments') / ctx.get('llm') 兜底
```

### 1.6 工具定义字段的**层级**写错了

计划 §5 把 `presentResult` / `presentCall` / `isConcurrencySafe` / `timeoutMs` 当成 `output.*` 的子字段。实际（`dsh-tools/lib/types/schema.d.ts:178-240`、`lib/types/index.d.ts:106-191`）：

```ts
output: { schema, render(args, value): ContentBlock[], presentationMeta?(args, value) }   // 只有这三个
// 下面这些是【顶层】字段：
execute, presentCall, presentResult, isConcurrencySafe, timeoutMs, projectContent, finalizeContent
```

另外 `render` 的职责确认无误：它是**面向模型**的投影（注释："Pure projection … to Native/model content"），计划"render 必须是纯函数"这条约束是对的。`presentResult(args, result: ToolResult)` 读的是 `result.meta`，而 `meta` 由 `output.presentationMeta` 持久化——**会话回放要出图，必须同时实现 `presentationMeta` + `presentResult`**，只写 `presentResult` 拿不到 attachment。

---

## 2. 事实性错误（已实测证伪 / 修正）

### 2.1 av 钉版本错了：应 `av<19`，不是 `av<17` ★

计划 §1 C4c 与 §10 表格**自相矛盾**：C4c 说"PyAV 从 **17** 起移除 `metadata_errors`"（⇒ 钉 `av<17`），§10 表格又说"PyAV **19** 与 faster-whisper 1.2.1 不兼容"。**后者才对**。

**一手证据**（PyAV 官方 changelog）：

> **v19.0.0 — Major:** Remove the `metadata_encoding` and `metadata_errors` arguments to `av.open()` …
> （v16/v17/v18 的 changelog 均**未**列出此项移除）

**本机实测**：

| 组合 | 结果 |
|---|---|
| `av 19.0.1` + `faster-whisper 1.2.1` | ❌ `TypeError: open() got an unexpected keyword argument 'metadata_errors'`，位置 `faster_whisper/audio.py:46` |
| `av 18.1.0` + `faster-whisper 1.2.1` | ✅ `decode_audio()` 正常返回 `(128174,) float32`，端到端转写通过 |

同时逐字核对上游源码确认调用点存在：`faster_whisper/audio.py:46` = `with av.open(input_file, mode="r", metadata_errors="ignore") as container:`（本机从 PyPI wheel 解包核对，非猜测）。

**改法**：README / `media_probe` / 安装脚本统一钉 **`av>=16,<19`**（本机落 `18.1.0`，wheel 标签 `cp311-abi3`，对 3.11+ 通用）。计划里"主版本 < 17"的探针断言要改成"主版本 < 19"。

### 2.2 ffmpeg 版本假设与实装不一致（但命令仍正确）

- 计划 §10 声称本机有 **ffmpeg 9.0.2**（winget `Gyan.FFmpeg`）。**本机原本根本没有 ffmpeg/ffprobe**，也没有 winget（§3）。
- 本次实装 **ffmpeg 6.0 + ffprobe 6.0**（gyan essentials build，经 PyPI `ffmpeg-binaries` 分发）。
- 计划 C4a 的结论"必须用 `-fps_mode vfr`"在 6.0 上**依然成立**（实测 6.0 同时有 `-fps_mode` 与 `-vsync`；`-fps_mode` 在 5.1+ 才引入，是正确选择）。计划"命令按 9.x 写"的说法要改成"命令按 5.1+ 写，`-fps_mode` 是 6.0/7.x/9.x 通用写法"。

**实测复现计划 §10.1 全部结论**（ffmpeg 6.0，合成 4×2s 色块 + 正弦音轨）：

| 验证项 | 结果 |
|---|---|
| `ffprobe -print_format json -show_streams` | ✅ `0:video/h264, 1:audio/aac`，`duration=8.000000` |
| 无音轨视频判据 | ✅ 去掉音轨后仅 `0:video`，"无音轨"可判定 |
| 抽音轨 → 16k 单声道 WAV | ✅ 8s → 256,426 字节 WAV |
| ~~`select='gt(scene,0.3)',metadata=mode=print` + `-fps_mode vfr`~~ | ❌ **本结论有误，已在实施期推翻**（见下方勘误） |

> ## ★★ 勘误（2026-10-16，实施期实测）★★
>
> 上表那一行写的是"✅ 解析出 `pts_time:4` / `:6`"。**这条验证结论站不住**：在**本机 ffmpeg 6.0**
> 上复现时，`metadata=mode=print` **根本不打印 `pts_time`**（只有普通的 `Metadata:` 行）。
> 实施按它对时间戳编程，结果是**所有时间戳静默退化成按帧率估算**——而且没有任何报错，
> 属于"看着能用其实是错的"那类缺陷：`fps` 采样下估算值碰巧正确，`scene` 采样下则完全对不上。
>
> **正确做法是用 `showinfo`**，它对每个被输出的帧打一行含 `pts_time`：
>
> ```
> [Parsed_showinfo_1 @ …] n:   0 pts:      0 pts_time:0 duration: 1 duration_time:1 …
> [Parsed_showinfo_1 @ …] n:   1 pts:      1 pts_time:1 duration: 1 duration_time:1 …
> ```
>
> 行序与输出文件严格 1:1，因此"顺序对应"这条判断**仍然成立**，只是打印器换了。
> 实测两种策略都拿到 `timestampSource: exact`（场景采样落在 4.0s/6.0s，与 §10.5 的历史记录一致）。
> 实现：`src/pure/timestamps.ts`（优先解析 showinfo 行、裸 `pts_time` 兜底、并记 `parsedFrom`）、
> `src/media/ffmpeg.ts`（命令构造）；回归测试：`test/timestamps.test.mjs`。
>
> ⚠️ **另一条相关教训**：本表把"在 shell 里手跑一条命令成功"当成了"插件里也必然成功"。
> 实际上插件的路径拼接、子进程 stdio、JSON 无损性都各自出过问题
> （见 §10 的 D3/D12）。**凡是被当作契约写进代码的结论，都必须在宿主里端到端复验过。**

| `-fps_mode vfr` 单独使用（不带 `-vsync`） | ✅ 同样正确 |
| 首帧不出帧（`select` 对首帧恒假，t=2.0s 的切换漏掉） | ✅ 复现，计划 §C4a 注释正确 |
| 纯色视频 → 无场景变化 | ✅ **0 个文件，exit=0**（不是报错），可据此返回 `no-scene-change` |
| `strategy=fps` + `scale='min(1280,iw)':-2` | ✅ `fps=1/2` 出 4 帧，尺寸保持 320×240 |
| 中文 + 空格文件名（argv 传参） | ✅ 正常出帧（R7 风险项已验证可控） |

⚠️ **一处实现提醒**：6.0 打印的是 `pts_time:4`（整数），计划示例是 `pts_time:4.2`。计划给的正则 `/pts_time:([0-9.]+)/` 两者都能吃，但**不要**写成 `[0-9]+\.[0-9]+`，否则整数时刻全部解析失败。

### 2.3 §10 环境表与本机几乎全不符

见 §3 对照表。要点：工作区不是 `D:\Ollama\projects\...`、用户不是 `reamerai\reame`、python 不是 `C:\Program Files\Python314\python.exe`、模型缓存不在 `C:\Users\reame\.cache\...`、默认路由的 provider 不是 `loki`。

### 2.4 计划引用的"参考实现"在本机不存在

计划 §3 说"参考本机已安装的真实插件（`dsh-context`、`dsh-knowledge`、`dsh-better-sidebar`）"。实测 profile 的 bundles 是：

```
@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dshmarket, mattpocock-skills-dsh, dsh-better-sidebar
```

**`dsh-context`、`dsh-knowledge` 在本机（profile 与 .pnpm 树）都不存在**，只有 `dsh-better-sidebar@0.26.0` 是 profile 里唯一第三方插件。§5 中"`dsh-knowledge` 就这么写的（手写 JSON Schema）"这一论据**无法在本机核实**。

> ✅ **后续已补**（2026-10-16）：本机另有一个**在产的宿主侧第三方插件**范本 —— `C:\workspace\github\dsh-mcp-skill-panel`（0.7.2，已适配 DSH 0.2.0-rc.2，30 个 src 文件）。它比 §2.4 下面这些 `.pnpm` 内官方包更贴近本插件要写的东西：宿主半区、注册工具（`defineTool` + `ctx.tools.register`）、自带 bundle patch、独立打包与本地类型解析。**其结论已抄进计划 §3.1**（含 `external` 铁律、`inject` 策略修正、模块同一性风险）。下面这张表仍是"官方实现范本"的入口。

**替代参考实现（都在 .pnpm 里，可直接读）**：

| 需求 | 该看哪个 |
|---|---|
| 图片能力门控 + `imageLimits` + `saveImage` + `ImageBlock` 投影 | `dsh-tool-fs/lib/index.js:898-1056`（`read_image`），尤其 `:917-963` 的 `imageRefFromValue`/`imageReadContent` |
| `ctx.subprocess` 的 spawn + collect + spill 标准写法 | `dsh-tool-fs-search/lib/index.js:166-207` |
| **长驻媒体 worker**（与计划的 Python worker 最像） | `dsh-experimental-speech-to-text-sensevoice/lib/index.js:773-813` |
| `inject` 可选能力 + 顶层字段齐全的工具定义 | `dsh-tool-fs/lib/index.js:1176-1206` |
| schemastery `Config` | `dsh-tool-fs/lib/index.js:1181-1186,1212` |

> 顺带一提：`dsh-experimental-speech-to-text-sensevoice` 就是一个**现成的语音转写插件**。在动手自研之前值得先读它——至少能省掉 worker 生命周期（env token、stderr 收集、空闲退出）那一整块设计。

---

## 3. 环境实测对照表（计划 §10 vs 现实）

> ⚠️ 本表中 **CPU / 内存** 两行的数值是**扩容前**的；现状见 §9.1（8 核 / 64 GB）。其余各行仍然有效。

| 项 | 计划 §10 声称 | **本机实测（2026-10-15）** |
|---|---|---|
| 工作区 | `D:\Ollama\projects\github\dsh-media-understanding`（空） | **`C:\workspace\github\dsh-media-understanding`**（已含 `docs/coding-plan.md`） |
| 用户 / 权限 | `reamerai\reame`，**非提权** | **`Administrator`**；`workspace-write` 沙箱内 `IsAdmin=False`，`danger-full-access` 下 `IsAdmin=True` |
| DSH 运行时 | `0.1.7-rc.2` | **`0.2.0-rc.2`** |
| DSH_HOME / profile | `~/.dsh/profiles/web` | `C:\Users\Administrator\.dsh`，profile `web` ✅ |
| profile bundles | 提到 `dsh-context`、`dsh-knowledge`、`dsh-attachment-local`、`dsh-subprocess-local` | `dsh-base`、`dsh-web-app`、`dshmarket`、`mattpocock-skills-dsh`、`dsh-better-sidebar`（**无 context/knowledge**） |
| 默认路由 | `loki / coding-standard-local` | **provider `dsh`** / model `coding-standard-local`（`api: openai-responses`，`baseURL: https://loki.azeus.dev`） |
| 图片输入声明 | 本轮手动追加 `input: [text,image]` | **已存在**于 `cordis.patch.yml`（`agent-default-model` + `llm-pi-ai` 段）✅ |
| 备用 vision 路由 | `litellm / Qwen3-VL-4B` | **不存在**。同 provider 下另有 `Qwen/Qwen3.6-35B-A3B`、`Qwen/Qwen3-VL-Embedding-2B`（**均未声明 `input`**） |
| 文件策略 | 已切 `danger-full-access` | ✅ 本会话为 `danger-full-access`（无审批） |
| OS | — | **Windows Server 2022 Datacenter 10.0.20348** |
| CPU | — | ~~Intel Xeon Cascadelake，1 核 / 2 逻辑处理器~~ → **现为 2×Xeon Gold 5118 = 8 核**（§9.1） |
| 内存 | — | ~~**4 GB**（关键约束，见 §4.1）~~ → **现为 64 GB**（§9.1） |
| GPU | — | **不可用**（`nvidia-smi` 无法与驱动通信；`ctranslate2.get_cuda_device_count() == 0`）。装了 CUDA 12.8 toolkit 但无驱动/设备 ⇒ **只能 CPU 推理** |
| node | v24.14.0 | **v26.8.2**（nvm：`%LOCALAPPDATA%\Author Software\nvm\installs\v26.8.2`） |
| pwsh | Windows PowerShell 5.1.26100.9444 | Windows PowerShell **5.1.20348.2849** |
| git | 未提 | 2.47.0（`C:\Program Files\Git\cmd`） |
| 包管理器 | winget `Gyan.FFmpeg` | **winget / choco / scoop / uv 全部不存在** |
| ffmpeg / ffprobe | 9.0.2（winget 安装） | **原本缺失** → 本次装 **6.0**（见 §4.2） |
| python | 3.14.3 @ `C:\Program Files\Python314\python.exe` | 原本只有 **3.15.0**（`%LOCALAPPDATA%\Programs\Python\Python315`）→ 本次补装 **3.14.8** |
| pip | 26.2.1 | 26.2.1 ✅ |
| faster-whisper | 1.2.1（已装） | 原本**缺失** → 本次装 1.2.1 ✅ |
| av | "必须 16.1.0（钉 av<17）" | 本次装 **18.1.0**（钉 `av<19`，见 §2.1）✅ |
| Whisper 模型缓存 | `C:\Users\reame\.cache\huggingface\hub` | **`C:\Users\Administrator\.cache\huggingface\hub`**（本次已预置 tiny/base/small） |
| MSVC 运行时 | 未提 | 原本 **14.22.27821.0（2019）** ← 崩溃根因 → 本次升级 **14.44.35211.0** ✅ |

---

## 4. 预安装记录（本次已完成并验证）

### 4.1 ★ 阻断级环境缺陷：MSVC 运行时过旧导致原生库硬崩溃

**现象**：`ctranslate2` / `onnxruntime` 一旦被调用，进程**直接 `0xC0000005`（access violation）消失**——没有 Python traceback、没有 stderr，`faulthandler` 只能给到"崩在 `WhisperModel.__init__` → `ctranslate2.models.Whisper(...)`"。极易被误判为"内存不足"或"模型损坏"。

**定位过程**（供日后复现同类问题）：

1. 排除模型损坏：`model.bin` 75,538,270 字节、头部 `060000000c0057686973706572`（`WhisperSpe…`）合法；改用**纯目录副本**（无 HF 符号链接）仍崩。
2. 排除路径语义：传一个**根本不存在的路径**也崩 ⇒ 崩在原生初始化，与文件读取无关。
3. 排除内存：崩溃时峰值工作集仅 **36 MB**；进程**不在** Job Object 中。
4. 排除 ISA 分发：`CT2_FORCE_CPU_ISA=GENERIC/AVX/AVX2/AVX512` 全部同样崩。
5. 排除版本 bug：`ctranslate2` 4.6.3 / 4.7.2 / 4.8.2 / 4.8.3 **全部**同样崩。
6. **决定性证据**——Windows 应用程序日志（事件 ID 1000）：

   ```
   错误应用程序名称: python.exe, 版本: 3.14.8150.1013
   错误模块名称: MSVCP140.dll, 版本: 14.22.27821.0
   异常代码: 0xc0000005
   错误模块路径: C:\Windows\SYSTEM32\MSVCP140.dll
   ```

**根因**：`C:\Windows\SYSTEM32\MSVCP140.dll` 是 2019 年的 **14.22.27821.0**，而 ctranslate2 / onnxruntime 的 Windows wheel 由新版 MSVC 工具链构建，需要新版 VC++ 运行时 → 调用即崩。

**修复**：安装 VC++ 2015-2022 可再发行组件（x64）。

```powershell
curl.exe -sL -o "$env:TEMP\vc_redist.x64.exe" https://aka.ms/vs/17/release/vc_redist.x64.exe
Start-Process "$env:TEMP\vc_redist.x64.exe" -ArgumentList '/install','/quiet','/norestart' -Wait
# 退出码 3010（成功，建议重启）；实测无需重启即对新进程生效
```

结果：`msvcp140.dll` **14.22.27821.0 → 14.44.35211.0**；副作用是失败方式也变好了——从**段错误**变成**可捕获的 `RuntimeError`**。

> **给计划的要求**：`media_probe` 应把 "MSVCP140 主版本 ≥ 14.30" 之类纳入校验（或至少把"python 子进程无输出退出、exit code 为 `0xC0000005`/`-1073741819`"识别为**运行时缺失**这一独立错误类），否则这个坑会在用户机器上以"工具莫名失败"的形式复现。

### 4.2 已安装清单

| 组件 | 版本 | 路径 | 备注 |
|---|---|---|---|
| **ffmpeg / ffprobe** | **6.0**（gyan.dev essentials build） | `%LOCALAPPDATA%\Programs\ffmpeg\bin\` | 已**追加**到**用户** PATH（不动系统 PATH） |
| **Python** | **3.14.8** | `%LOCALAPPDATA%\Programs\Python\Python314\python.exe` | 用户级安装，**未改 PATH**；`py -3.14` 可用 |
| faster-whisper | 1.2.1 | 上述 3.14 的 site-packages | |
| ctranslate2 | 4.8.3 | 同上 | |
| **av (PyAV)** | **18.1.0**（`av<19`） | 同上 | ★ 不是计划写的 16.1.0 |
| onnxruntime | 1.31.0 | 同上 | Silero VAD 依赖 |
| tokenizers / huggingface-hub / numpy | 0.23.3 / 2.2.0 / 2.5.4 | 同上 | |
| **Whisper 模型** | `tiny` + `base` + `small` | `%USERPROFILE%\.cache\huggingface\hub`（blobs 共 **672 MB**） | **已验证离线可用**（`local_files_only=True`） |
| VC++ 运行时 | 14.44.35211.0 | `C:\Windows\System32\msvcp140*.dll` | 见 §4.1 |

**~~未装且不建议装~~（已被 §9 取代）**：`medium` 现**已拉取**（扩容后可行）；`large-v3` **也已拉取并实测**（2026-10-16，见 §9.4.1：加权 0.71× 中文 / 0.41× 英文实时，中文 CER 4.8% 优于 `small` 的 6.0%，但不作默认）；CUDA 路径不可用（**无 GPU**）。

### 4.3 安装通道的坑：只有 PyPI 和 HuggingFace 快

实测吞吐（同一时段）：

| 源 | 速度 | 结论 |
|---|---|---|
| `files.pythonhosted.org` (PyPI) | **~650 MB/min** | ✅ 首选 |
| `huggingface.co` | **~734 MB/min** | ✅ 模型/样例走这里 |
| Microsoft CDN（aka.ms） | ~477 MB/min | ✅ 可用 |
| `python.org` | ~0.7 MB/min | ❌ 31.8 MB 安装包下了约 40 分钟 |
| `github.com` releases | ~1.3 MB/min | ❌ |
| `gyan.dev` | ~0.47 MB/min，**且在中途 16.7 MB 处被对端强断** | ❌ 不可用 |
| `registry.npmjs.org` | ~0.4 MB/min | ❌ |

**由此产生的选型**：不装 winget，改为**从 PyPI wheel 里取官方 gyan 构建**——

- `ffmpeg-binaries 1.1.0`（`py3-none-win_amd64.whl`，86.95 MB）内即含 `ffmpeg.exe` + `ffprobe.exe` + `ffplay.exe`，**版本互相匹配（同为 gyan 6.0 essentials build）**，这点比 `imageio-ffmpeg`（只带 ffmpeg 7.1，无 ffprobe）更适合本方案。
- 解包命令（本轮实际执行）：

```powershell
# 先 pip download / Invoke-WebRequest 取 wheel，再用 .NET ZipFile 定向解出两个 exe
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($wheel)
$z.Entries | Where-Object { $_.FullName -in 'ffmpeg/binaries/bin/ffmpeg.exe','ffmpeg/binaries/bin/ffprobe.exe' } |
  ForEach-Object { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($_, "$dest\bin\" + [IO.Path]::GetFileName($_.FullName), $true) }
```

### 4.4 Python 3.15 装不了 faster-whisper（必须用 3.14）

> ⚠️ **部分已被 §9 取代**：本节"本机默认 `python` 是 3.15"的描述**已过时**——3.14 现已提升为默认。但"3.15 装不了 faster-whisper"这一**事实**与"探针必须实测依赖"这一结论仍然有效（换机器/换 PATH 时仍会踩到）。

本机原有且**只有** Python **3.15**，而依赖链在 3.15 上装不上。PyPI 实测 wheel 标签：

| 包 | 最新版 | 有 cp315 wheel？ |
|---|---|---|
| `ctranslate2` | 4.8.3 | ❌ 最高 cp314（**无 abi3**）→ 硬阻断 |
| `onnxruntime` | 1.31.0 | ❌ 最高 cp314 → 硬阻断 |
| `av` | 19.0.1 | ✅ `cp312-abi3`（但见 §2.1，需钉 <19） |
| `tokenizers` | 0.23.3 | ✅ `cp310-abi3` |
| `numpy` | 2.5.4 | ✅ cp315 |
| `faster-whisper` | 1.2.1 | ✅ 纯 Python |

⇒ 装 **Python 3.14.8**（cp314 轮子齐全）。**这也解释了计划为何假设 3.14.3**——3.14 是当前能承载 faster-whisper 的下限版本区间。

**为什么没把 3.14 设成默认 `python`**：`python` 目前仍解析到 3.15，全局默认未改动，以免破坏用户既有环境。插件应按计划用 `whisper.pythonPath` 显式指向：

```
C:\Users\Administrator\AppData\Local\Programs\Python\Python314\python.exe
```

⚠️ **但计划 §4 Phase 1 的"自动探测 python"必须改**：只找 `python` 会捡到 3.15 并必然失败。探针要**逐个候选解释器验证 `import faster_whisper`**（候选：配置值 → `py -3.14` → `python3.14` → `python`），并把失败原因如实回报，而不是先报"python 正常"再在转写时炸。

### 4.5 内存：4 GB，无页面文件（此坑会以 `mkl_malloc` 形式出现）

> ⚠️ **已被 §9 取代**：本机内存已由 4 GB 扩容到 **64 GB**，该约束消失。本节保留作为**错误分类**的依据（`mkl_malloc` 应作为独立错误类如实回报），以及换小内存机器时的参考。

过程中出现过 `RuntimeError: mkl_malloc: failed to allocate memory`——**连 `base` 模型都加载不了**，而 `tiny` 正常。当时的实测状态：

```
Win32_OperatingSystem.TotalVirtualMemorySize = 4095 MB   （= 物理内存，说明无页面文件）
Win32_PageFileUsage                          = 空
HKLM\...\Memory Management\PagingFiles       = {}
可用提交（Commit Limit - Committed）          ≈ 1.5 GB
```

之后系统提交上限变为 **65,535 MB**，`tiny`/`base`/`small` **全部**通过（含离线）。所以：

- **当前可用**：`tiny` 1.3s 加载 / 13s 音频 2.0s 转写；`base` 1.0s / 2.7s；`small` 2.0s / 7.7s（均 `device=cpu, compute_type=int8`）。
- **但 4 GB 物理内存 + 未配置页面文件**是真实脆弱点：一旦提交余量变紧，就会以 `mkl_malloc` 复现。**建议**：① 插件默认 `whisper.model: tiny`（不是 `small`）；② 把 `mkl_malloc` 作为独立错误类如实回报，文档提示"配置页面文件或换更大内存的机器"；③ 若要长期稳定跑 `base`/`small`，建议给这台机器配页面文件（需重启，属机器级变更，未擅自执行）。

### 4.6 端到端验证（真实语音，非合成）

用 HF 的真实语音样本（`Narsil/asr_dummy` 的 `mlk.flac`，13.0s）：

```
tiny   cpu/int8: load  1.3s  transcribe  2.0s  lang=en  "I have a dream that one day, this nation will rise"
base   cpu/int8: load  1.0s  transcribe  2.7s  lang=en  "I have a dream that one day this nation will rise"
small  cpu/int8: load  2.0s  transcribe  7.7s  lang=en  "I have a dream that one day this nation will rise"
```

- **`vad_filter=True` 通过**（即 onnxruntime + Silero VAD 链路可用）。
- **`local_files_only=True` 三模型全部通过** ⇒ 模型预置有效，首调用不需要联网。
- `device` 行为：`cpu` ✅ / `auto` ✅ / `cuda` ❌ `RuntimeError: CUDA failed with error no CUDA-capable device is detected`（干净报错，非崩溃）。⚠️ **本条记录于驱动修好之前**（2026-10-16 已修复，见 §9.4.2）；结论的正确读法是：**无可用驱动时 `cuda` 会干净报错、`auto` 安静落 CPU**，因此默认必须是 `auto` 而不是 `cuda`。

**对计划的建议**：~~`whisper.device` 默认写 **`cpu`** 比 `auto` 更贴合本机（无 GPU）~~ ⇒ ⚠️ **已被 §9.4.2 推翻**：本机有 Tesla P40 且已于 2026-10-16 打通，默认应写 **`auto`**（`cuda → cpu` 自动解析），并在 README 写明 `cuda` 需要驱动 + cuBLAS/cuDNN；无驱动时必须静默落 CPU。

---

## 5. 已核实为**正确**的部分（照抄即可）

| 计划断言 | 判定 | 证据 |
|---|---|---|
| C1：`ImageBlock = { type:'image', attachment: ImageAttachmentRef }`，**无** `source`/`base64` | ✅ TRUE | `dsh-llm/lib/types/types.d.ts:61-71`（另有 harness 自设的可选 `offloaded?: true`）；`ContentBlock` 联合 `:114-126` |
| C1：必须先用附件服务持久化，`saveImages([{data, mediaType, name?}])` → `ImageAttachmentRef[]` | ✅ TRUE | `dsh-attachment/lib/types/index.d.ts:43`；`SaveImageAttachment`：`data: Uint8Array`、`mediaType: 'image/png'\|'image/jpeg'\|'image/webp'\|'image/gif'`、可选 `name`（`types.d.ts:115-121`） |
| C1：`ctx.attachments` 服务 + `imageLimits` | ✅ TRUE | `index.d.ts:12-21`；实测默认值：**单图 20 MiB / 单消息 20 张 / 单消息 200 MiB / 64e6 像素 / 单边 8192 / png,jpeg,webp,gif** |
| C1：`render` 必须纯、IO 只能在 `execute` | ✅ TRUE（层级见 §1.6） | `dsh-tools/lib/types/schema.d.ts:178-240` |
| C2：模型不支持图片输入时是**硬失败**（`UNSUPPORTED_CONTENT`），不是降级 | ✅ TRUE | pi-ai：`dsh-llm-pi-ai/lib/index.js:1858-1861`，`if (containsImage && !model.input.includes("image")) throw new LlmError(\`pi-ai model "${model.id}" does not support image input\`, "UNSUPPORTED_CONTENT")`；DeepSeek：`dsh-llm-deepseek/lib/index.js:1414-1416`，读**静态 catalog** 的 `inputModalities` |
| C2：解析链 `entry.input ?? catalog ?? route.defaultInput`，`DEFAULT_INPUT = ['text']` | ✅ TRUE | pi-ai `lib/index.js:687`、`:940`；`info.inputModalities` 由 `:1825` 映射 |
| C2：门控必须按"**显式声明才放行**" | ✅ TRUE | 两个适配器在缺失时都不放行 ⇒ 计划的防御性门控是必要的 |
| C2：工具结果**可以**带 image 块 | ✅ TRUE | pi-ai 对 role `'tool'` 豁免（`lib/index.js:1185`）；DeepSeek `lib/index.js:1416` 限定 user/tool |
| C3：应走 `ctx.subprocess` 而非裸 `child_process.spawn` | ✅ TRUE（细节见 §1.4） | `dsh-subprocess/lib/types/index.d.ts:88,102`；`types.d.ts:69-99` |
| C4：faster-whisper **没有** `python -m faster_whisper` CLI，必须自带 worker | ✅ TRUE | 装包后实测：入口只有 Python API（`WhisperModel`）；`faster_whisper/` 下无 `__main__.py` |
| C4：`-vsync` 不可信、**时间戳与输出文件 1:1**、正则要能吃整数 | ✅ TRUE（ffmpeg 6.0 复现）—— 但**打印器必须用 `showinfo`**，原写的 `metadata=mode=print` 不输出 `pts_time`（见 §2 勘误与 §10 D1） | §2.2 实测表 |
| §5：`parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` 存在且由 `defineTool` 调用 | ✅ TRUE | `dsh-tools/lib/types/schema.d.ts:157,163`；`lib/index.js:792,802,848-849` |
| §5：spec DSL 下 `object` 节点必须显式 `additionalProperties` | ✅ TRUE（仅 spec DSL，且有例外） | `ObjectValueSchemaSpec` 要求 `additionalProperties: boolean`（`schema.d.ts:58-62`），编译器校验 `authorError`（`lib/index.js:699`）。⚠️ **`parameters` 根节点是隐式开放对象（`schema.d.ts:161`），不要在那里加**；手写 JSON Schema 注册时该项是可选的（`json-schema.d.ts:33-34`） |
| §7：用 `@deepseek-ai/schemastery` 定义 `Config` | ✅ TRUE | 本机 `3.18.4`；写法见 `dsh-tool-fs/lib/index.js:1181-1186,1212`（`export { Config, apply, inject, name }`） |

---

## 6. 逐 Phase 修订建议

| Phase | 必须改的点 |
|---|---|
| **Phase 0** | §10 整表按 §3 重写；补 MSVCP140 校验项（§4.1）；补"python 候选解释器必须实测 `import faster_whisper`"（§4.4） |
| **Phase 1** | peer 版本改 `^0.2.0-rc.2`，去掉 `dsh.compatibility.dshReleases`（§1.1/§1.2）；`media_probe` 校验项改为：`ffmpeg -version`、`ffprobe -print_format json`、**`av` 主版本 < 19**、`ctranslate2`/`onnxruntime` **可构造对象且能跑一次推理**（不能只 `import`——见 §4.1）、`ctx.attachments`/`ctx.subprocess` 实际可调用 |
| **Phase 2** | worker 启动参数用 `whisper.pythonPath`；**默认模型改 `tiny`**（§4.5）；~~默认 `device: cpu`~~ ⇒ **改 `device: auto` + `computeType: auto`**（§5.1.0、§9.4.2）；`mkl_malloc`、`0xC0000005` 各自归类为独立错误；探测 `local_files_only=True` 是否可离线（本机为是） |
| **Phase 3** | 门控改 `resolveModelInfo` + `exec.agent.session.requestHeader()?.config`（§1.3）；帧临时目录自己 `mkdtemp`（§1.4c）；`maxFrames` 默认值要 ≤ `imageLimits.maxImagesPerMessage`（实测 20，计划正好卡在边界，建议默认调小到 12~16 留余量）；同时实现 `output.presentationMeta` + `presentResult` 才能回放出图（§1.6） |
| **Phase 4** | `timeoutMs` 等字段是**顶层**（§1.6）；`SubprocessSpawnSpec` 无 `timeoutMs`，超时自己用 `signal`（§1.4） |
| **Phase 5** | 测试用例里的 `av` 断言改 `>=19` 才拒绝；README 安装前提改为 §4.2 的实际清单 + `av<19` + VC++ 运行时 + 3.14 |

---

## 7. 仍然存在的风险 / 待决策项

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| D1 | 内存 4 GB，`base`+/长音频可能 `mkl_malloc` | ✅ **已解决**（扩容到 64 GB，见 §9.5） |
| D2 | `python` 指向 3.15，需 `whisper.pythonPath` | ✅ **已解决**（3.14 已提升为默认，见 §9.2） |
| D3 | `ffmpeg`/`python 3.14` 已装但**当前 `dsh web` 进程尚未重启** | 现有进程的 PATH 里还没有 ffmpeg | ✅ **已解决**（重启后已验证生效）；⚠️ 但 §9.2 的 Python 默认提升是在那次重启**之后**做的 → **需再重启一次** |
| D4 | 默认路由 `input: [text, image]` 属**过度声明**（计划 R2b 已记录） | provider 可能在回合中途拒绝且消息已落盘 | 保留计划的门控作为防御；出现该错误就删掉那 4 行回滚 |
| D5 | 本机无 GPU，`whisper.device: auto` 实际等于 `cpu` | 无影响，但 `auto` 在有 GPU 的机器上可能因缺 cuBLAS/cuDNN 失败 | 默认写 `cpu`，README 说明 `cuda` 前置条件 |
| D6 | 计划"参考 `dsh-context`/`dsh-knowledge`"在本机不成立 | 实现时无处对照 | 改用 §2.4 的 .pnpm 内真实参考实现 |
| D7 | 本机存在 `dsh-experimental-speech-to-text-sensevoice`（现成语音转写插件） | 可能重复造轮子 | 实现 Phase 2 前先读它，至少复用 worker 生命周期设计 |

---

## 8. 复核命令（可随时重跑）

```powershell
$py = "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe"

# 1) 工具链
ffmpeg -version | Select-Object -First 1
ffprobe -version | Select-Object -First 1
& $py -VV
& $py -c "import av,ctranslate2,faster_whisper,onnxruntime; print(av.__version__, ctranslate2.__version__, faster_whisper.__version__, onnxruntime.__version__)"
(Get-Item C:\Windows\System32\msvcp140.dll).VersionInfo.FileVersion   # 期望 >= 14.30

# 2) 原生链路真的能跑（不要只 import）
& $py -c "import onnxruntime as o; print(o.get_available_providers())"
& $py -c "import ctranslate2 as c; print(c.get_supported_compute_types('cpu'), c.get_cuda_device_count())"

# 3) 离线转写（把 13s 语音换成任意真实音频）
& $py -c "from faster_whisper import WhisperModel; m=WhisperModel('tiny',device='cpu',compute_type='int8',local_files_only=True); s,i=m.transcribe(r'$env:USERPROFILE\.dsh\media-selftest\speech.flac',vad_filter=True); print(i.language,[x.text for x in s])"

# 4) 抽帧时间戳与文件 1:1
ffmpeg -hide_banner -y -i "$env:USERPROFILE\.dsh\media-selftest\blocks.mp4" `
  -vf "select='gt(scene,0.3)',metadata=mode=print" -fps_mode vfr -frames:v 20 -q:v 3 "$env:USERPROFILE\.dsh\media-selftest\f_%04d.jpg" 2>&1 |
  Select-String 'pts_time'
```

本报告用到的测试素材留在 `%USERPROFILE%\.dsh\media-selftest\`（`speech.flac` 真实语音 13s、`blocks.mp4` 4×2s 色块+正弦音轨、`audio.wav` 16k 单声道），可直接复用为 Phase 5 的测试夹具。

---

## 9. 硬件扩容后的复验（2026-10-15 二次实测，**最新权威**）

### 9.1 变化点

| 项 | 扩容前（§3/§4 记录） | **扩容后（现状）** |
|---|---|---|
| CPU | Xeon Cascadelake，1 核 / 2 逻辑处理器 | **2 × Intel Xeon Gold 5118 @2.30GHz = 8 核 / 8 逻辑处理器**（`os.cpu_count() == 8`） |
| 内存 | 4 GB（空闲约 1.1~1.3 GB） | **64 GB**（65535 MB，空闲约 61 GB） |
| 磁盘 | 79 GB 空闲 | 71 GB 空闲（已含 2.08 GB 模型） |
| 虚拟化 | 原为 1 核 VM | **KVM 虚拟机**，主机名 `10-60-114-126` |
| GPU | 无（`nvidia-smi` 无法通信） | **仍无**（`ctranslate2.get_cuda_device_count() == 0`） |
| `python` 默认 | 3.15（装不了 faster-whisper） | **3.14.8**（已提升，见 §9.2） |

**操作系统未变**：Windows Server 2022 Datacenter 20348；`MSVCP140.dll` 仍为已修复的 14.44.35211.0；ffmpeg/ffprobe 6.0、模型缓存、自测素材**全部保留**。

### 9.2 `python` 3.14 提升为默认（本次实际改动）

| 改动 | 值 |
|---|---|
| **用户 PATH** | 在**最前**插入 `...\Python314\Scripts` 与 `...\Python314`（3.15 的两条保留在其后，仍可用） |
| **`PY_PYTHON`（用户环境变量）** | `3.14` ⇒ `py` 启动器默认 3.14（`py -0p` 显示 `-V:3.14 *`） |

验证结果：

```
python -> C:\Users\Administrator\AppData\Local\Programs\Python\Python314\python.exe
Python 3.14.8
faster-whisper 1.2.1 | av 18.1.0 | ctranslate2 4.8.3 | onnxruntime 1.31.0
py -0p →  -V:3.15   ...\Python315\python.exe
          -V:3.14 * ...\Python314\python.exe
```

> ⚠️ **生效范围**：PATH 变更只对**新启动的进程**生效。本次改动发生在最近一次 `dsh web` 重启**之后**，因此 **DSH 派生的子进程目前仍把 `python` 解析到 3.15**（实测：后台 `python` 跑 faster-whisper 报 `ModuleNotFoundError`）。**需再重启一次 `dsh web`**；在那之前插件调用请用绝对路径或 `whisper.pythonPath`。这也再次印证 §4.4 的结论：**探针必须实测 `import faster_whisper`，不能只认路径**。

### 9.3 复验结果（全部通过）

| 验证项 | 结果 |
|---|---|
| `ffmpeg` / `ffprobe` 经 PATH 解析 | ✅ 6.0，`Get-Command` 命中（上一次 `dsh web` 重启已使 PATH 生效） |
| 场景抽帧时间戳 1:1 | ✅ `f_0001.jpg`/`f_0002.jpg` ↔ `pts_time:4` / `:6` |
| `ffprobe` 流识别 | ✅ `0:video/h264` / `1:audio/aac` |
| 抽音轨 16k 单声道 | ✅ 256,426 字节 WAV |
| 原生库可用性 | ✅ `ctranslate2` / `onnxruntime` 正常（8 核被正确识别） |

### 9.4 模型基准（8 核，13.0s 真实语音，`cpu/int8/beam5/vad`）

| 模型 | 加载 | 转写 | 相对实时 | 决策 |
|---|---|---|---|---|
| `tiny` | 1.3s | **1.6s** | **8.0×** | 保留 |
| `base` | 0.9s | **2.8s** | **4.6×** | 保留 |
| **`small`** | 2.0s | **7.9s** | **1.7×** | ✅ **默认** |
| `medium` | 37.5s（含 1.5 GB 下载） | **21.7s** | **0.6×** | ⚠️ 慢于实时，仅按需 |
| `large-v3` | — | — | — | ~~未拉取~~ → **已实测，见下方补测** |

**已预置模型**：`tiny` / `base` / `small` / `medium`（HF 缓存 blobs 共 **2.08 GB**），`local_files_only=True` 离线可加载。

#### 9.4.1 `large-v3` 补测（2026-10-16，**已拉取并实测**）

上述表格每个模型只跑过一条 13.0s 音频，模型间的精度差无从比较。为此本轮**五个模型全部重测一遍**，用两条已知原文的 TTS 素材（Windows SAPI：`Huihui` zh-CN / `Zira` en-US，16 kHz 单声道，写盘后经 ffmpeg 处理），协议不变（`cpu / int8 / beam_size=5 / vad_filter=True`），并用量纲无关的**去标点字符错误率**比较精度：

| 模型 | 加载 | zh 24.08s 转写 | 相对实时 | en 8.04s 转写 | 相对实时 | 中文 CER | 英文 WER |
|---|---|---|---|---|---|---|---|
| `tiny` | 1.70s | 1.87s | 12.89× | 0.87s | 9.28× | 7.2% | 5.9% |
| `base` | 1.23s | 2.77s | 8.68× | 1.51s | 5.34× | 8.4% | 5.9% |
| **`small`** | 2.80s | 7.58s | **3.18×** | 3.88s | 2.07× | 6.0% | 5.9% |
| `medium` | 6.18s | 21.08s | 1.14× | 11.49s | 0.70× | 6.0% | 5.9% |
| `large-v3` | **11.02s** | **33.85s** | **0.71×** | **19.84s** | **0.41×** | **4.8%** | 5.9% |

**三点结论**（`large-v3` 的默认值决策由此有实测依据）：

1. **拉取与加载**：首次拉取到加载完成共 **88s**（HF 通道比 §4.3 记录的 ~700 MB/min 快得多），缓存 blobs 实占 **2.88 GB**（与计划估算的 ~3.1 GB 一致）；暖启动加载 **11.02s**，比 `small` 贵 4 倍。
2. **精度**：`large-v3` 中文 CER **4.8%**，是五个模型里最好的；但相对 `small`（6.0%）只少 1.2 个百分点，而且错的地方**五档一致**——`转录`→`转路`、`抽帧`→`抽真/抽针`（TTS 发音域内难以区分）。英文五档都只剩数字写法差异（`three`→`3`、`eight`→`8`），精度上分不出胜负。
3. **速度**：`large-v3` 在 8 核 CPU 上是 **0.71×（中文）/ 0.41×（英文）实时**——1 小时录音约需 **1.4 小时**。故 **`small` 仍作默认合理**，`large-v3` 定位为"精度优先、可接受慢于实时"的按需档；B8 的"CPU 上更慢"由估算变为实测。

**素材与脚本**：本次放在仓库外的临时目录 `C:\workspace\github\_scratch\`（`bench.py`、`accuracy.py`，TTS 原文与 5×2 全部结果写在脚本/JSON 里，可直接重跑核对）；该目录是临时产物，核对完即删，未纳入仓库。

#### 9.4.2 GPU（Tesla P40 / CUDA）实测 —— 2026-10-16

**本机其实有卡**：`PCI\VEN_10DE&DEV_1B38`（GP102 = Tesla P40），KVM 直通，`nvidia-smi` 报 **23040 MiB / 驱动 573.76 / compute cap 6.1**。此前"无 GPU"的结论是**误判**，根因不是没有硬件，而是驱动从未真正加载，见下方"卡在哪"。

**GPU 基准**（同一素材与协议，`device=cuda`、`compute_type=int8_float32`、`beam_size=5` + VAD）：

| 模型 | 设备 | zh 24.08s | 相对实时 | en 8.04s | 相对实时 | 加载 |
|---|---|---|---|---|---|---|
| `large-v3` | cpu/int8 | 33.85s | 0.71× | 19.84s | 0.41× | 11.02s |
| **`large-v3`** | **cuda/int8_float32** | **5.30s** | **4.55×** | **1.03s** | **7.81×** | 10.26s |
| `medium` | cpu/int8 | 21.08s | 1.14× | 11.49s | 0.70× | 6.18s |
| **`medium`** | **cuda/int8_float32** | **1.92s** | **12.53×** | **0.68s** | **11.83×** | 4.84s |
| `small` | cpu/int8 | 7.58s | 3.18× | 3.88s | 2.07× | 2.80s |
| **`small`** | **cuda/int8_float32** | **0.96s** | **25.06×** | **0.36s** | **22.42×** | 2.10s |

**结论**：

1. **加速比 6~8×**（中文：`large-v3` 6.4×、`small` 7.9×、`medium` 11×）。`large-v3` 在 GPU 上是 **4.55× 实时** —— 1 小时录音约 **13 分钟**（CPU 上要 ~85 分钟）。⇒ **有卡时 `large-v3` 从"精度优先的按需档"变成"可作默认的候选"**（是否改默认仍取决于部署机器有没有卡，默认值按 §5.1.0 的 `auto` 解析）。
2. **GPU 与 CPU 的文本一致**：同一素材上 CPU `int8` 与 GPU `int8_float32` 输出**逐字相同**（含同样的 CT2 已知混字 `转录`→`转路`）。⇒ GPU 不会改变精度结论。
3. ⚠️ **`float16` 在 P40 上直接报错**（`ValueError: Requested float16 compute type, but the target device or backend do not support efficient float16 computation`）——P40 是 GP102，FP16 吞吐只有 FP32 的 1/64，CT2 直接拒绝。本机实测可用集合：`cuda → {float32, int8, int8_float32}`；`cpu → {float32, int16, int8, int8_float32}`。**这正是 §5.1.0 要求 `computeType: auto` 而不能硬编码 `float16` 的实证**：自动选择应落在 `int8_float32`。

**卡在哪（这轮修复的实际过程，供换机器时复现）**：

| 步骤 | 现象 | 结论 |
|---|---|---|
| 1 | 设备存在（`Problem=CM_PROB_NONE`）但 `Service` 为空、无 `nvlddmkm.sys`、`cuInit=100` | 有硬件、有半装的驱动包，但没有可用的内核驱动 |
| 2 | `DriverStore` 里**已有** P40 的包（`oem8/nv_dispswi` 537.36、`oem6/nv_dispui` 538.33），且 ranked `00CF0001` | 包是齐的，问题在加载 |
| 3 | `nvlddmkm` 服务 `Start=3`（按需）、`ErrorControl=0`，`ImagePath` 指向 DriverStore 里**存在**的 `nvlddmkm.sys` | ★ **根因之一**：内核驱动从不加载 |
| 4 | 改为 `Start=0`+`ErrorControl=1` 并 `sc start` → `STATE: 4 RUNNING`，但设备仍无 `DEVPKEY_Device_Service` | 驱动起来了，设备节点却仍未被配置 |
| 5 | `DevNodeStatus` 含 `0x01000000`（`DN_NEED_RESTART`）；`pnputil /remove-device` + `/scan-devices` 重建节点 | ★ **根因之二**：设备节点是"待重启"的残状态 |
| 6 | 节点重建后自动绑定 `nvlddmkm`/`oem8.inf`，`DIF_INSTALLDEVICE` 返回 `0xc0000493`（`STATUS_DEVICE_HARDWARE_ERROR`） | ⚠️ 这一步曾是"硬件不响应"的误判来源；**实际是启动过程中的瞬时错误**，节点随后完成启动 |
| 7 | `cuInit=0` / `cuDeviceGetCount=1` / `Tesla P40` / `compute cap 6.1` / `ctranslate2.get_cuda_device_count()==1` | ✅ 通了 |

**换机器时的排查顺序**：① `sc query nvlddmkm` 与服务的 `Start/ErrorControl`（按需启动 + 半装最容易被忽略）→ ② `DevNodeStatus` 是否含 `DN_NEED_RESTART`，必要时 `pnputil /remove-device` + `/scan-devices` 重建节点 → ③ `cuInit`/`cuDeviceGetCount` 直接问 CUDA 驱动 API（比 `nvidia-smi` 更能区分"驱动没起"与"设备没绑"）→ ④ 最后才怀疑硬件/直通。**本次全程没重启机器**。

⚠️ **Windows 的 Pascal 支持边界（与 Linux 文档不一致，已实测）**：NVIDIA 官方矩阵把 Pascal 6.1 的"Last Driver Support"写成 **R580**，但 **Windows 版 R580 起已不再包含 P40 的 INF**——实测 `616.92`（R615）与 `596.86`（R595）解包后**所有 INF 里都没有 `DEV_1B38`**；本机能用的包是 R573 分支（`537.36`/`538.33`），**`536.25` 也含 `DEV_1B38`**（`nv_dispwi.inf`）。⇒ Windows 上的实际边界早于文档口径，换卡/升级驱动前必须先查 INF 是否含 `DEV_1B38`。

⚠️ **写入的系统改动**（便于回滚）：`HKLM\SYSTEM\CurrentControlSet\Services\nvlddmkm` 的 `Start` 由 `3` 改为 `0`、`ErrorControl` 由 `0` 改为 `1`（保证重启后驱动自动加载）；设备节点被 `pnputil /remove-device` 重建过一次（因是即插即用设备，重建是常规且无损的操作）；设了 `whisper.device` 相关的临时**代码**在仓库外，未进仓库。

### 9.5 由此产生的默认值变更（已同步进计划）

| 配置 | 扩容前建议 | **现在** |
|---|---|---|
| `whisper.model` | `tiny`（内存所迫） | **`small`** |
| `whisper.device` | `cpu` | **`auto`**（⚠️ 2026-10-16 修正：本机有 Tesla P40 且已打通，`auto` 会解析为 `cuda`；无卡机器自动落 `cpu`，见 §9.4.2） |
| `whisper.computeType` | `int8` | **`auto`**（⚠️ 2026-10-16 修正：按 device 取可用档——GPU `int8_float32`、CPU `int8`；`float16` 在 P40 上被 CT2 直接拒绝，见 §9.4.2） |
| `whisper.pythonPath` | 必须显式指向 3.14 | **仍建议显式**，但默认 `python` 已是 3.14 |
| 内存相关风险（R3e） | 高 | **基本消除**（`mkl_malloc` 仍应作为独立错误类保留） |
| `frames.maxFrames` | 16 | **16**（不变——约束来自 `imageLimits.maxImagesPerMessage = 20`，与内存无关） |

### 9.6 §7 待决策项的现状

| # | 原状态 | 现状 |
|---|---|---|
| D1 | 内存 4 GB，`base`+/长音频可能 `mkl_malloc` | ✅ **已解决**（64 GB） |
| D2 | `python` 指向 3.15，需 `whisper.pythonPath` | ✅ **已解决**（3.14 已为默认，重启后 DSH 子进程亦为 3.14.8） |
| D3 | `dsh web` 未重启，PATH 里没有 ffmpeg | ✅ **已解决**（重启后 `Get-Command ffmpeg` 命中） |
| D5 | 无 GPU，`device: auto` 等于 `cpu` | ⚠️ **前提已被推翻**（2026-10-16，见 §9.4.2）：本机**有** Tesla P40，`auto` 解析为 `cuda`；无卡机器仍自动落 `cpu`，故默认用 `auto` |
| D4 / D6 / D7 | — | 未变 |

### 9.7 两项设计决策（2026-10-16）

| 项 | 决策 | 记录位置 |
|---|---|---|
| 长音频执行模型 | **走 `jobs` 后台作业**：`transcribe_audio` 起 `kind: 'transcribe'` 作业后立即返回 `jobId`，正文由 `job_output` 读取；`video_frames` 保持同步（抽帧秒级，且帧图需在 `execute` 内落附件服务） | 计划 §5.1（契约）、§6（输出）、§7（配置）、§8 R2c |
| vision 真图 | **已实测通过**：`read_image` 把含随机码的 PNG 作为工具结果投给默认路由，模型读出 `FFEJD9` 与未入上下文的答案一致 ⇒ 工具结果里的 image 块被上游接受并理解，R2b 的过度声明有真实能力兜底 | 计划 §10.4（方法+证据） |
| 宿主侧范本 | **已找到**：`C:\workspace\github\dsh-mcp-skill-panel` ⇒ B2 关闭。其**打包 `external` 铁律**纠正了一条会真出事的地方：把 `@deepseek-ai/*` 内联进 bundle 会得到第二份模块副本 → 重复 Symbol → 工具调度崩溃 | 计划 §3.1、§11.3 B2 |

> 这两项都已闭环，不再是开工前的待决项；§9.6 的 D4/D6/D7 也不构成阻断（见计划 §11.3）。

---

## 10. 实施期偏离清单（2026-10-16，**权威口径：以实现为准**）

插件已实现并端到端验证（`test/` 69 项全绿）。下面是**设计与实现的全部不一致**——
凡与此表冲突的旧描述，一律以本节与代码为准。计划文档中对应段落已就地加了勘误。

| # | 原设计 | **实现（权威）** | 为什么改 |
|---|---|---|---|
| D1 ★ | 抽帧时间戳用 `metadata=mode=print`（且标为"实测已通过"） | **用 `showinfo`**；解析优先匹配 `n: <i> pts: … pts_time:<s>`，裸 `pts_time` 兜底，并记录 `parsedFrom` | 本机 ffmpeg 6.0 实测 `metadata=mode=print` **不输出 `pts_time`** ⇒ 时间戳全部静默退化为按帧率估算。原"实测通过"的结论无法复现 |
| D2 | `transcribe_audio` 输出 `status: 'running'`（恒为 running） | **`status: 'running' \| 'not-started'`**；`not-started` 时 `jobId` 为空串，并带 `reason` | 前置判定（无音轨/不支持的 scheme）时不起作业，原契约自相矛盾（`running` 配空 `jobId`），渲染成 `job  (…)` |
| D3 | 工具返回值未规定 JSON 无损 | **返回值边界一律 `pruneUndefined`**（`src/pure/json.ts`） | 宿主校验器遇任何 `undefined` 属性整体判 `invalid output "value is not lossless JSON"`，且**不报字段名**；而对象展开不会省掉键 |
| D4 | 帧条目含 `attachmentId`/`path`/`width`/`height` | **额外含 `mediaType`/`bytes`**；并含 `durationSec` 与 `note` | 回放（会话重放）时 `render` 拿不到文件，需靠这些字段重建 `ImageAttachmentRef` |
| D5 | 配置项含 `workDir` | **不存在该配置项**；临时目录固定为 `os.tmpdir()` 下的独立 `mkdtemp` | 原表列了一个从未实现的键 |
| D6 | `whisper.timeoutMs` "覆盖下载+长音频" | `whisper.timeoutMs` **只管转录**；下载有独立的 `download.timeoutMs` | 两条路径是不同子进程，预算应当分开 |
| D7 | `video_frames` 同步抽帧，"中等（分钟级）" | 一致，实取 **600s**；`transcribe_audio` 取 **120s**（只做前置校验+起作业）；`media_probe` **180s** | 计划要求"按工具性质设定并在 README 写明依据"，已写入 README |
| D8 | 取消的行为未规定 | 取消终态必须是 **`killed`**（不是 `failed`），reason 进终态；`exec.signal` 与 `job_kill` 共用同一 `AbortController` | 原实现下"我按了取消"与"它真炸了"在 `job_list` 里无法区分，用户不知道该不该重试 |
| D9 | 输入只支持本地文件（原计划明确"不支持远程 URL"） | **支持 http(s)**：直链走 ffmpeg、平台页面走 yt-dlp；不支持的 scheme 明确拒绝 | 用户后续提出的需求（见计划 §11.2 新增需求段） |
| D10 | 无 `render` 层的测试 | `output.render` 抽到 `src/pure/render.ts` 并加 8 项回归测试 | render 是**模型唯一能看到的一面**，D2 与"取消提醒"两个缺陷都出在这里，原先完全没测到 |
| D11 | 错误矩阵中"死链"未分类 | 死链/404 归 **`download-failed`**（含 `HTTP error 4xx`、`Server returned 4xx` 等实测形态） | 原分类器只认 yt-dlp 的措辞，ffmpeg 拉死链会落 "unrecognised reason" |
| D12 | worker 路径约定未写明 | **唯一约定**：`workersDir()` 返回 workers 目录本身，调用方只拼文件名；并加"脚本不存在即报错"断言 | 两处各拼一次 `workers` ⇒ 路径不存在 ⇒ 探针静默失败、伪装成"这台机器没装依赖" |

**两条可复用的教训**（比单个 bug 更值钱）：

1. **"shell 里手跑成功"≠"插件里成功"**：D1、D12 都是命令/路径在 shell 里看着没问题，
   在宿主里才暴露。凡是要写进代码的契约，必须在真实宿主里端到端复验。
2. **静默降级比报错危险**：D1（时间戳退化为估算）与 D12（探针空结果 ⇒ 落 CPU）
   都不报错、都"看起来在正常工作"。**降级必须有痕迹**（`timestampSource`、`reason`、
   `parsedFrom`），**路径错误必须报错而不能降级**。
