// Excelsior reminder sender: Cloudflare Worker.
// - Runs every minute (Cron Trigger "* * * * *"), reads each user's events from Firestore and sends due reminders as web push.
// - POST /test (from the app's Settings → Test button): sends a real push to the calling device, so the whole chain is tested.
// Secrets (Cloudflare → Worker → Settings → Variables and Secrets, type "Secret"):
//   FIREBASE_SA    the Firebase service account JSON (same as the GitHub secret)
//   VAPID_PRIVATE  the VAPID private key (same as the GitHub secret)
// No libraries: Firestore is reached through its REST API and web push is encrypted here (RFC 8291 / RFC 8292).

const VAPID_PUBLIC = 'BCcHdmo8rR4moROkbMK0rxkCCrA5xdjc6r50SzrdDSdU_BCjFKPKS1VqCURkFxjZ7yxKWA9zm95skoHP6chfBIc';
const VAPID_SUB = 'mailto:noreply@excelsior.app';
const ALLOWED_ORIGINS = ['https://saypov.github.io'];
const WINDOW_MIN = 90;      // catch up on reminders that fell due in the last 90 min (e.g. after an outage)
const KEEP_SENT_DAYS = 10;

// ---------- small helpers ----------
const enc = new TextEncoder();
const b64uEnc = buf => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64uDec = str => { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '='.repeat((4 - s.length % 4) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const jsonB64u = obj => b64uEnc(enc.encode(JSON.stringify(obj)));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const quotePath = k => '`' + String(k).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';

// ---------- Google auth (service account → access token) ----------
let saCache = null, tokenCache = null;
function sa(env) {
  if (!saCache) { if (!env.FIREBASE_SA) throw new Error('FIREBASE_SA secret missing'); saCache = JSON.parse(env.FIREBASE_SA); }
  return saCache;
}
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp > now + 120) return tokenCache.token;
  const s = sa(env);
  const der = b64uDec(s.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const unsigned = jsonB64u({ alg: 'RS256', typ: 'JWT' }) + '.' + jsonB64u({
    iss: s.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64uEnc(sig)
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Google auth failed: ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.token;
}

// ---------- Firestore REST ----------
function decode(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decode(f[k]); return o; }
const numVal = n => Number.isInteger(n) ? { integerValue: String(n) } : { doubleValue: n };

class Firestore {
  constructor(env) { this.env = env; this.project = sa(env).project_id; this.root = `projects/${this.project}/databases/(default)/documents`; this.base = 'https://firestore.googleapis.com/v1/' + this.root; }
  async req(path, init = {}) {
    const r = await fetch(this.base + path, { ...init, headers: { authorization: 'Bearer ' + await accessToken(this.env), 'content-type': 'application/json', ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Firestore ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  async userIds() {
    const ids = []; let page = '';
    do {
      const j = await this.req(`/users?showMissing=true&pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
      for (const d of (j.documents || [])) ids.push(d.name.split('/').pop());
      page = j.nextPageToken || '';
    } while (page);
    return ids;
  }
  async getDocs(paths) {   // paths relative to root, e.g. users/x/app/state → {path: data|null}
    const j = await this.req(':batchGet', { method: 'POST', body: JSON.stringify({ documents: paths.map(p => this.root + '/' + p) }) });
    const out = {};
    for (const p of paths) out[p] = null;
    for (const item of j) if (item.found) out[item.found.name.slice(this.root.length + 1)] = decodeFields(item.found.fields || {});
    return out;
  }
  // Set/delete individual keys inside one map field, without touching other keys (like a merge).
  async patchMap(path, field, set, del = []) {
    const keys = Object.keys(set);
    if (!keys.length && !del.length) return;
    const fields = {}; for (const k of keys) fields[k] = set[k] === null ? { nullValue: null } : numVal(set[k]);
    await this.req(':commit', { method: 'POST', body: JSON.stringify({ writes: [{
      update: { name: this.root + '/' + path, fields: { [field]: { mapValue: { fields } } } },
      updateMask: { fieldPaths: [...keys, ...del].map(k => field + '.' + quotePath(k)) }
    }] }) });
  }
}

// ---------- web push (RFC 8291 aes128gcm + RFC 8292 VAPID) ----------
let vapidKey = null; const vapidJwt = {};
async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000);
  const c = vapidJwt[aud];
  if (c && c.exp > now + 600) return c.header;
  if (!vapidKey) {
    if (!env.VAPID_PRIVATE) throw new Error('VAPID_PRIVATE secret missing');
    const pub = b64uDec(VAPID_PUBLIC);
    vapidKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE.trim(), x: b64uEnc(pub.slice(1, 33)), y: b64uEnc(pub.slice(33, 65)), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  const exp = now + 12 * 3600;
  const unsigned = jsonB64u({ typ: 'JWT', alg: 'ES256' }) + '.' + jsonB64u({ aud, exp, sub: VAPID_SUB });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, enc.encode(unsigned));
  const header = `vapid t=${unsigned}.${b64uEnc(sig)}, k=${VAPID_PUBLIC}`;
  vapidJwt[aud] = { exp, header };
  return header;
}
export async function encryptPayload(p256dh, authSecret, plaintext, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const uaPub = b64uDec(p256dh), auth = b64uDec(authSecret);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(plaintext), new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
  return concat(header, asPub, ct);
}
async function sendPush(sub, payload, env) {
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, payload);
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: {
    authorization: await vapidHeader(sub.endpoint, env), 'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream', ttl: '3600', urgency: 'high'
  } });
  const text = r.ok ? '' : (await r.text().catch(() => '')).slice(0, 200);
  return { status: r.status, ok: r.ok, text };
}

// ---------- reminder rules (same as notify/notify.mjs) ----------
export function zoned(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]));
    t += Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return t;
}
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// weekly recurring events (rep 'w') repeat every 7 days from e.d until e.until (inclusive), minus e.skip; e.dn = weeks marked done.
// Only occurrences near now matter (reminders are at most a day before), so expand a few days either side.
function occurrences(list, now) {
  const from = new Date(now - 3 * 864e5).toISOString().slice(0, 10), to = new Date(now + 3 * 864e5).toISOString().slice(0, 10), out = [];
  for (const e of list) {
    if (!e || e.rep !== 'w' || !e.d) { out.push(e); continue; }
    const sk = new Set(e.skip || []), dn = new Set(e.dn || []);
    for (let d = e.d, g = 0; d <= to && (!e.until || d <= e.until) && g < 2000; d = addDays(d, 7), g++)
      if (d >= from && !sk.has(d) && !dn.has(d)) out.push({ ...e, d, done: false });
  }
  return out;
}
const CAT = { class: 'Class', academic: 'Academic', work: 'Jobs & careers', meeting: 'Meeting', social: 'Social', other: 'Other' };
const lead = m => m === 0 ? 'Now' : m < 60 ? `In ${m} min` : m === 60 ? 'In 1 hour' : m === 1440 ? 'Tomorrow' : `In ${Math.round(m / 60)} hours`;
export function remindersFor(e, tz) {
  const rem = e.rem || (e.time ? '60' : 'am');
  if (rem === 'none') return [];
  const out = [], cat = CAT[e.cat] || 'Event', note = e.note ? ' · ' + e.note : '';
  for (const r of String(rem).split('+')) {
    if (e.time && /^\d+$/.test(r)) {
      const m = +r;
      out.push({ key: `${e.id}|${e.d}|${e.time}|${r}`, at: zoned(e.d, e.time, tz) - m * 60000, title: e.title, body: `${lead(m)} · ${e.time} · ${cat}${note}` });
    } else if (!e.time && r === 'am') {
      out.push({ key: `${e.id}|${e.d}|am`, at: zoned(e.d, '09:00', tz), title: e.title, body: `Today · ${cat}${note}` });
    } else if (!e.time && r === 'pm') {
      out.push({ key: `${e.id}|${e.d}|pm`, at: zoned(addDays(e.d, -1), '18:00', tz), title: e.title, body: `Tomorrow · ${cat}${note}` });
    }
  }
  return out;
}

// ---------- the minute job ----------
export async function runReminders(env, now = Date.now()) {
  const fs = new Firestore(env);
  let sentTotal = 0, checked = 0;
  for (const uid of await fs.userIds()) {
    const P = n => `users/${uid}/app/${n}`;
    const docs = await fs.getDocs([P('state'), P('push'), P('pushlog')]);
    const st = docs[P('state')], pu = docs[P('push')], lg = docs[P('pushlog')];
    if (!st || !pu) continue;
    const subs = Object.entries(pu.subs || {}).filter(([, s]) => s && s.endpoint && s.keys);
    if (!subs.length) continue;
    checked++;
    const tz = (subs.find(([, s]) => s.tz) || [, {}])[1].tz || 'Europe/London';
    const del = st.del || {}, sent = (lg && lg.sent) || {};
    const due = [];
    for (const e of occurrences(st.events || [], now)) {
      if (!e || !e.id || !e.d || e.done || del[e.id]) continue;
      for (const r of remindersFor(e, tz)) if (r.at <= now && r.at > now - WINDOW_MIN * 60000 && !sent[r.key]) due.push(r);
    }
    const newSent = {}, dead = new Set();
    for (const r of due) {
      const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.key, url: './#events' });
      let ok = false;
      for (const [dev, s] of subs) {
        if (dead.has(dev)) continue;
        try {
          const res = await sendPush(s, payload, env);
          if (res.ok) ok = true;
          else if (res.status === 404 || res.status === 410) dead.add(dev);
          else console.error('push failed', dev, res.status, res.text);
        } catch (err) { console.error('push error', dev, err.message); }
      }
      newSent[r.key] = now; if (ok) sentTotal++;
    }
    const prune = Object.keys(sent).filter(k => !(k in newSent) && sent[k] < now - KEEP_SENT_DAYS * 864e5);
    await fs.patchMap(P('pushlog'), 'sent', newSent, prune);
    if (dead.size) await fs.patchMap(P('push'), 'subs', Object.fromEntries([...dead].map(d => [d, null])));
  }
  return { checked, sent: sentTotal };
}

// ---------- Firebase ID token check (for /test) ----------
let jwksCache = null;
async function googleKeys() {
  if (jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const j = await r.json();
  const age = +((r.headers.get('cache-control') || '').match(/max-age=(\d+)/) || [, 3600])[1];
  jwksCache = { keys: j.keys || [], exp: Date.now() + Math.min(age, 6 * 3600) * 1000 };
  return jwksCache.keys;
}
export async function verifyIdToken(token, project, keys) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const head = JSON.parse(new TextDecoder().decode(b64uDec(parts[0]))), c = JSON.parse(new TextDecoder().decode(b64uDec(parts[1])));
  if (head.alg !== 'RS256') throw new Error('bad token alg');
  const jwk = keys.find(k => k.kid === head.kid);
  if (!jwk) throw new Error('unknown token key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uDec(parts[2]), enc.encode(parts[0] + '.' + parts[1]))) throw new Error('bad token signature');
  const now = Math.floor(Date.now() / 1000);
  if (c.aud !== project || c.iss !== 'https://securetoken.google.com/' + project) throw new Error('token for another project');
  if (!(c.exp > now) || !(c.iat <= now + 300) || !c.sub) throw new Error('token expired');
  if (c.email_verified !== true) throw new Error('email not verified');
  return c.sub;
}

async function handleTest(request, env) {
  const tok = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let uid;
  try { uid = await verifyIdToken(tok, sa(env).project_id, await googleKeys()); }
  catch (e) { return { status: 401, body: { ok: false, error: 'auth', detail: e.message } }; }
  const body = await request.json().catch(() => ({}));
  const fs = new Firestore(env);
  const pu = (await fs.getDocs([`users/${uid}/app/push`]))[`users/${uid}/app/push`] || {};
  const s = (pu.subs || {})[body.dev];
  if (!s || !s.endpoint || !s.keys) return { status: 404, body: { ok: false, error: 'device-not-registered' } };
  const payload = JSON.stringify({ title: 'Excelsior test', body: 'Sent from the server. Your reminders will arrive like this.', tag: 'excelsior-test', url: './#settings' });
  const res = await sendPush(s, payload, env);
  if (res.status === 404 || res.status === 410) {
    await fs.patchMap(`users/${uid}/app/push`, 'subs', { [body.dev]: null });
    return { status: 410, body: { ok: false, error: 'subscription-expired' } };
  }
  return { status: res.ok ? 200 : 502, body: { ok: res.ok, error: res.ok ? undefined : 'push-service', detail: res.ok ? undefined : `${res.status} ${res.text}` } };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).then(r => console.log(`Checked ${r.checked} user(s), sent ${r.sent} reminder(s).`)));
  },
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const cors = ALLOWED_ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400', vary: 'origin' } : {};
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/test' && request.method === 'POST') {
      let out;
      try { out = await handleTest(request, env); } catch (e) { console.error('test error', e.message); out = { status: 500, body: { ok: false, error: 'server', detail: e.message } }; }
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json', ...cors } });
    }
    return new Response('Excelsior notify: OK', { headers: { 'content-type': 'text/plain' } });
  }
};
