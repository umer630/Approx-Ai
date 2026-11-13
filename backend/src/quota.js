// Server-authoritative quota (spec §25): 100 AI requests per rolling 60 minutes,
// usage cycle renews every 2 days (cycle anchored at account creation).
import { one, run, now } from './db.js';
import { HttpError } from './http.js';
import { config } from './config.js';

export function cycleBounds(user, t = now()) {
  const len = config.quota.cycleDays * 86400_000;
  const n = Math.floor((t - user.created_at) / len);
  const start = user.created_at + n * len;
  return { start, end: start + len };
}

export async function usageSummary(user) {
  const t = now();
  const winMs = config.quota.windowMinutes * 60_000;
  const winStart = t - winMs;
  const inWindow = await one('SELECT COUNT(*) c, MIN(created_at) first FROM usage_events WHERE user_id = ? AND created_at > ?', user.id, winStart);
  const { start, end } = cycleBounds(user, t);
  const inCycle = (await one('SELECT COUNT(*) c FROM usage_events WHERE user_id = ? AND created_at >= ?', user.id, start)).c;
  return {
    window: {
      minutes: config.quota.windowMinutes,
      limit: config.quota.windowLimit,
      used: inWindow.c,
      remaining: Math.max(0, config.quota.windowLimit - inWindow.c),
      resets_at: inWindow.first ? inWindow.first + winMs : null,
    },
    cycle: {
      days: config.quota.cycleDays,
      started_at: start,
      renews_at: end,
      used: inCycle,
      limit: config.quota.cycleLimit || null,
    },
  };
}

/** Atomically check and record one AI request. Throws 429 when over quota. */
export async function consumeQuota(user, { source, modelId, mode, requestId }) {
  const u = await usageSummary(user);
  if (u.window.used >= u.window.limit) {
    throw new HttpError(429, 'quota_exceeded', `Quota reached: ${u.window.limit} AI requests per ${u.window.minutes} minutes.`,
      { retryAfter: Math.max(1, Math.ceil(((u.window.resets_at || now()) - now()) / 1000)), usage: u });
  }
  if (u.cycle.limit && u.cycle.used >= u.cycle.limit) {
    throw new HttpError(429, 'cycle_quota_exceeded', 'Usage cycle limit reached; it renews automatically.',
      { retryAfter: Math.ceil((u.cycle.renews_at - now()) / 1000), usage: u });
  }
  await run('INSERT INTO usage_events (user_id,source,model_id,mode,request_id,created_at) VALUES (?,?,?,?,?,?)',
    user.id, source, modelId, mode, requestId, now());
}
