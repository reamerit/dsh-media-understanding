# DSH 音视频理解插件 · Coding Plan

> 目标：在空仓库 `dsh-media-understanding` 中实现一个 DSH 宿主侧插件，注册 `transcribe_audio`（音频/视频 → 转录文本）与 `video_frames`（视频 → 带时间戳的关键帧真图）两个工具。
>
> 本计划最初基于对**原开发机**的勘察（DSH 0.1.7-rc.2）编写，并在 §1 修正了原技术方案中会导致实现失败的若干处。
> ⚠️ **后续实现全部在本机进行，一切以本机为准**：本机为 `C:\workspace\github\dsh-media-understanding` + **DSH 0.2.0-rc.2**，硬件 **2×Xeon Gold 5118 = 8 核 / 64 GB / 无 GPU**。所有环境相关的路径、版本、默认值以**顶部勘误块 + §10.2**为唯一权威。
>
> **2026-XX 更新（Phase 0 已执行）**：环境探测完成，结果见 §10；照片输入路由已配置并**实测生效**（见 C2）；命令沙箱根因已定位（见 C5）；`ffmpeg` 与 `faster-whisper` 已在安装。

> ## ⚠️ 勘误（2026-10-15 复审，详见 [coding-plan-review.md](./coding-plan-review.md)）
>
> 本计划写于**另一台机器**（`D:\Ollama\...`、用户 `reamerai\reame`、DSH 0.1.7-rc.2）。在**当前机器**（`C:\workspace\github\dsh-media-understanding`、DSH **0.2.0-rc.2**）上复审后，以下条目**必须按本节修正**，否则会在 Phase 1/2 直接失败：
>
> | # | 原文 | 修正 |
> |---|---|---|
> | 1 | §3 peerDependencies 全部 `^0.1.7-rc.2` | **`>=0.2.0-rc.2`**（否则被插件管理器判 `incompatible-version` 拒绝装载；判定只看 peerDependencies ↔ 运行时版本）。⚠️ 必须写成 `0.2.0-rc.2`（带点）——`rc2` 不匹配；`@deepseek-ai/cordis` 不参与判定 |
> | 2 | §3 `dsh.compatibility.dshReleases` | **该字段不存在**，删掉；真实形状为 `{ bundle: { patch }, manifestVersion: 1 }` |
> | 3 | C2 `ctx.llm.resolveModel(...)` | **`ctx.llm.resolveModelInfo(provider, model, exec.signal)`**（`resolveModel` 只在插件拿不到的 `LlmAdapter` 上） |
> | 4 | C3 `stderr: { maxBytes }` 即得 spill；`await handle.done` 取输出 | 要显式传 `spill: { maxBytes }`；**`handle.done` 只返回 `{ exitCode, signal }`**，输出走 `handle.collected.stderr?.readFrom(0)`（含 `spillPath`） |
> | 5 | C3"`ctx` 提供的 home/temp 路径" | **不存在此服务**：用 `node:os` 的 `tmpdir()`+`mkdtempSync`，或 `exec.agent?.session.header.cwd`，或库包 `@deepseek-ai/dsh-home-paths` |
> | 6 | **C4c 钉 `av<17`** | **改钉 `av<19`**。移除 `metadata_errors` 的是 **PyAV 19.0.0**（不是 17）；实测 `av 18.1.0` 通过、`19.0.1` 报 `TypeError`。§10 表格里写的"PyAV 19"才是对的，C4c 与之矛盾 |
> | 7 | C4c 探针"`av` 主版本 < 17" | 改为 **`< 19`** |
> | 8 | §5 `presentCall`/`presentResult`/`isConcurrencySafe`/`timeoutMs` 视作 `output.*` | 这些是**顶层字段**；`output` 只有 `{ schema, render, presentationMeta? }` |
> | 9 | §4 Phase 1"自动探测 python" | 本机原默认 `python` 是 3.15（装不了 faster-whisper：`ctranslate2`/`onnxruntime` 无 cp315 wheel）。**现已把 3.14 提升为默认**（用户 PATH 中 3.14 优先 + `PY_PYTHON=3.14`）；探针仍应**实测 `import faster_whisper`** 而非只认路径 |
> | 10 | §10 环境表 | 整表失真，见 §10.2 的实测值 |
> | 11 | §3"参考 `dsh-context`、`dsh-knowledge`" | 本机**未安装**这两个包；改用 `.pnpm` 内的真实参考（`dsh-tool-fs` 的 `read_image`、`dsh-tool-fs-search` 的 spawn、`dsh-experimental-speech-to-text-sensevoice` 的长驻 worker） |
> | 12 | 原文按"小机器"推断的默认值 | **硬件已扩容为 8 核 / 64 GB（无 GPU）**：`whisper.model` 默认改回 **`small`**（13s 音频 7.9s ≈ 1.7× 实时；`medium` 仅 0.6× 实时，慢于实时不推荐作默认）；内存相关限制已消失；`device` 仍应为 **`cpu`**（无 GPU） |
>
> **计划未预见、但本机实测撞到的阻断级环境缺陷**：`C:\Windows\System32\MSVCP140.dll` 为 2019 年的 14.22.27821.0，导致 `ctranslate2`/`onnxruntime` 一调用就 **`0xC0000005` 硬崩溃（无 traceback）**。已装 VC++ 2015-2022 可再发行组件修复（→ 14.44.35211.0）。`media_probe` 应把"子进程无输出退出且退出码为 `0xC0000005`/`-1073741819`"识别为独立的运行时缺失错误。

---

## 1. 勘察结论：必须先修正的 4 个前提

原方案的整体思路（音频→转录文本、视频→帧图+转录，交给主模型融合）成立。但以下 4 点按原方案写会直接失败：

### C1（阻断级）工具产生的 image 块**不是** base64 直传

原方案：

```ts
{ type: 'image', source: { type: 'base64', data: f.base64 } }   // ❌ DSH 无此形状
```

DSH 的真实契约（`@deepseek-ai/dsh-llm` 的 `ImageBlock`）：

```ts
export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef   // 只有持久引用，没有 source/base64
}
```

`ImageAttachmentRef` 是不透明存储 id + 媒体类型 + 字节数 + 宽高。**插件无法凭空构造**，必须先把 JPEG 字节交给附件服务持久化：

```ts
const refs = await ctx.attachments.saveImages([{ data: jpegBytes, mediaType: 'image/jpeg', name }])
// → ImageAttachmentRef[]，再放进 ImageBlock.attachment
```

`ctx.attachments` 只存在于宿主半（`@deepseek-ai/dsh-attachment` 的 service）。因此：

- `video_frames` 的 `execute` 必须注入 `attachments` 服务并做持久化，`render` 只做投影；
- 抽帧工具**不能**在 `render` 里读文件/编码（`render` 必须是纯函数）。

### C2（阻断级）模型路由不支持图片输入时，整个模型调用会**报错**，不是降级

本机 `~/.dsh/profiles/web/cordis.patch.yml` 的默认路由是：

```yaml
- id: agent-default-model
  config: { provider: dsh, model: coding-standard-local }   # ⚠️ 勘误：provider 名是 dsh（不是 loki）
```

`dsh` provider 段下的 `coding-standard-local` **没有声明 `input: [text, image]`**。而 pi-ai 适配器（本 profile 用的 `@deepseek-ai/dsh-llm-pi-ai`）是**硬失败**：

```js
if (containsImage && !model.input.includes('image'))
  throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
```

DeepSeek Messages 适配器同样抛 `UNSUPPORTED_CONTENT`，并要求路由是 vision 模型且附件服务已挂载。

**后果**：只要 `video_frames` 在默认模型下返回了 image 块，用户下一次提问就会整轮失败 —— 这比"看不到图"严重得多。

**对策（写进实现）**：`video_frames` 在产出 image 块前必须做能力门控。⚠️ **勘误**：服务上的方法名是 **`resolveModelInfo`**（`dsh-llm/lib/types/index.d.ts:360`），**不是** `resolveModel`（后者只在插件拿不到的 `LlmAdapter` 抽象类上，`index.d.ts:171`）：

```ts
// ⚠️ 勘误：resolveModel → resolveModelInfo
const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
const canSeeImages = info.inputModalities?.includes('image') === true
```

`provider` / `model` 在 `execute` 里这样取（逐字对齐 `dsh-tool-fs/lib/index.js:898-904`，计划原文漏了这一段）：

```ts
const routed   = exec.agent?.session.requestHeader()?.config
const provider = routed?.provider ?? exec.agent?.options.provider
const model    = routed?.model    ?? exec.agent?.options.model
```

- `canSeeImages === true` → 走真图分支；
- 否则 → **不返回 image 块**，返回 canonical 值里的文本分支（帧文件路径 + 时间戳 + 一句说明"当前模型不支持图片输入，请切换到声明了 image 的模型"）。

> 注：`inputModalities` 缺失的官方语义是"未知"，但两个适配器在缺失时都**不**放行图片（pi-ai 用 `model.input.includes('image')`）。所以门控必须按"显式声明才放行"实现。

**已解决（2026-XX）**：✅ **当前机器上该声明已存在**（无需再改）——`provider: dsh` 的 `llm-pi-ai` 段内 `coding-standard-local` 单条 entry 已带：

```yaml
- id: coding-standard-local
  name: coding-standard-local
  contextWindow: 1000000
  input: [text, image]
```

- 字段与作用域均经源码核实：`MODALITIES = ['text','image']`，解析链 `entry.input ?? catalog ?? route.defaultInput`（`DEFAULT_INPUT = ["text"]`），**仅影响该 entry**，不会波及其它模型。
- **实测生效**：配置写入后（未重启）在会话中投喂了一张 PNG，主模型成功读图并解析出图中文字 —— 说明该路由确实接受图片输入，且配置被热加载。
- 备选 vision 路由：⚠️ **勘误**：原文的 `litellm / Qwen3-VL-4B` 在**当前机器不存在**；同 provider 下另有 `Qwen/Qwen3.6-35B-A3B`、`Qwen/Qwen3-VL-Embedding-2B`，但**两者都未声明 `input`**，不能当 vision 备选。
- ⚠️ 该声明属"过度声明风险自负"：pi-ai 的注释明确说，少声明会在附图片前就拒绝（安全），过度声明会让 provider 在**回合中途**拒绝、而消息已落盘。回滚方式 = 删掉这 4 行 `input:`。
- **门控仍要保留**：部署可能被换到未声明 vision 的路由（本机还有 `ollama`、`glm`、`qianwenai` 等），门控是防御性检查，不是一次性修复。

### C3 子进程要走 `ctx.subprocess`，不是裸 `child_process.spawn`

DSH 自带托管的子进程 seam，契约是 `SubprocessSpawnSpec`（⚠️ 勘误已就地标注）：

```ts
const exe = await ctx.subprocess.resolveExecutable('ffmpeg', undefined, exec.signal)
const handle = ctx.subprocess.spawn({          // 同步返回 handle，不是 Promise
  argv: [exe, '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-y', out],
  cwd: workDir,
  // ⚠️ 勘误：不传 spill 就没有 spill 文件；想要完整 stderr 必须显式给 spill
  stdio: { stdin: 'ignore',
           stdout: { maxBytes: 1 << 20 },
           stderr: { maxBytes: 1 << 20, spill: { maxBytes: 8 << 20 } } },
  graceMs: 5000,
  signal: exec.signal,          // 取消即升级终止整个进程组
  // env?: { HF_HOME: ... }     // 可选，可直接给 worker 传环境变量
})
const outcome = await handle.done   // ⚠️ 只给 { exitCode, signal }，没有 stdout/stderr
// ⚠️ 勘误：输出这样取（readFrom 是增量读取，settle 后 readFrom(0) 即批式结果）
const err = handle.collected.stderr?.readFrom(0)   // { text, nextOffset, lossy, spillPath? }
```

用它的理由：可执行文件解析（含 Windows `.exe`）、进程组终止、输出有界收集与溢出落盘、取消联动。裸 `spawn` 会绕过这些，且在 Windows 上 `spawn(message, args, { signal })` 不能保证杀掉 ffmpeg 子进程树。

同时注意：`-y <out>` 的输出路径由插件决定。⚠️ **勘误**：**不存在 `ctx` 提供的 home/temp 路径服务**，可用的是 `node:os` 的 `tmpdir()` + `fs.mkdtempSync()`、或 `exec.agent?.session.header.cwd`、或库包 `@deepseek-ai/dsh-home-paths`（`resolveDshHome`/`dshHomePath`/`dshCachePath`，是库不是 ctx 服务）。**不要**硬编码 `/tmp`（原方案如此，Windows 上不存在）。另外 spill 文件是 subprocess 层**故意保留**的（不自动删），帧图与 spill 都要在 `finally` 里自己清。

### C4 抽帧命令拿不到时间戳；ASR 命令行不存在

**(a) 时间戳**：原方案 `-vf "select='gt(scene,0.3)',showinfo"` + `-vsync vfr`，然后 `timestamp: 0 // 从 showinfo 解析`。这条命令**不会**把帧时间写进能解析的输出（`showinfo` 打到 stderr，且 `-vsync vfr` 下帧号≠时间），结果就是所有帧时间戳都是 0 —— 时间线对齐直接失效。

改用 `metadata=mode=print` 把选择帧的 `pts_time` 打到 stderr 再解析：

```
-vf "select='gt(scene,TH)',metadata=mode=print" -fps_mode vfr -frames:v N -q:v 3 out_%04d.jpg
```

**实测已通过**（原机器 ffmpeg 9.0.2；⚠️ 当前机器实装 **ffmpeg 6.0**，同一命令与结论**均已复现通过**），两个必须注意的点：

1. **`-vsync` 不可信**（原机器 ffmpeg 9 已移除，报 `Unrecognized option 'vsync'`；当前 6.0 尚存但已废弃）→ 必须用 **`-fps_mode vfr`**（或 `passthrough`，两者实测都可用）。`-fps_mode` 自 ffmpeg **5.1** 引入，因此该写法在 6.x/7.x/9.x 上通用 —— "按 9.x 写"的说法应改为"按 **5.1+** 写"。
2. **`select` + `metadata` 串联时，打印出的正是被选中的帧**，与输出文件 **1:1 顺序对应** —— 无需再用帧号/帧率反推。step 只需按顺序把第 i 个 `pts_time` 配给第 i 个 `NNNN.jpg`。
3. 正则：`/pts_time:([0-9.]+)/`；同时可抓 `lavfi.scene_score=([0-9.]+)` 作为诊断信息。
4. `metadata=mode=print` 不写文件（默认打印到日志），**无需** `file=-`（某些版本会把它当字面文件名）。

实测输出示例（4 个 2 秒色块的合成视频，`gt(scene,0.3)`）：

```
[Parsed_metadata_1 @ ...] frame:0    pts:43008   pts_time:4.2
[Parsed_metadata_1 @ ...] lavfi.scene_score=0.400000
[Parsed_metadata_1 @ ...] frame:1    pts:63488   pts_time:6.2
[Parsed_metadata_1 @ ...] lavfi.scene_score=1.000000
→ 文件 a_0001.jpg ↔ 4.2s，a_0002.jpg ↔ 6.2s
```

（t=2.0s 的那次切换没被抓到，是因为它是首帧场景基准：`select` 对第一帧恒为假。设计文档需说明"首帧不产出"，必要时在 `strategy:'scene'` 下额外补抽 `t=0`。）

stderr 收进 `SubprocessCollect` 的 spill 文件以便完整解析。兜底估算保留（解析不到时标记 `timestampSource: 'estimated'`，不假装精确）。

**(b) ASR**：`python -m faster_whisper --model large-v3 ...` **不是** faster-whisper 的 CLI（它是库，只有 Python API）。原方案的 `transcribeWithWhisper` 会直接失败。正确做法是本插件自带一个极小的 Python worker 脚本：

```
src/workers/transcribe.py    # 读参数 → WhisperModel(...).transcribe(...) → 向 stdout 吐 JSON
```

由 `ctx.subprocess.spawn` 以 `argv: [python, workerPath, audioPath, model, language]` 调用，JSON 结果落文件后读取（避免大 JSON 走 stdout 被 collect 截断）。首次运行会自动下载模型，需要：

- 允许配置 `model` 规格（`tiny`/`base`/`small`/`medium`/`large-v3`）。本机 8 核实测（13.0s 真实语音）：`tiny` 1.6s（8.0× 实时）/ `base` 2.8s（4.6×）/ **`small` 7.9s（1.7×，默认）** / `medium` 21.7s（**0.6×，慢于实时，不作默认**）→ **默认 `small`**；
- ⚠️ **勘误**：模型可在**离线**下加载（本机已预置 `tiny`/`base`/`small`/`medium`，实测 `local_files_only=True` 通过），因此 worker 应支持离线/已就绪判定，而不是每次都尝试联网；
- 工具需要有反馈的长超时（下载阶段可能数分钟），并如实告知模型未就绪；
- ⚠️ **勘误**：内存/提交余量不足时表现为 `RuntimeError: mkl_malloc: failed to allocate memory`（可捕获，非崩溃）→ 应作为独立错误类如实回报"内存不足"，而不是笼统的"模型加载失败"。

**(c) 必须钉住 `av<19`（实测踩到的上游坑）** ★勘误：原文写 `av<17`，**版本号错了**。

`faster-whisper 1.2.1` 只声明 `av>=11`（无上限），但其 `faster_whisper/audio.py:46` 仍在传 `metadata_errors="ignore"`：

```python
with av.open(input_file, mode="r", metadata_errors="ignore") as container:
```

而 **PyAV 在 19.0.0 才移除** `av.open()` 的 `metadata_errors` / `metadata_encoding` 参数（[PyAV changelog v19.0.0](https://pyav.basswood.io/docs/stable/development/changelog.html)；v16/v17/v18 的 changelog 均未列出此项）→ 报
`TypeError: open() got an unexpected keyword argument 'metadata_errors'`。

**已实测确认**（本机）：

| 组合 | 结果 |
|---|---|
| `av 19.0.1` | ❌ 上述 `TypeError`，位置 `faster_whisper/audio.py:46` |
| `av 18.1.0` | ✅ `decode_audio()` 返回 `(128174,) float32`，端到端转写通过 |

因此：

- README 与 `media_probe` 必须把 **`av<19`** 作为硬前提校验（探测 `import av; av.__version__` 的**主版本 < 19**）；
- 钉 `av<17` 属**无谓降级**（白丢两个大版本）；
- 若日后 faster-whisper 新版去掉该参数，再放开此钉版本。

### C5（开发环境约束）Windows ACL 沙箱在非提权进程下必然失败

> ⚠️ **勘误（当前机器）**：本节的路径与用户名来自原机器。当前机器上已切到 `danger-full-access`，命令**完全可用**（且该模式下 `IsAdmin = True`），因此本节的处置结论"已解除阻塞"在本机同样成立，只是根因里的具体路径/用户不同。

**现象**：`workspace-write` 模式下任何 `pwsh` 调用都在沙箱初始化阶段失败，报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Ollama\projects\github\dsh-media-understanding)`。

**根因（已读源码定位）**：`@deepseek-ai/dsh-sandbox-windows-acl` 的 `AclSandbox.init()` 会对工作区根调用 `grantWrite()`，后者在 `mergeAndApply()` 里以
`SetNamedSecurityInfoW(path, SE_FILE_OBJECT, 20, …)` 一次性写入 **DACL + SACL 强制完整性标签**（`20 = DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION`）。
写 SACL 需要 `SeSecurityPrivilege`。而**该包全库没有任何 `SeSecurityPrivilege` / `AdjustTokenPrivileges` 调用**（已 grep 确认）—— 即它依赖调用进程本就持有该特权。

**本机事实**：工作区 `Owner = REAMERAI\reame`（`grantWrite` 要求的"调用者拥有"这点是满足的），但 `dsh web`（PID 39416）以 `reamerai\reame` **非提权**运行（`IsInRole(Administrator) = False`）。非提权令牌默认剥离 `SeSecurityPrivilege` → Win32 5 拒绝访问。

**处置**：

- **本会话已切到 `danger-full-access` 文件策略**，该模式下 `read-only` / `danger-full-access` 都不走 ACL 授权（`runner.js`：`manageDacls: !seamManaged`），命令已可用 → **开发不再阻塞**。
- 若日后需要恢复 `workspace-write` 的受限执行，唯一可行的用户侧操作是**以管理员身份启动 `dsh web`**（并非目录 ACL 问题，`icacls` 修不好 SACL 特权缺失）。
- 本插件的工具走 `ctx.subprocess`，其可执行性受同一沙箱约束；在 `danger-full-access` 下不受限。

---

## 2. 交付物与工作区状态

- 工作区 ⚠️ **勘误：`C:\workspace\github\dsh-media-understanding`**（不是 `D:\Ollama\...`），且**非空**（已含 `docs/coding-plan.md` 与本复审报告），从零搭建插件本体。
- 交付：可加载的 DSH 宿主插件包（TypeScript → `lib/`），含两个工具、Python worker、配置 schema、测试与 README。
- **开发环境前置已就绪**：文件策略切到 `danger-full-access` 后命令沙箱不再阻断（根因与取舍见 C5 与 R1）；且该模式下本会话具备管理员权限。

---

## 3. 包结构

参考本机已安装的真实插件。⚠️ **勘误**：本机**没有** `dsh-context`、`dsh-knowledge`；唯一第三方插件是 `dsh-better-sidebar@0.26.0`，另有 `.pnpm` 内的官方实现可作范本（`dsh-tool-fs` 的 `read_image`、`dsh-tool-fs-search` 的 spawn、`dsh-experimental-speech-to-text-sensevoice` 的长驻媒体 worker）。

```jsonc
// package.json  ⚠️ 勘误：版本号按本机运行时 0.2.0-rc.2 改；兼容性字段名按真实清单形状改
{
  "name": "dsh-media-understanding",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" } },
  "files": ["lib/index.js", "lib/**/*.js", "lib/types/**/*.d.ts", "src/workers/transcribe.py", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "manifestVersion": 1
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": ">=0.2.0-rc.2",
    "@deepseek-ai/dsh-attachment": ">=0.2.0-rc.2",
    "@deepseek-ai/dsh-subprocess": ">=0.2.0-rc.2"
  },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.2" }
}
```

> **兼容性口径（已确认）**：`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 一律用 **`>=0.2.0-rc.2`**。
> ⚠️ **必须带那个点**：写成 `>=0.2.0-rc2` 会被判为**不兼容**——semver 的预发布标识符 `rc2` ≠ `rc.2`，实测 `satisfies('0.2.0-rc.2', '>=0.2.0-rc2') === false`。
> ⚠️ `>=` 无上界：`0.3.0` / `1.0.0` 也会放行。若日后要挡住破坏性大版本，改成 `>=0.2.0-rc.2 <0.3.0`。
> ℹ️ `@deepseek-ai/cordis` **不参与**兼容性判定（`dsh-app-boot/lib/index.js:294` 只筛 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）。

> 为什么必须改：DSH 的兼容性判定**只**比对 peerDependencies 与运行时版本（`dsh-app-boot/lib/index.js:286-301`，`includePrerelease: true`；若写成 `workspace:^`/`workspace:~`/`workspace:*` 则视为"等于当前运行时"，永远通过）。`satisfies('0.2.0-rc.2','^0.1.7-rc.2') === false` ⇒ 装载时被判 `incompatible-version` 拒绝（`dsh-plugin-manager/lib/index.js:1490-1491`）。原字段 `dsh.compatibility.dshReleases` **在 .pnpm 全树 grep 零命中**，属不存在的字段；本机唯一真实第三方插件 `dsh-better-sidebar@0.26.0` 的清单形状为 `{ bundle: { patch }, client?, manifestVersion: 1 }`，可作范本。

```yaml
# cordis.patch.yml — 一行 insert 把本包主入口挂成宿主半插件
- insert:
    - id: media-understanding
      name: dsh-media-understanding
      config:
        whisper: { model: small, device: cpu }      # 8 核/64 GB、无 GPU：small ≈1.7× 实时
        frames: { threshold: 0.3, maxFrames: 16 }   # 见 §7 注（imageLimits.maxImagesPerMessage = 20，留余量）
```

源码布局：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`export const name`、⚠️ **勘误**：`inject` 只写真正必需的（如 `['tools']`），其余用 `ctx.inject(['llm','attachments','subprocess'], …)` 可选注入（照抄 `dsh-tool-fs/lib/index.js:1176-1206`）；`apply(ctx)` 注册两个工具、`Config` schema |
| `src/tools/transcribe.ts` | `transcribe_audio` 工具定义（参数/输出契约/降级） |
| `src/tools/frames.ts` | `video_frames` 工具定义（含 C2 能力门控与附件持久化） |
| `src/media/ffmpeg.ts` | `ctx.subprocess` 封装：`probe()`、`extractAudio()`、`sampleFrames()`（含 C4a 时间戳解析） |
| `src/media/whisper.ts` | Python worker 调用 + JSON 结果解析 + worker 可用性探测 |
| `src/media/attachments.ts` | 帧字节 → `saveImages()`，按 `imageLimits` 做前置校验与缩放决策 |
| `src/media/errors.ts` | 错误分类：缺 ffmpeg / 缺 python / 缺依赖 / **缺 MSVC 运行时（`0xC0000005` 无输出退出）** / **内存不足（`mkl_malloc`）** / 缺音轨 / 无场景变化 |
| `src/workers/transcribe.py` | faster-whisper worker（stdlib + faster_whisper，无第三方胶水） |
| `test/*.test.mjs` | 契约测试（参数校验、render 纯函数性、降级分支、时间戳解析） |

---

## 4. 分阶段实施（每阶段一个可验证闭环）

### Phase 0 · 环境与能力探测 —— ✅ 已完成（结果见 §10）

1. ~~修复沙箱~~ → 已定位根因（C5）并以 `danger-full-access` 解除阻塞。
2. ⚠️ **勘误（2026-10-15 在本机重做 Phase 0）**：原记录 `python 3.14.3`、`node v24.14.0`、ffmpeg "正在装"，与本机不符。本机最终状态：`ffmpeg`/`ffprobe` **6.0**（已装 + 已在用户 PATH 生效）、**`python` 默认 3.14.8**（原默认 3.15 装不了 faster-whisper，已把 3.14 提升为默认；3.15 保留可用）、`faster_whisper 1.2.1` + **`av 18.1.0`（钉 `av<19`）** + `ctranslate2 4.8.3` + `onnxruntime 1.31.0`、`node` **v26.8.2**（`pnpm 12.4.1` 可用）、模型 **tiny/base/small/medium 已预置**。硬件为 **2×Xeon Gold 5118 = 8 核 / 64 GB / 无 GPU**。逐项结果见 §10.2。
3. 运行时服务齐备性：`ctx.tools` / `ctx.llm` / `ctx.attachments` / `ctx.subprocess` 均为已发布 Service Definition；本 profile 的 bundles 为 `dsh-base`、`dsh-web-app`、`dshmarket`、`mattpocock-skills-dsh`、`dsh-better-sidebar`；**Phase 1 的 `media_probe` 会做实际可用性断言**。
4. 默认路由 `inputModalities`：已确认图片可用（C2 实测，`input: [text,image]` 已在 profile 中）。

**产出**：§10 环境探测表。

**决策门（已过）**：ffmpeg 已装成功（本机为**从 PyPI 分发渠道取得的 gyan 6.0 essentials build**，非 winget）→ 抽帧工具保留，无需退化为"仅转录"。

⚠️ **另有一个原计划未预见的决策门（已过）**：本机 `MSVCP140.dll` 过旧导致 `ctranslate2`/`onnxruntime` **硬崩溃**；已装 VC++ 2015-2022 可再发行组件（14.22 → **14.44.35211.0**）修复，三条模型链路均已实测通过。详见 [coding-plan-review.md §4.1](./coding-plan-review.md)。

### Phase 1 · 骨架 + 装载闭环

1. 建包（package.json / tsconfig / cordis.patch.yml / README 骨架）。
2. `src/index.ts` 注册一个最小工具（如 `media_probe`，返回 ffmpeg/whisper 可用性），验证注册链路。**探针必须包含**：`ffmpeg -version`、`ffprobe -print_format json` 可解析、**实测 `python -c "import faster_whisper"`**（本机 `python` 已是 3.14，但探针仍应**验证依赖可导入**而非只认路径——3.15 装了也缺 faster-whisper）、**`import av` 且主版本 `< 19`**、**`ctranslate2`/`onnxruntime` 能真正构造一次对象/跑一次推理**（⚠️ 只 `import` 不足以判可用，见 §10.3 的 MSVCP140 教训）、以及 `ctx.attachments` / `ctx.subprocess` 的实际可调用性。
3. 装进 profile：`~/.dsh/profiles/web/package.json` 加 `"dsh-media-understanding": "link:C:\\workspace\\github\\dsh-media-understanding"`，`bundles` 数组追加包名，profile 目录 `pnpm install`，重启 `dsh web`。
4. 在新会话里调用该工具，确认出现在工具列表且能返回。

**验收**：新会话中模型能列出并成功调用 `media_probe`；`dsh web` 启动日志无插件加载错误。这条打通后，工具契约的其余部分都是同构复制。

### Phase 2 · `transcribe_audio`

1. 工具契约：
   - 参数（`defineTool` 的 spec DSL，注册时会被 `parameterSchemaSpecToJsonSchema` 编译）：`file_path`（string, required）、`language`（string, 可选）、`translate_to_english`（boolean, 可选）、`backend`（enum: `whisper-local`）。
   - 输出：**立即返回作业句柄** `{ jobId, status, backend, model, note, reason? }`（⚠️ B3 决策：走 jobs，契约见 §5.1/§6），转写正文经 `job_output` 读取，`render` 出带时间戳的纯文本。
2. `extractAudio()`：非音频容器先经 ffmpeg 抽轨到 16k 单声道 WAV（`os.tmpdir()` + `mkdtempSync`，`finally` 清理）。
3. `src/workers/transcribe.py`：`WhisperModel(model, device='cpu', compute_type='int8', local_files_only=…)` → `transcribe(audio, language=..., beam_size=5, vad_filter=True)` → 写 JSON 到 `--out`（⚠️ 默认 `cpu` 而非 `auto`；模型已预置，优先离线）。
4. `whisper.ts`：解析 `whisper.pythonPath`，**实测 `import faster_whisper`** 判定可用（不认路径）；作业用 `ctx.jobs.start({ kind: 'transcribe', owner, outputLimitBytes, run })`，`run` 内 `ctx.subprocess` 跑抽轨 + worker，`job.append` 写进度与正文，`exec.signal` 全程透传。
5. 错误分类（C4b，新增两个本机实测错误类）：python 缺失 / faster_whisper 未安装 / **缺 MSVC 运行时（子进程无输出退出、退出码 `0xC0000005`）** / **内存不足（`mkl_malloc`）** / 模型下载失败 / 无音轨（前置探测即返回 `reason: 'no-audio-track'`，**不起作业**）。

**验收**：对一个真实 mp4（含语音）与一个纯音频 wav，作业起得来、`job_output` 能读到非空 `text` 与合理的 `segments` 时间轴；**1 小时长音频下工具调用立即返回、不阻塞**，期间可用 `job_kill` 终止且无孤儿 ffmpeg/python；对一个无音轨视频得到 `no-audio-track` 而非报错。

### Phase 3 · `video_frames`（最高风险，C1+C2+C4a 全在这里）

> ✅ **B4 已先行验证通过**（§10.4）：默认路由确实接受并理解工具结果里的 image 块，本阶段可以放心产出 image 块。工具保持**同步**执行（抽帧秒级，且帧图必须在 `execute` 内落到附件服务才能内联渲染）。

1. 工具契约：
   - 参数：`file_path`（required）、`threshold`（number, 默认 0.3，可配）、`max_frames`（number, 默认 **16**，可配）、`strategy`（enum: `scene` | `fps`，默认 `scene`）、`fps`（number，`strategy=fps` 时生效）。
   - 输出（canonical，永远有值）：`{ frames: [{ index, timestampSec, attachmentId?, width, height, path? }], strategy, timestampSource: 'exact' | 'estimated', mode: 'images' | 'text-only', reason? }`
2. **能力门控（C2）**：⚠️ 勘误：查 **`ctx.llm.resolveModelInfo(provider, model)`**（`provider`/`model` 取自 `exec.agent?.session.requestHeader()?.config ?? exec.agent?.options`）；`inputModalities` 不含 `image` → `mode: 'text-only'`，帧只落临时文件并给路径+时间戳，`reason: 'model-lacks-image-input'`，**绝不**产出 image 块。
3. **附件持久化（C1）**：读 `ctx.attachments.imageLimits`，先按 `maxImageDimension` / `maxImageBytes` 决定是否让 ffmpeg 直接输出合适尺寸（`scale='min(1280,iw)':-2` + `-q:v 3`），再 `saveImages()` 批量持久化，拿 `ImageAttachmentRef[]`。
4. **render（纯函数）**：`frames.flatMap(f => [{type:'text', text:`[${f.timestampSec}s]`}, {type:'image', attachment: f.attachment}])`；`presentResult` 提供同构 `GenericResultView`，保证**会话回放**（UI 重放时不重新执行 execute）也能出图。
5. **时间戳（C4a）**：`metadata=mode=print` → 解析 stderr spill；解析不到则按帧号估算并如实标 `timestampSource: 'estimated'`。
6. 清理：临时帧文件在 `finally` 里删除；spill 文件由 subprocess 层管理。

**验收**：在默认路由（⚠️ 勘误：`dsh/coding-standard-local`，已声明 vision）下，一次调用返回 N 张**真图**且每张带正确时间戳（人工对照视频抽查 2~3 帧），模型能据此回答"第 12 秒屏幕上的字是什么"；用测试注入"未声明 image"的模型信息时，工具返回 `text-only` 且**后续对话不报 `UNSUPPORTED_CONTENT`**；纯色视频返回 `frames: []` 且 `reason: 'no-scene-change'`。

### Phase 4 · 统一横切：错误、超时、取消、可观测

1. 错误语义遵循 DSH 契约：**基础设施故障 throw**（ffmpeg 缺失、文件不存在），**业务非理想结果返回 canonical 值**（无音轨、无场景变化、模型不支持图片）。
2. `defineTool` 的 `timeoutMs` 按工具性质设定并在 README 写明依据：`transcribe_audio` 只做前置校验 + 起作业 ⇒ **短**（几秒）；`video_frames` 同步抽帧 ⇒ 中等（分钟级）。作业本身的时长不受工具超时约束（B3 决策的收益）。
3. `exec.signal` 全链路透传到 `ctx.subprocess.spawn({ signal })`，`finally` 清理临时产物；确认取消后无孤儿 ffmpeg/python——**作业路径同样要验**（取消会话 → `job_kill` 两条路径）。
4. `isConcurrencySafe`：只读 + 独立临时目录（且作业各自持 `jobId`）→ 可声明 `true`（需确认临时目录命名不冲突）。
5. `presentCall`：起作业时给一张如实的"已提交后台"卡片；`video_frames` 给"抽帧中"卡片。

**验收**：逐条执行 §8 错误矩阵，每格行为符合预期；任务管理器/`tasklist` 确认取消后无残留子进程。

### Phase 5 · 测试与文档

1. `node --test`（⚠️ 勘误：原写"对齐 `dsh-knowledge` 的测试风格"，该包在本机未安装；可对齐 `.pnpm` 内官方包的 `lib/**/*.test.mjs` 风格）：
   - 参数校验：非法 `threshold`/`max_frames`/`strategy` 被拒；
   - `render` 纯函数性：同输入两次调用结果一致、不触碰 fs；
   - 时间戳解析：给定 ffmpeg stderr 样本，断言解析出的 `pts_time` 序列；
   - 降级分支：mock **`resolveModelInfo`**（⚠️ 勘误：不是 `resolveModel`）返回无 `image` → 断言 `mode: 'text-only'` 且输出中**零** image 块（这是回归 C2 的关键测试）；
   - 附件门控：mock 超限图片 → 断言被缩放到 limits 内。
2. README：安装前提（ffmpeg、python **3.14** + faster-whisper 1.2.1 + **`av<19`** + VC++ 2015-2022 运行时）、**vision 路由要求**（C2，含本机已配置的 `dsh / coding-standard-local` 与回滚方法；⚠️ 勘误：原文的备用路由 `litellm/Qwen3-VL-4B` 在本机**不存在**）、配置项表、两个工具的参数与降级语义、限制说明（不解析内嵌字幕、不支持远程 URL、单次帧数上限）。
3. `docs/coding-plan.md`（本文）保留为设计记录。

**验收**：`pnpm test` 全绿；README 能让一个没参与开发的人照做装好并跑通。

### Phase 6+ · 后续可选（不在本次范围）

- `understand_video`：合并转录+抽帧为按时间线对齐的单一工具（社区 `dsh-video-lens` 思路）。
- 字幕优先：`ffprobe` 检查内嵌字幕轨 → 优先提取（快且准），Whisper 兜底。
- OpenAI 兼容云端点作为第二后端（需 API Key，与本方案"无需 Key"的定位冲突，故默认不做）。

---

## 5. 工具契约细则（实现时的硬约束）

- **参数用 `defineTool` 的 spec DSL**：`{ file_path: { type: 'string', required: true, description } }`。注册时 `defineTool` 会调 `parameterSchemaSpecToJsonSchema()` 编译成 JSON Schema 并写入 `definition.parameters`；`execute` 前框架用编译结果校验参数并抛 `ToolArgsError`。
  > 注意别混用两种写法：`@deepseek-ai/dsh-tools` 内部函数签名用 spec DSL，而 `ToolSchema.parameters` 是 `Record<string, unknown>`（编译后的 JSON Schema）。手写 `{ type:'object', properties:{...} }` 也能跑（⚠️ 勘误：原文举的 `dsh-knowledge` 在本机**未安装**，无法核实；但 `register` 只断言 `output.schema`，`dsh-tools/lib/index.js:2878-2887`，所以手写 `parameters` 确实能跑），但会绕过 spec DSL 的必需性标注，二者不要混。
- **`output.render` 必须纯**：只做 `(args, value) → ContentBlock[]` 投影，不读文件、不编码、不 spawn。所有 IO 在 `execute` 里完成，并已体现在 canonical value 中。
- ⚠️ **勘误：注意字段层级**。`output` **只有** `{ schema, render, presentationMeta? }` 三个字段；下面这些都是**顶层**字段：`execute`、`presentCall`、`presentResult`、`isConcurrencySafe`、`timeoutMs`、`projectContent`、`finalizeContent`（`dsh-tools/lib/types/schema.d.ts:178-240`、`lib/types/index.d.ts:106-191`）。
- ⚠️ **`presentResult` 要能出图，必须同时实现 `output.presentationMeta`**：`presentResult(args, result: ToolResult)` 读的是 `result.meta`，而 `meta` 由 `output.presentationMeta(args, value)` 持久化。只写 `presentResult` 在会话回放时拿不到 attachment。
- **`execute` 只返回一个根值**，形状严格匹配 `output.schema`（框架会用 `valueSchemaSpecToJsonSchema` 校验）；写错会被 `ToolOutputError` 拒。
- `output.schema` 里的 `object` 节点必须显式声明 `additionalProperties`（DSH 的 `ObjectValueSchemaSpec` 强制要求，不允许依赖 JSON Schema 默认值）。
  > ⚠️ **例外**：`parameters` 的**根节点**是隐式开放对象（`dsh-tools/lib/types/schema.d.ts:161`），**不要**在那里加 `additionalProperties`。

### 5.1 `transcribe_audio` 的执行模型：`jobs` 后台作业（B3 决策）

**为什么**：`small` ≈ 1.7× 实时，1 小时录音要 ~35 分钟。工具超时是**协作式**的（`timeout-policy` 只读工具声明的 `timeoutMs`，未声明就不设表；无硬上限），但同步等待会白占一次工具调用，且 DSH 已有现成的后台作业设施。

**分工**：`transcribe_audio` 走后台作业；`video_frames` **保持同步**（抽帧只需秒级，且帧图必须在 `execute` 里落到附件服务，异步拿不到内联渲染）。

契约（均已核实）：

| 项 | 事实 | 出处 |
|---|---|---|
| 服务键 | `interface Context { jobs: JobRegistry }` → `ctx.jobs` | `dsh-jobs/lib/types/index.d.ts:16-18` |
| 起作业 | `ctx.jobs.start(spec: JobSpec): JobId`；`spec.run(job)` **同步**返回 `JobHooks`（含 `done: Promise<JobOutcome>`） | `dsh-jobs/lib/types/types.d.ts:117-149`、`index.d.ts:71` |
| 进度/输出 | `JobHandle.append(text, options?)`、`updateProgress(line)` | `types.d.ts:79-94` |
| 读结果 | 模型侧用**已挂载**的 `job_output` / `job_list` / `job_kill` 工具（`@deepseek-ai/dsh-tool-jobs`） | `dsh-tool-jobs/lib/index.js:298,348,368` |
| 归属 | `spec.owner = exec.agent?.session.id` ⇒ 作业随会话回收 | `types.d.ts:122-128` |
| 自定 kind | `JobKindMap` 是**可合并扩展**的（现有 `bash`/`subagent`）⇒ 声明合并加 `transcribe: 'transcribe'` | `dsh-jobs/lib/types/view.d.ts:26-31` |
| 模型面预算 | `spec.outputLimitBytes` 同时约束**完成通知**与**输出读取** | `types.d.ts:129-134` |

**流程**：

1. `execute` 做前置校验（文件存在、ffmpeg/python/faster-whisper 可用），失败照旧 `throw`；
2. `ctx.jobs.start({ kind: 'transcribe', label, owner, outputLimitBytes, run(job) { … } })`，`run` 内用 `ctx.subprocess` 跑「抽音轨 → python worker」，把分段文本经 `job.append` 写入 ring，`finally` 里删临时 WAV；
3. `execute` **立即**返回 canonical 值（含 `jobId`），不阻塞；
4. 模型用 `job_output` 读转写结果；若要中断用 `job_kill`。

**必须注意**：`exec.signal` 仍要透传到 `ctx.subprocess`（用户在作业运行中取消会话/中断时能真正杀掉 ffmpeg+python）；worker 的 JSON 落文件读取，不要把大 JSON 塞进 ring 之外的通道；ring 有上限，超长转录要如实标 `truncated`。

---

## 6. 输出契约草案

```ts
// transcribe_audio —— 立即返回作业句柄，转写结果经 job_output 读取
{
  jobId: string                    // 如 'transcribe-1'
  status: 'running'                // 起作业后必然是 running
  backend: 'whisper-local'
  model: string                    // 实际使用的 whisper 规格
  note: string                     // 提示模型用 job_output 取结果
  reason?: 'no-audio-track'        // 前置探测已判定无音轨时，直接给结论、不起作业
}

// job_output 读到（并作为转写正文的正式形状）
{
  text: string
  language: string
  durationSec: number
  segments: Array<{ start: number; end: number; text: string }>
  backend: 'whisper-local'
  truncated: boolean
  reason?: 'no-audio-track'
}

// video_frames
{
  frames: Array<{
    index: number
    timestampSec: number
    attachmentId?: string      // 仅在 mode:'images' 时给出
    width: number
    height: number
    path?: string              // 仅在 mode:'text-only' 时给出（临时帧文件）
  }>
  strategy: 'scene' | 'fps'
  timestampSource: 'exact' | 'estimated'
  mode: 'images' | 'text-only'
  reason?: 'model-lacks-image-input' | 'no-scene-change' | 'no-video-stream'
}
```

---

## 7. 配置项（schemastery `Config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `whisper.pythonPath` | **`C:\Users\Administrator\AppData\Local\Programs\Python\Python314\python.exe`** | 本机 `python` **已是 3.14.8**（PATH + `py` 启动器默认），故自动探测通常可命中；仍建议显式配置，且探针要**实测 `import faster_whisper`**（3.15 缺依赖，装不上 faster-whisper） |
| `whisper.model` | **`small`** | `tiny`/`base`/`small`/`medium`/`large-v3`。本机 8 核实测：`tiny` 8.0× / `base` 4.6× / **`small` 1.7×** / `medium` **0.6×（慢于实时，不推荐）**；`tiny`/`base`/`small`/`medium` 均已预置并**离线可用** |
| `whisper.device` | **`cpu`** | `auto`/`cpu`/`cuda`。本机**无 GPU**（`cuda_device_count == 0`，`nvidia-smi` 无法通信）→ `auto` 等价 `cpu`，写 `cpu` 更明确；`cuda` 必然报错 |
| `whisper.computeType` | `int8` | 本机 `get_supported_compute_types('cpu')` = `int8` / `int8_float32` / `int16` / `float32` |
| `whisper.modelCacheDir` | 系统缓存 | 本机实际：`C:\Users\Administrator\.cache\huggingface\hub`，**已预置 tiny/base/small/medium（2.08 GB）** |
| `whisper.localFilesOnly` | 建议 `false`（模型已预置，可留联网兜底） | 本机实测 `local_files_only=True` 全通，离线环境可置 `true` |
| `whisper.timeoutMs` | 覆盖下载+长音频 | ⚠️ `SubprocessSpawnSpec` **没有** `timeoutMs`，要自己用 `signal` 实现（这里的 `timeoutMs` 是本插件内部的子进程预算，不是工具超时） |
| `transcribe.jobOutputLimitBytes` | `262144`（256 KiB） | 作业的**模型面**字节上限，同时约束输出读取与完成通知（`JobSpec.outputLimitBytes`，`dsh-jobs/lib/types/types.d.ts:129-134`） |
| `transcribe.maxSegments` | `5000` | 分段上限；超出即截断并置 `truncated: true`（job ring 有上限，超长转录必须如实标注） |
| `frames.threshold` | `0.3` | 场景变化灵敏度 |
| `frames.maxFrames` | **`16`** | 单次抽帧上限。⚠️ 实测 `imageLimits.maxImagesPerMessage` 默认正好是 **20**，卡边界没有余量，故默认留出余量 |
| `frames.jpegQuality` | `3` | ffmpeg `-q:v`，数值越小越清晰越大 |
| `frames.maxWidth` | `1280` | 与 `attachments.imageLimits` 取小值（本机 `maxImageDimension = 8192`、`maxImageBytes = 20 MiB`） |
| `ffmpeg.path` / `ffprobe.path` | 自动解析 | 本机已装 `%LOCALAPPDATA%\Programs\ffmpeg\bin`（6.0）并已在用户 PATH 中**验证生效**；仍支持覆盖 |
| `workDir` | ⚠️ **`os.tmpdir()` + `mkdtempSync`**（不存在"受管临时目录"服务） | 中间产物落点，`finally` 清理（spill 文件也由自己清） |

---

## 8. 风险登记

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | Windows ACL 沙箱在非提权 `dsh web` 下无法初始化（C5） | `workspace-write` / `read-only` 模式下**所有**命令失败 | 已切 `danger-full-access` 解除；如需受限执行须以管理员启动 `dsh web`（`icacls` 修不了 SACL 特权缺失） |
| R2 | 路由未声明图片输入（C2） | 含图结果 → 整轮模型调用失败 | **已为默认模型声明 `input: [text,image]` 且实测生效**；Phase 3 门控保留为防御；README 说明 |
| R2b | 过度声明图片能力（C2） | provider 在回合中途拒绝，消息已落盘、会话反复重试 | ✅ **本机已实测排除**（§10.4，随机码真图验证通过）。门控仍作为换路由时的防御保留；若日后真出现该错误，删掉那 4 行 `input:` 回滚 |
| **R2c** | 作业（jobs）路径引入的新失败面：会话中断时作业是否真的停、ring 溢出丢字、临时 WAV 泄漏 | 长音频下最可能出现"看着跑完了其实被截断" | `exec.signal` 透传到 `ctx.subprocess`；`transcribe.maxSegments` + `truncated` 如实标注；`run` 的 `finally` 删临时文件；`owner = session.id` 让作业随会话回收 |
| R3 | Whisper 模型首次下载体积大（已装 `faster-whisper 1.2.1`） | 首调用像卡死 | ✅ 已基本消除：本机**已预置 tiny/base/small/medium（2.08 GB）**，实测 `local_files_only=True` **离线可加载**，首调用无需下载；仍保留下载进度提示与 `modelCacheDir` 预置能力 |
| R3b | **`av>=19` 与 faster-whisper 1.2.1 不兼容**（已实测） | 模型能加载但**推理必崩**（`TypeError: metadata_errors`），且错误信息与真实原因相距很远 | 钉 **`av<19`**（本机落 `18.1.0`）；`media_probe` 校验 `av` **主版本 < 19**；README 写明 |
| R3c | **`-vsync` 不可信**（ffmpeg 9 已移除，6.0 已废弃） | 抽帧命令报 `Unrecognized option 'vsync'` | 统一用 `-fps_mode vfr`（ffmpeg **5.1+** 通用）；本机实装 **6.0** |
| R3d | **`MSVCP140.dll` 过旧（14.22）**导致 `ctranslate2`/`onnxruntime` **`0xC0000005` 硬崩溃**，**无 traceback、无输出** | 表现为"python 子进程莫名消失"，极难定位；`import` 也可能崩 | ✅ 本机**已修复**（VC++ 2015-2022 → `14.44.35211.0`）；README 列为安装前提；`media_probe` 校验运行时版本，并把"无输出退出 + 退出码 `0xC0000005`/`-1073741819`"识别为独立错误类 |
| R3e | 内存不足 → `mkl_malloc: failed to allocate memory` | 模型加载/推理失败 | ⚠️ 本机已由 **4 GB 扩容到 64 GB**，该风险**基本消除**；但仍建议把 `mkl_malloc` 作为独立错误类如实回报（换机器时仍会遇到） |
| R4 | 抽帧无场景变化（纯色/动画） | `frames: []` | 返回 canonical + `reason`，并在工具描述里引导模型改用 `strategy:'fps'` |
| R5 | 图片超 `imageLimits` | `saveImages` 抛错 | `execute` 内先按 limits 缩放/降质，再持久化 |
| R6 | 任意 `file_path` 输入 | 工具读取工作区外文件（越出 better-sidebar 的 workspace fence 语义） | 明确记录为设计边界；可选加 `allowedRoots` 配置，默认不限制但文档警示 |
| R7 | Windows 路径/编码/中文文件名 | ffmpeg 与 python 参数处理出错 | 全程 `argv` 数组传参（不经 shell）；临时目录名用 ASCII；测试覆盖中文文件名 |
| R8 | 插件在 profile 里以 `link:` 安装 | 改动需重装/重启才生效 | 明确开发循环：改宿主半代码 → 重启 `dsh web`；Phase 1 记录验证命令 |
| R9 | 单次 20 帧真图的上下文成本 | token 暴涨 | 默认 `maxFrames: 20` + `maxWidth: 1280`；在工具描述中提示模型按需调小 |

---

## 9. 完成定义（DoD）

1. Phase 1~5 验收项全部通过，`pnpm test` 全绿。
2. 在真实会话中完成一次端到端演示：上传/指定一个会议录屏 → `transcribe_audio` 出带时间戳转录 + `video_frames` 出带时间戳真图 → 模型给出融合后的"讲了什么 + 画面发生了什么"。
3. 在**默认路由**下重复一次：现已声明 vision，应正常出图；并额外用 mock/门控测试覆盖"路由未声明 image 时降级为 `text-only` 且对话不报错"。
4. README 具备可复现的安装与使用说明；`docs/` 留有设计记录与风险登记。

---

## 10. Phase 0 环境探测结果

> ⚠️ **§10.1 探测于另一台机器，§10.2 才是当前机器的实测结果。§10.1 在本机已逐条重做，结论仍然成立（见 §10.3）。**

### 10.1 原机器探测结果（2026-XX，**非本机**）

| 项 | 结果 | 备注 |
|---|---|---|
| `dsh` 运行时 | `0.1.7-rc.2`（`dsh web --no-open`，PID 39416） | 用户身份 `reamerai\reame`，**非提权** |
| 文件策略 | `danger-full-access`（本轮已切换） | ACL 沙箱不再参与，命令可用 |
| `node` | **v24.14.0** | 满足 dsh 包 `engines: ^22.19.0 \|\| >=24.0.0` |
| `pwsh` | Windows PowerShell **5.1.26100.9444** | `-Command` 可用 |
| `ffmpeg` / `ffprobe` | ✅ **9.0.2-full_build**（winget `Gyan.FFmpeg`）@ `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\` | 安装后 PATH 需新 shell 才生效 → 插件应走 `resolveExecutable` 并支持 `ffmpeg.path` 覆盖 |
| `python` | **3.14.3** @ `C:\Program Files\Python314\python.exe` | 注意 `python3` 是 WindowsApps 占位器，**不要用**；worker 调用应固定 `python` 或配置 `whisper.pythonPath` |
| `pip` | 26.2.1（user site: `%APPDATA%\Python\Python314\site-packages`） | 非 venv，属用户级 site-packages；HF 缓存不支持 symlink（会退化存储，功能正常） |
| `faster-whisper` | ✅ **1.2.1** + `ctranslate2 4.8.3` | 见下条 `av` 钉版本 |
| **`av`（PyAV）** | ⚠️ 记作"必须 **16.1.0**（钉 `av<17`）" | ⚠️ **版本号记错**：移除 `metadata_errors` 的是 **PyAV 19.0.0**，正确钉法是 `av<19`（本机实测 `18.1.0` 通过、`19.0.1` 报错） |
| 已预装的相关依赖 | `huggingface-hub`、`httpx`、`filelock`、`fsspec`、`hf-xet`、`tqdm`、`numpy 2.5.4` | 加速安装 |
| Whisper 模型缓存 | `C:\Users\reame\.cache\huggingface\hub` | `tiny` 已拉取；插件应支持 `modelCacheDir` 指向此处或自定 |
| 默认模型 | `loki / coding-standard-local`，现声明 `input: [text,image]` | **实测可读图**（会话中投喂 PNG 成功解析）；⚠️ provider 名在本机是 `dsh` |
| 工作区 | 空，`Owner = REAMERAI\reame`，ACL 含继承的 Full/Modify | 空仓库从零搭建 |
| 其它可用 vision 路由 | `litellm / Qwen3-VL-4B` | ⚠️ 本机**不存在**此路由 |

### 10.2 ★ 本机实测环境（**权威**：2026-10-15 复审 + 预安装 + 硬件扩容后复验）

> 后续实现**全部在本机进行**，一切以本表为准。

| 项 | 结果 | 备注 |
|---|---|---|
| 工作区 | `C:\workspace\github\dsh-media-understanding` | 非空（含 `docs/`） |
| 用户 / 权限 | `Administrator`；`danger-full-access` 下 `IsAdmin=True` | `workspace-write` 沙箱内为 `False` |
| DSH 运行时 | **`0.2.0-rc.2`** | ⇒ peerDependencies 必须 `^0.2.0-rc.2` |
| OS | Windows Server 2022 Datacenter 20348（KVM 虚拟机） | — |
| **CPU** | **2 × Intel Xeon Gold 5118 @ 2.30 GHz = 8 核 / 8 逻辑处理器**（`os.cpu_count() == 8`） | 无超线程暴露 |
| **内存** | **64 GB**（65535 MB，空闲约 61 GB） | 原 4 GB 的内存约束**已消失** |
| 磁盘 | C: 剩余 **约 71 GB** | 足以容纳 `medium`/`large-v3` 模型 |
| **GPU** | **无**（`nvidia-smi` 无法与驱动通信；`ctranslate2.get_cuda_device_count() == 0`） | **只能 CPU 推理**，CUDA 路径无意义 |
| node / pwsh / git | **v26.8.2**（nvm）/ 5.1.20348.2849 / 2.47.0，`npm 11.19.1` / `pnpm 12.4.1` 可用 | 无 winget / choco / scoop / uv |
| **`ffmpeg` / `ffprobe`** | ✅ **6.0**（gyan essentials build）@ `%LOCALAPPDATA%\Programs\ffmpeg\bin`，已在**用户 PATH** 中 | 重启 `dsh web` 后**已生效**（`Get-Command ffmpeg` 命中） |
| **`python`（默认）** | ✅ **3.14.8** @ `%LOCALAPPDATA%\Programs\Python\Python314\python.exe` | **已提升为默认**：用户 PATH 里 3.14 置于 3.15 之前；`py` 启动器默认亦为 3.14（`PY_PYTHON=3.14`）。3.15 保留可用（`py -3.15`） |
| ⚠️ 生效范围提醒 | PATH 变更对**新启动的进程**（新终端、重启后的 `dsh web`）生效 | Python 3.14 的 PATH 提升发生在最近一次 `dsh web` 重启**之后** → **需再重启一次 `dsh web`**，其派生的子进程里 `python` 才落到 3.14；在那之前请用绝对路径或 `whisper.pythonPath` |
| `python`（旧默认 3.15） | 仍在 `%LOCALAPPDATA%\Programs\Python\Python315` | ⚠️ **装不了 faster-whisper**（`ctranslate2`/`onnxruntime` 无 cp315 wheel），插件不要用它 |
| **`faster-whisper`** | ✅ 1.2.1 + `ctranslate2 4.8.3` + `onnxruntime 1.31.0` | 装在 3.14 的 site-packages，已随默认 `python` 可用 |
| **`av`（PyAV）** | ✅ **18.1.0**（钉 **`av<19`**） | 19.0.1 实测报 `TypeError: metadata_errors` |
| **MSVC 运行时** | ✅ `msvcp140.dll` **14.44.35211.0**（原 14.22.27821.0） | 升级前 `ctranslate2`/`onnxruntime` 必崩 `0xC0000005` |
| Whisper 模型缓存 | `C:\Users\Administrator\.cache\huggingface\hub` | **已预置 `tiny`/`base`/`small`/`medium`**（blobs 共 2.08 GB），`tiny`/`base`/`small` 实测**离线**可用 |
| 默认模型 | provider **`dsh`** / model `coding-standard-local`，已声明 `input: [text,image]` | vision 可用 |
| 工作区外可用 vision 路由 | ⚠️ 无。同 provider 另有 `Qwen/Qwen3.6-35B-A3B`、`Qwen/Qwen3-VL-Embedding-2B`（**均未声明 `input`**） | 原文的 `litellm/Qwen3-VL-4B` 不存在 |
| 参考插件 | `dsh-better-sidebar@0.26.0`（唯一第三方）；`.pnpm` 内有官方 `dsh-tool-fs` 等可作范本 | `dsh-context`、`dsh-knowledge` **未安装** |

### 10.3 冒烟测试（**本机实测，全部通过**）

在 `%USERPROFILE%\.dsh\media-selftest\` 用合成 + 真实媒体验证（硬件扩容后已复跑）：

| 验证项 | 结果 |
|---|---|
| `ffprobe` 区分有无音轨 | ✅ 带音轨 → `0:video/h264` / `1:audio/aac`；无音轨 → 只有 `0:video`（降级判据可靠） |
| `ffmpeg` 抽音轨 → 16k 单声道 WAV | ✅ 8 秒视频产出 256,426 字节 WAV |
| `select` + `metadata=mode=print` + `-fps_mode vfr` 取时间戳 | ✅ 解析出 `pts_time:4` / `:6`，与 `f_0001.jpg`/`f_0002.jpg` **1:1 顺序对应**；首帧不产出（与原文一致） |
| 纯色视频 → 无场景变化 | ✅ **0 文件、exit=0**（非报错） |
| `strategy=fps` + `scale='min(1280,iw)':-2` | ✅ 正常出帧，尺寸不受损 |
| 中文 + 空格文件名 | ✅ argv 传参正常 |
| VAD（onnxruntime + Silero） | ✅ `vad_filter=True` 全链路通过 |
| 离线可用性 | ✅ `local_files_only=True` 全通 |
| `device` 行为 | ✅ `cpu` / `auto` 通过（无 GPU，自动落 CPU）；`cuda` 干净报错 |
| 原生库可用性 | ✅ 修复 MSVCP140 后 `ctranslate2` / `onnxruntime` 均可正常构造与推理（**修复前**：`0xC0000005` 硬崩溃） |

**8 核机器上的模型基准**（真实语音 13.0s，`device=cpu, compute_type=int8, beam_size=5, vad_filter=True`）：

| 模型 | 加载 | 转写 13s 音频 | 相对实时 | 结论 |
|---|---|---|---|---|
| `tiny` | 1.3s | 1.6s | **8.0×** | 最快，精度最低 |
| `base` | 0.9s | 2.8s | **4.6×** | 快速档 |
| **`small`** | 2.0s | 7.9s | **1.7×** | ✅ **推荐默认**（精度/速度平衡） |
| `medium` | 37.5s（含下载） | 21.7s | **0.6×** | ⚠️ **慢于实时**，1 小时录音需 ~1.7 小时，仅按需使用 |
| `large-v3` | — | — | — | 未拉取；CPU 上预计更慢，不建议 |

**待办**：`large-v3` 未拉取（CPU-only，预计慢于实时；如需按需 `transcribe` 首次下载）；GPU 推理不可行（无驱动/设备）。

### 10.4 vision 真图验证（B4，已通过）

**要验的是什么**：默认路由 `dsh/coding-standard-local` 声明了 `input: [text, image]`，但这是"过度声明"（见 C2/R2b）——本机从未真正投喂过图片。若上游实际不接受，`video_frames` 一返回 image 块就会让**整轮对话**失败且消息已落盘。

**方法**（带反向控制，避免"看到想看到的"）：

1. 用 ffmpeg 生成 880×420 PNG：深色底 + 上方红条 + 下方蓝条 + 中间一串 **6 位随机码**。随机码写入 `vision-answer.txt` 后**全程不打印** ⇒ 它**从未进入模型上下文**，只能靠"看见"才能读出。
2. 用 `read_image` 读该 PNG。这条通路与 `video_frames` **完全一致**：工具结果里放 `ImageBlock`（附件服务持久化 + pi-ai 对 role `'tool'` 的 image 豁免，`dsh-llm-pi-ai/lib/index.js:1185`）。
3. 模型先复述所见，再打开答案文件核对。

**结果**：模型读出 **`FFEJD9`**，与答案文件一字不差；并正确描述"上方红条、下方蓝条"。

**结论**：默认路由**确实接受并理解工具结果中的 image 块**，全程无 `UNSUPPORTED_CONTENT`。R2b 的过度声明在本机有真实能力兜底；C2 的能力门控仍作为**换路由时的防御**保留，不回滚那 4 行 `input:`。

**素材**：`%USERPROFILE%\.dsh\media-selftest\vision-test.png`（另有 `vision-answer.txt`、`font.ttf`）。

---

## 11. 实现就绪度检查表（2026-10-15）

### 11.1 ✅ 已就绪（不需要再做任何准备）

| 项 | 状态 | 证据 |
|---|---|---|
| 运行时依赖 | ✅ | ffmpeg/ffprobe 6.0（已在 PATH 生效）、python **3.14.8**（默认）、faster-whisper 1.2.1、av 18.1.0、ctranslate2 4.8.3、onnxruntime 1.31.0、MSVCP140 14.44 |
| Whisper 模型 | ✅ | tiny/base/small/medium 已预置，`local_files_only=True` **离线可用** |
| 构建工具链 | ✅ | node v26.8.2、npm 11.19.1、pnpm 12.4.1；`@deepseek-ai/dsh-tools@0.2.0-rc.2` 等**可从 npm 取到**（3.1s，实测），可作 devDependencies 供 `tsc` 类型检查 |
| profile 服务齐备性 | ✅ | `dsh --profile web --dump-config` 实测已挂载：`@deepseek-ai/dsh-tools`（id `tools`）、`dsh-llm`、`dsh-attachment-local`（id `attachment-local`）、`dsh-subprocess-local`（id `subprocess`）、`dsh-jobs-local`（id `jobs`）、`dsh-tool-call-timeout-policy`（id `timeout-policy`） |
| 工具注册 API | ✅ | `interface Context { tools: ToolRuntime }`（`dsh-tools/lib/types/index.d.ts:33-34`）；`ctx.tools.register(definition): () => void`（同文件 `:636`，返回注销器）；`defineTool(options)` 由 `@deepseek-ai/dsh-tools` 导出（`lib/index.js:838`） |
| 插件 import 解析机制（**关键未知已澄清**） | ✅ | 宿主对**声明为 peerDependencies** 的 DSH 包做**模块解析拦截**：`dsh-app-boot/lib/index.js:1470-1500` 的 `routeLinked()` 读取请求方的 peer 名（`readPeerNames(directory)`），命中即路由到宿主自己的那份实现 ⇒ **插件必须把 `@deepseek-ai/dsh-*` 写进 peerDependencies，运行时由宿主提供**（这也解释了为何 profile 的 `node_modules` 里没有这些包，而 `dsh-better-sidebar` 仍能工作） |
| 长任务执行模型 | ✅ 已定 | **走 `jobs` 后台作业**（B3 决策 + 契约见 §5.1）：`ctx.jobs`（`dsh-jobs/lib/types/index.d.ts:16-18`）+ 已挂载的 `job_output`/`job_list`/`job_kill`（`dsh-tool-jobs`）。工具超时本身无硬上限且是协作式的（`timeout-policy` 只读工具声明的 `timeoutMs`，未声明就不设表），但长转录不再依赖它 |
| vision 通路 | ✅ 已实测 | 工具结果里的 image 块被默认路由正确理解（§10.4，随机码真图 `FFEJD9` 读出并核对通过） |
| 兼容性口径 | ✅ | `>=0.2.0-rc.2`（见 §3 注：必须带点；`cordis` 不参与判定） |
| 测试素材 | ✅ | `%USERPROFILE%\.dsh\media-selftest\`（真实语音 13s + 合成色块视频 + 16k WAV） |
| 本机范本 | ✅ | `dsh-better-sidebar@0.26.0` 的 `package.json` 可直接照抄清单形状；`.pnpm` 内有 `dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-experimental-speech-to-text-sensevoice` 作实现范本 |

### 11.2 🔨 还差什么（**要写的代码，目前一行都没有**）

工作区当前只有 `docs/`。需要新建：

| 文件 | 内容 | 依赖的已核实契约 |
|---|---|---|
| `package.json` | name/version/exports/`files`、`dsh: { bundle: { patch }, manifestVersion: 1 }`、peers `>=0.2.0-rc.2`、`@deepseek-ai/schemastery` 放 dependencies | §3 |
| `tsconfig.json`（+ `tsconfig.build.json`） | 编译到 `lib/`，`tsc` 严格模式 | 参照 `dsh-better-sidebar` 的 `build` 脚本 |
| `devDependencies` | `typescript`、`@types/node`、各 `@deepseek-ai/dsh-*@0.2.0-rc.2`（精确钉版本，仅本地类型检查） | npm 实测可取 |
| `cordis.patch.yml` | 一行 `insert:` 挂载本插件 + 默认 config | §3 |
| `src/index.ts` | `name` / `Config`（schemastery）/ `apply(ctx)` / `inject` | §7 |
| `src/tools/transcribe.ts` | `transcribe_audio` 定义 | `defineTool` |
| `src/tools/frames.ts` | `video_frames` 定义（能力门控 + 附件持久化） | `resolveModelInfo`、`saveImages` |
| `src/tools/probe.ts` | `media_probe`（Phase 1 装载闭环的验证工具） | — |
| `src/media/ffmpeg.ts` | `probe()` / `extractAudio()` / `sampleFrames()`（含时间戳解析） | `ctx.subprocess` |
| `src/media/whisper.ts` | worker 调用 + JSON 解析 + 可用性探测 | `ctx.subprocess` |
| `src/media/attachments.ts` | 帧字节 → `saveImages()`，`imageLimits` 前置校验 | `imageLimits` |
| `src/media/errors.ts` | 错误分类（含 `0xC0000005` 运行时缺失、`mkl_malloc` 内存不足） | — |
| `src/workers/transcribe.py` | faster-whisper worker | 本机已验证可行 |
| `test/*.test.mjs` | 参数校验 / render 纯函数 / 时间戳解析 / 门控降级 | `node --test` |
| `README.md` | 安装前提、配置表、两个工具契约与降级语义、vision 路由要求与回滚 | — |

### 11.3 ⛔ 阻断点与待决项

| # | 事项 | 性质 | 处置 |
|---|---|---|---|
| **B1** | ~~需再重启一次 `dsh web`~~ | 环境 | ✅ **已解决**：重启后 DSH 子进程里 `python` 已解析到 3.14.8。探针仍要实测 `import faster_whisper`，不认路径 |
| **B2** | **本机没有现成的"宿主侧第三方插件"范本** | 工程 | 已澄清机制（peer 声明 + 宿主拦截，§11.1），可照 `dsh-better-sidebar` 的 `package.json` 形状起步；Phase 1 的 `media_probe` 就是用来一次性验证装载链路的，**建议先只做这一件事再写业务代码** |
| **B3** | ~~长音频 × 工具超时~~ | 设计 | ✅ **已决：走 `jobs` 后台任务**。`ctx.jobs.start(spec)` 起一个 `kind: 'transcribe'` 的后台作业，工具**立即**返回 `jobId`；模型用已挂载的 `job_output`/`job_list`/`job_kill` 读结果。契约见 §5.1，配置见 §7 |
| **B4** | ~~vision 路由是"过度声明"，本机未实测~~ | 风险（R2b） | ✅ **已实测通过**（2026-10-16）：用 `read_image` 把一张含**随机码**的 PNG 作为**工具结果**投给默认路由 `dsh/coding-standard-local`，模型读出了 `FFEJD9`，与事先写入、从未进入模型上下文的答案完全一致 ⇒ 上游**确实接受并理解**工具结果里的 image 块，那条 `input: [text, image]` 声明有真实能力兜底。详见 §10.4 |
| **B5** | `maxImagesPerMessage = 20` | 约束 | `maxFrames` 默认取 16 留余量；工具描述里提示模型按需调小 |
| **B6** | ~~工作区不是 git 仓库~~ | 工程 | ✅ **已解决**：已 `git init`、身份设为维护者、并推送到 `reamerit/dsh-media-understanding`；提交前的署名扫描写入 `AGENTS.md` |
| **B7** | 会话回放出图 | 实现细节 | 必须同时实现 `output.presentationMeta` + `presentResult`，只写 `presentResult` 在回放时拿不到 attachment |
| **B8** | 无 GPU / `large-v3` 不可用 | 限制 | 已在文档写明；`device` 固定 `cpu` |

### 11.4 建议的开工顺序

1. ~~`git init` + 首次提交~~ ✅ 已完成
2. 骨架（package.json / tsconfig / cordis.patch.yml）+ **只注册 `media_probe`** → 装进 profile → 重启 `dsh web` → 新会话确认工具可见可调用
3. `transcribe_audio`：`jobs` 后台作业（§5.1）+ worker + 错误分类
4. `video_frames`：抽帧 + 附件持久化（B4 已先行验证通过，可直接照 `read_image` 的既有通路实现）
5. 横切：`jobs` 的取消与进度、`presentationMeta`/`presentResult`（B7）
6. 测试 + README
