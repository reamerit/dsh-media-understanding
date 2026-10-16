#!/usr/bin/env python
"""faster-whisper worker：把参数读进来，把结果 JSON 写到 `--out`。

为什么不让 worker 自己遍历也就是为什么要有这个文件（coding-plan C4b）：
`python -m faster_whisper` **不是** faster-whisper 的 CLI（它是库，只有 Python API），
所以必须自带这个极小的 worker。

为什么不把 JSON 吐到 stdout：stdout 的 collect 上限是 1 MiB，长转录（5000 段）
必然超；落文件再由 TS 侧读，才不会静默丢字。

把结果写成 `{"error": "..."}` + **退出码 0** 是刻意的：让错误信息走
"业务结果"通道回到 TS 侧，由 `src/pure/errors.ts` 统一分类
（`mkl_malloc` = 内存不足、`no CUDA-capable device` = CUDA 不可用、
`metadata_errors` = PyAV 版本过新…），而不是让 stderr 的格式成为唯一线索。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback

# 进程内缓存：一个 worker 进程只服务一次调用（每次 spawn 一个新进程），
# 但保留这层也能让"同进程多次调用"的测试路径不至于重复加载。
_MODEL_CACHE: dict = {}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="faster-whisper transcription worker")
    parser.add_argument("--audio", required=True, help="16k mono wav (or any decodable media)")
    parser.add_argument("--out", required=True, help="path to write the JSON result")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu", help="cuda | cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default=None, help="source language; omit to auto-detect")
    parser.add_argument("--translate-to-english", action="store_true")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--model-cache-dir", default=None)
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--max-segments", type=int, default=5000)
    parser.add_argument("--vad", dest="vad", action="store_true", default=True)
    parser.add_argument("--no-vad", dest="vad", action="store_false")
    return parser


def load_model(args):
    from faster_whisper import WhisperModel

    key = (args.model, args.device, args.compute_type, args.model_cache_dir, args.local_files_only)
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached, 0.0

    started = time.perf_counter()
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=args.model_cache_dir,
        local_files_only=args.local_files_only,
    )
    elapsed = time.perf_counter() - started
    _MODEL_CACHE[key] = model
    return model, elapsed


def run(args) -> dict:
    model, load_sec = load_model(args)

    started = time.perf_counter()
    segments_iter, info = model.transcribe(
        args.audio,
        language=args.language,
        task="translate" if args.translate_to_english else "transcribe",
        beam_size=args.beam_size,
        vad_filter=args.vad,
    )

    segments = []
    truncated = False
    for segment in segments_iter:
        if len(segments) >= args.max_segments:
            truncated = True
            break
        segments.append(
            {
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": segment.text,
            }
        )
    infer_sec = time.perf_counter() - started

    return {
        "text": "".join(segment["text"] for segment in segments).strip(),
        "language": getattr(info, "language", args.language or "unknown"),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "durationSec": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
        "segments": segments,
        "truncated": truncated,
        "model": args.model,
        "device": args.device,
        "computeType": args.compute_type,
        "loadSec": round(load_sec, 2),
        "inferSec": round(infer_sec, 2),
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    payload: dict
    try:
        payload = run(args)
    except Exception as exc:  # noqa: BLE001 - 一切失败都走"业务结果"通道回到 TS 侧分类
        payload = {
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(),
        }

    try:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except OSError as exc:
        # 连结果文件都写不出去：只能退化成 stderr + 非零退出。
        sys.stderr.write(f"failed to write result file {args.out}: {exc}\n")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
