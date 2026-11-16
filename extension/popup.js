"use strict";

/* Popup: the list of tracked meetings and the add/edit form. */

const core = globalThis.MeetingCore;
const store = globalThis.MeetingStore;
const capture = globalThis.MeetingCapture;

const FIELDS = ["brand", "partnerBrand", "email", "date", "time", "endTime", "timezone", "meetingLink", "note"];
const el = {};
const state = { meetings: [], settings: store.DEFAULT_SETTINGS, tab: null, editingId: null, sourceUrl: "", toastTimer: null };

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.querySelectorAll("[id]").forEach((node) => { el[node.id] = node; });
  el.brand.replaceChildren(...store.BRANDS.map((brand) => new Option(brand, brand)));
  el.timezone.replaceChildren(...core.orderedTimezones().map((zone) => new Option(zone.label, zone.id)));
  bindEvents();

  const [meetings, settings, tabs, draft] = await Promise.all([
    store.getMeetings(), store.getSettings(), chrome.tabs.query({ active: true, currentWindow: true }), store.takeDraft()
  ]);
  state.meetings = meetings;
  state.settings = settings;
  state.tab = tabs[0] || null;
  el.openToolBtn.hidden = !settings.webAppUrl;

  if (state.tab?.url && core.isMeetingUrl(state.tab.url)) {
    el.tabHint.textContent = `This tab is a ${core.meetingProvider(state.tab.url)} link. Track it to keep it with its date and time.`;
    el.tabHint.hidden = false;
  }
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
  el.meetingList.addEventListener("click", handleListClick);
  el.meetingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveForm(false);
  });
  el.saveCopyBtn.addEventListener("click", () => saveForm(true));
  el.openToolBtn.addEventListener("click", openInFullTool);
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

  if (!state.meetings.length) {
    el.meetingList.innerHTML = `<div class="empty"><strong>No meetings tracked yet</strong>
      Open an invite, booking email or calendar event, then press “Track meeting from this page”. You can also right-click any meeting link.</div>`;
    return;
  }

  const group = (title, meetings) => (meetings.length
    ? `<h2 class="group-title">${title}</h2>${meetings.map((meeting) => meetingCard(meeting, now)).join("")}` : "");
  el.meetingList.innerHTML = [
    group("Today", todays),
    group("Coming up", later),
    !upcoming.length ? '<div class="empty"><strong>Nothing coming up</strong>Track the next meeting from its invite or link.</div>' : "",
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
  const sub = [status, provider ? `on ${escapeHtml(provider)}` : ""].filter(Boolean).join(" ") || escapeHtml(meeting.email);

  return `
    <article class="meeting ${isLive ? "is-live" : ""} ${isPast ? "is-past" : ""}" data-id="${escapeHtml(meeting.id)}">
      <div class="meeting-when">
        <span class="meeting-time">${escapeHtml(core.formatTimeForMessage(converted.time))}</span>
        <span class="meeting-date">${escapeHtml(dayLabel(converted.date, now))}</span>
      </div>
      <div class="meeting-body">
        <div class="meeting-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="meeting-sub">${sub}</div>
        <div class="meeting-actions">
          ${isPast ? "" : '<button class="btn btn-primary btn-small" type="button" data-action="join">Join</button>'}
          <button class="text-btn" type="button" data-action="copy-reminder">Copy reminder</button>
          <button class="text-btn" type="button" data-action="copy-link">Copy link</button>
          <button class="text-btn" type="button" data-action="edit">Edit</button>
          <button class="text-btn danger" type="button" data-action="delete">Delete</button>
        </div>
      </div>
    </article>`;
}

async function handleListClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const meeting = state.meetings.find((item) => item.id === button.closest("[data-id]").dataset.id);
  if (!meeting) return;

  switch (button.dataset.action) {
    case "join":
      chrome.tabs.create({ url: meeting.meetingLink });
      break;
    case "copy-reminder":
      await copyText(await store.reminderFor(meeting), meeting.email ? "Reminder copied. Paste it in Slack." : "Reminder copied. It has no email line yet.");
      break;
    case "copy-link":
      await copyText(meeting.meetingLink, "Meeting link copied.");
      break;
    case "edit":
      openForm(meeting, { id: meeting.id });
      break;
    case "delete":
      // First click arms the button; the second one deletes.
      if (button.dataset.armed) {
        await store.deleteMeeting(meeting.id);
        state.meetings = state.meetings.filter((item) => item.id !== meeting.id);
        renderList();
        showToast("Meeting deleted.");
      } else {
        button.dataset.armed = "1";
        button.textContent = "Delete for good?";
      }
      break;
    default:
  }
}

/* ---------- capture ---------- */

async function captureCurrentTab() {
  el.captureBtn.disabled = true;
  try {
    if (!state.tab?.id) throw new Error("No active tab.");
    openForm(await capture.captureFromTab(state.tab.id, store.BRANDS), { captured: true });
  } catch (error) {
    console.warn(error);
    openForm({}, { warning: "Chrome doesn't let extensions read this page. Fill in the details by hand, or copy the invite text and use the right-click menu on another page." });
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
  el.saveBtn.textContent = id ? "Save changes" : "Save meeting";
  el.formError.hidden = true;

  let hint = warning;
  let isWarning = Boolean(warning);
  if (captured) {
    const missing = [["meetingLink", "meeting link"], ["date", "date"], ["time", "start time"]]
      .filter(([key]) => !details[key]).map(([, label]) => label);
    if (missing.length === 3) {
      hint = "No meeting details were found here. Tip: select the invite text on the page first, then track again.";
      isWarning = true;
    } else if (missing.length) {
      hint = `Found some details. Still to add: ${missing.join(", ")}.`;
      isWarning = true;
    } else {
      hint = "Details found on the page. Check them, then save.";
    }
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
  const converted = core.convertToDhaka(readForm());
  el.formTicket.classList.toggle("is-empty", !converted);
  el.formTicketTime.textContent = converted
    ? `${core.formatWeekday(converted.date)}, ${core.formatConvertedRange(converted)}`
    : "Add a date and start time";
}

async function saveForm(copyReminder) {
  const details = readForm();
  const problems = [];
  if (!core.cleanUrlCandidate(details.meetingLink)) problems.push(["meetingLink", "a meeting link"]);
  if (!details.date) problems.push(["date", "the date"]);
  if (!details.time) problems.push(["time", "the start time"]);
  if (problems.length) {
    problems.forEach(([key]) => el[key].classList.add("invalid"));
    el.formError.textContent = `Add ${problems.map(([, label]) => label).join(" and ")} to save this meeting.`;
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
  if (copyReminder) await copyText(await store.reminderFor(meeting), "Saved, and the reminder is copied.");
  else showToast(state.settings.notify ? `Saved. You'll get a reminder ${state.settings.leadMinutes} min before.` : "Meeting saved.");
}

function openInFullTool() {
  const base = state.settings.webAppUrl.replace(/#.*$/, "");
  chrome.tabs.create({ url: `${base}#${core.encodePrefill(readForm())}` });
}

/* ---------- helpers ---------- */

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
    showToast("Couldn't copy. Click inside the popup and try again.");
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
