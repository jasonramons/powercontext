import base64, json, subprocess
from pathlib import Path
GH = r"C:\Users\PC\Documents\deepseek-harness\default-workspace\tools\gh\bin\gh.exe"
REPO = "repos/jasonramons/powercontext"
BASE = "dab240063bfcfa7917898dc44da4baadb3747bd0"   # 比赛分支头，含冻结基线
OLD_BRANCH = "feat/dify-memory-inn"
NEW_BRANCH = "feat/dify-memory-inn-v2"
ROOT = Path(r"C:\Users\PC\Documents\deepseek-harness\default-workspace\memory-inn")
TMP = ROOT / ".upload"; TMP.mkdir(exist_ok=True)
FILES = [
    "package.json", "README.md", "data/lore.json", "bridge/app.py",
    "server/embed.mjs", "server/index.mjs", "server/memory.mjs", "server/store.mjs",
    "scripts/verify.mjs", "scripts/build_dsl.py",
    "dify/memory-inn.dsl.yml", "docs/verification.md",
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
    entries.append({"path": f"memory-inn/{rel}", "mode":"100644", "type":"blob", "sha": blob["sha"]})
tree = gh(["-X","POST",f"{REPO}/git/trees"], {"base_tree": BASE, "tree": entries})
commit = gh(["-X","POST",f"{REPO}/git/commits"], {
    "message": "feat(dify): add 记忆旅馆 — a chatflow adventure that remembers you\n\n"
               "Dify 负责叙事编排，seekdb 做世界档案的向量检索，PowerContext 保存玩家记忆。\n"
               "含 DSL、世界服务、29 条档案与 11 项端到端验证。\n"
               "基于比赛基线重建，保证包含冻结版本。",
    "tree": tree["sha"], "parents": [BASE]})
print("commit", commit["sha"])
try:
    gh(["-X","POST",f"{REPO}/git/refs"], {"ref": f"refs/heads/{NEW_BRANCH}", "sha": commit["sha"]})
except RuntimeError:
    gh(["-X","PATCH",f"{REPO}/git/refs/heads/{NEW_BRANCH}"], {"sha": commit["sha"], "force": True})
cmp = gh([f"{REPO}/compare/9db1753434162c0aa7c9f1189a1722e617880a52...{NEW_BRANCH}"])
print(json.dumps({"branch": NEW_BRANCH, "commit": commit["sha"],
                  "status": cmp["status"], "ahead": cmp["ahead_by"], "behind": cmp["behind_by"]}, indent=2))