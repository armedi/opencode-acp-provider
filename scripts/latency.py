#!/usr/bin/env python3
"""Measure real OpenCode greetings, including admission, startup, and completion.

Usage: python3 scripts/latency.py [provider/model] [trials-per-title-mode]
Creates diagnostic sessions. Requires the plugin to be configured in OpenCode.
"""

import json
import os
import statistics
import subprocess
import sys
import time


def api(method, path, data=None):
    command = ["opencode", "api", method, path]
    if data is not None:
        command += ["--data", json.dumps(data)]
    result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=120)
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    provider, model = (sys.argv[1] if len(sys.argv) > 1 else "acp-cmd/deepseek/deepseek-v4.1-flash").split("/", 1)
    trials = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    if trials < 1:
        raise ValueError("trials must be positive")
    results = []
    for titles in [False, True]:
        for trial in range(trials):
            options = {
                "location": {"directory": os.getcwd()},
                "model": {"providerID": provider, "id": model},
            }
            if not titles:
                options["title"] = "ACP latency diagnostic"
            session = api("post", "/api/session", options)["data"]["id"]
            start = time.monotonic()
            api("post", f"/api/session/{session}/prompt", {"text": "hi"})
            admitted = time.monotonic()
            api("post", f"/api/experimental/session/{session}/wait", {})
            idle = time.monotonic()
            messages = api("get", f"/api/session/{session}/context")["data"]
            assistant = next((item for item in reversed(messages) if item["type"] == "assistant"), {})
            text = "".join(part.get("text", "") for part in assistant.get("content", []) if part["type"] == "text")
            result = {
                "session": session,
                "titles": titles,
                "trial": trial + 1,
                "admissionSeconds": round(admitted - start, 3),
                "idleSeconds": round(idle - start, 3),
                "success": bool(text.strip()) and "[ACP error:" not in text and assistant.get("finish") == "stop",
            }
            results.append(result)
            print(json.dumps(result), flush=True)
    for titles in [False, True]:
        group = [item for item in results if item["titles"] == titles]
        elapsed = [item["idleSeconds"] for item in group if item["success"]]
        print(json.dumps({
            "titles": titles,
            "successful": len(elapsed),
            "failed": len(group) - len(elapsed),
            "medianSeconds": statistics.median(elapsed) if elapsed else None,
            "rangeSeconds": [min(elapsed), max(elapsed)] if elapsed else None,
        }), flush=True)
    return 0 if all(item["success"] for item in results) else 1


if __name__ == "__main__":
    sys.exit(main())
