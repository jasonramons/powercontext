"""Publish study-buddy/ to jasonramons/powercontext in one commit via the Git Data API."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

GH = r"C:\Users\PC\Documents\deepseek-harness\default-workspace\tools\gh\bin\gh.exe"
REPO = "repos/jasonramons/powercontext"
OWNER_REPO = "jasonramons/powercontext"
ROOT = Path(r"C:\Users\PC\Documents\deepseek-harness\default-workspace\study-buddy")
BRANCH = "feat/qoder-study-buddy"
TMP = Path(r"C:\Users\PC\Documents\deepseek-harness\default-workspace\study-buddy\.upload")
TMP.mkdir(exist_ok=True)

FILES = [
    "package.json",
    "README.md",
    "TECH.md",
    "server/embed.mjs",
    "server/index.mjs",
    "server/powercontext.mjs",
    "server/review.mjs",
    "server/store.mjs",
    "bridge/app.py",
    "web/index.html",
    "web/app.js",
    "web/style.css",
    "data/seed.json",
    "scripts/seed.mjs",
    "scripts/smoke.mjs",
    "docs/verification.md",
    "docs/qoder-checklist.md",
]


def gh(args: list[str], payload: dict | None = None) -> dict:
    cmd = [GH, "api", *args]
    if payload is not None:
        path = TMP / "payload.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        cmd += ["--input", str(path)]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"gh failed: {' '.join(args)}\n{result.stderr[:500]}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


repo = gh([REPO])
default_branch = repo["default_branch"]
head = gh([f"{REPO}/git/ref/heads/{default_branch}"])["object"]["sha"]
print(f"default branch {default_branch} @ {head[:8]}")

tree_entries = []
for rel in FILES:
    data = (ROOT / rel).read_bytes()
    blob = gh(["-X", "POST", f"{REPO}/git/blobs"], {
        "content": base64.b64encode(data).decode("ascii"),
        "encoding": "base64",
    })
    tree_entries.append({"path": f"study-buddy/{rel}", "mode": "100644", "type": "blob", "sha": blob["sha"]})
    print(f"  blob {rel} ({len(data)} bytes)")

tree = gh(["-X", "POST", f"{REPO}/git/trees"], {"base_tree": head, "tree": tree_entries})
commit = gh(["-X", "POST", f"{REPO}/git/commits"], {
    "message": (
        "feat(qoder): add study buddy review assistant\n\n"
        "错题/笔记复习助手：seekdb 混合检索（HNSW + 关键词）+ PowerContext 薄弱点记忆，"
        "含 24 道示例题与 18 项端到端自检。"
    ),
    "tree": tree["sha"],
    "parents": [head],
})
print(f"commit {commit['sha']}")

try:
    gh(["-X", "POST", f"{REPO}/git/refs"], {"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]})
    print(f"branch {BRANCH} created")
except RuntimeError as error:
    if "already exists" in str(error):
        gh(["-X", "PATCH", f"{REPO}/git/refs/heads/{BRANCH}"], {"sha": commit["sha"], "force": True})
        print(f"branch {BRANCH} updated")
    else:
        raise

print(json.dumps({
    "repo": f"https://github.com/{OWNER_REPO}",
    "branch": BRANCH,
    "commit": commit["sha"],
}, indent=2))
