# Deploying the experiment publicly (for remote participants)

GitHub Pages **cannot** run this experiment: it only serves static files, but
the LLM hints need a server-side proxy so the OpenAI key never reaches the
browser. This guide deploys the whole app (`server.py`) to **Render** (free)
and collects results in a **Google Sheet/Drive** folder.

You do each section once. Total time ~20 minutes.

---

## A. Collect results in Google Drive (do this first)

In the cloud there's no host PC, and Render's free disk is wiped on restart, so
results are forwarded to a Google Apps Script you own. It saves one CSV per
participant into a Drive folder (same format as the local files).

1. Create a folder in **Google Drive** (e.g. `Expra results`). Open it and copy
   the **folder ID** from the URL — the part after `/folders/`.
2. Go to <https://script.google.com> → **New project**.
3. Replace the contents with this, pasting your folder ID:

   ```javascript
   function doPost(e) {
     var data = JSON.parse(e.postData.contents);
     var folder = DriveApp.getFolderById('PASTE_FOLDER_ID_HERE');
     folder.createFile(data.filename, data.csv, MimeType.CSV);
     return ContentService.createTextOutput('ok');
   }
   ```

4. **Deploy** → **New deployment** → type **Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   - Click **Deploy**, authorize when prompted.
5. Copy the **Web app URL** (ends in `/exec`). This is your
   `RESULTS_WEBHOOK_URL`.

Test it later: when a participant finishes, a new CSV should appear in the
folder within seconds.

---

## B. Deploy the app to Render

1. Push your code to GitHub (this repo already contains `render.yaml`).
2. Go to <https://render.com> → sign in with GitHub.
3. **New** → **Blueprint** → pick this repository. Render reads `render.yaml`
   and creates one web service.
4. It will ask you to fill the secret env vars (`sync: false`):
   - `OPENAI_API_KEY` — your real OpenAI key.
   - `ACCESS_TOKEN` — invent a token, e.g. `expra2026-x7k2`. (Participants get
     it in their URL; it blocks random callers from spending your credits.)
   - `RESULTS_WEBHOOK_URL` — the `/exec` URL from section A.
5. Click **Apply / Deploy**. After ~2 min you get a URL like
   `https://expra-hints-experiment.onrender.com`.

> **Free-tier note:** the service sleeps after ~15 min idle, so the first
> participant after a quiet spell waits ~30–60 s for a cold start. Fine for a
> pilot. ~$7/mo upgrades to always-on if needed.

---

## C. Protect your OpenAI budget

The proxy is now public, so before sharing it:

- In the **OpenAI dashboard → Limits**, set a **hard monthly spending cap**
  (e.g. $10). This is your real safety net — do it regardless of anything else.
- The `ACCESS_TOKEN` above keeps casual/bot traffic out, but anyone with the
  participant link has the token, so the spending cap is what actually bounds cost.

---

## D. The link you send participants

Append the access token as `?key=...`:

```
https://expra-hints-experiment.onrender.com/?key=expra2026-x7k2
```

You can still add the usual params:

```
.../?key=expra2026-x7k2&condition=strategy&id=p_001
```

Without a matching `key`, `/api/hint` and `/api/results` return `401` — hints
won't load and results won't forward. (Locally, with no `ACCESS_TOKEN` set, the
check is skipped, so `python server.py` keeps working as before.)

---

## Quick checklist

- [ ] Drive folder created, Apps Script deployed, `/exec` URL copied
- [ ] Render service deployed from `render.yaml`
- [ ] `OPENAI_API_KEY`, `ACCESS_TOKEN`, `RESULTS_WEBHOOK_URL` set in Render
- [ ] OpenAI hard spending cap set
- [ ] Test run end-to-end: hint loads, CSV appears in Drive
- [ ] Share the `?key=...` link
