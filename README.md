# Slack Reminder Generator and Meeting Tracker

Two tools that share one set of rules for reading meeting details and converting them to Bangladesh time.

| | What it does | Where it lives |
|---|---|---|
| **Slack Reminder Generator** (web app) | Reads a meeting screenshot or pasted text and writes the Slack reminder | repository root, deployed to GitHub Pages |
| **Meeting Tracker** (Chrome extension) | Tracks meeting links from any page, reminds you before they start, copies the Slack reminder | `extension/` |

## Web app

Open `index.html` through any static server (for example `npx serve .`), or use the GitHub Pages site.

1. Drop, upload or paste (Ctrl + V) a screenshot. Pasting copied text works too.
2. Check the details. Fields the scan filled in are tinted green until you edit them.
3. The reminder writes itself as soon as email, date, start time and link are present. Copy it, or copy and open Slack. Ctrl + Enter also copies.

If you edit the message by hand, it stops following the form until you press "Rebuild from details".

## Chrome extension

### Install

1. Download `meetingtime-extension.zip` from the footer of the deployed site (or use the `extension/` folder from this repository) and unzip it.
2. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked** and pick the folder.
3. Pin "Meeting Tracker" to the toolbar. Alt + Shift + M opens it.

### Use

- **Track meeting from this page**: open the invite, booking email or calendar event, then press the button. It reads the date, time, time zone, brand, email and the real meeting link behind "Join" buttons. If the page is busy, select the invite text first.
- **Right-click** a meeting link, selected text or the page, and choose a "Track…" entry.
- The popup lists meetings in Bangladesh time with Join, Copy reminder and Copy link.
- A desktop notification appears before each meeting (10 minutes by default) with a Join button. The badge shows how many meetings are left today.
- **Settings** (slider icon): reminder timing, representatives, and the web address of the full tool so the popup can hand a meeting over to it.

Meetings are stored only in the browser. The extension asks for no site access up front; it reads a page only when you click.

## Configuration

`brand-config.js` holds the brand list with each brand's representative and Slack member ID. Both tools read it. People can override representatives in their own browser (web app: Representatives; extension: Settings).

Time zones and recognised meeting providers are at the top of `core.js`.

## Development

```
npm test        # unit tests for parsing, time conversion and the message format
npm run sync    # copy core.js, brand-config.js and fonts into extension/
```

`core.js` and `brand-config.js` are the source of truth; `extension/` keeps copies because an extension can only load files from its own folder. Run `npm run sync` after editing either file. The tests fail if the copies drift, and the deploy workflow syncs, tests and zips the extension on every push to `main`.

| File | Purpose |
|---|---|
| `core.js` | Parsing, time conversion, message building. No DOM, shared everywhere |
| `app.js` | Web app UI and the OCR pipeline (PaddleOCR first, Tesseract as backup) |
| `extension/background.js` | Right-click menu, reminders, badge |
| `extension/capture.js` | Reads meeting details off the current page |
| `extension/store.js` | Extension storage |
| `extension/popup.*`, `extension/options.*` | Extension screens |
