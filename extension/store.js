/*
 * MeetingStore: storage for the extension, shared by the popup, the settings
 * page and the background service worker.
 *
 * Meetings and the pending draft stay on this computer (chrome.storage.local).
 * Settings and representatives follow the person's Chrome profile (chrome.storage.sync).
 */
(function (root) {
  "use strict";

  const core = root.MeetingCore;
  const BRAND_CONFIG = Array.isArray(root.BRAND_CONFIG) ? root.BRAND_CONFIG : [];
  const BRANDS = BRAND_CONFIG.map((item) => String(item.brand || "").trim()).filter(Boolean);
  const DEFAULT_SETTINGS = { notify: true, leadMinutes: 10 };
  const KEEP_PAST_DAYS = 7;
  const DRAFT_MAX_AGE_MS = 10 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function getMeetings() {
    const { meetings } = await chrome.storage.local.get({ meetings: [] });
    return (Array.isArray(meetings) ? meetings : []).sort((a, b) => a.startUtc - b.startUtc);
  }

  /* Build a stored meeting from form details. Returns null if the date or time is invalid. */
  function toMeeting(details, existing) {
    const converted = core.convertToDhaka(details);
    if (!converted) return null;
    return {
      id: existing?.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      brand: String(details.brand || ""),
      partnerBrand: core.cleanText(details.partnerBrand),
      email: String(details.email || "").trim(),
      date: details.date,
      time: details.time,
      endTime: details.endTime || "",
      timezone: converted.sourceZone,
      meetingLink: String(details.meetingLink || "").trim(),
      startUtc: converted.startUtc,
      endUtc: converted.endUtc,
      sourceUrl: details.sourceUrl || existing?.sourceUrl || "",
      createdAt: existing?.createdAt || Date.now()
    };
  }

  async function saveMeeting(details, id) {
    const meetings = await getMeetings();
    const index = id ? meetings.findIndex((item) => item.id === id) : -1;
    const meeting = toMeeting(details, index >= 0 ? meetings[index] : null);
    if (!meeting) return null;
    if (index >= 0) meetings[index] = meeting;
    else meetings.push(meeting);
    await chrome.storage.local.set({ meetings });
    return meeting;
  }

  async function deleteMeeting(id) {
    const meetings = await getMeetings();
    await chrome.storage.local.set({ meetings: meetings.filter((item) => item.id !== id) });
  }

  /* Wipe every tracked meeting, plus the pending draft and reminder bookkeeping. */
  function deleteAllMeetings() {
    return Promise.all([chrome.storage.local.set({ meetings: [] }), chrome.storage.local.remove(["draft", "notified"])]);
  }

  /* Drop meetings that ended more than a week ago. */
  async function pruneMeetings() {
    const meetings = await getMeetings();
    const cutoff = Date.now() - KEEP_PAST_DAYS * DAY_MS;
    const kept = meetings.filter((item) => meetingEnd(item) >= cutoff);
    if (kept.length !== meetings.length) await chrome.storage.local.set({ meetings: kept });
  }

  /* A meeting with no end time is treated as lasting 30 minutes. */
  function meetingEnd(meeting) {
    return meeting.endUtc || meeting.startUtc + 30 * 60 * 1000;
  }

  async function getSettings() {
    const { settings } = await chrome.storage.sync.get({ settings: {} });
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    merged.leadMinutes = Math.min(120, Math.max(1, Number(merged.leadMinutes) || DEFAULT_SETTINGS.leadMinutes));
    return { notify: merged.notify !== false, leadMinutes: merged.leadMinutes };
  }

  function saveSettings(settings) {
    return chrome.storage.sync.set({ settings });
  }

  /* Representatives: brand-config.js defaults, overridden by what was saved in settings. */
  async function getRepresentatives() {
    const { representatives } = await chrome.storage.sync.get({ representatives: {} });
    const reps = {};
    BRAND_CONFIG.forEach((item) => {
      const brand = String(item.brand || "").trim();
      const saved = representatives?.[brand];
      reps[brand] = saved
        ? { name: String(saved.name || "").trim(), slackId: core.normalizeSlackId(saved.slackId) }
        : { name: String(item.representativeName || "").trim(), slackId: core.normalizeSlackId(item.slackId) };
    });
    return reps;
  }

  function saveRepresentatives(representatives) {
    return chrome.storage.sync.set({ representatives });
  }

  /* A draft is a meeting captured from the right-click menu, waiting to be reviewed in the popup. */
  function setDraft(details) {
    return chrome.storage.local.set({ draft: { details, createdAt: Date.now() } });
  }

  async function takeDraft() {
    const { draft } = await chrome.storage.local.get({ draft: null });
    if (!draft) return null;
    await chrome.storage.local.remove("draft");
    return Date.now() - draft.createdAt <= DRAFT_MAX_AGE_MS ? draft.details : null;
  }

  async function reminderFor(meeting) {
    const reps = await getRepresentatives();
    return core.buildReminderMessage({ ...meeting, rep: reps[meeting.brand], converted: core.convertToDhaka(meeting) });
  }

  root.MeetingStore = {
    BRANDS, DEFAULT_SETTINGS,
    getMeetings, saveMeeting, deleteMeeting, deleteAllMeetings, pruneMeetings, meetingEnd,
    getSettings, saveSettings, getRepresentatives, saveRepresentatives,
    setDraft, takeDraft, reminderFor
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
