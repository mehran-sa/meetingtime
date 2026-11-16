"use strict";

/* Popup: the list of tracked meetings and the add/edit form. */

const core = globalThis.MeetingCore;
const store = globalThis.MeetingStore;
const capture = globalThis.MeetingCapture;

const FIELDS = ["brand", "partnerBrand", "email", "date", "time", "endTime", "timezone", "meetingLink"];
const el = {};
const state = { meetings: [], settings: store.DEFAULT_SETTINGS, tab: null, editingId: null, sourceUrl: "", toastTimer: null };

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.querySelectorAll("[id]").forEach((node) => { el[node.id] = node; });
  el.brand.replaceChildren(...store.BRANDS.map((brand) => new Option(brand, brand)));
  el.timezone.replaceChildren(...core.orderedTimezones().map((zone) => new Option(zone.shortLabel, zone.id)));
  bindEvents();

  const [meetings, settings, tabs, draft] = await Promise.all([
    store.getMeetings(), store.getSettings(), chrome.tabs.query({ active: true, currentWindow: true }), store.takeDraft()
  ]);
  state.meetings = meetings;
  state.settings = settings;
  state.tab = tabs[0] || null;

  renderList();
  if (draft) openForm(draft, { captured: true });
  // Keep "starts in 5 min" labels honest while the popup stays open.
  window.setInterval(() => { if (!el.listView.hidden) renderList(); }, 30000);
}

function bindEvents() {
  el.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  el.captureBtn.addEventListener("click", captureCurrentTab);
  el.addBtn.addEventListener("click", () => openForm({}));
  el.cancelBtn.addEventListener("click", showList);
  el.deleteBtn.addEventListener("click", deleteEditedMeeting);
  el.meetingList.addEventListener("click", handleListClick);
  el.meetingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveForm();
  });
  FIELDS.forEach((key) => {
    el[key].addEventListener("input", () => {
      el[key].classList.remove("autofilled", "invalid");
      el.formError.hidden = true;
      renderFormTicket();
    });
  });
}

/* ---------- list ---------- */

function renderList() {
  const now = Date.now();
  const today = dhakaDate(now);
  const upcoming = state.meetings.filter((meeting) => store.meetingEnd(meeting) > now);
  const past = state.meetings.filter((meeting) => store.meetingEnd(meeting) <= now).reverse();
  const todays = upcoming.filter((meeting) => dhakaDate(meeting.startUtc) === today);
  const later = upcoming.filter((meeting) => dhakaDate(meeting.startUtc) !== today);

  const group = (title, meetings) => (meetings.length
    ? `<h2 class="section-title">${title}</h2>${meetings.map((meeting) => meetingCard(meeting, now)).join("")}` : "");
  el.meetingList.innerHTML = [
    group("Today", todays),
    group("Coming up", later),
    !upcoming.length ? '<div class="empty"><strong>No meetings coming up</strong>Open the invite or booking email, then press the button above.</div>' : "",
    past.length ? `<details class="past"><summary>Earlier meetings (${past.length})</summary>${past.map((meeting) => meetingCard(meeting, now)).join("")}</details>` : ""
  ].join("");
}

function meetingCard(meeting, now) {
  const converted = core.convertToDhaka(meeting);
  const isPast = store.meetingEnd(meeting) <= now;
  const isLive = !isPast && meeting.startUtc <= now;
  const provider = core.meetingProvider(meeting.meetingLink);
  const title = [meeting.brand, meeting.partnerBrand].filter(Boolean).join(" with ") || "Meeting";

  let status = "";
  if (isLive) status = "<strong>Happening now</strong>";
  else if (!isPast) status = `<strong>${escapeHtml(countdown(meeting.startUtc - now))}</strong>`;
  // Always show where the link really goes; flag it when it is not a known meeting provider.
  const host = linkHost(meeting.meetingLink);
  const where = provider
    ? `on ${escapeHtml(provider)} (${escapeHtml(host)})`
    : `<span class="link-flag">Check link: ${escapeHtml(host || "not a web address")}</span>`;

  return `
    <article class="meeting ${isPast ? "is-past" : ""}" data-id="${escapeHtml(meeting.id)}">
      <div class="meeting-when">
        <span class="meeting-time">${escapeHtml(core.formatTimeForMessage(converted.time))}</span>
        <span class="meeting-date">${escapeHtml(dayLabel(converted.date, now))}</span>
      </div>
      <div class="meeting-body">
        <div class="meeting-title">${escapeHtml(title)}</div>
        <div class="meeting-sub" title="${escapeHtml(meeting.meetingLink)}">${[status, where].filter(Boolean).join(" ")}</div>
        <div class="meeting-actions">
          ${isPast ? "" : '<button class="btn btn-dark btn-small" type="button" data-action="join">Join</button>'}
          <button class="text-btn" type="button" data-action="copy">Copy reminder</button>
          <button class="text-btn" type="button" data-action="edit">Edit</button>
        </div>
      </div>
    </article>`;
}

async function handleListClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const meeting = state.meetings.find((item) => item.id === button.closest("[data-id]").dataset.id);
  if (!meeting) return;

  if (button.dataset.action === "join") chrome.tabs.create({ url: meeting.meetingLink });
  else if (button.dataset.action === "copy") await copyText(await store.reminderFor(meeting), "Reminder copied. Paste it in Slack.");
  else openForm(meeting, { id: meeting.id });
}

/* ---------- capture ---------- */

async function captureCurrentTab() {
  el.captureBtn.disabled = true;
  try {
    if (!state.tab?.id) throw new Error("No active tab.");
    openForm(await capture.captureFromTab(state.tab.id, store.BRANDS), { captured: true });
  } catch (error) {
    console.warn(error);
    openForm({}, { warning: "Chrome doesn't allow reading this page. Fill in the details by hand." });
  } finally {
    el.captureBtn.disabled = false;
  }
}

/* ---------- form ---------- */

function openForm(details, { id = null, captured = false, warning = "" } = {}) {
  state.editingId = id;
  state.sourceUrl = details.sourceUrl || "";
  el.meetingForm.reset();
  FIELDS.forEach((key) => {
    const field = el[key];
    field.classList.remove("autofilled", "invalid");
    const value = details[key];
    if (!value) return;
    if (field.tagName === "SELECT" && ![...field.options].some((option) => option.value === value)) return;
    field.value = value;
    if (captured) field.classList.add("autofilled");
  });

  el.formTitle.textContent = id ? "Edit meeting" : captured ? "Check the details" : "Add a meeting";
  el.formError.hidden = true;
  el.deleteBtn.hidden = !id;
  el.deleteBtn.textContent = "Delete this meeting";
  delete el.deleteBtn.dataset.armed;

  let hint = warning;
  let isWarning = Boolean(warning);
  if (captured) {
    const missing = [["meetingLink", "meeting link"], ["date", "date"], ["time", "start time"]]
      .filter(([key]) => !details[key]).map(([, label]) => label);
    if (missing.length === 3) hint = "Nothing found on this page. Select the invite text first and try again, or fill it in by hand.";
    else if (missing.length) hint = `Still to add: ${missing.join(", ")}.`;
    else hint = "Details found. Check them, then save.";
    isWarning = missing.length > 0;
  }
  el.formHint.textContent = hint;
  el.formHint.hidden = !hint;
  el.formHint.classList.toggle("warn", isWarning);

  el.listView.hidden = true;
  el.formView.hidden = false;
  renderFormTicket();
  const firstEmpty = ["meetingLink", "date", "time"].find((key) => !el[key].value);
  if (firstEmpty) el[firstEmpty].focus();
}

function showList() {
  el.formView.hidden = true;
  el.listView.hidden = false;
  renderList();
}

function readForm() {
  const details = Object.fromEntries(FIELDS.map((key) => [key, el[key].value.trim()]));
  if (details.meetingLink) details.meetingLink = core.cleanUrlCandidate(details.meetingLink) || details.meetingLink;
  details.sourceUrl = state.sourceUrl;
  return details;
}

function renderFormTicket() {
  const form = readForm();
  const converted = core.convertToDhaka(form);
  const host = linkHost(form.meetingLink);
  el.linkWarning.hidden = !host || core.isMeetingUrl(form.meetingLink);
  el.linkWarning.textContent = `${host} isn't a known meeting site. Check the address before you save.`;
  el.formTicket.classList.toggle("is-empty", !converted);
  el.formTicketTime.textContent = converted ? `${core.formatWeekday(converted.date)}, ${core.formatConvertedRange(converted)}` : "--:--";
}

async function saveForm() {
  const details = readForm();
  const problems = [];
  if (!core.cleanUrlCandidate(details.meetingLink)) problems.push(["meetingLink", "the meeting link"]);
  if (!details.date) problems.push(["date", "the date"]);
  if (!details.time) problems.push(["time", "the start time"]);
  if (problems.length) {
    problems.forEach(([key]) => el[key].classList.add("invalid"));
    el.formError.textContent = `Add ${problems.map(([, label]) => label).join(" and ")} to save.`;
    el.formError.hidden = false;
    el[problems[0][0]].focus();
    return;
  }

  const meeting = await store.saveMeeting(details, state.editingId);
  if (!meeting) {
    el.formError.textContent = "That date or time isn't valid. Check both and save again.";
    el.formError.hidden = false;
    return;
  }
  state.meetings = await store.getMeetings();
  showList();
  showToast(state.settings.notify ? `Saved. You'll be reminded ${state.settings.leadMinutes} min before.` : "Meeting saved.");
}

/* First click arms the button; the second one deletes. */
async function deleteEditedMeeting() {
  if (!el.deleteBtn.dataset.armed) {
    el.deleteBtn.dataset.armed = "1";
    el.deleteBtn.textContent = "Click again to delete for good";
    return;
  }
  await store.deleteMeeting(state.editingId);
  state.meetings = await store.getMeetings();
  showList();
  showToast("Meeting deleted.");
}

/* ---------- helpers ---------- */

function linkHost(link) {
  try {
    return new URL(link).hostname.replace(/^www\./i, "");
  } catch (error) {
    return "";
  }
}

function dhakaDate(timestamp) {
  return core.formatDateTimeInZone(new Date(timestamp), core.TARGET_ZONE).date;
}

function dayLabel(date, now) {
  const today = dhakaDate(now);
  if (date === today) return "Today";
  if (date === core.addDaysToDateInput(today, 1)) return "Tomorrow";
  if (date === core.addDaysToDateInput(today, -1)) return "Yesterday";
  return `${core.formatWeekday(date).slice(0, 3)} ${core.formatDateForMessage(date).slice(0, 6)}`;
}

function countdown(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `Starts in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Starts in ${hours} hr`;
  const days = Math.round(hours / 24);
  return `In ${days} day${days === 1 ? "" : "s"}`;
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch (error) {
    showToast("Couldn't copy. Click inside this window and try again.");
  }
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => el.toast.classList.remove("visible"), 2600);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
