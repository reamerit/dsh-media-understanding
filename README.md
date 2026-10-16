<p align="center">
  <strong style="font-size: 2.2em">🎬 DSH 音视频理解插件</strong><br>
  <span style="font-size: 1.1em">DeepSeek Harness 宿主侧插件 · 本地音视频 → 转录文本 + 带时间戳关键帧真图 · 全程离线、无需 API Key</span>
</p>

<p align="center">
  <a href="./README.en.md">🌐 English</a> · <strong>中文</strong>
</p>

> **状态：已实现并本机跑通（2026-10-16）**。三个工具都已在真实 DSH 宿主里端到端验证：`media_probe` 报出 `device: cuda` / `int8_float32`；`transcribe_audio` 对真实语音产出带时间戳转录（作业 + `job_output`）；`video_frames` 抽到真图且**模型确实看见了画面**；直链可下载后处理。`test/` **69 项全绿**。**尚未发布到 npm**，安装方式见下（本机是用 link + 重启生效）。
>
> 与原设计文档不一致的地方已在代码里注明并修正，其中一处值得单独提醒：**时间戳打印器必须用 ffmpeg 的 `showinfo`，而不是设计文档里写的 `metadata=mode=print`** —— 本机 ffmpeg 6.0 实测后者根本不输出 `pts_time`，会让所有时间戳静默退化成"按帧率估算"。

---

## ✨ 是什么

一个把本地音视频**或视频链接**交给模型的 DSH 插件，注册三个工具：

| 工具 | 方向 | 形态 |
| --- | --- | --- |
| `media_probe` | 环境体检：能不能转录、用哪个设备、为什么 | **只读同步** |
| `transcribe_audio` | 音频/视频 → 带时间戳的转录文本 | **后台作业**：立即返回 `jobId`，正文用 `job_output` 读 |
| `video_frames` | 视频 → 带时间戳的关键帧**真图** | **同步**：帧图在 `execute` 内落附件服务，随工具结果内联给模型 |

输入统一为"一段媒体"：

- **本地绝对路径** —— 包括你在 GUI 里拖进对话框的视频（宿主会把上传文件落到
  `<DSH_HOME>\attachments\v1\files\…` 并把该路径写进模型可见的文本，模型据此传参）；
- **http(s) 链接** —— 直链（`.mp4`/`.m3u8`…）走 ffmpeg，平台页面链接（YouTube / Bilibili 等）
  走 **yt-dlp** 先下载。

「任务要求」（比如"总结讲了什么"、"第 12 秒屏幕上是什么字"）由**主模型**自行消化成上面这些
工具调用，插件不额外引入 `task` 参数 —— 少一层转述，也少一层失真。

主模型拿到「说了什么」+「画面发生了什么」后自行融合 —— 插件只负责取证据，不做总结。选型上刻意**只用本机能力**：`ffmpeg` 抽音轨与抽帧、`faster-whisper` 本地转录、`yt-dlp` 下载，不依赖任何云端 API 密钥。

## 🎯 核心能力

| 能力 | 说明 |
| --- | --- |
| 🎙️ **本地转录** | `faster-whisper` + CPU `int8`，模型规格 `tiny`/`base`/`small`/`medium`/`large-v3`，可选语言与「翻译成英文」 |
| 🖼️ **关键帧真图** | ffmpeg 场景变化抽帧 → JPEG 经 `ctx.attachments.saveImages()` 持久化 → 以**真正的 image 块**进模型上下文，不是路径、不是文字描述 |
| ⏱️ **时间戳对齐** | 用 ffmpeg 的 **`showinfo`** 打印每帧 `pts_time`（`n: <序号> pts_time:<秒>`），与输出文件 **1:1 对应**（`-fps_mode vfr`，兼容 ffmpeg 5.1+）。⚠️ **不能用 `metadata=mode=print`**：本机 ffmpeg 6.0 实测它不输出 `pts_time`，会让时间戳静默退化成按帧率估算。解析失败时如实标 `timestampSource: 'estimated'`，不假装精确 |
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
| yt-dlp | 2026.08.19（本机实测） | **仅平台页面链接需要**（YouTube / Bilibili 等）；直链与本地文件不需要。未安装时该路径报 `download-tool-missing`，不影响其余功能 |
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

`media_probe` 会把这些如实报出来，便于判断"这次用了什么、为什么"（本机真实输出形状，此处展示**无卡降级**时的取值）：

```jsonc
{
  "device": "cpu",                    // 实际生效值
  "deviceSource": "auto",             // config / auto
  "reason": "no-cuda-device",         // 见下方取值表；正常用卡时为 "cuda-available"
  "computeType": "int8",
  "gpu": {                            // 有卡时给型号/显存/驱动版本；取不到则整个字段不出现
    "name": "Tesla P40",
    "memoryMiB": 23040,
    "driverVersion": "573.76",
    "computeCapability": "6.1"
  },
  "problems": []                      // 需要处理的问题清单（人读）
}
```

`reason` 的全部取值：`cuda-available`（用卡）、`no-cuda-device`、`cuda-count-failed`、`cuda-probe-failed`、`unsupported-compute-type`、`configured`（显式配置 device 时）。

探测不是"看得到设备就算数"：会在所选设备上**真的构造一次模型或跑一次极短推理**，因为"`import` 能过、一推理就崩"在这个项目上已经真实发生过（见上表的 VC++ 运行时一条）。

## 📦 安装

1. **装本机前提**（见上表）：ffmpeg、Python 3.14、`pip install "faster-whisper==1.2.1" "av<19" yt-dlp`、VC++ 2015-2022 运行时。
2. **构建**（从 git 源安装时不用手敲这几条：包自带 `prepare` 钩子，pnpm/npm 装依赖时会自动用 tsdown 打出 `lib/index.js`；下面这条链路是本地开发与发布用的）：

       npm install          # typescript + tsdown
       node scripts/setup-dsh-deps.mjs   # 把宿主闭包 junction 进 node_modules（供类型解析）
       npm run build        # tsdown 打包 + tsc 出 lib/types
       npm test             # 69 项契约与回归测试

   注：安装期由 `scripts/prepare.mjs` 构建，入口 `lib/index.js` 是硬指标（缺了安装即失败）；
   类型声明 `lib/types/` 是尽力而为——没有宿主闭包的机器上会跳过，不影响插件运行。

3. **部署到仓库树外**（重要：仓库内的 `node_modules/@deepseek-ai` 是**开发副本**，若让插件从仓库里被解析，
   会与宿主成为两份模块实例 → 工具调度崩溃）：

       node scripts/deploy.mjs
       # 产出 C:\workspace\github\_deploy\dsh-media-understanding（lib/ + src/workers/ + 指向宿主闭包的 junction）

4. **link 进 profile 并重启 `dsh web`**：

       dsh plugin --profile web add "dsh-media-understanding@link:C:\\workspace\\github\\_deploy\\dsh-media-understanding"
       # 该命令同时写入 dependencies 与 profile 的 bundles，然后重启 dsh web
       # （宿主半插件代码改动一律要重启才生效）

5. **确认**：新会话里调 `media_probe`。本机期望看到
   `device: cuda` / `computeType: int8_float32` / `fasterWhisper.ready: true` / `problems: []`；
   若落 `cpu`，`reason` 会告诉你原因（`no-cuda-device` / `cuda-count-failed` / `cuda-probe-failed`）。

## ✅ 已验证的行为（本机实测）

| 场景 | 结果 |
| --- | --- |
| `media_probe` | `device: cuda`、`int8_float32`、`reason: cuda-available`、5 个模型已缓存、`problems: []` |
| 语音视频转录 | 作业起得来，`job_output` 读到带时间戳转录，设备 `cuda/int8_float32` |
| 场景抽帧 | `blocks.mp4` → 2 张真图、`timestampSource: exact`、时间戳 4.0s / 6.0s；**模型看得见图并描述了内容** |
| `strategy: fps` | 10s 片段 1fps → 3 帧、`timestampSource: exact`、0.0/1.0/2.0s |
| 无场景变化 | 返回 `mode: text-only` + `reason: no-scene-change`，并提示改用 `fps` |
| 直链 mp4 | 下载 → 抽帧 → 真图回传，模型正确描述画面 |
| 死链 | 返回 `download-failed`（而不是笼统失败） |
| worker 脚本路径错 | **直接报错**，不再伪装成"这台机器没装依赖" |

## ⏱️ 超时与取消（Phase 4 实测）

**工具超时按"工具做什么"设定，而不是按"作业跑多久"**：

| 工具 | `timeoutMs` | 依据 |
| --- | --- | --- |
| `media_probe` | 180s | 只跑探针 + 解析可执行文件；给予启动余量（首次冷启动 Python 较慢） |
| `transcribe_audio` | **120s** | 只做**前置校验 + 起作业**，随即返回 ⇒ 短。**作业本身不受工具超时约束**，这才是走 jobs 的收益 |
| `video_frames` | 600s | 同步抽帧 + 落附件，分钟级 |

**取消（`job_kill`）实测**：对一个 6 分钟的音频起作业后立刻 `job_kill`，结果是

```
transcribe-1 [transcribe] killed — transcribe long6min.wav (small on cpu)
[status: killed, cancelled; cancellation test]
```

- 最终状态是 **`killed`**，不是 `failed` —— 取消与真故障在 `job_list` 里**可区分**，你才知道该不该重试；
- `job_kill` 传入的 reason 会出现在终态里；
- **取消后 `python` / `ffmpeg` 残留进程数为 0**（`Get-Process` 实测），临时产物也在 `finally` 里清掉。

`exec.signal` 全链路透传：`execute` → 前置探流/下载 → 作业内的 `ctx.subprocess.spawn({ signal })`；会话中断与 `job_kill` 两条路径都走同一个 `AbortController`。

## 🧯 错误矩阵实测（Phase 4）

| 场景 | 行为 |
| --- | --- |
| 输入无音轨 | `status: not-started` + `reason: no-audio-track`，**不起作业**，并说明没有可转录的音轨 |
| 本地文件不存在 | **抛错**（基础设施故障），错误文本带上具体路径 |
| `ftp://` 等不支持的 scheme | `status: not-started` + `reason: unsupported-url`，明确只接受 http(s) 与本地路径 |
| 死链 / 404 | `reason: download-failed`（而不是笼统"未知原因"） |
| 无场景变化 | `mode: text-only` + `reason: no-scene-change`，并提示改用 `strategy: fps` |
| 模型不支持图片 | `mode: text-only` + `reason: model-lacks-image-input`，帧以路径+时间戳返回，**不产出 image 块**（后续对话不会报 `UNSUPPORTED_CONTENT`） |
| 缺 ffmpeg / python 依赖 / av≥19 / 内存不足 | 各有独立的错误分类与修复建议（见 `src/pure/errors.ts`） |
| worker 脚本路径错 | **立即报错**并指出路径，不再伪装成"这台机器没装依赖" |

**语义分工**：基础设施故障（ffmpeg 缺失、文件不存在）**抛错**；业务非理想结果（无音轨、无场景变化、模型不支持图片、链接下不动）**返回 canonical 值 + `reason`**。

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
| `whisper.timeoutMs` | 省略（即不设子进程超时） | 单次**转录**的子进程预算；下载有独立的 `download.timeoutMs` |
| `transcribe.jobOutputLimitBytes` | `262144` | 作业的模型面字节上限（同时约束输出读取与完成通知） |
| `transcribe.maxSegments` | `5000` | 超出即截断并置 `truncated: true` |
| `frames.threshold` | `0.3` | 场景变化灵敏度 |
| `frames.maxFrames` | `16` | 单次抽帧上限；`imageLimits.maxImagesPerMessage` 默认为 20，故留余量 |
| `frames.jpegQuality` | `3` | ffmpeg `-q:v`，越小越清晰越大 |
| `frames.maxWidth` | `1280` | 与 `attachments.imageLimits` 取小值 |
| `download.ytDlpPath` | `python -m yt_dlp` | 覆盖 yt-dlp 可执行文件 |
| `download.timeoutMs` | 30 分钟 | 单个链接的下载预算 |
| `ffmpeg.path` / `ffprobe.path` | 自动解析 | 可覆盖（走 `ctx.subprocess.resolveExecutable`） |

中间产物落在 `os.tmpdir()` 下的独立 `mkdtemp` 目录（抽轨、抽帧、下载各一个），全部在 `finally` 里清理；worker 的 spill 文件也由插件显式删除。

**vision 路由**：真图分支要求当前路由声明图片输入，DSH 的 pi-ai 适配器在模型未声明 `image` 时**硬失败**（`UNSUPPORTED_CONTENT`，整轮对话失败，而非降级）。确认方式是在 profile 的路由 entry 上带 `input: [text, image]`；若要回滚，删掉该行即可。插件侧的门控是防御性检查，不是一次性修复 —— 换到 `ollama`/`glm`/`qianwenai` 等未声明图片的路由时会自动降级为文字模式。

## 🔧 工具契约

### `transcribe_audio`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | ✅ | **本地绝对路径**（含 GUI 上传落到 `~/.dsh/attachments/v1/files/…` 的路径）**或 http(s) 链接**（直链走 ffmpeg、平台页面走 yt-dlp 先下载） |
| `language` | string | | 源语言（如 `zh`、`en`）；省略则自动判定 |
| `translate_to_english` | boolean | | 转写并翻译成英文 |
| `backend` | enum | | 目前只有 `whisper-local` |

返回值的 `status` 有两种（`jobId` 在第一种下才非空）：

```jsonc
// 起了作业：正文用 job_output 读
{
  "jobId": "transcribe-1",
  "status": "running",
  "backend": "whisper-local",
  "model": "small",
  "device": "cuda",
  "source": "local",
  "note": "the transcript is streamed into the job output; read it with job_output …"
}

// 没起作业（前置判定已给出结论）：jobId 为空串，status 为 not-started
{
  "jobId": "",
  "status": "not-started",
  "backend": "whisper-local",
  "model": "small",
  "device": "n/a",
  "source": "local",
  "note": "the input has no audio track, so there is nothing to transcribe",
  "reason": "no-audio-track"   // 另有 "unsupported-url" / "download-failed"
}
```

模型可见的渲染形式（结构化字段一定出现在输出里，不会只给一句话）：

```text
transcription started as job transcribe-1
status: running | jobId: transcribe-1 | model: small | device: cuda | source: local
the transcript is streamed into the job output; read it with job_output using this jobId, or stop the job with job_kill.
```

`job_output` 读到的正文形状：带 `# transcript (en, 12.9s, 1 segments, cuda/int8_float32)` 头，随后每行 `[00:00.7 → 00:12.7] 文本`；超出 `maxSegments` 时头里加 `# TRUNCATED:`。

### `video_frames`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | — | **本地绝对路径或 http(s) 链接**（必填） |
| `threshold` | number | `0.3` | 场景变化灵敏度 |
| `max_frames` | number | `16` | 抽帧上限（与部署的 `imageLimits.maxImagesPerMessage` 取小值） |
| `strategy` | enum | `scene` | `scene` 场景变化 / `fps` 固定采样 |
| `fps` | number | `1` | `strategy=fps` 时生效 |

输出（canonical，永远有值）：

```jsonc
{
  "frames": [{ "index": 0, "timestampSec": 4.2, "attachmentId": "sha256:…", "mediaType": "image/jpeg", "bytes": 12345, "width": 320, "height": 240, "path": "…" }],
  "strategy": "scene",
  "timestampSource": "exact",          // 解析失败则为 "estimated"
  "mode": "images",                    // 或 "text-only"
  "durationSec": 8.0,
  "reason": "model-lacks-image-input"  // 另有 "no-scene-change" / "no-video-stream" / "attachments-unavailable"
}
```

模型可见的渲染形式：标题行 + 一行事实（`mode: images | strategy: scene | timestampSource: exact | durationSec: 8.00`），随后每帧 `[00:04.2]` + 内联图片；`text-only` 时改为列出帧文件路径。

**降级语义（重要）**：`mode: 'text-only'` 时只返回临时帧文件路径 + 时间戳，**不产出 image 块**，因此后续对话不会因为路由不支持图片而报错。纯色/动画视频返回 `frames: []` 且 `reason: 'no-scene-change'`，此时可改用 `strategy: 'fps'`。

**设计边界**：基础设施故障（ffmpeg 缺失、文件不存在）**抛错**；业务非理想结果（无音轨、无场景变化、模型不支持图片）**返回 canonical 值 + `reason`**。工具不限制 `file_path` 落在工作区内，读取范围记为已知设计边界。

## 💡 用法

一句任务 + 一段媒体即可；模型自己决定调哪些工具（下例是**实测跑通**的形态）：

```text
用户：看下 meeting.mp4 讲了什么，第 12 秒屏幕上是什么字？
模型：→ transcribe_audio({ file_path: "…\\meeting.mp4" })
      ← status: running | jobId: transcribe-1 | model: small | device: cuda | source: local
模型：→ job_output({ job_id: "transcribe-1" })
      ← # transcript (en, 12.9s, 1 segments, cuda/int8_float32)
        [00:00.7 → 00:12.7] I have a dream that one day this nation will rise up …
模型：→ video_frames({ file_path: "…\\meeting.mp4", max_frames: 12 })
      ← mode: images | strategy: scene | timestampSource: exact | durationSec: 8.00
        [00:04.0] <内联图片>  [00:06.0] <内联图片>
模型：讲了版本排期、风险和分工；第 12 秒画面是标题为「Q3 Roadmap」的幻灯片。
```

也可以直接给链接（模型只需把 URL 当 `file_path` 传进来）：

```text
用户：这个视频里有什么？ https://example.com/clip.mp4
模型：→ video_frames({ file_path: "https://example.com/clip.mp4", strategy: "fps", max_frames: 3 })
      ← 下载 → 抽帧 → 3 张真图（exact 时间戳）
```

## 📁 包结构

```text
dsh-media-understanding/
├── src/
│   ├── index.ts               # 插件入口：name / inject / apply(ctx) / Config / workersDir()
│   ├── globals.d.ts           # 空类型导入，激活官方包增强 + 合并 JobKindMap（transcribe/download）
│   ├── tools/
│   │   ├── probe.ts           # media_probe（只读环境体检）
│   │   ├── transcribe.ts      # transcribe_audio（jobs 后台作业）
│   │   └── frames.ts          # video_frames（同步抽帧 + 附件持久化 + vision 门控）
│   ├── media/                 # 宿主交互层
│   │   ├── exec.ts            # ctx.subprocess 封装（解析/有界收集/spill/取消/超时）
│   │   ├── ffmpeg.ts          # ffprobe 探流、抽音轨、sampleFrames（showinfo 时间戳）
│   │   ├── whisper.ts         # Python 探针调用、设备解析、worker 转录
│   │   ├── download.ts        # yt-dlp / ffmpeg 链接下载
│   │   └── input.ts           # 输入归一：本地路径 vs 链接 vs 不支持的 scheme
│   ├── pure/                  # 纯逻辑（零宿主依赖，单独打包供测试）
│   │   ├── device.ts          # 设备与计算档解析（有卡用卡 / 无卡降级）
│   │   ├── errors.ts          # 错误分类（0xC0000005、mkl_malloc、av≥19、下载失败…）
│   │   ├── json.ts            # pruneUndefined / assertJsonSafe（宿主要求 JSON 无损）
│   │   ├── render.ts          # output.render 的纯投影（模型可见面的唯一来源）
│   │   ├── timestamps.ts      # showinfo / pts_time 解析与配对
│   │   └── resolve-input.ts   # 输入分类与下载文件名推导
│   └── workers/
│       ├── probe.py           # 环境探针（真的构造一次原生对象，不只 import）
│       └── transcribe.py      # faster-whisper worker（结果写文件，避免 stdout 截断）
├── test/                      # 69 项（device / errors / json / render / resolve-input / timestamps / layout）
├── scripts/
│   ├── setup-dsh-deps.mjs     # 把宿主 .pnpm 闭包 junction 进 node_modules
│   ├── build.mjs              # tsdown 打包 → tsc 出 lib/types（顺序不可换）
│   ├── deploy.mjs             # 部署到仓库树外 + 建解析作用域
│   └── check-encoding.mjs     # 源码 UTF-8 体检（防双重编码）
├── docs/                      # 设计记录（coding-plan.md）与复审报告（coding-plan-review.md）
├── cordis.patch.yml           # 把本包挂成宿主半插件
└── README.md / README.en.md   # 中文（默认）/ 英文
```

构建与本地开发的几条要点：

- **打包铁律**：`tsdown` 必须把 `@deepseek-ai/*` 与 `node:*` 标为 external —— 内联会得到第二份模块副本、重复 `Symbol`，导致工具调度崩溃（`lib/index.js` 里 `TOOL_RUNTIME_SCHEDULER` 出现次数必须为 0）。
- 类型声明由 `tsc` 出到 `lib/types/`；`tsconfig` 直接靠 `node_modules` 里的 junction 解析宿主类型。
- 构建顺序不可换：`tsdown`（带 `clean: true`）先跑，`tsc` 后跑，否则清掉刚生成的声明。
- 部署必须在**仓库树外**：仓库内的 `node_modules/@deepseek-ai` 是开发副本，运行时会被抢先解析成第二份实例。

## ⚠️ 已知限制

- 不解析内嵌字幕轨（未来可选：字幕优先、Whisper 兜底）。
- 平台页面链接（YouTube / Bilibili）依赖 **yt-dlp**；未安装时该路径会明确报 `download-tool-missing`（直链不受影响）。链接只支持 http(s)。
- 单次抽帧上限受 `imageLimits.maxImagesPerMessage`（默认 20）约束，默认取 16 留余量；帧图会显著消耗上下文。
- `strategy: 'scene'` 不产出首帧（`select` 对第一帧恒为假），必要时应额外补抽 `t=0`。
- 时间戳在解析失败时是**估算值**，输出里会如实标注并附提醒。
- 时间格式在秒值四舍五入到 60 时会显示成 `00:60.0`（显示层面的既有行为，不影响模型读数）。

## 📚 文档

- [`docs/coding-plan.md`](docs/coding-plan.md) —— 设计、工具契约、配置项、包结构、分阶段实施与风险登记。**动契约、DSH API 调用或包结构之前先读它。**
- [`docs/coding-plan-review.md`](docs/coding-plan-review.md) —— 复审结论、本机实测环境、阻断点修正。**接入 profile、跑不通、或怀疑 DSH 版本差异时读它。**

## 📄 许可

[Apache-2.0](LICENSE)。
