# Shared saving — setup reference

> **✅ Already done.** Shared saving was deployed on 2026-07-28 and is live:
> `LINKS.SAVE_URL` is filled in, the **Links** tab exists, and resolutions save
> for everyone. The header chip reads **"Saving: shared."**
>
> Keep these steps for redeploying, troubleshooting, or rotating the URL.

**What it does:** when anyone clicks **Link**, **Mark returned**, or **Undo**, the
result is written to a **Links** tab in the CageTrack Google Sheet — one shared
record, from any computer, including the hosted site. Without it, resolutions
would save only in the browser that made them.

This runs inside Ethan's Google account, so only he can (re)deploy it.

---

## Step 1 — Open the script editor

1. Open your **CageTrack Google Sheet** (the one with the Checkouts and Returns tabs).
2. In the menu: **Extensions → Apps Script**.
3. A new tab opens with a code editor and a few lines of starter code.

## Step 2 — Paste in the script

1. Select everything in the editor and delete it.
2. Open `apps-script/Code.gs` from the CageTrack folder, copy **all** of it.
3. Paste it into the editor.
4. Click the **save icon** (or Ctrl+S).

## Step 3 — Deploy it as a web app

1. Click **Deploy** (top right) → **New deployment**.
2. Click the **gear icon** next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description:** `CageTrack link saver`
   - **Execute as:** `Me` (your account)
   - **Who has access:** `Anyone`
4. Click **Deploy**.

> **On "Who has access: Anyone":** this is required — the dashboard saves without
> anyone logging in. The URL is long and random, and the script *only* appends rows
> to the Links tab. It can't read or change anything else in your sheet. Still, treat
> the URL like a key: don't post it publicly.

## Step 4 — Approve the permissions

Google will ask you to authorize it (it's your own script writing to your own sheet):

1. Click **Authorize access**, pick your Google account.
2. You'll likely see **"Google hasn't verified this app"** — that's normal for a
   personal script. Click **Advanced** → **Go to CageTrack link saver (unsafe)**.
3. Click **Allow**.

## Step 5 — Copy the URL and paste it into the app

1. Google shows a **Web app URL** ending in `/exec`. Copy it.
2. Open `config.js` in the CageTrack folder.
3. Find this near the top:

   ```js
   LINKS: {
     SAVE_URL: "",       // paste the Apps Script "web app" URL here
   ```

4. Paste the URL between the quotes:

   ```js
   SAVE_URL: "https://script.google.com/macros/s/AKfy..../exec",
   ```

5. Save the file. Then commit and push so the hosted site gets it:

   ```bash
   git add config.js && git commit -m "Turn on shared saving" && git push
   ```

---

> **Rotating the URL:** deploying a *new version* keeps the same URL. To get a
> brand-new URL (and kill the old one), create a **new deployment** instead,
> then paste the new `/exec` URL into `config.js` and push.

## Step 6 — Confirm it worked

1. Reload CageTrack.
2. The chip in the top bar should switch from red **"Saving: this PC only"** to
   green **"Saving: shared"**.
3. Click any tool that's currently out → **Mark returned**.
4. Check the Google Sheet — a **Links** tab should now exist with a new row in it.

If a row shows up, you're done. Every link and mark from either of you now lands
in that one tab.

### If you made saves before doing this
They're not lost. The chip will read **"Saving: shared · N to upload"** — click it,
then click **Upload N now** to push them into the shared sheet.

---

## Troubleshooting

| What you see | What it usually means |
|---|---|
| Chip stays red after reload | `SAVE_URL` wasn't saved, or has a typo / missing quotes. It must end in `/exec`. |
| Chip is green but no row appears | The deployment wasn't set to **Who has access: Anyone**. Redeploy and check that setting. |
| Nothing happens after editing the script later | Apps Script changes only go live on a **new version**: Deploy → Manage deployments → edit → New version. |

## If someone makes a wrong fix
They don't need to touch the sheet. In the **Reviewed** tab, every saved fix has an
**Undo** button — click it, confirm, and it's removed for everyone.

Undo works by adding a "removed" row to the Links tab rather than deleting the
original, so you keep the full history of what was done and what was taken back.
That's why the Links tab grows rows that look like duplicates — that's intended.

**Don't hand-delete rows from the Links tab** unless you're clearing something out
deliberately. Use Undo in the app; it's safer and leaves a trail.
