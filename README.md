# CageTrack

A standalone internal dashboard for tracking technician cage activity:
check-outs, returns, outstanding items, overdue items, and technician activity.

This is the **MVP**. It runs entirely in the browser (HTML/CSS/JavaScript) —
no login, no backend, no Excel/Graph sync. It starts on **mock data** so you can
see it working, then switches to your **live Google Sheet** with one setting.

---

## Files

| File          | What it does                                                        |
|---------------|---------------------------------------------------------------------|
| `index.html`  | The page layout (KPI cards, filters, tables).                       |
| `styles.css`  | All styling. Clean, mobile-friendly.                                |
| `config.js`   | **The only file you edit to go live.** Settings + column mapping.   |
| `mockData.js` | Sample data so the dashboard works out of the box. Delete when live.|
| `app.js`      | The logic: status rules, KPIs, tables, filters, CSV loading.        |

---

## Adding your Peterman logo

Open `config.js` and find the `BRAND` block at the top. Paste your logo into
`logoUrl` — either a web link or a base64 data string:

```js
BRAND: {
  logoUrl: "https://your-site.com/peterman-logo.png",   // or "data:image/png;base64,...."
  companyName: "Peterman Brothers",
  productName: "CageTrack",
  tagline: "Cage Activity Dashboard",
}
```

Leave `logoUrl: ""` to show the clean text wordmark instead. If the image link
is broken, the dashboard automatically falls back to the wordmark.

## How to run it

Because the app loads several `.js` files, open it through a small local server
(opening `index.html` directly as a file can be blocked by the browser).

Any of these work — pick the easiest:
- Open the folder in VS Code and use the **Live Server** extension.
- If you ever install Python: `python -m http.server` in this folder, then visit the address it prints.
- Host the folder on any static host (Netlify, GitHub Pages, internal web server).

---

## Status logic (how an item's status is decided)

For each row in the sheet:

1. Check-out time exists, return time is **blank** → **Checked Out**
2. Return time **exists** → **Returned**
3. Check-out exists, return blank, **and** more than `RETURN_WINDOW_HOURS` have
   passed → **Overdue**

You set the allowed window in `config.js` (`RETURN_WINDOW_HOURS`, default **48**).

---

## Connecting your live Google Sheet

The simplest method (no API key, no developer account):

1. In Google Sheets: **File → Share → Publish to web**.
2. Choose the correct **tab**, set the format to **CSV**, click **Publish**.
3. Copy the link it gives you.
4. In `config.js`:
   - Set `DATA_SOURCE: "live"`
   - Paste the link into `GOOGLE_SHEET_CSV_URL`
   - Under `COLUMNS`, make the right-hand values match your **exact** sheet
     header names (e.g. if your header is `Tech Name`, set `technician: "Tech Name"`).
5. Refresh the page. The tag in the top bar will read **Live sheet**.

### Your sheet needs (at minimum) these columns
- A **Technician** name
- A **Part/Tool** name
- A **Checkout Timestamp** (date+time)
- A **Return Timestamp** (blank until the item comes back)
- A **Branch** (optional but powers the Branch filter)
- A **Transaction ID** (optional)

> Timestamps should be real date/time values (e.g. `6/25/2026 14:30`). The app
> reads them with the browser's date parser, so a standard date+time format is safest.

---

## What to verify before relying on it

- [ ] Your real column headers are mapped correctly in `config.js`.
- [ ] Timestamps in the sheet parse into real dates (overdue math depends on this).
- [ ] `RETURN_WINDOW_HOURS` matches your actual policy.
- [ ] "Today" uses **your computer's local time** — check the KPIs reflect your timezone.

---

## Not included yet (by design)
Login, user accounts, Microsoft Graph, Excel sync, write-back to the sheet,
notifications, and scheduled automation. These can come after the MVP is in use.
