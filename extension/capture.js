/*
 * Reading a meeting off the current page.
 *
 * captureMeetingContext() is injected into the page (it must stay
 * self-contained: no references to anything outside its own body).
 * detailsFromCapture() then runs in the extension and turns what it
 * returned into reminder details.
 */
(function (root) {
  "use strict";

  function captureMeetingContext() {
    const isVisible = (node) => node && node.getClientRects().length > 0;
    const textOf = (node) => (node?.innerText || "").trim();

    // The most specific container that holds the meeting, per app; then generic fallbacks.
    const scopeSelectors = [
      "#xDetDlg",                        // Google Calendar event bubble
      '[role="dialog"]',                 // event dialogs and booking confirmations
      ".a3s",                            // Gmail message body
      '[aria-label="Message body"]',     // Outlook on the web
      '[aria-label="Reading Pane"]',
      "article",
      "main",
      '[role="main"]'
    ];
    let scope = null;
    for (const selector of scopeSelectors) {
      const matches = [...document.querySelectorAll(selector)].filter((node) => isVisible(node) && textOf(node).length > 40);
      if (matches.length) {
        scope = matches[matches.length - 1]; // in a mail thread the newest message is last
        break;
      }
    }
    scope = scope || document.body;

    const linksIn = (node) => [...node.querySelectorAll("a[href]")]
      .map((anchor) => anchor.href)
      .filter((href) => /^https?:\/\//i.test(href))
      .slice(0, 400);

    // A Gmail subject line often names the partner or brand, so keep it with the body.
    const heading = textOf(document.querySelector("h2.hP")) || "";
    return {
      selection: String(window.getSelection ? window.getSelection() : "").trim().slice(0, 20000),
      text: `${heading}\n${textOf(scope)}`.trim().slice(0, 20000),
      scopeLinks: linksIn(scope),
      pageLinks: scope === document.body ? [] : linksIn(document.body),
      title: document.title,
      url: location.href
    };
  }

  function detailsFromCapture(capture, brands) {
    const core = root.MeetingCore;
    const text = capture.selection || capture.text || "";
    const details = core.extractReminderDetails(text, brands);
    const firstMeetingLink = (links) => (links || []).map(core.cleanUrlCandidate).find(core.isMeetingUrl) || "";

    // Real link targets beat anything read out of the visible text.
    details.meetingLink = firstMeetingLink(capture.scopeLinks)
      || (core.isMeetingUrl(details.meetingLink) ? details.meetingLink : "")
      || firstMeetingLink(capture.pageLinks)
      || (core.isMeetingUrl(capture.url) ? capture.url : "");
    if (!details.brand) details.brand = core.extractBrand(capture.title, brands);
    details.sourceUrl = capture.url || "";
    return details;
  }

  /* Run the capture in a tab. Throws on pages Chrome keeps off limits (chrome://, the Web Store, PDFs). */
  async function captureFromTab(tabId, brands) {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: captureMeetingContext });
    if (!injection?.result) throw new Error("The page returned nothing to read.");
    return detailsFromCapture(injection.result, brands);
  }

  root.MeetingCapture = { captureMeetingContext, detailsFromCapture, captureFromTab };
})(typeof globalThis !== "undefined" ? globalThis : this);
