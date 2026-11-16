# Publishing Meeting Tracker privately on the Chrome Web Store

Everything to paste into the Chrome Web Store developer dashboard. Publishing has to be done from a Google account your organisation controls; it cannot be done from this repository.

## Steps

1. Sign in to the Chrome Web Store developer dashboard with a company Google account and complete developer registration (one-time fee).
2. Choose **Add new item** and upload `meetingtime-extension.zip` (the zipped contents of `extension/`, with `manifest.json` at the top level).
3. Fill in **Store listing**, **Privacy** and **Distribution** using the text below. Upload the two screenshots in this folder (1280 × 800) and `extension/icons/icon-128.png` as the store icon.
4. Under **Distribution → Visibility** choose **Private**, then either your Google Workspace domain or a list of trusted testers.
5. Submit for review. Once approved, share the store link; installs then update automatically whenever a new version is approved.

For each later release: raise `version` in `extension/manifest.json`, zip, upload as a new package, submit.

## Store listing

**Name:** Meeting Tracker for Slack Reminders

**Summary (132 characters max):**
Track meeting links from any page, see them in Bangladesh time, and copy the Slack reminder in one click.

**Category:** Workflow & Planning

**Language:** English

**Description:**
Meeting Tracker keeps partner meetings in one place for the team.

Open an invite, booking email or calendar event and click "Track meeting from this page". The extension reads the date, time, time zone, brand, contact email and meeting link, then shows them for you to check before saving. You can also right-click a meeting link and choose "Track this meeting".

- Meetings are listed in Bangladesh Standard Time, converted from UK time with daylight saving handled.
- A desktop notification appears before each meeting, with a Join button.
- One click copies the team's standard Slack reminder message.
- Each meeting shows where its link really goes, and links that are not a known meeting provider are flagged.

Meetings are stored only in your browser. The extension makes no network requests and reads a page only when you ask it to.

## Privacy tab

**Single purpose:**
Track upcoming meetings (date, time and join link) captured from a page the user chooses, show them in Bangladesh time, and produce a Slack reminder message for each.

**Permission justifications**

| Permission | Justification |
|---|---|
| `activeTab` | Read the meeting details from the current tab, only after the user clicks the extension button or its right-click menu entry. |
| `scripting` | Run the one-off reader that collects the visible text and link addresses from that tab. No script is injected at any other time. |
| `storage` | Save the tracked meetings and the user's settings in the browser. |
| `alarms` | Schedule the reminder shortly before each meeting and refresh the toolbar badge. |
| `notifications` | Show the reminder with a Join button. |
| `contextMenus` | Offer "Track this meeting" in the right-click menu. |

**Host permissions:** none requested.

**Remote code:** No. All code is included in the package. The content security policy blocks every network connection from the extension's pages.

**Data usage:** The extension reads page text and link addresses (website content) and may store an email address the user confirms (personally identifiable information). This data stays in the browser's extension storage. It is not transmitted, sold, or used for any purpose other than the single purpose above. Settings and representative names use Chrome's own sync storage if the user has Chrome sync turned on.

**Privacy policy URL:** host `PRIVACY.md` from this folder (for example on the GitHub Pages site) and paste its address.
