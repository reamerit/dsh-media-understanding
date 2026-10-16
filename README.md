<p align="center">
  <strong style="font-size: 2.2em">🎬 DSH 音视频理解插件</strong><br>
  <span style="font-size: 1.1em">DeepSeek Harness 宿主侧插件 · 本地音视频 → 转录文本 + 带时间戳关键帧真图 · 全程离线、无需 API Key</span>
</p>

<p align="center">
  <a href="./README.en.md">🌐 English</a> · <strong>中文</strong>
</p>

> **状态：设计中（尚未发布）**。本仓库目前只有设计文档，`src/` 与 `package.json` 尚未落地，因此下方「安装」「配置」两节记录的是**已经实测确认的目标契约**，不是当前可用功能。实现进度与阶段验收见 [`docs/coding-plan.md`](docs/coding-plan.md) §4。

---

## ✨ 是什么

一个把本地音视频交给模型的 DSH 插件，注册两个工具：

| 工具 | 方向 | 形态 |
| --- | --- | --- |
| `transcribe_audio` | 音频/视频 → 带时间戳的转录文本 | **后台作业**：立即返回 `jobId`，正文用 `job_output` 读 |
| `video_frames` | 视频 → 带时间戳的关键帧**真图** | **同步**：帧图在 `execute` 内落附件服务，随工具结果内联给模型 |

主模型拿到「说了什么」+「画面发生了什么」后自行融合 —— 插件只负责取证据，不做总结。选型上刻意**只用本机能力**：`ffmpeg` 抽音轨与抽帧，`faster-whisper` 本地转录，不依赖任何云端 API。

## 🎯 核心能力

| 能力 | 说明 |
| --- | --- |
| 🎙️ **本地转录** | `faster-whisper` + CPU `int8`，模型规格 `tiny`/`base`/`small`/`medium`/`large-v3`，可选语言与「翻译成英文」 |
| 🖼️ **关键帧真图** | ffmpeg 场景变化抽帧 → JPEG 经 `ctx.attachments.saveImages()` 持久化 → 以**真正的 image 块**进模型上下文，不是路径、不是文字描述 |
| ⏱️ **时间戳对齐** | `metadata=mode=print` 打印被选中帧的 `pts_time`，与输出文件 **1:1 对应**（`-fps_mode vfr`，兼容 ffmpeg 5.1+）；解析失败时如实标 `timestampSource: 'estimated'`，不假装精确 |
| 🚦 **vision 能力门控** | 产出 image 块前查 `ctx.llm.resolveModelInfo()` 的 `inputModalities`；路由未声明 `image` 时**只给帧路径 + 时间戳**并回 `reason: 'model-lacks-image-input'`，因此下次提问不会整轮报 `UNSUPPORTED_CONTENT` |
| ⏳ **长音频不阻塞** | 走 `ctx.jobs` 后台作业（`small` 约 3.2× 实时，1 小时录音约 20 分钟；`large-v3` 约 0.7×，需 ~1.4 小时），执行中可用 `job_output` 看进度、`job_kill` 终止 |
| 🧯 **错误如实分类** | 缺 ffmpeg / 缺 python 依赖 / **缺 MSVC 运行时（`0xC0000005` 无输出退出）** / **内存不足（`mkl_malloc`）** / 无音轨 / 无场景变化 / 模型不支持图片，各有独立结论 |
| 🔌 **无 Key、无网络依赖** | 模型可离线加载（`local_files_only`），子进程经 `ctx.subprocess` 托管（可执行解析、进程组终止、输出有界收集与溢出落盘） |

## 🧱 环境前提（已实测）

| 项 | 要求 | 原因 |
| --- | --- | --- |
| ffmpeg / ffprobe | **6.0+**（本机实测 6.0） | 抽轨、抽帧、流探测 |
| Python | **3.14**（本机 3.14.8） | ⚠️ 3.15 无 `ctranslate2`/`onnxruntime` wheel，装不上 faster-whisper |
| faster-whisper | `1.2.1` | 本地转录引擎 |
| PyAV | **`av<19`**（本机 18.1.0） | ⚠️ 硬前提：`av>=19` 移除了 `av.open()` 的 `metadata_errors` 参数，而 faster-whisper 1.2.1 仍在传它 → 推理必崩 `TypeError: open() got an unexpected keyword argument 'metadata_errors'` |
| VC++ 运行时 | 2015-2022 可再发行组件（`MSVCP140.dll` ≥ 14.40） | ⚠️ 过旧版本会导致 `ctranslate2`/`onnxruntime` **`0xC0000005` 硬崩溃：无 traceback、无输出**，表现为「python 子进程莫名消失」 |
| 硬件 | **CPU 必需**，GPU 可选；内存 ≥ 8 GB 建议 | 没有 NVIDIA 卡/驱动时自动用 CPU（`device: auto` → `cpu`）——**无卡环境是一等公民，不是降级特例**。本机 8 核 / 64 GB / NVIDIA Tesla P40 24 GB（KVM 直通） |
| GPU（可选加速） | NVIDIA 卡 + 能用的数据中心驱动；**计算能力 ≥ 6.1 需落在 R580 分支内** | ⚠️ Pascal（6.0/6.1）的 CUDA Toolkit 支持**止于 12.x**、驱动分支**止于 R580**（[NVIDIA 官方矩阵](https://docs.nvidia.com/datacenter/tesla/drivers/latest/cuda-toolkit-driver-and-architecture-matrix.html)）。本机 `ctranslate2 4.8.3`（CUDA 12 + cuDNN 9）正好可用；⚠️ 但 **Windows 版的 R580 数据中心驱动已不含 P40 的 INF**，Windows 上实际只能停在更早的分支（现场结论见 [`docs/coding-plan-review.md`](docs/coding-plan-review.md) §9.4.2） |
| DSH | 运行时 **≥ `0.2.0-rc.2`** | 兼容性判定只比对 peerDependencies 与运行时版本，写错直接被判 `incompatible-version` 拒绝装载 |
| vision 路由 | 默认模型声明 `input: [text, image]` | 见「配置」；未声明时插件自动降级，不会让对话失败 |

Whisper 模型规格与实测速度（`beam_size=5` + VAD）。中文素材 24.08s、英文素材 8.04s，均为**已知原文的合成语音**，因此可以顺带给出精度：

**CPU**（8 核、`int8`）：

| 模型 | 加载 | 中文 24s 转写 | 相对实时 | 英文 8s 转写 | 相对实时 | 中文 CER | 英文 WER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tiny` | 1.70s | 1.87s | 12.89× | 0.87s | 9.28× | 7.2% | 5.9% |
| `base` | 1.23s | 2.77s | 8.68× | 1.51s | 5.34× | 8.4% | 5.9% |
| **`small`（默认）** | 2.80s | 7.58s | **3.18×** | 3.88s | 2.07× | 6.0% | 5.9% |
| `medium` | 6.18s | 21.08s | 1.14× | 11.49s | 0.70× | 6.0% | 5.9% |
| `large-v3` | 11.02s | 33.85s | 0.71× | 19.84s | 0.41× | **4.8%** | 5.9% |

**GPU**（NVIDIA Tesla P40 24 GB、`cuda` + `int8_float32`）：

| 模型 | 加载 | 中文 24s 转写 | 相对实时 | 英文 8s 转写 | 相对实时 | 相比 CPU |
| --- | --- | --- | --- | --- | --- | --- |
| **`small`** | 2.10s | **0.96s** | **25.06×** | 0.36s | 22.42× | **7.9×** |
| `medium` | 4.84s | **1.92s** | **12.53×** | 0.68s | 11.83× | 11× |
| `large-v3` | 10.26s | **5.30s** | **4.55×** | 1.03s | 7.81× | 6.4× |

**怎么读这张表**：

- **有卡时 `large-v3` 才真正可用**：GPU 上 **4.55× 实时**（1 小时录音约 **13 分钟**），而 CPU 上是 0.71×（约 85 分钟）。所以默认值仍按「设备自动解析」走：**有卡会自动用卡**，无卡就落回 CPU，两边都能跑。
- **GPU 不改变精度**：同一素材上 CPU `int8` 与 GPU `int8_float32` 的输出**逐字相同**；`large-v3` 的中文 CER 4.8% 仍是最好的，比 `small` 少 1.2 个百分点。
- ⚠️ **`float16` 不能用**：P40 是 GP102，FP16 吞吐仅为 FP32 的 1/64，CTranslate2 直接拒绝（`ValueError: ... do not support efficient float16 computation`）。本机可用集合：`cuda → {float32, int8, int8_float32}`、`cpu → {float32, int16, int8, int8_float32}` —— 这就是 `computeType` 必须是 `auto` 而不能硬编码的原因。
- 英文五档都只剩数字写法差异（`three`→`3`、`eight`→`8`），精度上分不出胜负。
- 五档模型（blobs 共 4.97 GB）已在本机预置，可离线加载。完整数据与素材见 [`docs/coding-plan-review.md`](docs/coding-plan-review.md) §9.4.1 与 §9.4.2。

## 🎛️ 执行设备：有卡用卡，无卡照跑

转录设备**不写死**，启动/调用时解析：

| 配置 | 默认 | 解析方式 |
| --- | --- | --- |
| `whisper.device` | `auto` | `cuda → cpu`：查得到可用 CUDA 设备就用 GPU，否则静默落回 CPU |
| `whisper.computeType` | `auto` | 用 `ctranslate2.get_supported_compute_types(device)` 取可用档：**本机 GPU → `int8_float32`、CPU → `int8`**；⚠️ **`float16` 不能用**（P40 的 FP16 吞吐只有 FP32 的 1/64，CTranslate2 直接拒绝），所以绝不硬编码 |

**无卡环境是一等公民**：没有 NVIDIA 驱动 / 直通未生效 / 卡被别的 VM 占用时，`get_cuda_device_count() == 0` ⇒ 自动用 `cpu` + `int8`，功能与有卡时**完全一致**，只是慢一些。**任何 CUDA 探测失败都不抛错**，只记录原因。

`media_probe` 会把这些如实报出来，便于判断"这次用了什么、为什么"：

```jsonc
{
  "device": "cpu",                    // 实际生效值
  "deviceSource": "auto",             // config / auto
  "reason": "no-cuda-driver",         // 降级原因；正常用卡时为 null
  "gpu": null                         // 有卡时给型号/显存/驱动版本，取不到给 null
}
```

探测不是"看得到设备就算数"：会在所选设备上**真的构造一次模型或跑一次极短推理**，因为"`import` 能过、一推理就崩"在这个项目上已经真实发生过（见上表的 VC++ 运行时一条）。

## 📦 安装

> 实现落地后按本节操作；当前仓库尚无包可装。

1. **装本机前提**（见上表）：ffmpeg、Python 3.14、`pip install "faster-whisper==1.2.1" "av<19"`、VC++ 2015-2022 运行时。
2. **装插件本体**：仓库放在工作区树外、再 link 进 profile（避免仓库内 `node_modules/@deepseek-ai/*` 在运行时抢先解析、与宿主成为两个模块实例）：

       # ~/.dsh/profiles/web/package.json
       "dsh-media-understanding": "link:C:\\workspace\\github\\dsh-media-understanding"

   并把包名追加进该 profile 的 `bundles` 数组，然后在该目录 `pnpm install`。
3. **重启 `dsh web`**：宿主半插件代码改动一律要重启才生效。
4. **确认工具出现**：新会话里模型能列出并调用 `media_probe`（可用性探针）—— 这是 Phase 1 的验收动作。

## ⚙️ 配置

以下为 `Config` schema 的目标默认值（写进 `cordis.patch.yml` 的 `config` 段）：

```yaml
- insert:
    - id: media-understanding
      name: dsh-media-understanding
      config:
        whisper: { model: small, device: auto }   # device: auto → 有卡用 CUDA，无卡自动落 CPU
        frames: { threshold: 0.3, maxFrames: 16 }
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `whisper.pythonPath` | 自动探测（本机命中 3.14.8） | 解释器路径；探针会**实测 `import faster_whisper`**，不只看路径 |
| `whisper.model` | `small` | 见上方速度表；`large-v3` 精度最高（中文 CER 4.8%），有卡时 4.55× 实时、无卡时 0.71× |
| `whisper.device` | `auto` | **`cuda → cpu` 自动解析**；无 NVIDIA 驱动/未直通时静默用 CPU。`cuda` 在无卡机器上必然报错 |
| `whisper.computeType` | `auto` | 按 device 取可用档：本机 **GPU → `int8_float32`**、**CPU → `int8`**；⚠️ `float16` 在 P40 上被直接拒绝 |
| `whisper.modelCacheDir` | 系统缓存（HF hub） | 可预置模型以实现完全离线 |
| `whisper.localFilesOnly` | `false` | 置 `true` 则只用本地已下载模型 |
| `whisper.timeoutMs` | 覆盖下载 + 长音频 | 子进程预算，用 `signal` 实现（`SubprocessSpawnSpec` 本身没有 `timeoutMs`） |
| `transcribe.jobOutputLimitBytes` | `262144` | 作业的模型面字节上限（同时约束输出读取与完成通知） |
| `transcribe.maxSegments` | `5000` | 超出即截断并置 `truncated: true` |
| `frames.threshold` | `0.3` | 场景变化灵敏度 |
| `frames.maxFrames` | `16` | 单次抽帧上限；`imageLimits.maxImagesPerMessage` 默认为 20，故留余量 |
| `frames.jpegQuality` | `3` | ffmpeg `-q:v`，越小越清晰越大 |
| `frames.maxWidth` | `1280` | 与 `attachments.imageLimits` 取小值 |
| `ffmpeg.path` / `ffprobe.path` | 自动解析 | 可覆盖 |
| `workDir` | `os.tmpdir()` + `mkdtempSync` | 中间产物落点，执行完在 `finally` 清理 |

**vision 路由**：真图分支要求当前路由声明图片输入，DSH 的 pi-ai 适配器在模型未声明 `image` 时**硬失败**（`UNSUPPORTED_CONTENT`，整轮对话失败，而非降级）。确认方式是在 profile 的路由 entry 上带 `input: [text, image]`；若要回滚，删掉该行即可。插件侧的门控是防御性检查，不是一次性修复 —— 换到 `ollama`/`glm`/`qianwenai` 等未声明图片的路由时会自动降级为文字模式。

## 🔧 工具契约

### `transcribe_audio`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | ✅ | 本地音视频文件路径 |
| `language` | string | | 源语言（如 `zh`、`en`）；省略则自动判定 |
| `translate_to_english` | boolean | | 转写并翻译成英文 |
| `backend` | enum | | 目前只有 `whisper-local` |

立即返回作业句柄：

```jsonc
{
  "jobId": "transcribe-1",
  "status": "running",
  "backend": "whisper-local",
  "model": "small",
  "note": "用 job_output 读取转写正文",
  "reason": "no-audio-track"   // 前置探测即判定无音轨时给出，此时不起作业
}
```

`job_output` 读到的正文形状：`{ text, language, durationSec, segments: [{ start, end, text }], backend, truncated, reason? }`。

### `video_frames`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | — | 本地视频文件路径（必填） |
| `threshold` | number | `0.3` | 场景变化灵敏度 |
| `max_frames` | number | `16` | 抽帧上限 |
| `strategy` | enum | `scene` | `scene` 场景变化 / `fps` 固定采样 |
| `fps` | number | — | `strategy=fps` 时生效 |

输出（canonical，永远有值）：

```jsonc
{
  "frames": [{ "index": 0, "timestampSec": 4.2, "attachmentId": "…", "width": 1280, "height": 720, "path": "…" }],
  "strategy": "scene",
  "timestampSource": "exact",          // 解析失败则为 "estimated"
  "mode": "images",                    // 或 "text-only"
  "reason": "model-lacks-image-input"  // 另有 "no-scene-change" / "no-video-stream"
}
```

**降级语义（重要）**：`mode: 'text-only'` 时只返回临时帧文件路径 + 时间戳，**不产出 image 块**，因此后续对话不会因为路由不支持图片而报错。纯色/动画视频返回 `frames: []` 且 `reason: 'no-scene-change'`，此时可改用 `strategy: 'fps'`。

**设计边界**：基础设施故障（ffmpeg 缺失、文件不存在）**抛错**；业务非理想结果（无音轨、无场景变化、模型不支持图片）**返回 canonical 值 + `reason`**。工具不限制 `file_path` 落在工作区内，读取范围记为已知设计边界。

## 💡 用法

> 实现落地后可用的典型会话（示例为示意）：

```text
用户：看下 meeting.mp4 讲了什么，第 12 秒屏幕上是什么字？
模型：→ transcribe_audio({ file_path: "…\\meeting.mp4", language: "zh" })
      ← { jobId: "transcribe-1", status: "running", … }
模型：→ job_output({ job_id: "transcribe-1" })
      ← [00:00.0 → 00:04.2] 大家好，今天讨论三件事…
模型：→ video_frames({ file_path: "…\\meeting.mp4", max_frames: 12 })
      ← 12 张带时间戳真图（含 12.4s 那一帧）
模型：讲了版本排期、风险和分工；第 12 秒画面是标题为「Q3 Roadmap」的幻灯片。
```

## 📁 包结构

```text
dsh-media-understanding/
├── src/
│   ├── index.ts               # 插件入口：name / inject / apply(ctx) / Config schema
│   ├── globals.d.ts           # 空类型导入，激活官方包的 declare module 增强（无运行时依赖）
│   ├── tools/                 # transcribe_audio、video_frames 的工具定义
│   ├── media/                 # ffmpeg 封装、whisper 调用、附件持久化、错误分类
│   └── workers/transcribe.py  # faster-whisper worker（stdlib + faster_whisper）
├── test/                      # 契约测试（参数校验、render 纯函数性、降级分支、时间戳解析）
├── docs/                      # 设计记录（coding-plan.md）与复审报告（coding-plan-review.md）
├── cordis.patch.yml           # 把本包挂成宿主半插件
└── README.md / README.en.md   # 中文（默认）/ 英文
```

构建与本地开发的结论照搬工作区内已量产的宿主侧插件（`dsh-mcp-skill-panel`），几条要点：

- **打包铁律**：`tsdown` 必须把 `@deepseek-ai/*` 与 `node:*` 标为 external —— 内联会得到第二份模块副本、重复 `Symbol`，导致工具调度崩溃。
- 类型声明由 `tsc` 出到 `lib/types/`；`tsconfig` 用 `paths` 把用到的 DSH 包映射到宿主闭包。
- 本地类型来源用脚本把宿主 `.pnpm` 闭包 junction 进 `<repo>/node_modules/@deepseek-ai`（Windows 下 `mklink /J` 无需管理员）。
- 多入口时显式指定 `outputOptions.entryFileNames`（basename 相同会互相覆盖）。

## ⚠️ 已知限制

- 不解析内嵌字幕轨（未来可选：字幕优先、Whisper 兜底）。
- 不支持远程 URL，只读本地文件。
- 单次抽帧上限受 `imageLimits.maxImagesPerMessage`（默认 20）约束，默认取 16 留余量；帧图会显著消耗上下文。
- `strategy: 'scene'` 不产出首帧（`select` 对第一帧恒为假），必要时应额外补抽 `t=0`。
- 时间戳在解析失败时是**估算值**，输出里会如实标注。

## 📚 文档

- [`docs/coding-plan.md`](docs/coding-plan.md) —— 设计、工具契约、配置项、包结构、分阶段实施与风险登记。**动契约、DSH API 调用或包结构之前先读它。**
- [`docs/coding-plan-review.md`](docs/coding-plan-review.md) —— 复审结论、本机实测环境、阻断点修正。**接入 profile、跑不通、或怀疑 DSH 版本差异时读它。**

## 📄 许可

[Apache-2.0](LICENSE)。
