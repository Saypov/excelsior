# Excelsior reminder Worker (Cloudflare)

`worker.js` is the main reminder sender. It is a single file with no dependencies, pasted into the Cloudflare dashboard.

- **Cron Trigger `* * * * *`**: every minute it reads `users/*/app/{state,push,pushlog}` through the Firestore REST API and sends due reminders as web push. It logs each one in `pushlog.sent` (merge writes, one key per reminder).
- **`POST /test`**: called by the app's Settings → Test button with `Authorization: Bearer <Firebase ID token>` and `{dev}`. It verifies the token (project, expiry, verified email), then sends a real push to that device. CORS allows only `https://saypov.github.io`.
- **Secrets** (Worker → Settings → Variables and Secrets, type Secret): `FIREBASE_SA` (service account JSON) and `VAPID_PRIVATE`. These are the same values as the GitHub secrets. Never put them in code.
- **Backup:** `notify/notify.mjs` on GitHub Actions still runs (roughly hourly). It only sends reminders still unsent 3+ minutes after they fell due.
- **Rollback:** delete the Worker in Cloudflare. The pre-Worker version of everything is branch `backup-v4.0.24`.
- **To update:** edit `worker.js` here, then paste it into the dashboard editor and Deploy.
