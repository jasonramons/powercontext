/**
 * Small line-based diff so the submission can record "修改前后代码块" without
 * pulling in a dependency. It is a readable unified-style diff, not a patch
 * format meant for `git apply`.
 */
export function unifiedDiff(before, after, file = 'file') {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  const n = a.length;
  const m = b.length;

  // LCS table
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${a[i]}`);
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`-${a[i]}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+${b[j]}`);
    j += 1;
  }

  const changed = lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
  return {
    file,
    changedLines: changed,
    text: `--- a/${file}\n+++ b/${file}\n${lines.join('\n')}`,
  };
}
