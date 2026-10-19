# 安装步骤（setup）

本文是 `dsh-media-understanding` 的**逐步安装手册**，面向 Windows（PowerShell）。每一步都给出可直接粘贴的命令与**如何确认这一步成功了**。

**有显卡**与**没有显卡**的差异只有两处（其余步骤完全一致），下文用 🔵 有卡 / ⚪ 无卡 标注：

| | 🔵 有 NVIDIA 卡 | ⚪ 无 NVIDIA 卡 |
| --- | --- | --- |
| 第 3 步 预安装软件 | 额外装 **CUDA 12.x 运行库**（提供 `cublas64_12.dll` / `cudart64_12.dll`），并确认驱动版本可用 | **什么都不用装**：跳过 CUDA，别装 CUDA Toolkit |
| 第 6 步 配置 | 保持 `device: auto` 即可自动用卡；也可显式写 `device: cuda`（无卡机器上写 `cuda` 会直接报错） | 保持 `device: auto`，插件自动落 `cpu` + `int8` |

> **无卡环境是一等公民**：插件默认 `whisper.device: auto` 走 `cuda → cpu` 解析，没有卡时**静默使用 CPU**，功能与有卡时完全一致，只是慢一些（`small` 模型实测 CPU 3.18× 实时 / GPU 25.06× 实时）。**不要**为了让插件"能跑"而在无卡机器上装 CUDA Toolkit，那是纯粹的浪费。

---

## 0. 本机实测基准（可用来对照）

安装完成后 `media_probe` 应当报出与下面同形状的事实（本仓库开发机，**有卡**）：

```jsonc
{
  "ok": true,
  "device": "cuda",                 // ⚪ 无卡时为 "cpu"
  "deviceSource": "auto",
  "computeType": "int8_float32",    // ⚪ 无卡时为 "int8"
  "reason": "cuda-available",       // ⚪ 无卡时为 "no-cuda-device"
  "python":   { "version": "3.14.8", "executable": "C:\\…\\Python314\\python.EXE" },
  "ffmpeg":   { "ready": true },
  "ffprobe":  { "ready": true },
  "fasterWhisper": { "ready": true, "version": "1.2.1" },
  "pyav":     { "version": "18.1.0", "compatible": true },
  "ctranslate2": { "version": "4.8.3", "exercised": true },
  "onnxruntime": { "version": "1.31.0" },
  "gpu":      { "name": "Tesla P40", "memoryMiB": 23040, "driverVersion": "573.76", "computeCapability": "6.1" },
  "cachedModels": ["base", "large-v3", "medium", "medium.en", "small", "small.en", "tiny"],
  "ytDlp":    { "available": true, "version": "2026.08.19" },
  "problems": []
}
```

| 组件 | 本机版本 | 要求 |
| --- | --- | --- |
| Node.js | 26.8.2 | **≥ 22.19**（`engines`） |
| DSH | 0.2.0-rc.2 | **≥ 0.2.0-rc.2** |
| ffmpeg / ffprobe | 6.0 | **≥ 5.1**（插件用 `-fps_mode vfr`；README 口径 6.0+） |
| Python | 3.14.8 | **3.14**（见下方三个坑） |
| faster-whisper | 1.2.1 | 固定该版本 |
| PyAV | 18.1.0 | **`av<19` 硬前提** |
| CTranslate2 | 4.8.3 | 随 faster-whisper 一起装 |
| yt-dlp | 2026.08.19 | 仅平台页面链接需要（YouTube / Bilibili） |
| VC++ 运行时 | `MSVCP140.dll` 14.44.35211 | **≥ 14.40** |
| CUDA（🔵 可选） | 12.8 | CUDA **12.x** + cuDNN 9 |

### 三个会让人白折腾半天的坑

1. **Python 必须 3.14 附近，不能是 3.15**：3.15 没有 `ctranslate2` / `onnxruntime` 的 wheel，`pip install faster-whisper` 装不上。
2. **`av` 必须 `<19`**：`av>=19` 移除了 `av.open()` 的 `metadata_errors` 参数，而 faster-whisper 1.2.1 仍在传它，于是**每次推理必崩**：`TypeError: open() got an unexpected keyword argument 'metadata_errors'`。所以命令里固定写 `"av<19"`，不要只写 `av`。
3. **VC++ 运行时不能旧**：过旧的 `MSVCP140.dll` 会让 `ctranslate2` / `onnxruntime` **`0xC0000005` 硬崩溃——没有 traceback、没有输出**，现象是"python 子进程莫名消失"。这是本插件把「缺 MSVC 运行时」单列成一个错误分类的原因。

---

## 1. 装 Node.js 与 DSH

```powershell
node -v          # 需要 ≥ v22.19
dsh --version    # 需要 ≥ 0.2.0-rc.2
```

若 `dsh` 不在 PATH：DSH 的启动垫片在 `$env:USERPROFILE\.dsh\bin\`，把它加进 PATH，或直接用该目录下的 `dsh.cmd`。

**确认**：两条命令都能打印版本号。DSH 版本低于 `0.2.0-rc.2` 时，插件会因 peerDependencies 被宿主判为 `incompatible-version` 而拒绝装载。

---

## 2. 装 ffmpeg（🔵⚪ 都要）

ffmpeg 负责探流、抽音轨、抽帧；ffprobe 随 ffmpeg 一起提供。

```powershell
# 方式 A：winget（需要 App Installer）
winget install --id Gyan.FFmpeg -e

# 方式 B：手动下载（winget 不可用时）
# 从 https://www.gyan.dev/ffmpeg/builds/ 取 "release full" 压缩包，
# 解压后把 …\ffmpeg-<版本>-full_build\bin 加进 PATH（该目录里同时有 ffmpeg.exe 与 ffprobe.exe）
```

```powershell
ffmpeg -version   # 第一行形如 ffmpeg version 6.0 …
ffprobe -version
```

**确认**：`ffmpeg` 与 `ffprobe` 都能直接执行。两者缺任一个，`media_probe` 都会给出独立的修复建议（不会笼统报"环境有问题"）。

> 若不想动 PATH，可在插件配置里显式指定 `ffmpeg.path` / `ffprobe.path`（第 6 步）。

---

## 3. 预安装软件：Python 侧依赖（🔵⚪ 都要，🔵 多一段 CUDA）

### 3.1 装 Python 3.14

```powershell
winget install --id Python.Python.3.14 -e

# 或从 https://www.python.org/downloads/ 下载 3.14.x 安装包
# 安装时勾选 "Add python.exe to PATH"
```

```powershell
python -V        # 期望 Python 3.14.x
```

### 3.2 装 VC++ 运行时（2015-2022 可再发行组件）

```powershell
winget install --id Microsoft.VCRedist.2015+.x64 -e

# 或手动：https://aka.ms/vs/17/release/vc_redist.x64.exe
```

**确认**（关键：版本号要 ≥ 14.40）：

```powershell
(Get-Item C:\Windows\System32\msvcp140.dll).VersionInfo.FileVersion
# 本机参考值：14.44.35211.0
```

### 3.3 装 faster-whisper + PyAV + yt-dlp

```powershell
python -m pip install --upgrade pip
python -m pip install "faster-whisper==1.2.1" "av<19" yt-dlp
```

**确认**（三件事一次查完）：

```powershell
python -c "import faster_whisper, av, ctranslate2; print(faster_whisper.__version__, av.__version__, ctranslate2.__version__)"
python -c "import ctranslate2; print('cpu types:', sorted(ctranslate2.get_supported_compute_types('cpu')))"
```

期望：`1.2.1 18.1.0 4.8.3`，以及 `cpu types: ['float32', 'int16', 'int8', 'int8_float32']`。

> 第二条命令不是走过场：它**真的进一次原生层**。若 VC++ 运行时过旧，这一步就会以 `0xC0000005` 无输出退出——这正是"`import` 能过、一用就崩"的复现方式，也是插件探针必须真构造对象的原因。

### 3.4 🔵 有卡：CUDA 12.x 运行库

**前提判断**——先确认"卡在、驱动新"：

```powershell
nvidia-smi
# 期望看到显卡型号、显存、Driver Version（本机：Tesla P40 / 23040MiB / 573.76）
```

`nvidia-smi` 都跑不出来 ⇒ 卡或驱动不可用，此时**跳过 CUDA，按 ⚪ 无卡路走**（插件会自动落 CPU，不需要额外改动）。

**为什么需要 CUDA 12 运行库**：`ctranslate2.dll`（4.8.3）会动态加载 `cublas64_12.dll`（cuBLAS）和 `nvcuda.dll`（驱动提供），并在需要时加载 `cudnn64_9.dll`。其中 **cuDNN 9 由 ctranslate2 wheel 自带**（`…\site-packages\ctranslate2\cudnn64_9.dll`），**cuBLAS / CUDA 运行时不在 wheel 里，必须由系统或 pip 提供**。

```powershell
# 方式 A（本机实测路径）：CUDA Toolkit 12.x 安装器
# 从 https://developer.nvidia.com/cuda-12-8-0-download-archive 取 Windows x86_64 安装器
# 自定义安装时只需勾选 Runtime 相关的 Libraries
# 装完确认环境变量 CUDA_PATH 指向 …\CUDA\v12.8，且 …\CUDA\v12.8\bin 在 PATH 里

# 方式 B：不装完整 Toolkit，用 pip 提供的 CUDA 运行库
python -m pip install nvidia-cublas-cu12 nvidia-cuda-runtime-cu12
```

方式 B 装完后，DLL 落在 `…\site-packages\nvidia\cublas\bin` 与 `…\site-packages\nvidia\cuda_runtime\bin`，**这两个目录必须在 PATH 上**（或由 `os.add_dll_directory()` 注册），否则 ctranslate2 找不到 `cublas64_12.dll`。

**确认**（这一步是 GPU 路径的真正验收）：

```powershell
python -c "import ctranslate2; print('cuda count:', ctranslate2.get_cuda_device_count()); print('cuda types:', sorted(ctranslate2.get_supported_compute_types('cuda')))"
```

期望（本机实测）：

```
cuda count: 1
cuda types: ['float32', 'int8', 'int8_float32']
```

- `cuda count: 0` ⇒ 卡/驱动没就绪，插件会用 CPU（功能不受影响）；
- 报 `Library cublas64_12.dll is not found or cannot be loaded` 一类错误 ⇒ CUDA 12 运行库没装好或不在 PATH，回到上面方式 A/B 补齐；
- ⚠️ **`float16` 用不了**：Pascal（算力 6.x）的 FP16 吞吐只有 FP32 的 1/64，CTranslate2 会直接拒绝。可用档就是上面的三个——这也是插件把 `computeType` 固定为 `auto`、按设备现取可用档的原因；
- ⚠️ **驱动分支**：算力 6.1 的卡（如 P40）CUDA Toolkit 支持止于 12.x、驱动分支止于 R580（[NVIDIA 官方矩阵](https://docs.nvidia.com/datacenter/tesla/drivers/latest/cuda-toolkit-driver-and-architecture-matrix.html)）。驱动过旧时会报 `cuda driver version is insufficient`。

### 3.5 ⚪ 无卡：什么都不用装

跳过 3.4。**不要**安装 CUDA Toolkit / cuDNN，也不会因此少任何功能：

- `media_probe` 的 `reason` 会是 `no-cuda-device`，`device: cpu`、`computeType: int8`；
- 转录、抽帧、链接下载全部照常工作。

**确认**：

```powershell
python -c "import ctranslate2; print('cuda count:', ctranslate2.get_cuda_device_count())"
# 期望 cuda count: 0（这是正常结果，不是错误）
```

---

## 4. 获取插件源码并构建

```powershell
git clone https://github.com/reamerit/dsh-media-understanding.git
cd dsh-media-understanding

npm install          # typescript + tsdown
node scripts/setup-dsh-deps.mjs   # 把宿主闭包 junction 进 node_modules（供类型解析）
npm run build        # tsdown 打包 + tsc 出 lib/types
npm test             # 69 项契约与回归测试
```

**确认**：

- `lib/index.js` 存在（这是 `package.json` 的入口，**缺了安装必失败**）；
- `lib/types/` 存在（尽力而为：没有宿主闭包的机器上会跳过，不影响运行）；
- `npm test` 全绿；
- 文件体积自检：`lib/index.js` 里 `TOOL_RUNTIME_SCHEDULER` 出现次数必须是 **0**（打包把 `@deepseek-ai/*` 内联了就会得到第二份模块副本，工具调度会崩）：

```powershell
(Select-String -Path lib\index.js -Pattern 'TOOL_RUNTIME_SCHEDULER' -AllMatches).Matches.Count   # 期望 0
```

### 部署到仓库树外（从源码安装时必做）

⚠️ 仓库内的 `node_modules/@deepseek-ai` 是**开发副本**。若让插件从仓库里被解析，会与宿主成为两份模块实例 → 工具调度崩溃。因此部署目录必须**在仓库树之外**：

```powershell
node scripts/deploy.mjs
# 产出 C:\workspace\github\_deploy\dsh-media-understanding（lib/ + src/workers/ + 指向宿主闭包的 junction）
```

若脚本报"找不到 pnpm store"，先指定宿主闭包位置：

```powershell
$env:DSH_HOST_SCOPE = "$env:USERPROFILE\deepseek-harness\node_modules\.pnpm"
node scripts/deploy.mjs
```

**确认**：输出末尾的 5 项检查（`dsh-tools` / `dsh-jobs` / `dsh-llm` / `schemastery` / `cordis`）都必须是 `ok`。

---

## 5. 安装插件到 DSH

`dsh plugin add` 会同时把这个包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，无需手改文件。

```powershell
# 方式 A：本地构建产物（第 4 步刚部署的目录）
dsh plugin --profile web add "dsh-media-understanding@link:C:\workspace\github\_deploy\dsh-media-understanding"

# 方式 B：直接从 git 源安装（包自带 prepare 钩子，会在安装期用 tsdown 打出 lib/index.js）
dsh plugin --profile web add "dsh-media-understanding@github:reamerit/dsh-media-understanding"

# 方式 C：npm（尚未发布到 npm，发布后可用）
dsh plugin --profile web add dsh-media-understanding
```

> **尚未发布到 npm**。所以现在只有方式 A / B 可用。方式 B 依赖安装期构建：`lib/` 在 `.gitignore` 里、不进仓库，`scripts/prepare.mjs` 会在安装时补上入口产物；入口缺失会让插件市场判为 broken、下次启动组装不出组合包（prepare 因此把 `lib/index.js` 当硬指标，缺了就让安装失败）。

**确认**：`$env:USERPROFILE\.dsh\profiles\web\package.json` 的 `dependencies` 里有 `dsh-media-understanding`，且 `dsh.profile.bundles` 数组里也有同名条目。

**然后重启 `dsh web`**：宿主半插件的代码改动一律要重启才生效（不是刷新页面）。

---

## 6. 配置（🔵⚪ 不同之处在这里）

配置写进 profile 的 `cordis.patch.yml`（本机路径 `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`），插件自带一份默认 patch（`cordis.patch.yml` 在包根），可覆盖如下：

```yaml
- insert:
    - id: media-understanding
      name: dsh-media-understanding
      config:
        whisper:
          model: small        # tiny|base|small|medium|large-v3
          device: auto        # 🔵⚪ 关键项：auto = 有卡用 CUDA，无卡自动落 CPU
          computeType: auto   # 按设备取可用档：GPU int8_float32 / CPU int8
          # pythonPath: C:\…\Python314\python.EXE   # 自动探测不到时手写
          # localFilesOnly: true                    # 完全离线（需模型已缓存）
        frames:
          threshold: 0.3      # 场景变化灵敏度
          maxFrames: 16       # 单次抽帧上限（留余量：imageLimits.maxImagesPerMessage 默认 20）
```

🔵 **有卡**：保持 `device: auto` 即可自动用卡。想强制不走卡时显式写 `device: cpu`。
⚠️ **无卡**：**不要**写 `device: cuda`——那是唯一会在无卡机器上直接报错的取值（`transcribe_audio` 会抛 `cuda-unavailable`）。留 `auto` 即自动落 CPU。

**vision 路由**：`video_frames` 的"真图"分支要求当前模型路由声明图片输入（profile 的路由 entry 带 `input: [text, image]`）。未声明时 DSH 的 pi-ai 适配器会**硬失败**（`UNSUPPORTED_CONTENT`，整轮对话失败）。插件侧有防御性门控：检测到路由不支持图片时自动降级为 `mode: text-only`（只给帧路径 + 时间戳），不会让对话失败。

**模型缓存**：默认从 HuggingFace hub 缓存目录取（`HF_HOME\hub` 或 `~\.cache\huggingface\hub`）。首次使用某个规格时会联网下载，之后可离线加载；要完全离线就预置模型并设 `localFilesOnly: true`。

---

## 7. 验收：跑 `media_probe`

新开一个会话，调用 `media_probe`。

**🔵 有卡时期望**：

```jsonc
{ "ok": true, "device": "cuda", "computeType": "int8_float32", "reason": "cuda-available",
  "fasterWhisper": { "ready": true, "version": "1.2.1" }, "problems": [] }
```

**⚪ 无卡时期望**：

```jsonc
{ "ok": true, "device": "cpu", "computeType": "int8", "reason": "no-cuda-device",
  "fasterWhisper": { "ready": true, "version": "1.2.1" }, "problems": [] }
```

`reason` 的全部取值与含义：

| `reason` | 含义 |
| --- | --- |
| `cuda-available` | 用卡（🔵 正常） |
| `no-cuda-device` | 没有可用 CUDA 设备，落 CPU（⚪ 正常） |
| `cuda-count-failed` | `get_cuda_device_count()` 抛错（驱动/运行库层面拿不到） |
| `cuda-probe-failed` | CUDA 计算档探测失败 |
| `unsupported-compute-type` | 当前设备没有可用计算档 |
| `configured` | 配置里显式指定了 `device` |

然后跑一次真实转录与抽帧（用一个短视频）：

```text
transcribe_audio({ file_path: "C:\\path\\clip.mp4" })   → 记下 jobId，再 job_output 读正文
video_frames({ file_path: "C:\\path\\clip.mp4", max_frames: 4 })
```

期望：转录正文头部形如 `# transcript (zh, 12.9s, 1 segments, cuda/int8_float32)`；抽帧得到**真图**并使 `timestampSource: exact`。

---

## 8. 故障排查

| 现象 | 结论 / 处理 |
| --- | --- |
| `pip install faster-whisper` 装不上 | Python 是 3.15 或过新/过旧 → 换 **3.14** |
| 推理必崩 `TypeError: … 'metadata_errors'` | `av>=19` → `python -m pip install "av<19"` |
| python 子进程无输出、直接 `0xC0000005` 退出 | VC++ 运行时过旧 → 装 2015-2022 x64 可再发行组件 |
| `Library cublas64_12.dll is not found or cannot be loaded`（🔵） | CUDA 12.x 运行库缺失或不在 PATH → 见 3.4 |
| `Could not locate cudnn_ops64_9.dll` 一类（🔵） | cuDNN 9 缺失；ctranslate2 wheel 自带 `cudnn64_9.dll`，若被外部旧 cuDNN 抢先加载，检查 PATH 里是否有旧 cuDNN 目录 |
| `cuda driver version is insufficient`（🔵） | 驱动过旧 → 升级驱动；算力 6.x 的卡止于 CUDA 12 / R580 分支 |
| 报 `mkl_malloc` / 内存不足 | 内存不够 → 换更小的 `whisper.model`（`small` → `base` → `tiny`） |
| 平台上 `device: cuda` 但期望 CPU | 配置里显式写了 `cuda`；无卡或想省显存时改 `auto` 或 `cpu` |
| `reason: model-lacks-image-input` | 当前路由没声明图片输入 → 帧以路径 + 时间戳返回；在路由 entry 加 `input: [text, image]` 后用真图 |
| `reason: no-scene-change` | 纯色/动画视频无场景切换 → 改用 `strategy: "fps"` |
| `reason: download-tool-missing` | 平台页面链接需要 yt-dlp → `python -m pip install yt-dlp`（直链与本地文件不受影响） |
| `reason: unsupported-url` | 只支持 http(s) 链接与本地路径（`ftp://` 等会明确拒绝） |
| 工具调度崩溃 / 报 `TOOL_RUNTIME_SCHEDULER` | 打包内联了宿主包 → 重新 `npm run build` 并用 `scripts/deploy.mjs` **部署到仓库树外**（仓库内的 `node_modules/@deepseek-ai` 是开发副本） |
| 插件市场判 broken / 启动组装不出组合包 | `lib/index.js` 缺失 → 从 git 源安装时确认安装期 prepare 构建成功 |
| 改代码后不生效 | 宿主半插件改动**必须重启 `dsh web`**（刷新页面不够） |
| `incompatible-version` 拒绝装载 | DSH 运行时 < `0.2.0-rc.2` → 升级 DSH |

更多设计取舍与实测细节见 [`README.md`](README.md)、[`docs/coding-plan.md`](docs/coding-plan.md)、[`docs/coding-plan-review.md`](docs/coding-plan-review.md)。
