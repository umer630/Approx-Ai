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

/** Per-client limits set by an administrator (null = platform default). */
export async function limitsFor(user) {
  const l = await one('SELECT * FROM user_limits WHERE user_id = ?', user.id);
  let models = {}; try { models = JSON.parse(l?.model_limits || '{}'); } catch { models = {}; }
  return { window: l?.window_limit ?? config.quota.windowLimit, cycle: l?.cycle_limit ?? (config.quota.cycleLimit || null), models,
    overridden: !!l };
}

export async function usageSummary(user) {
  const t = now();
  const lim = await limitsFor(user);
  const winMs = config.quota.windowMinutes * 60_000;
  const winStart = t - winMs;
  const inWindow = await one('SELECT COUNT(*) c, MIN(created_at) first FROM usage_events WHERE user_id = ? AND created_at > ?', user.id, winStart);
  const { start, end } = cycleBounds(user, t);
  const inCycle = (await one('SELECT COUNT(*) c FROM usage_events WHERE user_id = ? AND created_at >= ?', user.id, start)).c;
  return {
    window: {
      minutes: config.quota.windowMinutes,
      limit: lim.window,
      used: inWindow.c,
      remaining: Math.max(0, lim.window - inWindow.c),
      resets_at: inWindow.first ? inWindow.first + winMs : null,
    },
    cycle: {
      days: config.quota.cycleDays,
      started_at: start,
      renews_at: end,
      used: inCycle,
      limit: lim.cycle || null,
    },
    model_limits: lim.models,
    custom_limits: lim.overridden,
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
  const modelLimit = u.model_limits?.[modelId];
  if (modelLimit != null) {
    const used = (await one('SELECT COUNT(*) c FROM usage_events WHERE user_id = ? AND model_id = ? AND created_at >= ?', user.id, modelId, u.cycle.started_at)).c;
    if (used >= modelLimit) {
      throw new HttpError(429, 'model_quota_exceeded', `You have used this model's limit for the current usage cycle (${modelLimit} requests).`,
        { retryAfter: Math.ceil((u.cycle.renews_at - now()) / 1000), usage: u });
    }
  }
  await run('INSERT INTO usage_events (user_id,source,model_id,mode,request_id,created_at) VALUES (?,?,?,?,?,?)',
    user.id, source, modelId, mode, requestId, now());
}
