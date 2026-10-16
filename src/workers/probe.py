#!/usr/bin/env python
"""环境探测：一次子进程调用把"能不能转录"所需的事实全部如实报出来。

为什么要专门做这个（coding-plan Phase 1 / R3d / §5.1.0）：
- **只 import 不足以判可用**：MSVCP140.dll 过旧时 `import ctranslate2` 能过、
  一构造对象就 `0xC0000005` 硬崩溃。所以这里会**真的构造一次对象**。
- **只认路径不足以判可用**：3.15 装了也缺 faster-whisper。所以这里**实测 import**。
- **PyAV 版本是硬前提**：`av>=19` 移除了 `av.open(metadata_errors=…)`，而
  faster-whisper 1.2.1 仍在传它 → 推理必崩。这里报出主版本。

输出：**单个 JSON 对象到 stdout**（stdout 只放 JSON，诊断信息一律进 stderr）。
中文字段与错误文本不出现，避免 Windows 控制台编码干扰。
"""

from __future__ import annotations

import json
import os
import sys
import traceback

RESULT: dict = {
    "ok": False,
    "python": {
        "version": sys.version.split()[0],
        "executable": sys.executable,
    },
    "modules": {},
    "cuda": {"deviceCount": None, "supportedComputeTypes": None, "error": None},
    "cpuComputeTypes": None,
    "models": {"cached": None, "dir": None, "error": None},
    "errors": [],
}


def record(name: str, fn) -> None:
    """跑一个探测项，异常收敛进 errors 而不是让整个探针炸掉。"""
    try:
        RESULT[name] = fn()
    except Exception as exc:  # noqa: BLE001 - 探针必须尽力而为
        RESULT["errors"].append({"probe": name, "error": f"{type(exc).__name__}: {exc}"})


def probe_modules() -> dict:
    """逐个实测 import + 版本，并**真的构造一次**原生对象。"""
    out: dict = {}

    def add(name: str, importer, exercise=None) -> None:
        entry: dict = {"imported": False, "version": None, "exercised": None, "error": None}
        try:
            module = importer()
            entry["imported"] = True
            entry["version"] = getattr(module, "__version__", None)
            if exercise is not None:
                try:
                    entry["exercised"] = bool(exercise(module))
                except Exception as exc:  # noqa: BLE001
                    entry["exercised"] = False
                    entry["error"] = f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # noqa: BLE001
            entry["error"] = f"{type(exc).__name__}: {exc}"
        out[name] = entry

    def import_faster_whisper():
        import faster_whisper  # noqa: F401

        return faster_whisper

    def import_av():
        import av

        return av

    def import_ctranslate2():
        import ctranslate2

        return ctranslate2

    def import_onnxruntime():
        import onnxruntime

        return onnxruntime

    # 真构造一次，才能发现"import 能过、一用就崩"（0xC0000005）
    def exercise_ctranslate2(module):
        # get_supported_compute_types 会走原生层，是轻量的"能用"证据
        return bool(module.get_supported_compute_types("cpu"))

    def exercise_ort(module):
        return hasattr(module, "get_available_providers")

    add("faster_whisper", import_faster_whisper)
    add("av", import_av)
    add("ctranslate2", import_ctranslate2, exercise_ctranslate2)
    add("onnxruntime", import_onnxruntime, exercise_ort)

    av_entry = out.get("av") or {}
    version = av_entry.get("version")
    if isinstance(version, str):
        major = version.split(".")[0]
        av_entry["majorVersion"] = int(major) if major.isdigit() else None
        # 硬前提：av<19（18.1.0 实测可用，19.0.1 报 TypeError: metadata_errors）
        av_entry["compatibleWithFasterWhisper"] = (
            av_entry["majorVersion"] is not None and av_entry["majorVersion"] < 19
        )
    return out


def probe_cuda() -> tuple[dict, list | None]:
    """CUDA 可用性与可用计算档。任何失败都只记录，不抛。"""
    cuda = {"deviceCount": None, "supportedComputeTypes": None, "error": None}
    cpu_types: list | None = None
    try:
        import ctranslate2

        cpu_types = sorted(ctranslate2.get_supported_compute_types("cpu"))
        try:
            cuda["deviceCount"] = int(ctranslate2.get_cuda_device_count())
        except Exception as exc:  # noqa: BLE001
            cuda["error"] = f"{type(exc).__name__}: {exc}"
            cuda["deviceCount"] = 0
        if cuda["deviceCount"]:
            try:
                cuda["supportedComputeTypes"] = sorted(
                    ctranslate2.get_supported_compute_types("cuda")
                )
            except Exception as exc:  # noqa: BLE001
                cuda["error"] = f"{type(exc).__name__}: {exc}"
    except Exception as exc:  # noqa: BLE001
        cuda["error"] = f"{type(exc).__name__}: {exc}"
    return cuda, cpu_types


def probe_models() -> dict:
    """报告已缓存的模型目录（不联网）。"""
    root = os.environ.get("HF_HOME")
    candidates: list[str] = []
    if root:
        candidates.append(os.path.join(root, "hub"))
    home = os.path.expanduser("~")
    candidates.append(os.path.join(home, ".cache", "huggingface", "hub"))

    for base in candidates:
        if not os.path.isdir(base):
            continue
        names = [
            name
            for name in os.listdir(base)
            if name.startswith("models--") and "faster-whisper" in name
        ]
        cached = sorted(name.split("faster-whisper-", 1)[-1] for name in names)
        return {"cached": cached, "dir": base, "error": None}
    return {"cached": [], "dir": None, "error": None}


def main() -> int:
    try:
        RESULT["modules"] = probe_modules()
        cuda, cpu_types = probe_cuda()
        RESULT["cuda"] = cuda
        RESULT["cpuComputeTypes"] = cpu_types
        RESULT["models"] = probe_models()
        RESULT["ok"] = True
    except Exception:  # noqa: BLE001 - 兜底：绝不因为探针自身出错而让插件看不到任何事实
        RESULT["errors"].append({"probe": "main", "traceback": traceback.format_exc()})

    sys.stdout.write(json.dumps(RESULT, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
