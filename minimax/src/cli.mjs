#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ingestAll } from './ingest.mjs';
import { buildContext, formatContextForPrompt } from './context.mjs';
import { chat, getCallLog } from './minimax.mjs';
import * as pc from './powercontext.mjs';
import { unifiedDiff } from './diff.mjs';
import { runTests, readFile, writeFile, parseModelJson } from './patch.mjs';
import { storeInfo, countChunks, closeStore } from './store.mjs';

const ROOT = process.cwd();
const TARGET_FILE = 'demo/src/pagination.mjs';
const DEFAULT_TASK =
  '修复 paginate 的分页边界缺陷：page 应按 1-based 处理，并补齐 pageSize 范围、非法页码、越界页、不修改入参的校验；保持 pageCount 与既有调用方兼容。';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function systemPrompt(contextText, currentCode) {
  return [
    '你是代码修改助手，需要基于检索到的规格、代码和测试完成一次最小范围修复。',
    '',
    contextText,
    '',
    `当前 ${TARGET_FILE} 的完整内容：`,
    '```js',
    currentCode,
    '```',
    '',
    '要求：',
    `1. 只修改 ${TARGET_FILE}，返回该文件的**完整新内容**（不是 diff）。`,
    '2. 保持导出函数名、参数顺序、返回类型不变。',
    '3. 不得删除或改写已有测试。',
    '4. 只返回 JSON，不要解释：{"files":[{"path":"' + TARGET_FILE + '","content":"<完整内容>"}]}',
  ].join('\n');
}

async function askModel(messages, maxTokens = 3000) {
  return chat(messages, { maxTokens, temperature: 0.1 });
}

async function applyAndTest(files, backups) {
  for (const file of files) {
    const rel = String(file.path || '').replace(/\\/g, '/');
    if (!rel.startsWith('demo/src/')) throw new Error(`refused to write outside demo/src: ${rel}`);
    const full = path.join(ROOT, rel);
    if (!backups.has(rel)) backups.set(rel, readFile(full));
    writeFile(full, file.content);
  }
  return runTests(ROOT);
}

function restore(backups) {
  for (const [rel, content] of backups) {
    writeFile(path.join(ROOT, rel), content);
  }
}

async function fix(task = DEFAULT_TASK) {
  const startedAt = new Date().toISOString();
  const result = { task, startedAt, steps: [] };

  const beforeTests = await runTests(ROOT);
  result.testsBefore = { ok: beforeTests.ok, exitCode: beforeTests.exitCode, elapsedMs: beforeTests.elapsedMs };
  result.steps.push({ step: 'run-tests-before', ...result.testsBefore });

  const scopeId = await pc.ensureScope({
    title: 'MiniMax × OceanBase 分页修复任务',
    summary: 'paginate 1-based 边界缺陷修复；状态可跨进程复用',
    key: 'mm-context-pagination-v1',
  });
  result.scopeId = scopeId;
  result.steps.push({ step: 'powercontext-ensure-scope', scopeId });

  await pc.remember(scopeId, 'observation', `任务开始：${task}`, 'fix-start');
  await pc.remember(scopeId, 'outcome', `修复前测试：exit=${beforeTests.exitCode}，${beforeTests.ok ? '通过' : '失败'}`, 'fix-start');

  const context = await buildContext(task);
  result.context = {
    specs: context.specs.map((s) => `${s.source}:${s.startLine}-${s.endLine}`),
    code: context.code.map((s) => `${s.source}:${s.startLine}-${s.endLine}`),
    tests: context.tests.map((s) => `${s.source}:${s.startLine}-${s.endLine}`),
    retrieved: context.retrieved,
  };
  result.steps.push({ step: 'seekdb-retrieve', ...result.context });

  const currentCode = readFile(path.join(ROOT, TARGET_FILE));
  const messages = [
    { role: 'user', content: systemPrompt(formatContextForPrompt(context), currentCode) },
  ];

  let attempt = 0;
  let lastTests = beforeTests;
  const backups = new Map();
  let applied = [];

  while (attempt < 2) {
    attempt += 1;
    const reply = await askModel(messages);
    result.steps.push({ step: `minimax-attempt-${attempt}`, model: reply.model, latencyMs: reply.latencyMs, usage: reply.usage });

    let parsed;
    try {
      parsed = parseModelJson(reply.content);
    } catch (err) {
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: `上一次输出不是合法 JSON（${err.message}）。请只返回规定的 JSON。` });
      continue;
    }

    const files = (parsed.files ?? []).filter((f) => f && f.path && typeof f.content === 'string');
    if (files.length === 0) {
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: 'JSON 中没有 files[].content，请重新返回完整文件内容。' });
      continue;
    }

    applied = files.map((f) => f.path);
    lastTests = await applyAndTest(files, backups);
    result.steps.push({ step: `run-tests-attempt-${attempt}`, ok: lastTests.ok, exitCode: lastTests.exitCode });

    if (lastTests.ok) break;

    messages.push({ role: 'assistant', content: reply.content });
    messages.push({
      role: 'user',
      content: `修改后测试仍然失败，输出如下（截断）：\n${(lastTests.stdout + lastTests.stderr).slice(-3000)}\n请修正后重新返回完整文件内容 JSON。`,
    });
  }

  const diffs = [];
  for (const [rel, original] of backups) {
    const updated = readFile(path.join(ROOT, rel));
    if (updated !== original) diffs.push(unifiedDiff(original, updated, rel));
  }

  result.changedFiles = applied;
  result.diffs = diffs;
  result.testsAfter = { ok: lastTests.ok, exitCode: lastTests.exitCode, elapsedMs: lastTests.elapsedMs };
  result.steps.push({ step: 'run-tests-after', ...result.testsAfter });

  if (!lastTests.ok) {
    restore(backups);
    result.restored = true;
    await pc.remember(scopeId, 'outcome', `修复失败，已回滚；退出码 ${lastTests.exitCode}`, 'fix-end');
  } else {
    await pc.remember(scopeId, 'decision', `修改 ${applied.join(', ')}，测试通过（exit=0）`, 'fix-end');
    await pc.remember(scopeId, 'next-step', '已修复，可在新会话中读取本 scope 继续验证或提交', 'fix-end');
  }

  result.calls = getCallLog();
  result.store = storeInfo();
  result.chunkCount = await countChunks();
  result.finishedAt = new Date().toISOString();
  writeUsageDoc(result);
  return result;
}

function writeUsageDoc(result) {
  const lines = [];
  lines.push('# 技术使用记录（自动生成）');
  lines.push('');
  lines.push(`- 任务：${result.task}`);
  lines.push(`- 开始：${result.startedAt}　结束：${result.finishedAt}`);
  lines.push(`- PowerContext scope：${result.scopeId}`);
  lines.push(`- seekdb：${result.store.path}（集合 ${result.store.collection}，${result.store.dimension} 维，共 ${result.chunkCount} 个片段）`);
  lines.push('');
  lines.push('## MiniMax 调用记录');
  lines.push('');
  lines.push('| 时间 | 模型 | 延迟 | prompt tokens | completion tokens | 响应摘要 |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const call of result.calls) {
    lines.push(`| ${call.at} | ${call.model} | ${call.latencyMs} ms | ${call.promptTokens ?? '-'} | ${call.completionTokens ?? '-'} | ${String(call.responsePreview).replace(/\|/g, '\\|').slice(0, 80)} |`);
  }
  lines.push('');
  lines.push('## 检索记录（seekdb）');
  lines.push('');
  lines.push('| 类别 | 命中片段 |');
  lines.push('|---|---|');
  lines.push(`| 规格 | ${result.context.specs.join('<br>') || '无'} |`);
  lines.push(`| 代码 | ${result.context.code.join('<br>') || '无'} |`);
  lines.push(`| 测试 | ${result.context.tests.join('<br>') || '无'} |`);
  lines.push('');
  lines.push('## 状态写入（PowerContext）');
  lines.push('');
  lines.push(`- scope：\`${result.scopeId}\``);
  lines.push('- 写入条目：任务开始（observation）、修复前测试结果（outcome）、修改结论（decision）、下一步（next-step）');
  lines.push('- 复用方式：重新执行 `node src/cli.mjs state` 读取同一 scope 的条目，进程重启后仍可读。');
  lines.push('');
  lines.push('## 测试结果');
  lines.push('');
  lines.push(`- 修复前：exit=${result.testsBefore.exitCode}，${result.testsBefore.ok ? '通过' : '失败'}`);
  lines.push(`- 修复后：exit=${result.testsAfter.exitCode}，${result.testsAfter.ok ? '通过' : '失败'}`);
  if (result.restored) lines.push('- 说明：修复后仍失败，已回滚到修改前内容。');
  lines.push('');
  lines.push('## 代码差异');
  lines.push('');
  for (const diff of result.diffs) {
    lines.push(`### ${diff.file}（${diff.changedLines} 行变更）`);
    lines.push('```diff');
    lines.push(diff.text);
    lines.push('```');
    lines.push('');
  }
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(path.join('docs', 'technical-usage.md'), lines.join('\n'), 'utf8');
}

async function main() {
  const cmd = process.argv[2] || 'help';
  if (cmd === 'ingest') {
    const stats = await ingestAll(ROOT);
    console.log(JSON.stringify(stats, null, 2));
  } else if (cmd === 'context') {
    const task = arg('task', DEFAULT_TASK);
    const ctx = await buildContext(task);
    console.log(JSON.stringify(ctx, null, 2));
  } else if (cmd === 'state') {
    const scopeId = arg('scope', '');
    const scope = scopeId || (await pc.ensureScope({
      title: 'MiniMax × OceanBase 分页修复任务',
      summary: 'paginate 1-based 边界缺陷修复；状态可跨进程复用',
      key: 'mm-context-pagination-v1',
    }));
    const entries = await pc.listEntries(scope);
    console.log(JSON.stringify({ scopeId: scope, entries }, null, 2));
  } else if (cmd === 'fix') {
    const task = arg('task', DEFAULT_TASK);
    const result = await fix(task);
    console.log(JSON.stringify({
      ok: result.testsAfter.ok,
      scopeId: result.scopeId,
      changedFiles: result.changedFiles,
      testsBefore: result.testsBefore,
      testsAfter: result.testsAfter,
      context: result.context,
      diffs: result.diffs.map((d) => ({ file: d.file, changedLines: d.changedLines })),
    }, null, 2));
  } else {
    console.log(`用法：
  node src/cli.mjs ingest              导入规格/代码/测试到 seekdb
  node src/cli.mjs context --task "…"  只做上下文检索
  node src/cli.mjs fix --task "…"      检索 → MiniMax 改码 → 跑测试 → 存状态
  node src/cli.mjs state               读取 PowerContext 中的任务状态`);
  }
  await closeStore();
}

main().catch(async (err) => {
  console.error('ERROR', err);
  await closeStore();
  process.exit(1);
});
