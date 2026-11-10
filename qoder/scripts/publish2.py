"""Add or update files on feat/qoder-study-buddy in one commit."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

GH = r"C:\Users\PC\Documents\deepseek-harness\default-workspace\tools\gh\bin\gh.exe"
REPO = "repos/jasonramons/powercontext"
BRANCH = "feat/qoder-study-buddy"
ROOT = Path(r"C:\Users\PC\Documents\deepseek-harness\default-workspace\study-buddy")
TMP = ROOT / ".upload"
TMP.mkdir(exist_ok=True)

FILES = [
    "package.json",
    "README.md",
    "web/demo.html",
    "scripts/build-demo.mjs",
    "docs/qoder-checklist.md",
]


def gh(args: list[str], payload: dict | None = None) -> dict:
    cmd = [GH, "api", *args]
    if payload is not None:
        path = TMP / "payload2.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        cmd += ["--input", str(path)]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"gh failed: {' '.join(args)}\n{result.stderr[:400]}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


head = gh([f"{REPO}/git/ref/heads/{BRANCH}"])["object"]["sha"]
print(f"branch head {head[:8]}")

entries = []
for rel in FILES:
    data = (ROOT / rel).read_bytes()
    blob = gh(["-X", "POST", f"{REPO}/git/blobs"], {
        "content": base64.b64encode(data).decode("ascii"),
        "encoding": "base64",
    })
    entries.append({"path": f"study-buddy/{rel}", "mode": "100644", "type": "blob", "sha": blob["sha"]})
    print(f"  blob {rel} ({len(data)} bytes)")

tree = gh(["-X", "POST", f"{REPO}/git/trees"], {"base_tree": head, "tree": entries})
commit = gh(["-X", "POST", f"{REPO}/git/commits"], {
    "message": "docs(qoder): add self-contained demo page and the step-by-step Qoder runbook",
    "tree": tree["sha"],
    "parents": [head],
})
gh(["-X", "PATCH", f"{REPO}/git/refs/heads/{BRANCH}"], {"sha": commit["sha"], "force": False})
print(json.dumps({"branch": BRANCH, "commit": commit["sha"]}, indent=2))
