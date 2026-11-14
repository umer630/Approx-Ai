// Approx's welcome line for an empty chat: warm, brief, professional — never robotic or over-the-top.
// Pure function (no DOM) so it is unit-tested and shared by the web app.

/** A first name we can greet by: the display name, or a name-like email local part (e.g. "umer.khan" → "Umer"). */
export function firstName({ displayName, email } = {}) {
  const fromDisplay = String(displayName || '').trim().split(/\s+/)[0];
  if (fromDisplay) return cap(fromDisplay.slice(0, 24));
  const local = String(email || '').split('@')[0].split(/[._+-]/)[0];
  // Only letters, 2–20 long: "umer" yes, "uq866108" no — a random handle is worse than no name.
  return /^\p{L}{2,20}$/u.test(local) ? cap(local) : '';
}
const cap = (s) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/**
 * @param {{displayName?: string, email?: string, hour?: number, returning?: boolean, day?: number}} o
 *   hour: local hour 0–23 · returning: the person has opened Approx before · day: any integer that changes daily
 * @returns {{ title: string, subtitle: string }}
 */
export function greeting({ displayName, email, hour = new Date().getHours(), returning = false, day = Math.floor(Date.now() / 864e5) } = {}) {
  const n = firstName({ displayName, email });
  const you = n ? `, ${n}` : '';
  const pick = (opts) => opts[Math.abs(day) % opts.length];
  let title;
  if (!returning) title = n ? `Hi ${n} — ready when you are.` : 'Hi — ready when you are.';
  else if (hour >= 5 && hour < 12) title = pick([`Good morning${you}.`, `Morning${you}. Good to see you.`]);
  else if (hour >= 12 && hour < 17) title = pick([`Good afternoon${you}.`, `Good to see you${you}.`]);
  else if (hour >= 17 && hour < 22) title = pick([`Good evening${you}.`, `Welcome back${you}.`]);
  else title = pick([`Still at it${you}?`, `Welcome back${you}.`]);
  const subtitle = !returning ? 'What would you like to work on?'
    : pick(['What are we working on today?', 'What can I help you with today?', 'What’s on your mind?']);
  return { title, subtitle };
}
