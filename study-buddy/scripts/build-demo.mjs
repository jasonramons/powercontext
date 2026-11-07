/**
 * Build web/demo.html: a self-contained static page for Qoder Sites.
 *
 * The demo keeps the same hashed-embedding retrieval as the server so the
 * published site shows *real* ranked results, only over the bundled sample
 * data instead of a live seekdb instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8'));

function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Deterministic sample history so the demo looks like a learner who has been
// using the tool for a couple of weeks.
const items = seed.map((item, index) => {
  const h = hash32(item.id);
  const attempts = 1 + (h % 4);
  const mastery = Number((0.18 + ((h >>> 5) % 70) / 100).toFixed(2));
  const correct = Math.max(0, Math.round(attempts * (mastery > 0.5 ? 0.8 : 0.3)));
  return {
    ...item,
    stats: { attempts, correct, mastery, intervalDays: mastery > 0.6 ? 4 : 1 },
    order: index,
  };
});

const data = JSON.stringify(items);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Study Buddy · 错题复习助手</title>
<style>
:root{--bg:#0f172a;--panel:#16213a;--panel2:#1d2b47;--text:#e6edf7;--muted:#93a4bd;--accent:#4f8cff;--ok:#34d399;--bad:#f87171;--border:#253552}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#1b2b4d 0%,var(--bg) 55%);color:var(--text);font:14px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 22px 60px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:1px solid var(--border);padding-bottom:18px}
.brand{display:flex;gap:14px;align-items:center}
.logo{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(135deg,#4f8cff,#7c5cff);font-weight:700}
h1{margin:0;font-size:19px}
.sub{margin:2px 0 0;color:var(--muted);font-size:12px}
.badge{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:4px 10px;white-space:nowrap}
.tabs{display:flex;gap:8px;margin:20px 0 16px;flex-wrap:wrap}
.tab{background:transparent;color:var(--muted);border:1px solid transparent;padding:8px 14px;border-radius:10px;cursor:pointer;font:inherit}
.tab.active{color:var(--text);background:var(--panel);border-color:var(--border)}
.panel{display:none}.panel.active{display:block}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
input,select{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 13px;font:inherit;outline:none;min-width:240px}
input:focus{border-color:var(--accent)}
button{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:9px 15px;cursor:pointer;font:inherit}
button.primary{background:linear-gradient(135deg,#4f8cff,#6f6bff);border:none;font-weight:600}
.cards{display:grid;gap:12px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px}
.card h3{margin:0 0 6px;font-size:15px}
.meta{color:var(--muted);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.tag{background:var(--panel2);border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:11px}
.prompt{margin:10px 0;white-space:pre-wrap}
.answer{margin:10px 0 0;white-space:pre-wrap;color:#cfe0ff;background:#14203a;border-left:3px solid var(--accent);padding:10px 12px;border-radius:8px}
.bar{height:6px;border-radius:99px;background:#0d1830;overflow:hidden;margin-top:8px}
.bar > i{display:block;height:100%;background:linear-gradient(90deg,#f87171,#fbbf24,#34d399)}
.memory{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-top:22px}
.memory h2{font-size:14px;margin:0 0 12px}
.empty{color:var(--muted);font-size:13px}
.note{background:#1a2740;border:1px dashed #34507d;border-radius:10px;padding:10px 12px;font-size:12px;color:#cfe0ff;margin-bottom:10px}
footer{margin-top:36px;color:var(--muted);font-size:12px;border-top:1px solid var(--border);padding-top:16px}
footer a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo">SB</div>
      <div>
        <h1>Study Buddy · 错题/笔记复习助手</h1>
        <p class="sub">seekdb 混合检索 + PowerContext 薄弱点记忆 · 备考场景</p>
      </div>
    </div>
    <span class="badge">静态演示 · ${items.length} 道示例题</span>
  </header>

  <div class="tabs">
    <button class="tab active" data-tab="search">相似题检索</button>
    <button class="tab" data-tab="review">今日复习</button>
    <button class="tab" data-tab="library">题库</button>
  </div>

  <section class="panel active" id="panel-search">
    <div class="row">
      <input id="q" placeholder="输入题干或关键词，例如：洛必达法则求极限"/>
      <button class="primary" id="go">检索</button>
    </div>
    <p class="small muted" style="color:var(--muted);font-size:12px;margin:-6px 0 14px">
      与本地版一致：384 维哈希向量 + 余弦相似度排序（线上版由 seekdb 的 HNSW 索引完成）。
    </p>
    <div id="results" class="cards"></div>
  </section>

  <section class="panel" id="panel-review">
    <div class="row">
      <select id="budget"><option value="10">10 分钟</option><option value="20" selected>20 分钟</option><option value="40">40 分钟</option></select>
      <button class="primary" id="plan">生成今日复习清单</button>
    </div>
    <div id="planCards" class="cards"></div>
  </section>

  <section class="panel" id="panel-library">
    <div class="row"><input id="filter" placeholder="按标题 / 知识点过滤"/><span id="count" class="meta"></span></div>
    <div id="library" class="cards"></div>
  </section>

  <div class="memory">
    <h2>PowerContext 薄弱点（示例记忆）</h2>
    <div id="weak" class="cards"></div>
  </div>

  <footer>
    演示页 · 数据为示例 · 完整功能见仓库
    <a href="https://github.com/jasonramons/powercontext/tree/feat/qoder-study-buddy/study-buddy">study-buddy</a>
  </footer>
</div>

<script>
const ITEMS = ${data};
const DIM = 384;
function hash32(t){let h=2166136261>>>0;for(let i=0;i<t.length;i++){h^=t.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h>>>0}
function tokens(text){const s=String(text||'').toLowerCase();const out=[];(s.match(/[a-z0-9]+/g)||[]).forEach(w=>{if(w.length>1)out.push('w:'+w)});(s.match(/[\\u4e00-\\u9fff]+/g)||[]).forEach(run=>{for(const ch of run)out.push('c:'+ch);for(let i=0;i+1<run.length;i++)out.push('b:'+run.slice(i,i+2))});return out}
function embed(text){const v=new Float64Array(DIM);for(const t of tokens(text)){const h=hash32(t);v[h%DIM]+=1;v[(h>>>11)%DIM]+=0.5}let n=0;for(const x of v)n+=x*x;n=Math.sqrt(n)||1;return Array.from(v,x=>x/n)}
function cosine(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s}
const DOC = ITEMS.map(it=>embed([it.title,it.prompt,it.answer,it.knowledge].join('\\n')));
const esc = s => String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function card(it, extra){return '<article class="card"><h3>'+esc(it.title)+'</h3><div class="meta">'+
  '<span class="tag">'+esc(it.subject)+'</span><span class="tag">'+esc(it.knowledge)+'</span>'+
  (extra||'')+'</div><p class="prompt">'+esc(it.prompt)+'</p>'+
  '<details><summary class="meta" style="cursor:pointer">查看答案解析</summary><p class="answer">'+esc(it.answer)+'</p></details></article>'}

function search(){const q=document.getElementById('q').value.trim();if(!q)return;
  const v=embed(q);const scored=ITEMS.map((it,i)=>({it,sim:cosine(v,DOC[i])})).sort((a,b)=>b.sim-a.sim).slice(0,5);
  document.getElementById('results').innerHTML=scored.map((s,i)=>card(s.it,'<span class="tag">相似度 '+s.sim.toFixed(3)+'</span>')).join('')}

function plan(){const minutes=Number(document.getElementById('budget').value);const slots=Math.floor(minutes/2);
  const scored=ITEMS.map(it=>{const st=it.stats;const weakness=Math.min(1,Math.max(0,(1-st.mastery)*0.7+(1-(st.correct/Math.max(st.attempts,1)))*0.2+0.1));
    return {it,weakness,priority:weakness*(st.intervalDays<=1?1.4:1)}}).sort((a,b)=>b.priority-a.priority).slice(0,slots);
  document.getElementById('planCards').innerHTML=scored.map((s,i)=>card(s.it,
    '<span class="tag">优先级 '+s.priority.toFixed(2)+'</span><span class="tag">掌握度 '+s.it.stats.mastery.toFixed(2)+'</span>')).join('')}

function library(){const f=document.getElementById('filter').value.trim().toLowerCase();
  const list=ITEMS.filter(it=>!f||[it.title,it.knowledge,it.prompt].join(' ').toLowerCase().includes(f));
  document.getElementById('count').textContent=list.length+' / '+ITEMS.length+' 条';
  document.getElementById('library').innerHTML=list.map(it=>'<article class="card"><h3>'+esc(it.title)+'</h3><div class="meta">'+
    '<span class="tag">'+esc(it.subject)+'</span><span class="tag">'+esc(it.knowledge)+'</span><span class="tag">掌握度 '+it.stats.mastery.toFixed(2)+'</span></div>'+
    '<div class="bar"><i style="width:'+Math.round(it.stats.mastery*100)+'%"></i></div></article>').join('')}

function weak(){const top=[...ITEMS].sort((a,b)=>a.stats.mastery-b.stats.mastery).slice(0,4);
  document.getElementById('weak').innerHTML='<div class="note">以下条目来自 PowerContext 记忆：每次答错都会写入一条「薄弱点：知识点（科目）最近答错，题目「…」」。</div>'+
    top.map(it=>'<div class="card"><div class="meta"><span class="tag">'+esc(it.subject)+'</span>'+
    '<span class="tag">掌握度 '+it.stats.mastery.toFixed(2)+'</span><span class="tag">答错 '+(it.stats.attempts-it.stats.correct)+' 次</span></div>'+
    '<p class="prompt" style="margin:8px 0 0">薄弱点：'+esc(it.knowledge)+'（'+esc(it.subject)+'）最近答错，题目「'+esc(it.title)+'」</p></div>').join('')}

document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t===tab));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+tab.dataset.tab))}));
document.getElementById('go').addEventListener('click',search);
document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')search()});
document.getElementById('plan').addEventListener('click',plan);
document.getElementById('filter').addEventListener('input',library);
document.getElementById('q').value='洛必达法则求极限';
search();plan();library();weak();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'web', 'demo.html'), html, 'utf8');
console.log(`web/demo.html ${(html.length / 1024).toFixed(1)} KB, ${items.length} items`);
