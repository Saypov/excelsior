// Excelsior reminder sender — run by GitHub Actions every few minutes.
// Reads each user's events from Firestore and sends due reminders as web push notifications.
// Secrets (GitHub → Settings → Secrets → Actions): FIREBASE_SA (service account JSON), VAPID_PRIVATE.
import admin from 'firebase-admin';
import webpush from 'web-push';

const VAPID_PUBLIC = 'BCcHdmo8rR4moROkbMK0rxkCCrA5xdjc6r50SzrdDSdU_BCjFKPKS1VqCURkFxjZ7yxKWA9zm95skoHP6chfBIc';
const WINDOW_MIN = 90;            // send reminders that fell due in the last 90 min (GitHub schedules can be late)
const KEEP_SENT_DAYS = 10;

if (!process.env.FIREBASE_SA || !process.env.VAPID_PRIVATE) {
  console.log('Secrets not set yet (FIREBASE_SA, VAPID_PRIVATE): skipping.'); process.exit(0);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
webpush.setVapidDetails('mailto:noreply@excelsior.app', VAPID_PUBLIC, process.env.VAPID_PRIVATE);
const db = admin.firestore();

// local date+time in a time zone -> UTC ms
function zoned(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]));
    const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    t += Date.UTC(y, m - 1, d, hh, mm) - asLocal;
  }
  return t;
}
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const CAT = { class: 'Class', academic: 'Academic', work: 'Jobs & careers', meeting: 'Meeting', social: 'Social', other: 'Other' };
const lead = m => m === 0 ? 'Now' : m < 60 ? `In ${m} min` : m === 60 ? 'In 1 hour' : m === 1440 ? 'Tomorrow' : `In ${Math.round(m / 60)} hours`;

function remindersFor(e, tz) {
  const rem = e.rem || (e.time ? '60' : 'am');
  if (rem === 'none') return [];
  const out = [], cat = CAT[e.cat] || 'Event';
  for (const r of rem.split('+')) {
    if (e.time && /^\d+$/.test(r)) {
      const m = +r, at = zoned(e.d, e.time, tz) - m * 60000;
      out.push({ key: `${e.id}|${e.d}|${e.time}|${r}`, at, title: e.title, body: `${lead(m)} · ${m === 1440 ? e.time + ' · ' : e.time + ' · '}${cat}${e.note ? ' · ' + e.note : ''}` });
    } else if (!e.time && r === 'am') {
      out.push({ key: `${e.id}|${e.d}|am`, at: zoned(e.d, '09:00', tz), title: e.title, body: `Today · ${cat}${e.note ? ' · ' + e.note : ''}` });
    } else if (!e.time && r === 'pm') {
      out.push({ key: `${e.id}|${e.d}|pm`, at: zoned(addDays(e.d, -1), '18:00', tz), title: e.title, body: `Tomorrow · ${cat}${e.note ? ' · ' + e.note : ''}` });
    }
  }
  return out;
}

const now = Date.now();
let sentTotal = 0;
const users = await db.collection('users').listDocuments();
for (const u of users) {
  const [stS, puS, lgS] = await Promise.all(['state', 'push', 'pushlog'].map(n => u.collection('app').doc(n).get()));
  if (!stS.exists || !puS.exists) continue;
  const st = stS.data(), subs = Object.entries((puS.data().subs) || {}).filter(([, s]) => s && s.endpoint);
  if (!subs.length) continue;
  const tz = (subs.find(([, s]) => s.tz) || [, {}])[1].tz || 'Europe/London';
  const del = st.del || {}, sent = (lgS.exists && lgS.data().sent) || {};
  const due = [];
  for (const e of (st.events || [])) {
    if (!e || !e.d || e.done || del[e.id]) continue;
    for (const r of remindersFor(e, tz)) if (r.at <= now && r.at > now - WINDOW_MIN * 60000 && !sent[r.key]) due.push(r);
  }
  const dead = [];
  for (const r of due) {
    const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.key, url: './#events' });
    let ok = false;
    for (const [dev, s] of subs) {
      if (dead.includes(dev)) continue;
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600 }); ok = true; }
      catch (err) { if (err.statusCode === 404 || err.statusCode === 410) dead.push(dev); else console.error('push failed', err.statusCode || err.message); }
    }
    sent[r.key] = now; if (ok) sentTotal++;
  }
  for (const k of Object.keys(sent)) if (sent[k] < now - KEEP_SENT_DAYS * 864e5) delete sent[k];
  if (due.length || !lgS.exists) await u.collection('app').doc('pushlog').set({ sent });
  if (dead.length) await u.collection('app').doc('push').set({ subs: Object.fromEntries(dead.map(d => [d, null])) }, { merge: true });
}
console.log(`Checked ${users.length} user(s), sent ${sentTotal} reminder(s).`);
process.exit(0);
