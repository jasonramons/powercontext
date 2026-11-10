/**
 * Review scheduling.
 *
 * A deliberately small spaced-repetition model: every item carries a mastery
 * score in [0, 1] and a due date. Wrong answers lower mastery and pull the item
 * forward, correct answers raise mastery and push it out. The planner then ranks
 * by "weakness x urgency" so a fixed time budget is spent on the items most
 * likely to be forgotten.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyStats(now = Date.now()) {
  return {
    attempts: 0,
    correct: 0,
    streak: 0,
    mastery: 0.4,
    lastReviewedAt: null,
    intervalDays: 1,
    dueAt: now,
  };
}

export function applyAnswer(stats, correct, now = Date.now()) {
  const next = { ...stats };
  next.attempts += 1;
  if (correct) {
    next.correct += 1;
    next.streak = (stats.streak ?? 0) + 1;
    next.mastery = Math.min(0.98, stats.mastery + 0.12 + 0.03 * Math.min(next.streak, 4));
    next.intervalDays = Math.min(30, Math.max(1, Math.round((stats.intervalDays ?? 1) * 2.1)));
  } else {
    next.streak = 0;
    next.mastery = Math.max(0.05, stats.mastery - 0.2);
    next.intervalDays = 1;
  }
  next.lastReviewedAt = now;
  next.dueAt = now + next.intervalDays * DAY_MS;
  return next;
}

export function weaknessOf(stats) {
  const attempts = stats.attempts ?? 0;
  const correctRate = attempts === 0 ? 0.5 : (stats.correct ?? 0) / attempts;
  const mastery = stats.mastery ?? 0.4;
  // Unseen items are mildly interesting, badly answered items are urgent.
  const uncertainty = attempts === 0 ? 0.45 : 1 - Math.min(attempts, 5) / 5;
  return Math.min(1, Math.max(0, (1 - mastery) * 0.7 + (1 - correctRate) * 0.2 + uncertainty * 0.1));
}

export function urgencyOf(stats, now = Date.now()) {
  const dueAt = stats.dueAt ?? now;
  const overdueDays = (now - dueAt) / DAY_MS;
  return Math.max(0.2, Math.min(2.5, 1 + overdueDays * 0.5));
}

/**
 * Order the queue for one review session.
 *
 * @param {Array} items   study items with `stats`
 * @param {number} budgetMinutes  how long the learner wants to spend
 * @param {number} now
 * @returns {Array} ordered review cards with the reason they were picked
 */
export function planReview(items, budgetMinutes = 20, now = Date.now()) {
  const minutesPerItem = 2;
  const slots = Math.max(1, Math.floor(budgetMinutes / minutesPerItem));
  const scored = items
    .map((item) => {
      const weakness = weaknessOf(item.stats ?? emptyStats(now));
      const urgency = urgencyOf(item.stats ?? emptyStats(now), now);
      return {
        item,
        weakness,
        urgency,
        priority: weakness * urgency,
        due: (item.stats?.dueAt ?? now) <= now,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  // Overdue cards first, then the highest priority tail, so a short session
  // never silently skips something that should already have been reviewed.
  const overdue = scored.filter((entry) => entry.due);
  const fresh = scored.filter((entry) => !entry.due);
  return [...overdue, ...fresh].slice(0, slots).map((entry) => ({
    item: entry.item,
    weakness: Number(entry.weakness.toFixed(3)),
    urgency: Number(entry.urgency.toFixed(3)),
    priority: Number(entry.priority.toFixed(3)),
    reason:
      entry.item.stats?.attempts === 0
        ? '还没复习过'
        : entry.due
          ? `已到期（掌握度 ${(entry.item.stats?.mastery ?? 0).toFixed(2)}）`
          : `掌握度偏低（${(entry.item.stats?.mastery ?? 0).toFixed(2)}）`,
  }));
}
