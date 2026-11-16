"use strict";

/* Settings page: reminders, brand representatives and stored meetings. */

const core = globalThis.MeetingCore;
const store = globalThis.MeetingStore;
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const [settings, reps] = await Promise.all([store.getSettings(), store.getRepresentatives()]);
  $("notify").checked = settings.notify;
  selectClosest($("leadMinutes"), settings.leadMinutes);

  $("repRows").replaceChildren(...store.BRANDS.map((brand) => {
    const row = document.createElement("tr");
    row.dataset.brand = brand;
    row.append(cell(brand), cell(input("name", reps[brand]?.name, "Name", brand)), cell(input("slackId", reps[brand]?.slackId, "U012AB3CD", brand)));
    return row;
  }));

  $("optionsForm").addEventListener("submit", save);
  $("deleteAllBtn").addEventListener("click", deleteAll);
  showMeetingCount();
});

async function showMeetingCount() {
  const count = (await store.getMeetings()).length;
  $("meetingCount").textContent = count ? `${count} meeting${count === 1 ? "" : "s"} stored` : "No meetings stored";
  $("deleteAllBtn").disabled = !count;
}

/* First click arms the button; the second one deletes. */
async function deleteAll() {
  const button = $("deleteAllBtn");
  if (!button.dataset.armed) {
    button.dataset.armed = "1";
    button.textContent = "Click again to delete all";
    return;
  }
  await store.deleteAllMeetings();
  delete button.dataset.armed;
  button.textContent = "Delete all meetings";
  showMeetingCount();
}

function cell(content) {
  const td = document.createElement("td");
  td.append(content);
  return td;
}

function input(field, value, placeholder, brand) {
  const node = document.createElement("input");
  node.type = "text";
  node.dataset.field = field;
  node.value = value || "";
  node.placeholder = placeholder;
  node.setAttribute("aria-label", `${field === "name" ? "Representative" : "Slack member ID"} for ${brand}`);
  return node;
}

function selectClosest(select, value) {
  const options = [...select.options].map((option) => Number(option.value));
  select.value = String(options.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best)));
}

async function save(event) {
  event.preventDefault();
  const representatives = {};
  [...$("repRows").rows].forEach((row) => {
    const slackInput = row.querySelector('[data-field="slackId"]');
    slackInput.value = core.normalizeSlackId(slackInput.value); // show the ID the way it was stored
    representatives[row.dataset.brand] = {
      name: row.querySelector('[data-field="name"]').value.trim(),
      slackId: slackInput.value
    };
  });
  await Promise.all([
    store.saveSettings({ notify: $("notify").checked, leadMinutes: Number($("leadMinutes").value) }),
    store.saveRepresentatives(representatives)
  ]);
  $("saveStatus").textContent = "Settings saved.";
  window.setTimeout(() => { $("saveStatus").textContent = ""; }, 2500);
}
