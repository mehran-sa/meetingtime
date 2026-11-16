"use strict";

/* Settings page: reminders, the web tool address and brand representatives. */

const core = globalThis.MeetingCore;
const store = globalThis.MeetingStore;
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const [settings, reps] = await Promise.all([store.getSettings(), store.getRepresentatives()]);
  $("notify").checked = settings.notify;
  selectClosest($("leadMinutes"), settings.leadMinutes);
  selectClosest($("keepPastDays"), settings.keepPastDays);
  $("webAppUrl").value = settings.webAppUrl;

  $("repRows").replaceChildren(...store.BRANDS.map((brand) => {
    const row = document.createElement("tr");
    row.dataset.brand = brand;
    row.append(cell(brand), cell(input("name", reps[brand]?.name, "Name", brand)), cell(input("slackId", reps[brand]?.slackId, "U012AB3CD", brand)));
    return row;
  }));

  $("optionsForm").addEventListener("submit", save);
});

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
    store.saveSettings({
      notify: $("notify").checked,
      leadMinutes: Number($("leadMinutes").value),
      keepPastDays: Number($("keepPastDays").value),
      webAppUrl: $("webAppUrl").value.trim()
    }),
    store.saveRepresentatives(representatives)
  ]);
  $("saveStatus").textContent = "Settings saved.";
  window.setTimeout(() => { $("saveStatus").textContent = ""; }, 2500);
}
