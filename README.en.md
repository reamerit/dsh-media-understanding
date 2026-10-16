<p align="center">
  <strong style="font-size: 2.2em">🎬 DSH Media Understanding</strong><br>
  <span style="font-size: 1.1em">A DeepSeek Harness host-side plugin · local audio/video → timestamped transcript + timestamped real keyframes · fully offline, no API key</span>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.md">🌐 中文</a>
</p>

> **Status: design phase (not yet released).** This repository currently holds only design docs — there is no `src/` and no `package.json` yet, so the *Install* and *Configuration* sections below record the **contracts verified on the development machine**, not features you can use today. For implementation progress and phase acceptance criteria see [`docs/coding-plan.md`](docs/coding-plan.md) §4.

---

## ✨ What it is

A DSH plugin that hands local media to the model. It registers two tools:

| Tool | Direction | Shape |
| --- | --- | --- |
| `transcribe_audio` | audio/video → timestamped transcript | **Background job**: returns a `jobId` immediately; read the text with `job_output` |
| `video_frames` | video → timestamped **real** keyframes | **Synchronous**: frames are persisted to the attachment service inside `execute` and inlined with the tool result |

The model then fuses "what was said" with "what was on screen" on its own — the plugin only gathers evidence, it does not summarise. Every dependency is deliberately local: `ffmpeg` for audio extraction and frame sampling, `faster-whisper` for transcription, no cloud API anywhere.

## 🎯 Core features

| Feature | Description |
| --- | --- |
| 🎙️ **Local transcription** | `faster-whisper` on CPU `int8`; model sizes `tiny`/`base`/`small`/`medium`/`large-v3`; optional language and "translate to English" |
| 🖼️ **Real keyframe images** | ffmpeg scene-change sampling → JPEG persisted via `ctx.attachments.saveImages()` → enters model context as **actual image blocks**, not paths and not prose descriptions |
| ⏱️ **Timestamp alignment** | `metadata=mode=print` prints `pts_time` for the selected frames, **1:1 with the output files** (`-fps_mode vfr`, valid on ffmpeg 5.1+); when parsing fails the output honestly marks `timestampSource: 'estimated'` instead of faking precision |
| 🚦 **Vision capability gate** | Before emitting image blocks the tool checks `inputModalities` via `ctx.llm.resolveModelInfo()`; when the route does not declare `image` it returns **frame paths + timestamps only** with `reason: 'model-lacks-image-input'`, so the next turn never fails with `UNSUPPORTED_CONTENT` |
| ⏳ **Long audio never blocks** | Runs as a `ctx.jobs` background job (`small` ≈ 3.2× realtime, so a 1-hour recording takes ~20 minutes; `large-v3` ≈ 0.7×, so ~1.4 hours); watch progress with `job_output`, stop it with `job_kill` |
| 🧯 **Errors classified honestly** | Missing ffmpeg / missing python deps / **missing MSVC runtime (`0xC0000005`, no output)** / **out of memory (`mkl_malloc`)** / no audio track / no scene change / model cannot see images — each reported as its own conclusion |
| 🔌 **No key, no network requirement** | Models load offline (`local_files_only`); subprocesses go through the managed `ctx.subprocess` seam (executable resolution, process-group kill, bounded output collection with spill-to-disk) |

## 🧱 Requirements (measured on the dev machine)

| Item | Requirement | Why |
| --- | --- | --- |
| ffmpeg / ffprobe | **6.0+** (6.0 verified) | Audio extraction, frame sampling, stream probing |
| Python | **3.14** (3.14.8 verified) | ⚠️ 3.15 has no `ctranslate2`/`onnxruntime` wheels, so faster-whisper cannot be installed |
| faster-whisper | `1.2.1` | Local transcription engine |
| PyAV | **`av<19`** (18.1.0 verified) | ⚠️ Hard requirement: `av>=19` removed the `metadata_errors` argument from `av.open()`, which faster-whisper 1.2.1 still passes → inference always crashes with `TypeError: open() got an unexpected keyword argument 'metadata_errors'` |
| VC++ runtime | 2015-2022 redistributable (`MSVCP140.dll` ≥ 14.40) | ⚠️ An older DLL makes `ctranslate2`/`onnxruntime` **crash hard with `0xC0000005`: no traceback, no output** — the symptom is "the python subprocess silently vanished" |
| Hardware | **CPU required, GPU optional**; ≥ 8 GB RAM recommended | With no NVIDIA card/driver it silently uses CPU (`device: auto` → `cpu`) — **a GPU-less machine is a first-class citizen, not a degraded special case**. Verified here: 8 cores / 64 GB / NVIDIA Tesla P40 24 GB (KVM passthrough) |
| DSH | runtime **≥ `0.2.0-rc.2`** | Compatibility is decided solely by peerDependencies vs. the runtime version; a mismatch is rejected as `incompatible-version` |
| GPU driver (optional) | An NVIDIA driver whose INF still lists the card | ⚠️ On Windows, Pascal support ends **before** the R580 branch NVIDIA's docs claim: measured `596.86` (R595) and `616.92` (R615) contain **no `DEV_1B38`** in any INF, while `536.25`/`537.36`/`538.33` do. Check the INF before upgrading ([§9.4.2](docs/coding-plan-review.md)) |
| Vision route | The default model declares `input: [text, image]` | See *Configuration*; without it the plugin degrades automatically rather than failing the conversation |

Whisper sizes and measured speed (`beam_size=5` + VAD). The Chinese sample is 24.08 s and the English one 8.04 s, both **synthesised speech with a known script**, so accuracy comes free with the timings:

**CPU** (8 cores, `int8`):

| Model | Load | Chinese 24 s | vs. realtime | English 8 s | vs. realtime | Chinese CER | English WER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tiny` | 1.70 s | 1.87 s | 12.89× | 0.87 s | 9.28× | 7.2% | 5.9% |
| `base` | 1.23 s | 2.77 s | 8.68× | 1.51 s | 5.34× | 8.4% | 5.9% |
| **`small` (default)** | 2.80 s | 7.58 s | **3.18×** | 3.88 s | 2.07× | 6.0% | 5.9% |
| `medium` | 6.18 s | 21.08 s | 1.14× | 11.49 s | 0.70× | 6.0% | 5.9% |
| `large-v3` | 11.02 s | 33.85 s | 0.71× | 19.84 s | 0.41× | **4.8%** | 5.9% |

**GPU** (NVIDIA Tesla P40 24 GB, `cuda` + `int8_float32`):

| Model | Load | Chinese 24 s | vs. realtime | English 8 s | vs. realtime | vs. CPU |
| --- | --- | --- | --- | --- | --- | --- |
| **`small`** | 2.10 s | **0.96 s** | **25.06×** | 0.36 s | 22.42× | **7.9×** |
| `medium` | 4.84 s | **1.92 s** | **12.53×** | 0.68 s | 11.83× | 11× |
| `large-v3` | 10.26 s | **5.30 s** | **4.55×** | 1.03 s | 7.81× | 6.4× |

**How to read it**:

- **`large-v3` only becomes practical with a GPU**: **4.55× realtime** on the GPU (a 1-hour recording takes ~13 minutes) versus 0.71× on CPU (~85 minutes). The default therefore stays "resolve the device at runtime": **a GPU is picked up automatically**, and a machine without one falls back to CPU — both work.
- **The GPU does not change accuracy**: on the same samples CPU `int8` and GPU `int8_float32` produce **character-for-character identical** output; `large-v3` still leads on Chinese at 4.8% CER, 1.2 points better than `small`.
- ⚠️ **`float16` is unusable here**: the P40 is GP102, whose FP16 throughput is 1/64 of FP32, so CTranslate2 refuses it outright (`ValueError: ... do not support efficient float16 computation`). Measured sets: `cuda → {float32, int8, int8_float32}`, `cpu → {float32, int16, int8, int8_float32}` — which is exactly why `computeType` must be `auto` rather than hard-coded.
- On English all five models differ only in number formatting (`three`→`3`, `eight`→`8`), so accuracy cannot separate them.
- All five models (4.97 GB of blobs) are cached locally and load offline. Full data and samples: [`docs/coding-plan-review.md`](docs/coding-plan-review.md) §9.4.1 and §9.4.2.

## 🎛️ Execution device: use the GPU when there is one, still runs without it

The transcription device is never hard-coded — it is resolved at startup/call time:

| Key | Default | How it resolves |
| --- | --- | --- |
| `whisper.device` | `auto` | `cuda → cpu`: an enumerable CUDA device means GPU, otherwise it falls back to CPU silently |
| `whisper.computeType` | `auto` | Picks a supported type via `ctranslate2.get_supported_compute_types(device)`: here **GPU → `int8_float32`**, **CPU → `int8`**; ⚠️ `float16` is refused outright on the P40, so it is never hard-coded |

**A machine without a GPU is a first-class citizen**: with no NVIDIA driver, no working passthrough, or the card held by another VM, `get_cuda_device_count() == 0` ⇒ `cpu` + `int8`, with behaviour **identical** to the GPU path, just slower. **No CUDA probe failure ever throws** — it is only recorded as a reason.

`media_probe` reports all of this, so you can always tell what was used and why:

```jsonc
{
  "device": "cpu",                    // effectively used
  "deviceSource": "auto",             // config / auto
  "reason": "no-cuda-driver",         // why it degraded; null when the GPU is in use
  "gpu": null                         // model/VRAM/driver version when present, else null
}
```

The probe is not "device visible means usable": it actually **constructs a model or runs a very short inference** on the selected device, because "`import` succeeds but the first inference crashes" has already happened for real in this project (see the VC++ runtime row above).

## 📦 Install

> Follow this once the package exists; there is nothing installable in this repo yet.

1. **Install the native prerequisites** (table above): ffmpeg, Python 3.14, `pip install "faster-whisper==1.2.1" "av<19"`, and the VC++ 2015-2022 redistributable.
2. **Install the plugin**: keep the repository outside the workspace tree and link it into the profile (this avoids the repo's own `node_modules/@deepseek-ai/*` winning module resolution at runtime and becoming a second instance of the host modules):

       # ~/.dsh/profiles/web/package.json
       "dsh-media-understanding": "link:C:\\workspace\\github\\dsh-media-understanding"

   Add the package name to that profile's `bundles` array, then run `pnpm install` in that directory.
3. **Restart `dsh web`**: host-side plugin code only takes effect after a restart.
4. **Confirm the tools exist**: in a new session the model should be able to list and call `media_probe` (the availability probe) — that is the Phase 1 acceptance step.

## ⚙️ Configuration

These are the target defaults of the `Config` schema (written into the `config` section of `cordis.patch.yml`):

```yaml
- insert:
    - id: media-understanding
      name: dsh-media-understanding
      config:
        whisper: { model: small, device: auto }   # device: auto → CUDA when present, CPU otherwise
        frames: { threshold: 0.3, maxFrames: 16 }
```

| Key | Default | Notes |
| --- | --- | --- |
| `whisper.pythonPath` | auto-detected (3.14.8 here) | Interpreter path; the probe **actually runs `import faster_whisper`** rather than trusting the path |
| `whisper.model` | `small` | See the speed table above; `large-v3` is the most accurate (4.8% Chinese CER) — 4.55× realtime with a GPU, 0.71× without |
| `whisper.device` | `auto` | **`cuda → cpu` auto-resolution**; silently uses CPU with no NVIDIA driver/passthrough. `cuda` necessarily fails on a GPU-less machine |
| `whisper.computeType` | `auto` | Picks a supported type per device: here **GPU → `int8_float32`**, **CPU → `int8`**; ⚠️ `float16` is refused outright on the P40, so it is never hard-coded |
| `whisper.modelCacheDir` | system cache (HF hub) | Pre-seed models here for fully offline use |
| `whisper.localFilesOnly` | `false` | `true` uses only already-downloaded models |
| `whisper.timeoutMs` | covers download + long audio | Subprocess budget, implemented with `signal` (`SubprocessSpawnSpec` has no `timeoutMs`) |
| `transcribe.jobOutputLimitBytes` | `262144` | Model-facing byte cap for the job (bounds both output reads and the completion notice) |
| `transcribe.maxSegments` | `5000` | Beyond this the result is truncated and flagged `truncated: true` |
| `frames.threshold` | `0.3` | Scene-change sensitivity |
| `frames.maxFrames` | `16` | Per-call frame cap; `imageLimits.maxImagesPerMessage` defaults to 20, so this leaves headroom |
| `frames.jpegQuality` | `3` | ffmpeg `-q:v`, lower is sharper and bigger |
| `frames.maxWidth` | `1280` | Takes the smaller of this and `attachments.imageLimits` |
| `ffmpeg.path` / `ffprobe.path` | auto-resolved | Overridable |
| `workDir` | `os.tmpdir()` + `mkdtempSync` | Scratch location, cleaned up in `finally` |

**Vision route**: the real-image branch requires the current route to declare image input. DSH's pi-ai adapter **hard-fails** when the model does not declare `image` (`UNSUPPORTED_CONTENT` — the whole turn fails, there is no fallback). Declare it as `input: [text, image]` on the profile's route entry; to roll back, delete that line. The plugin-side gate is a defensive check rather than a one-time fix — it degrades to text mode automatically on routes that do not declare images (`ollama`/`glm`/`qianwenai`, etc.).

## 🔧 Tool contracts

### `transcribe_audio`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `file_path` | string | ✅ | Path to a local audio/video file |
| `language` | string | | Source language (e.g. `zh`, `en`); auto-detected when omitted |
| `translate_to_english` | boolean | | Transcribe and translate into English |
| `backend` | enum | | Only `whisper-local` today |

Returns a job handle immediately:

```jsonc
{
  "jobId": "transcribe-1",
  "status": "running",
  "backend": "whisper-local",
  "model": "small",
  "note": "read the transcript with job_output",
  "reason": "no-audio-track"   // given when the pre-check already finds no audio; no job is started
}
```

The text read back via `job_output` has the shape `{ text, language, durationSec, segments: [{ start, end, text }], backend, truncated, reason? }`.

### `video_frames`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `file_path` | string | — | Path to a local video file (required) |
| `threshold` | number | `0.3` | Scene-change sensitivity |
| `max_frames` | number | `16` | Frame cap |
| `strategy` | enum | `scene` | `scene` for scene changes / `fps` for fixed sampling |
| `fps` | number | — | Used when `strategy=fps` |

Canonical output (always present):

```jsonc
{
  "frames": [{ "index": 0, "timestampSec": 4.2, "attachmentId": "…", "width": 1280, "height": 720, "path": "…" }],
  "strategy": "scene",
  "timestampSource": "exact",          // "estimated" when parsing failed
  "mode": "images",                    // or "text-only"
  "reason": "model-lacks-image-input"  // also "no-scene-change" / "no-video-stream"
}
```

**Degradation semantics (important)**: with `mode: 'text-only'` the tool returns temporary frame paths plus timestamps and **emits no image blocks**, so later turns cannot fail because the route lacks image support. A solid-colour or animated video returns `frames: []` with `reason: 'no-scene-change'`; retry with `strategy: 'fps'` in that case.

**Design boundary**: infrastructure failures (missing ffmpeg, missing file) **throw**; non-ideal business outcomes (no audio track, no scene change, model cannot see images) **return a canonical value plus `reason`**. The tool does not confine `file_path` to the workspace — that is a documented boundary.

## 💡 Usage

> A typical session once the implementation lands (illustrative):

```text
User:  What does meeting.mp4 cover, and what is on screen at 12s?
Model: → transcribe_audio({ file_path: "…\\meeting.mp4", language: "en" })
       ← { jobId: "transcribe-1", status: "running", … }
Model: → job_output({ job_id: "transcribe-1" })
       ← [00:00.0 → 00:04.2] Hi everyone, three items today…
Model: → video_frames({ file_path: "…\\meeting.mp4", max_frames: 12 })
       ← 12 timestamped real images (including the 12.4 s one)
Model: It covers the release schedule, risks and ownership; at 12 s the slide is titled "Q3 Roadmap".
```

## 📁 Package layout

```text
dsh-media-understanding/
├── src/
│   ├── index.ts               # entry: name / inject / apply(ctx) / Config schema
│   ├── globals.d.ts           # empty type imports that activate official module augmentation (no runtime deps)
│   ├── tools/                 # the transcribe_audio and video_frames tool definitions
│   ├── media/                 # ffmpeg wrapper, whisper invocation, attachment persistence, error classification
│   └── workers/transcribe.py  # faster-whisper worker (stdlib + faster_whisper)
├── test/                      # contract tests (arg validation, render purity, degradation branches, timestamp parsing)
├── docs/                      # design record (coding-plan.md) and review report (coding-plan-review.md)
├── cordis.patch.yml           # mounts this package as a host-side plugin
└── README.md / README.en.md   # Chinese (default) / English
```

Build and local-development conclusions are copied from the production host-side plugin in this workspace (`dsh-mcp-skill-panel`); the essentials:

- **Packaging rule**: `tsdown` must treat `@deepseek-ai/*` and `node:*` as external — inlining them yields a second copy of the modules and duplicate `Symbol`s, which crashes tool dispatch.
- Type declarations are emitted by `tsc` into `lib/types/`; `tsconfig` uses `paths` to map the DSH packages actually imported onto the host closure.
- Local types come from a script that junctions the host `.pnpm` closure into `<repo>/node_modules/@deepseek-ai` (`mklink /J` needs no admin rights on Windows).
- With multiple entries, set `outputOptions.entryFileNames` explicitly (identical basenames overwrite each other).

## ⚠️ Known limitations

- Embedded subtitle tracks are not parsed (a future option: prefer subtitles, fall back to Whisper).
- No remote URLs — local files only.
- The per-call frame cap is bounded by `imageLimits.maxImagesPerMessage` (20 by default); the default is 16 to leave headroom, and frames consume significant context.
- `strategy: 'scene'` never emits the first frame (`select` is always false for frame 0); sample `t=0` separately when needed.
- Timestamps are **estimates** when parsing fails, and the output says so.

## 📚 Documentation

- [`docs/coding-plan.md`](docs/coding-plan.md) — design, tool contracts, configuration, package layout, phased implementation and risk register. **Read it before touching contracts, DSH API calls, or the package layout.**
- [`docs/coding-plan-review.md`](docs/coding-plan-review.md) — review conclusions, the measured environment, and blocker corrections. **Read it when wiring up a profile, when something does not run, or when you suspect a DSH version difference.**

## 📄 License

[Apache-2.0](LICENSE).
