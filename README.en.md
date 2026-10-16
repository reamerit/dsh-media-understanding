<p align="center">
  <strong style="font-size: 2.2em">🎬 DSH Media Understanding</strong><br>
  <span style="font-size: 1.1em">A DeepSeek Harness host-side plugin · local audio/video → timestamped transcript + timestamped real keyframes · fully offline, no API key</span>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.md">🌐 中文</a>
</p>

> **Status: implemented and verified on this machine (2026-10-16).** All three tools have been exercised end to end inside a real DSH host: `media_probe` reports `device: cuda` / `int8_float32`; `transcribe_audio` produces timestamped transcripts of real speech as a job read back with `job_output`; `video_frames` returns real images **the model can actually see**; direct links are downloaded before processing. `test/` holds **69 passing tests**. **Not yet published to npm** — install as below (the local setup uses a link plus a restart).
>
> Deviations from the original design doc are noted and fixed in the code. One deserves a specific warning: **the timestamp printer must be ffmpeg's `showinfo`, not the `metadata=mode=print` the design doc specified** — measured on ffmpeg 6.0 here, the latter emits no `pts_time` at all, which silently degrades every timestamp to an fps-based estimate.

---

## ✨ What it is

A DSH plugin that hands local media **or a video link** to the model. It registers three tools:

| Tool | Direction | Shape |
| --- | --- | --- |
| `media_probe` | Environment check: can it transcribe, on which device, and why | **read-only, synchronous** |
| `transcribe_audio` | audio/video → timestamped transcript | **background job**: returns a `jobId` immediately; read the text with `job_output` |
| `video_frames` | video → timestamped **real** keyframes | **synchronous**: frames are persisted to the attachment service inside `execute` and inlined with the tool result |

Input is always "one piece of media":

- **a local absolute path** — including a video dropped into the GUI composer: the host stores uploads under
  `<DSH_HOME>\attachments\v1\files\…` and renders that path into model-visible text, so the model simply passes it as `file_path`;
- **an http(s) link** — direct media URLs go through ffmpeg, platform pages (YouTube / Bilibili, etc.)
  are downloaded first with **yt-dlp**.

The "task requirement" (e.g. "summarise what was said", "what text is on screen at 12s?") is interpreted by the **model** into those tool calls; the plugin deliberately exposes no `task` parameter — one less layer of paraphrase.

Every dependency is deliberately local: `ffmpeg` for audio extraction and frame sampling, `faster-whisper` for transcription, `yt-dlp` for downloads — no cloud API key anywhere.

## 🎯 Core features

| Feature | Description |
| --- | --- |
| 🎙️ **Local transcription** | `faster-whisper` on CPU `int8`; model sizes `tiny`/`base`/`small`/`medium`/`large-v3`; optional language and "translate to English" |
| 🖼️ **Real keyframe images** | ffmpeg scene-change sampling → JPEG persisted via `ctx.attachments.saveImages()` → enters model context as **actual image blocks**, not paths and not prose descriptions |
| ⏱️ **Timestamp alignment** | ffmpeg's **`showinfo`** prints `pts_time` per frame (`n: <index> pts_time:<sec>`), **1:1 with the output files** (`-fps_mode vfr`, valid on ffmpeg 5.1+). ⚠️ **`metadata=mode=print` must not be used**: measured on ffmpeg 6.0 here it emits no `pts_time`, silently degrading timestamps to an fps-based estimate. When parsing fails the output honestly marks `timestampSource: 'estimated'` instead of faking precision |
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

`media_probe` reports all of this, so you can always tell what was used and why (real output shape; this shows the **CPU-degraded** case):

```jsonc
{
  "device": "cpu",                    // effectively used
  "deviceSource": "auto",             // config / auto
  "reason": "no-cuda-device",         // see the value list below; "cuda-available" when the GPU is in use
  "computeType": "int8",
  "gpu": {                            // present only when a card is visible
    "name": "Tesla P40",
    "memoryMiB": 23040,
    "driverVersion": "573.76",
    "computeCapability": "6.1"
  },
  "problems": []                      // human-readable list of things needing attention
}
```

Every `reason` value: `cuda-available` (GPU in use), `no-cuda-device`, `cuda-count-failed`, `cuda-probe-failed`, `unsupported-compute-type`, `configured` (when `device` was set explicitly).

The probe is not "device visible means usable": it actually **constructs a native object or runs a very short inference** on the selected device, because "`import` succeeds but the first inference crashes" has already happened for real in this project (see the VC++ runtime row above).

## 📦 Install

1. **Install the native prerequisites** (table above): ffmpeg, Python 3.14, `pip install "faster-whisper==1.2.1" "av<19" yt-dlp`, and the VC++ 2015-2022 redistributable.
2. **Build**:

       npm install                        # typescript + tsdown
       node scripts/setup-dsh-deps.mjs    # junction the host closure into node_modules (for type resolution)
       npm run build                      # tsdown bundle + tsc declarations
       npm test                           # 69 contract & regression tests

3. **Deploy outside the repository tree** (important: the repo's own `node_modules/@deepseek-ai` is a *development* copy; if the plugin resolves from the repo it becomes a second instance of the host modules and tool dispatch breaks):

       node scripts/deploy.mjs
       # produces <workspace>\_deploy\dsh-media-understanding
       #   (lib/ + src/workers/ + junctions pointing at the host closure)

4. **Link into the profile and restart `dsh web`**:

       dsh plugin --profile web add "dsh-media-understanding@link:C:\\workspace\\github\\_deploy\\dsh-media-understanding"
       # this writes both the dependency and the profile's bundles entry; then restart dsh web
       # (host-side plugin code only takes effect after a restart)

5. **Confirm**: call `media_probe` in a new session. Expected here:
   `device: cuda` / `computeType: int8_float32` / `fasterWhisper.ready: true` / `problems: []`.
   If it lands on `cpu`, `reason` tells you why (`no-cuda-device` / `cuda-count-failed` / `cuda-probe-failed`).

## ✅ Verified behaviour (measured on this machine)

| Scenario | Result |
| --- | --- |
| `media_probe` | `device: cuda`, `int8_float32`, `reason: cuda-available`, 5 models cached, `problems: []` |
| Speech video transcription | Job starts; `job_output` returns a timestamped transcript; device `cuda/int8_float32` |
| Scene frame sampling | `blocks.mp4` → 2 real images, `timestampSource: exact`, timestamps 4.0 s / 6.0 s; **the model could see and describe them** |
| `strategy: fps` | 10 s clip at 1 fps → 3 frames, `timestampSource: exact`, 0.0/1.0/2.0 s |
| No scene change | Returns `mode: text-only` + `reason: no-scene-change` and suggests `fps` |
| Direct mp4 link | download → sample → real images returned; the model described the picture correctly |
| Dead link | Returns `download-failed` (not a generic failure) |
| Wrong worker-script path | **Fails loudly** instead of masquerading as "this machine lacks the dependency" |

## ⏱️ Timeouts and cancellation (Phase 4, measured)

**Tool timeouts follow what the *tool* does, not how long the *job* runs**:

| Tool | `timeoutMs` | Rationale |
| --- | --- | --- |
| `media_probe` | 180 s | probe + executable resolution only; headroom for a cold Python start |
| `transcribe_audio` | **120 s** | it only **pre-validates and starts a job**, then returns ⇒ short. **The job itself is not bounded by the tool timeout** — that is the payoff of using jobs |
| `video_frames` | 600 s | synchronous sampling + attachment persistence, minutes |

**Cancellation (`job_kill`), measured** — start a job on 6 minutes of audio, then kill it immediately:

```
transcribe-1 [transcribe] killed — transcribe long6min.wav (small on cpu)
[status: killed, cancelled; cancellation test]
```

- the terminal state is **`killed`**, not `failed` — cancellation is **distinguishable** from a real failure in `job_list`, which is what tells you whether a retry is worth it;
- the reason passed to `job_kill` surfaces in the terminal state;
- **zero orphaned `python`/`ffmpeg` processes** after cancellation (measured with `Get-Process`), and temporary artefacts are removed in `finally`.

`exec.signal` is threaded end to end: `execute` → pre-flight probing/download → `ctx.subprocess.spawn({ signal })` inside the job; session interruption and `job_kill` both drive the same `AbortController`.

## 🧯 Error matrix (Phase 4, measured)

| Scenario | Behaviour |
| --- | --- |
| Input has no audio track | `status: not-started` + `reason: no-audio-track`, **no job is started**, with an explanation |
| Local file does not exist | **throws** (infrastructure failure) with the concrete path in the message |
| Unsupported scheme (`ftp://`, …) | `status: not-started` + `reason: unsupported-url`; only http(s) and local paths are accepted |
| Dead link / 404 | `reason: download-failed` (not a generic "unknown reason") |
| No scene change | `mode: text-only` + `reason: no-scene-change`, suggesting `strategy: fps` |
| Model cannot accept images | `mode: text-only` + `reason: model-lacks-image-input`; frames come back as paths + timestamps and **no image blocks are emitted** (so the next turn never fails with `UNSUPPORTED_CONTENT`) |
| Missing ffmpeg / python deps / av≥19 / out of memory | Each has its own classification and remedy (`src/pure/errors.ts`) |
| Wrong worker-script path | **fails immediately** naming the path, instead of pretending the machine lacks the dependency |

**Semantics**: infrastructure failures (missing ffmpeg, missing file) **throw**; non-ideal business outcomes (no audio track, no scene change, model cannot see images, link not downloadable) **return a canonical value plus `reason`**.

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
| `download.ytDlpPath` | `python -m yt_dlp` | Overridable yt-dlp executable |
| `download.timeoutMs` | 30 min | Download budget for a single link |
| `ffmpeg.path` / `ffprobe.path` | auto-resolved | Overridable (via `ctx.subprocess.resolveExecutable`) |

Scratch files land in per-operation `mkdtemp` directories under `os.tmpdir()` (one each for audio extraction, frame sampling, and downloads) and are all cleaned up in `finally`; the worker's spill files are deleted explicitly by the plugin.

**Vision route**: the real-image branch requires the current route to declare image input. DSH's pi-ai adapter **hard-fails** when the model does not declare `image` (`UNSUPPORTED_CONTENT` — the whole turn fails, there is no fallback). Declare it as `input: [text, image]` on the profile's route entry; to roll back, delete that line. The plugin-side gate is a defensive check rather than a one-time fix — it degrades to text mode automatically on routes that do not declare images (`ollama`/`glm`/`qianwenai`, etc.).

## 🔧 Tool contracts

### `transcribe_audio`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `file_path` | string | ✅ | **A local absolute path** (including a GUI upload stored at `~/.dsh/attachments/v1/files/…`) **or an http(s) link** (direct media via ffmpeg; platform pages via yt-dlp) |
| `language` | string | | Source language (e.g. `zh`, `en`); auto-detected when omitted |
| `translate_to_english` | boolean | | Transcribe and translate into English |
| `backend` | enum | | Only `whisper-local` today |

`status` has two shapes (`jobId` is non-empty only in the first):

```jsonc
// a job was started: read the text with job_output
{
  "jobId": "transcribe-1",
  "status": "running",
  "backend": "whisper-local",
  "model": "small",
  "device": "cuda",
  "source": "local",
  "note": "the transcript is streamed into the job output; read it with job_output …"
}

// no job was started (the pre-check already reached a conclusion): jobId is empty, status is not-started
{
  "jobId": "",
  "status": "not-started",
  "backend": "whisper-local",
  "model": "small",
  "device": "n/a",
  "source": "local",
  "note": "the input has no audio track, so there is nothing to transcribe",
  "reason": "no-audio-track"   // also "unsupported-url" / "download-failed"
}
```

What the model actually sees (the structured fields are always rendered — never just a sentence):

```text
transcription started as job transcribe-1
status: running | jobId: transcribe-1 | model: small | device: cuda | source: local
the transcript is streamed into the job output; read it with job_output using this jobId, or stop the job with job_kill.
```

What `job_output` returns: a `# transcript (en, 12.9s, 1 segments, cuda/int8_float32)` header, then one line per segment (`[00:00.7 → 00:12.7] text`); past `maxSegments` the header gains a `# TRUNCATED:` line.

### `video_frames`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `file_path` | string | — | **A local absolute path or an http(s) link** (required) |
| `threshold` | number | `0.3` | Scene-change sensitivity |
| `max_frames` | number | `16` | Frame cap (takes the smaller of this and `imageLimits.maxImagesPerMessage`) |
| `strategy` | enum | `scene` | `scene` for scene changes / `fps` for fixed sampling |
| `fps` | number | `1` | Used when `strategy=fps` |

Canonical output (always present):

```jsonc
{
  "frames": [{ "index": 0, "timestampSec": 4.2, "attachmentId": "sha256:…", "mediaType": "image/jpeg", "bytes": 12345, "width": 320, "height": 240, "path": "…" }],
  "strategy": "scene",
  "timestampSource": "exact",          // "estimated" when parsing failed
  "mode": "images",                    // or "text-only"
  "durationSec": 8.0,
  "reason": "model-lacks-image-input"  // also "no-scene-change" / "no-video-stream" / "attachments-unavailable"
}
```

What the model sees: a header line plus one facts line (`mode: images | strategy: scene | timestampSource: exact | durationSec: 8.00`), then `[00:04.2]` + the inline image per frame; in `text-only` mode it lists frame file paths instead.

**Degradation semantics (important)**: with `mode: 'text-only'` the tool returns temporary frame paths plus timestamps and **emits no image blocks**, so later turns cannot fail because the route lacks image support. A solid-colour or animated video returns `frames: []` with `reason: 'no-scene-change'`; retry with `strategy: 'fps'` in that case.

**Design boundary**: infrastructure failures (missing ffmpeg, missing file) **throw**; non-ideal business outcomes (no audio track, no scene change, model cannot see images) **return a canonical value plus `reason`**. The tool does not confine `file_path` to the workspace — that is a documented boundary.

## 💡 Usage

One sentence of task plus one piece of media is enough; the model decides which tools to call (the example below matches the **verified** shape):

```text
User:  What does meeting.mp4 cover, and what is on screen at 12s?
Model: → transcribe_audio({ file_path: "…\\meeting.mp4" })
       ← status: running | jobId: transcribe-1 | model: small | device: cuda | source: local
Model: → job_output({ job_id: "transcribe-1" })
       ← # transcript (en, 12.9s, 1 segments, cuda/int8_float32)
         [00:00.7 → 00:12.7] I have a dream that one day this nation will rise up …
Model: → video_frames({ file_path: "…\\meeting.mp4", max_frames: 12 })
       ← mode: images | strategy: scene | timestampSource: exact | durationSec: 8.00
         [00:04.0] <inline image>  [00:06.0] <inline image>
Model: It covers the release schedule, risks and ownership; at 12 s the slide is titled "Q3 Roadmap".
```

Links work the same way — the model just passes the URL as `file_path`:

```text
User:  What is in this video? https://example.com/clip.mp4
Model: → video_frames({ file_path: "https://example.com/clip.mp4", strategy: "fps", max_frames: 3 })
       ← downloaded → sampled → 3 real images (exact timestamps)
```

## 📁 Package layout

```text
dsh-media-understanding/
├── src/
│   ├── index.ts               # entry: name / inject / apply(ctx) / Config / workersDir()
│   ├── globals.d.ts           # empty type imports: official augmentation + JobKindMap merge (transcribe/download)
│   ├── tools/
│   │   ├── probe.ts           # media_probe (read-only environment check)
│   │   ├── transcribe.ts      # transcribe_audio (background job)
│   │   └── frames.ts          # video_frames (sync sampling + attachment persistence + vision gate)
│   ├── media/                 # host-facing layer
│   │   ├── exec.ts            # ctx.subprocess wrapper (resolution / bounded collect / spill / cancel / timeout)
│   │   ├── ffmpeg.ts          # ffprobe streams, audio extraction, sampleFrames (showinfo timestamps)
│   │   ├── whisper.ts         # python probe call, device resolution, worker transcription
│   │   ├── download.ts        # yt-dlp / ffmpeg link download
│   │   └── input.ts           # input normalisation: local path vs link vs unsupported scheme
│   ├── pure/                  # pure logic (zero host deps, bundled separately for tests)
│   │   ├── device.ts          # device & compute-type resolution (GPU when present, CPU fallback)
│   │   ├── errors.ts          # error classification (0xC0000005, mkl_malloc, av>=19, download failures…)
│   │   ├── json.ts            # pruneUndefined / assertJsonSafe (the host requires lossless JSON)
│   │   ├── render.ts          # pure projection for output.render (the model-visible surface)
│   │   ├── timestamps.ts      # showinfo / pts_time parsing and pairing
│   │   └── resolve-input.ts   # input classification and download-name derivation
│   └── workers/
│       ├── probe.py           # environment probe (really constructs a native object, not just import)
│       └── transcribe.py      # faster-whisper worker (writes JSON to a file to avoid stdout truncation)
├── test/                      # 69 tests (device / errors / json / render / resolve-input / timestamps / layout)
├── scripts/
│   ├── setup-dsh-deps.mjs     # junction the host .pnpm closure into node_modules
│   ├── build.mjs              # tsdown bundle → tsc declarations (order matters)
│   ├── deploy.mjs             # deploy outside the repo tree + build a resolve scope
│   └── check-encoding.mjs     # source UTF-8 check (guards against double-encoding)
├── docs/                      # design record (coding-plan.md) and review report (coding-plan-review.md)
├── cordis.patch.yml           # mounts this package as a host-side plugin
└── README.md / README.en.md   # Chinese (default) / English
```

Build and local-development essentials:

- **Packaging rule**: `tsdown` must treat `@deepseek-ai/*` and `node:*` as external — inlining them yields a second copy of the modules and duplicate `Symbol`s, which crashes tool dispatch (`TOOL_RUNTIME_SCHEDULER` must appear 0 times in `lib/index.js`).
- Declarations are emitted by `tsc` into `lib/types/`; `tsconfig` resolves host types straight through the junctions in `node_modules`.
- Build order is not interchangeable: `tsdown` (with `clean: true`) runs first, `tsc` second — otherwise the freshly written declarations are wiped.
- Deployment must live **outside the repository tree**: the repo's `node_modules/@deepseek-ai` is a development copy that would win module resolution at runtime and become a second instance.

## ⚠️ Known limitations

- Embedded subtitle tracks are not parsed (a future option: prefer subtitles, fall back to Whisper).
- Platform page links (YouTube / Bilibili) depend on **yt-dlp**; without it that path reports `download-tool-missing` clearly (direct links are unaffected). Links are http(s) only.
- The per-call frame cap is bounded by `imageLimits.maxImagesPerMessage` (20 by default); the default is 16 to leave headroom, and frames consume significant context.
- `strategy: 'scene'` never emits the first frame (`select` is always false for frame 0); sample `t=0` separately when needed.
- Timestamps are **estimates** when parsing fails, and both the output and an explicit warning say so.
- Time formatting shows `00:60.0` when the seconds value rounds to 60 (existing display behaviour; it does not affect how the model reads it).

## 📚 Documentation

- [`docs/coding-plan.md`](docs/coding-plan.md) — design, tool contracts, configuration, package layout, phased implementation and risk register. **Read it before touching contracts, DSH API calls, or the package layout.**
- [`docs/coding-plan-review.md`](docs/coding-plan-review.md) — review conclusions, the measured environment, and blocker corrections. **Read it when wiring up a profile, when something does not run, or when you suspect a DSH version difference.**

## 📄 License

[Apache-2.0](LICENSE).
