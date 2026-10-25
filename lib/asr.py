#!/usr/bin/env python3
"""
lib/asr.py — 音轨转写（faster-whisper，CPU int8）

用法：
  python asr.py <wav 路径> [模型=small] [语言=auto|zh|en|...] [线程数=8]

语言传 auto（或留空）时走自动检测——B站 上不全是中文视频，
写死 zh 会把葡语/英语片转成一堆同音乱码。

输出：一行 JSON 到 stdout
  {"ok": true, "text": "...", "lang": "zh", "seconds": 12.3}
失败时：
  {"ok": false, "note": "..."}

为什么单开一个脚本：宿主 App 是 Node，ASR 走 Python 生态；
进程只在这一步存在，转写完音频就被调用方删掉。
"""

import json
import os
import sys
import time


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "note": "缺少 wav 路径"}, ensure_ascii=False))
        return 2

    wav = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "small"
    lang_arg = sys.argv[3] if len(sys.argv) > 3 else ""
    lang = None if lang_arg in ("", "auto") else lang_arg
    threads = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else min(8, os.cpu_count() or 4)

    t0 = time.time()
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "note": f"faster-whisper 不可用：{e}"}, ensure_ascii=False))
        return 3

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
        segments, info = model.transcribe(
            wav,
            language=lang,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        parts = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
        text = "".join(parts) if lang in ("zh", "ja", "ko") else " ".join(parts)
        print(
            json.dumps(
                {
                    "ok": True,
                    "text": text,
                    "lang": getattr(info, "language", "") or (lang or ""),
                    "seconds": round(time.time() - t0, 1),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "note": f"转写失败：{e}"}, ensure_ascii=False))
        return 4


if __name__ == "__main__":
    sys.exit(main())
