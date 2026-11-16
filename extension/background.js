/*
 * Background service worker: right-click menu, meeting reminders
 * (alarms + notifications) and the toolbar badge.
 */
importScripts("brand-config.js", "core.js", "store.js", "capture.js");

const core = globalThis.MeetingCore;
const store = globalThis.MeetingStore;
const capture = globalThis.MeetingCapture;

const ALARM_PREFIX = "meeting:";
const TICK_ALARM = "tick";
const MENU_ID = "track-meeting";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: "Track this meeting", contexts: ["page", "selection", "link"] });
  });
  refresh();
});
chrome.runtime.onStartup.addListener(refresh);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.meetings || changes.settings || changes.draft) refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) refresh();
  else if (alarm.name.startsWith(ALARM_PREFIX)) notifyMeeting(alarm.name.slice(ALARM_PREFIX.length));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  let details = {};
  try {
    if (info.linkUrl || info.selectionText) {
      // Right-clicked a link or a selection: read just that. A selection around
      // a link usually carries the date and time too.
      details = core.extractReminderDetails(info.selectionText || "", store.BRANDS);
      if (info.linkUrl) details.meetingLink = core.cleanUrlCandidate(info.linkUrl);
      else if (!core.isMeetingUrl(details.meetingLink)) details.meetingLink = "";
    } else if (tab?.id) {
      details = await capture.captureFromTab(tab.id, store.BRANDS);
    }
  } catch (error) {
    console.warn("Could not read the page.", error);
  }
  details.sourceUrl = details.sourceUrl || info.pageUrl || "";
  await store.setDraft(details);
  // Open the popup so the details can be checked and saved. Where Chrome refuses
  // (older versions, unfocused window) the badge shows a draft is waiting.
  try {
    await chrome.action.openPopup();
  } catch (error) {
    await updateBadge();
  }
});

chrome.notifications.onClicked.addListener(openMeetingFromNotification);
chrome.notifications.onButtonClicked.addListener(openMeetingFromNotification);

async function openMeetingFromNotification(notificationId) {
  if (!notificationId.startsWith(ALARM_PREFIX)) return;
  const meetings = await store.getMeetings();
  const meeting = meetings.find((item) => item.id === notificationId.slice(ALARM_PREFIX.length));
  if (meeting?.meetingLink) await chrome.tabs.create({ url: meeting.meetingLink });
  chrome.notifications.clear(notificationId);
}

/* Bring alarms and the badge in line with what is stored. Safe to call at any time. */
async function refresh() {
  await store.pruneMeetings();
  await Promise.all([syncAlarms(), updateBadge()]);
}

async function syncAlarms() {
  const [meetings, settings, alarms, notified] = await Promise.all([
    store.getMeetings(), store.getSettings(), chrome.alarms.getAll(), getNotified()
  ]);
  const now = Date.now();
  const wanted = new Map();
  if (settings.notify) {
    // A meeting that was already announced is not announced again unless its start time changes.
    meetings.filter((meeting) => meeting.startUtc > now && notified[meeting.id] !== meeting.startUtc).forEach((meeting) => {
      wanted.set(ALARM_PREFIX + meeting.id, Math.max(now + 1000, meeting.startUtc - settings.leadMinutes * 60000));
    });
  }

  await Promise.all(alarms
    .filter((alarm) => alarm.name.startsWith(ALARM_PREFIX) && wanted.get(alarm.name) !== alarm.scheduledTime)
    .map((alarm) => chrome.alarms.clear(alarm.name)));
  const existing = new Map(alarms.map((alarm) => [alarm.name, alarm.scheduledTime]));
  wanted.forEach((when, name) => {
    if (existing.get(name) !== when) chrome.alarms.create(name, { when });
  });
  if (!existing.has(TICK_ALARM)) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 15 });

  const ids = new Set(meetings.map((meeting) => meeting.id));
  const stillRelevant = Object.fromEntries(Object.entries(notified).filter(([id]) => ids.has(id)));
  if (Object.keys(stillRelevant).length !== Object.keys(notified).length) await chrome.storage.local.set({ notified: stillRelevant });
}

async function getNotified() {
  const { notified } = await chrome.storage.local.get({ notified: {} });
  return notified || {};
}

async function notifyMeeting(id) {
  const [meetings, settings] = await Promise.all([store.getMeetings(), store.getSettings()]);
  const meeting = meetings.find((item) => item.id === id);
  // Skip if it was deleted, reminders were switched off, or the computer woke long after it began.
  if (!meeting || !settings.notify || Date.now() > meeting.startUtc + 5 * 60000) return;

  const notified = await getNotified();
  await chrome.storage.local.set({ notified: { ...notified, [id]: meeting.startUtc } });

  const converted = core.convertToDhaka(meeting);
  const minutes = Math.max(0, Math.round((meeting.startUtc - Date.now()) / 60000));
  const who = [meeting.brand, meeting.partnerBrand].filter(Boolean).join(" with ") || "Meeting";
  chrome.notifications.create(ALARM_PREFIX + id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: minutes > 0 ? `${who} starts in ${minutes} min` : `${who} is starting now`,
    message: `${core.formatTimeForMessage(converted.time)} Bangladesh time${core.meetingProvider(meeting.meetingLink) ? ` on ${core.meetingProvider(meeting.meetingLink)}` : ""}`,
    buttons: meeting.meetingLink ? [{ title: "Join meeting" }] : [],
    priority: 2,
    requireInteraction: true
  });
  updateBadge();
}

/* Badge: a "+" while a right-click capture waits for review, otherwise how many meetings are left today. */
async function updateBadge() {
  const [{ draft }, meetings] = await Promise.all([chrome.storage.local.get({ draft: null }), store.getMeetings()]);
  if (draft) {
    await chrome.action.setBadgeBackgroundColor({ color: "#10231a" });
    await chrome.action.setBadgeText({ text: "+" });
    return;
  }
  const now = Date.now();
  const today = core.formatDateTimeInZone(new Date(now), core.TARGET_ZONE).date;
  const left = meetings.filter((meeting) => store.meetingEnd(meeting) > now
    && core.formatDateTimeInZone(new Date(meeting.startUtc), core.TARGET_ZONE).date === today).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#1b6e28" });
  await chrome.action.setBadgeText({ text: left ? String(left) : "" });
}
