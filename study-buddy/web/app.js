const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { items: [], tab: 'review' };

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* ---------------------------------------------------------------- tabs */
for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    $$('.tab').forEach((node) => node.classList.toggle('active', node === tab));
    $$('.panel').forEach((node) => node.classList.toggle('active', node.id === `panel-${state.tab}`));
  });
}

/* ---------------------------------------------------------------- health */
async function refreshHealth() {
  try {
    const health = await api('/api/health');
    const pc = health.powercontext?.ok;
    $('#status').innerHTML =
      `<span class="dot ${pc ? '' : 'off'}"></span>` +
      `seekdb 已索引 ${health.indexed ?? 0} 条 · 题库 ${health.items} 条 · ` +
      `PowerContext ${pc ? '在线' : '离线'}`;
  } catch (error) {
    $('#status').innerHTML = `<span class="dot off"></span>服务未就绪：${esc(error.message)}`;
  }
}

/* ---------------------------------------------------------------- library */
function renderLibrary() {
  const filter = $('#filterInput').value.trim().toLowerCase();
  const list = state.items.filter((item) =>
    !filter || [item.title, item.knowledge, item.prompt].join(' ').toLowerCase().includes(filter),
  );
  $('#itemCount').textContent = `${list.length} / ${state.items.length} 条`;
  $('#library').innerHTML =
    list.length === 0
      ? '<p class="empty">还没有题目，去「录入错题」或运行 npm run seed 载入示例。</p>'
      : list
          .map(
            (item) => `
        <div class="item">
          <div>
            <div><strong>${esc(item.title)}</strong></div>
            <small>${esc(item.subject)} · ${esc(item.knowledge || '未标注知识点')} · 掌握度 ${(item.stats?.mastery ?? 0).toFixed(2)}</small>
          </div>
          <button class="ghost" data-del="${esc(item.id)}">删除</button>
        </div>`,
          )
          .join('');
  for (const button of $$('#library [data-del]')) {
    button.addEventListener('click', async () => {
      await api(`/api/items/${encodeURIComponent(button.dataset.del)}`, { method: 'DELETE' });
      await loadItems();
    });
  }
}

function renderSubjects() {
  const subjects = [...new Set(state.items.map((item) => item.subject).filter(Boolean))];
  const select = $('#subjectFilter');
  const current = select.value;
  select.innerHTML =
    '<option value="">全部</option>' + subjects.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  select.value = current;
}

async function loadItems() {
  const payload = await api('/api/items');
  state.items = payload.items;
  renderLibrary();
  renderSubjects();
  refreshHealth();
}

/* ---------------------------------------------------------------- search */
async function runSearch() {
  const query = $('#searchInput').value.trim();
  if (!query) return;
  const results = $('#searchResults');
  results.innerHTML = '<p class="empty">检索中…</p>';
  try {
    const payload = await api('/api/search', { method: 'POST', body: { query, topK: 6 } });
    if (payload.hits.length === 0) {
      results.innerHTML = '<p class="empty">没有匹配的题目。</p>';
      return;
    }
    results.innerHTML = payload.hits
      .map(
        (hit, index) => `
      <article class="card">
        <h3>${index + 1}. ${esc(hit.title)}</h3>
        <div class="meta">
          <span class="tag">${esc(hit.subject)}</span>
          <span class="tag">${esc(hit.knowledge)}</span>
          <span class="score">相似度 ${(1 - (hit.distance ?? 0)).toFixed(3)}</span>
        </div>
        <p class="prompt">${esc(hit.metadata?.title ?? '')}</p>
      </article>`,
      )
      .join('');
  } catch (error) {
    results.innerHTML = `<p class="empty">检索失败：${esc(error.message)}</p>`;
  }
}

/* ---------------------------------------------------------------- review */
async function buildPlan() {
  const budgetMinutes = Number($('#budget').value);
  const subject = $('#subjectFilter').value;
  const list = $('#planList');
  const reminders = $('#reminders');
  list.innerHTML = '<p class="empty">生成中…</p>';
  reminders.innerHTML = '';
  try {
    const payload = await api('/api/plan', { method: 'POST', body: { budgetMinutes, subject } });
    if (payload.reminders.length > 0) {
      reminders.innerHTML = payload.reminders
        .map((hit) => `<div class="note">记忆提醒：${esc(hit.text)}</div>`)
        .join('');
    }
    if (payload.plan.length === 0) {
      list.innerHTML = '<p class="empty">题库为空，先录入或载入示例数据。</p>';
      return;
    }
    list.innerHTML = payload.plan
      .map(
        (entry, index) => `
      <article class="card" data-id="${esc(entry.item.id)}">
        <h3>${index + 1}. ${esc(entry.item.title)}</h3>
        <div class="meta">
          <span class="tag">${esc(entry.item.subject)}</span>
          <span class="tag">${esc(entry.item.knowledge)}</span>
          <span class="tag">优先级 ${entry.priority}</span>
          <span>${esc(entry.reason)}</span>
        </div>
        <p class="prompt">${esc(entry.item.prompt)}</p>
        <div class="actions">
          <button class="ok" data-answer="1">答对了</button>
          <button class="bad" data-answer="0">答错了</button>
          <button class="ghost" data-reveal="1">看答案</button>
        </div>
        <p class="answer" hidden>${esc(entry.item.answer)}</p>
      </article>`,
      )
      .join('');
    for (const card of $$('#planList .card')) {
      const answer = card.querySelector('.answer');
      card.querySelector('[data-reveal]').addEventListener('click', () => {
        answer.hidden = !answer.hidden;
      });
      card.querySelectorAll('[data-answer]').forEach((button) =>
        button.addEventListener('click', async () => {
          const correct = button.dataset.answer === '1';
          const result = await api('/api/answer', { method: 'POST', body: { id: card.dataset.id, correct } });
          card.style.opacity = '0.55';
          card.querySelector('.meta').insertAdjacentHTML(
            'beforeend',
            `<span class="tag">掌握度 ${result.weaknessBefore} → ${result.weaknessAfter}</span>`,
          );
          for (const node of card.querySelectorAll('[data-answer]')) node.disabled = true;
          await loadItems();
        }),
      );
    }
  } catch (error) {
    list.innerHTML = `<p class="empty">生成失败：${esc(error.message)}</p>`;
  }
}

/* ---------------------------------------------------------------- memory */
async function queryMemory() {
  const query = $('#memoryQuery').value.trim() || '薄弱点';
  const list = $('#memoryList');
  list.innerHTML = '<p class="empty">查询中…</p>';
  try {
    const payload = await api(`/api/weakpoints?q=${encodeURIComponent(query)}&limit=8`);
    list.innerHTML =
      payload.hits.length === 0
        ? '<p class="empty">还没有记忆。答错一道题后会自动写入。</p>'
        : payload.hits
            .map((hit) => `<div class="item"><small>${esc(hit.text)}</small><span class="score">${hit.score.toFixed(3)}</span></div>`)
            .join('');
  } catch (error) {
    list.innerHTML = `<p class="empty">查询失败：${esc(error.message)}</p>`;
  }
}

/* ---------------------------------------------------------------- add */
$('#addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  try {
    await api('/api/items', { method: 'POST', body: data });
    event.target.reset();
    await loadItems();
    alert('已保存并建立索引');
  } catch (error) {
    alert(`保存失败：${error.message}`);
  }
});

$('#filterInput').addEventListener('input', renderLibrary);
$('#searchBtn').addEventListener('click', runSearch);
$('#searchInput').addEventListener('keydown', (event) => event.key === 'Enter' && runSearch());
$('#planBtn').addEventListener('click', buildPlan);
$('#memoryBtn').addEventListener('click', queryMemory);
$('#memoryQuery').addEventListener('keydown', (event) => event.key === 'Enter' && queryMemory());

await loadItems();
await buildPlan();
await queryMemory();
