import base64, json, subprocess
from pathlib import Path
GH = r"C:\Users\PC\Documents\deepseek-harness\default-workspace\tools\gh\bin\gh.exe"
REPO = "repos/jasonramons/powercontext"
BASE = "dab240063bfcfa7917898dc44da4baadb3747bd0"
NEW_BRANCH = "feat/qoder-study-buddy-v2"
ROOT = Path(r"C:\Users\PC\Documents\deepseek-harness\default-workspace\study-buddy")
TMP = ROOT / ".upload"; TMP.mkdir(exist_ok=True)
FILES = [
 "package.json","README.md","TECH.md","Dockerfile","docker-compose.yml",".dockerignore",
 "server/embed.mjs","server/index.mjs","server/powercontext.mjs","server/review.mjs","server/store.mjs",
 "bridge/app.py","web/index.html","web/app.js","web/style.css","web/demo.html",
 "data/seed.json","scripts/seed.mjs","scripts/smoke.mjs","scripts/build-demo.mjs",
 "docs/verification.md","docs/qoder-checklist.md",
]
def gh(args, payload=None):
    cmd = [GH, "api", *args]
    if payload is not None:
        p = TMP / "p.json"; p.write_text(json.dumps(payload), encoding="utf-8"); cmd += ["--input", str(p)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0: raise RuntimeError(f"{' '.join(args)}: {r.stderr[:300]}")
    return json.loads(r.stdout) if r.stdout.strip() else {}
entries = []
for rel in FILES:
    data = (ROOT / rel).read_bytes()
    blob = gh(["-X","POST",f"{REPO}/git/blobs"], {"content": base64.b64encode(data).decode(), "encoding":"base64"})
    entries.append({"path": f"study-buddy/{rel}", "mode":"100644", "type":"blob", "sha": blob["sha"]})
tree = gh(["-X","POST",f"{REPO}/git/trees"], {"base_tree": BASE, "tree": entries})
commit = gh(["-X","POST",f"{REPO}/git/commits"], {
  "message": "feat(qoder): add study buddy review assistant\n\n"
             "错题/笔记复习助手：seekdb 混合检索 + PowerContext 薄弱点记忆，含 24 道示例题、\n"
             "静态演示页与 18 项端到端自检。基于比赛基线重建，保证包含冻结版本。",
  "tree": tree["sha"], "parents": [BASE]})
print("commit", commit["sha"])
try:
    gh(["-X","POST",f"{REPO}/git/refs"], {"ref": f"refs/heads/{NEW_BRANCH}", "sha": commit["sha"]})
except RuntimeError:
    gh(["-X","PATCH",f"{REPO}/git/refs/heads/{NEW_BRANCH}"], {"sha": commit["sha"], "force": True})
cmp = gh([f"{REPO}/compare/9db1753434162c0aa7c9f1189a1722e617880a52...{NEW_BRANCH}"])
print(json.dumps({"branch": NEW_BRANCH, "commit": commit["sha"], "status": cmp["status"],
                  "ahead": cmp["ahead_by"], "behind": cmp["behind_by"]}, indent=2))