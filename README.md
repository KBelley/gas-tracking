# Gas Log

Log a fill-up by voice in about 10 seconds. Tap the mic and say *"48,213 miles, 11.2 gallons, 41.97"*, check the numbers, and tap Save. MPG shows up right away, and the entry goes into a Google Sheet.

- **Installable phone app.** It opens instantly and works **with no signal**: entries made offline wait on the phone and sync by themselves later.
- **Voice first.** You can also type the numbers, or take optional photos of the odometer and pump. Photos can be read by OCR, Gemini or Claude, and are saved to Drive.
- **Your data stays in your own Google Sheet,** with MPG, $/mile and a Summary tab.

```
Phone app (docs/, GitHub Pages)  ──POST JSON──>  Apps Script (src/)  ──>  Google Sheet + Drive photos
  voice / keypad / photos                         token-checked API
  offline outbox (IndexedDB)
```

## Saying the numbers

Labels can come before or after each number, and the order doesn't matter:

| You say | You get |
|---|---|
| "48,213 miles, 11.2 gallons, 41.97" | everything; $/gal is worked out from gallons and total |
| "odometer 48213, gallons 11 point 2, total $41.97" | same |
| "48213, 11.2, 41.97" | same (no labels: the big number is the odometer) |
| "11.2 gallons at 3.49 a gallon" | gallons and price; the total is worked out |

Missed something? Tap the mic again and say just that part, for example "12.3 gallons". You can also tap a box and type, or use your keyboard's mic, which works offline.

If you only topped off, untick **Filled to full**. MPG is measured between full tanks, so a partial fill's gallons count toward your next full fill.

## Setup (one time)

### 1. The sheet and the backend (Apps Script)

1. Create a sheet at [sheets.new](https://sheets.new), then choose **Extensions → Apps Script**.
2. Add the code. Use one of these two methods:
   - **Paste by hand:**
     - Put `src/Code.js` into `Code.gs`.
     - Add script files named `parse` and `stats` and paste in `src/parse.js` and `src/stats.js`.
     - In Project Settings, tick "Show appsscript.json", then paste in `src/appsscript.json`.
   - **clasp:**
     - Run `npm i -g @google/clasp` and then `clasp login`.
     - Put the Script ID (from Project Settings) in `.clasp.json`.
     - Run `npm run push`.
3. In Project Settings, set **Time zone** to your own. The project ships with `America/Chicago`.
4. Run **`setup`** and approve the permissions. It asks for only three (see [Security](#security-and-permissions)). Because it's your own script, choose Advanced → Go to project when warned. `setup` creates:
   - the **Fill-ups** and **Summary** tabs
   - a **Gas Tracker Photos** Drive folder
   - the secret `APP_TOKEN`.
5. Choose **Deploy → New deployment → Web app**, with Execute as **Me** and Who has access **Anyone**. Your Google account isn't exposed: every request needs the token.
6. Run **`phoneSetupLink`** and copy the link from the log. It can't find the URL? Add a Script Property `EXEC_URL` set to the Web app URL (ends in `/exec`) and run it again.

### 2. The phone

1. Open the setup link in **Chrome on your phone**. It saves the connection and removes the token from the address bar.
2. Tap ⋮ → **Install app** (or **Add to Home screen**).
3. The first time you tap the mic, allow microphone access.

Keep the setup link private. If it leaks, run `rotateToken`, then `phoneSetupLink`, and open the new link on your phone.

### Optional: AI photo reading

Photos are read with Google Drive's free OCR by default. For better accuracy on pump displays, add a Script Property:

| `PROVIDER` | Also add | Cost |
|---|---|---|
| `ocr` (default) | nothing | free |
| `gemini` | `GEMINI_API_KEY` from [aistudio.google.com](https://aistudio.google.com); optional `GEMINI_MODEL` (default `gemini-3.6-flash`) | free tier |
| `claude` | `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com) | prepaid credits, roughly a cent per fill-up |

If the AI reader fails, OCR is used instead. Reading photos needs signal; photos taken offline are still attached when the entry syncs.

## Security and permissions

**What the script can access.** These are the only permissions in `src/appsscript.json`, and Google shows exactly these on the approval screen:

| Permission | What it allows | What it can't do |
|---|---|---|
| `spreadsheets.currentonly` | Read and write **the one sheet the script is attached to** | Open any of your other spreadsheets |
| `drive.file` | Create and use **only files the script made itself**: its photo folder, the photos, and temporary OCR docs (deleted right away) | See, read or delete anything else in your Drive, including files you put in its folder yourself |
| `script.external_request` | Make web requests | Reach anything outside `urlFetchWhitelist`: the Drive API, Gemini and Claude |

No Gmail, Calendar, Contacts, or broader Drive, Docs or Sheets access. A test (`test/backend.test.js`) fails if the code starts using a service that would need more.

**Who can call it.**
- The web app has to allow **Anyone** so the phone app can reach it without a Google sign-in. It runs as you, and every request must carry the 256-bit `APP_TOKEN`, which is compared in constant time.
- Requests without the token get the same `unauthorized` reply and do no work; the bare URL returns an empty page.

**What it accepts, even with the token:**
- Numbers must be within sensible ranges.
- Dates must be between 2000 and now.
- Entry IDs must have a fixed format.
- Notes are capped at 500 characters, and anything starting with `=` `+` `-` `@` is stored as plain text, never run as a formula.
- Photos must really be JPEG, PNG or WebP (the file's first bytes are checked) and under 8 MB.

**The phone app:**
- It can only run its own files and only send data to Apps Script (Content Security Policy).
- It refuses setup links that point anywhere other than a `script.google.com/…/exec` URL, so a look-alike link can't redirect your data.
- The token is removed from the address bar as soon as the link is opened, and is kept in the app's private storage.
- Photos are re-encoded on the phone, which removes location (GPS) data.

**Things only you can do:**
- **Don't give anyone edit access to the sheet.** Editors can open the script, read its Script Properties (token, API keys) and change the code. Share as **Viewer** if you share at all.
- Keep 2-step verification on your **Google** and **GitHub** accounts. Whoever controls the GitHub repo controls the app your phone loads.
- If the setup link or your phone is lost, run `rotateToken`, then `phoneSetupLink`, and open the new link. The old token stops working immediately.
- The AI readers are opt-in. With `gemini` or `claude`, photos are sent to Google or Anthropic, and Gemini's free tier may use them to improve Google's models. The default `ocr` keeps everything in your Google account.
- You can check or revoke the script's access at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## The sheet

- **Fill-ups:** Date · Odometer · Gallons · $/gal · Total · Full? · Miles · MPG · $/mile · photo links · Notes · ID.
  - Rows are kept in odometer order, and adding an older entry updates the MPG of the fill-ups after it.
  - If you edit numbers by hand, run `recalculateAll`.
  - The ID column stops a retried sync from adding the same entry twice.
- **Summary:** fill-up count, miles tracked, total spent, average $/gal, average/best/worst MPG, spending in the last 30 days, and spending by month.

## Updating

- **App:** push to `main`. GitHub Pages redeploys, and the phone picks up the new version the next time the app opens.
- **Backend:** run `npm run push` (or paste), then **Deploy → Manage deployments → Edit → New version**. That keeps the same `/exec` URL, so the phone doesn't need a new link.

## Development

Port 3020 is this project's reserved dev port.

```
npm test             # OCR, speech and MPG tests, plus a check that shared copies match
npm run sync         # copy shared/*.js into src/ and docs/shared/ (edit shared/, never the copies)
npm run serve        # app at http://localhost:3020/
npm run serve:mock   # same, plus a fake API; prints a setup link (token "dev") so the
                     # whole app works without Apps Script. GET /mock/network?down=1
                     # drops all requests to simulate no signal (down=0 restores)
npm run icons        # regenerate docs/icons/*.png
```

To compare photo readers, save a few fill-ups with photos from the app, then run `testReaders` in the editor. It runs every reader you have a key for on the last 10 photos the app saved. Photos you upload to Drive by hand aren't visible to it, because of the `drive.file` permission.
