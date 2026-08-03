"use strict";

const BRAND_CONFIG = Array.isArray(window.BRAND_CONFIG) ? window.BRAND_CONFIG : [];
const BRANDS = BRAND_CONFIG.map((item) => String(item.brand || "").trim()).filter(Boolean);
const STORAGE_KEY = "slack-message-generator-representatives-v1";
const SLACK_STORAGE_KEY = "slack-reminder-generator-webhook-v1";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LOOKUP = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
  october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const elements = {};
let currentImage = null;
let representatives = loadRepresentatives();
let settingsSnapshot = null;
let toastTimer = null;
let isOcrRunning = false;
let ocrWorker = null;
let ocrWorkerPromise = null;
let slackWebhookUrl = loadSlackWebhook();

window.addEventListener("DOMContentLoaded", init);

function init() {
  cacheElements();
  populateBrands();
  renderRepresentativeRows();
  bindEvents();
  updateRepresentativeCard();
  updateConversionPreview();
  updateCopyState();
}

function cacheElements() {
  [
    "openSettingsBtn", "settingsDialog", "settingsForm", "closeSettingsBtn", "cancelSettingsBtn",
    "clearSettingsBtn", "representativeRows", "dropZone", "fileInput", "uploadBtn", "pasteBtn",
    "replaceImageBtn", "clearImageBtn", "emptyDropState", "imageState", "previewImage", "imageName",
    "ocrStatus", "ocrStatusText", "ocrPercent", "progressBar", "extractionResult", "runOcrBtn",
    "fetchDetailsBtn", "extractedText", "brandSelect", "representativeName", "representativeMention",
    "editCurrentRepBtn", "partnerBrandInput", "emailInput", "sourceDate", "sourceTime", "sourceTimezone", "conversionCard",
    "convertedDateTime", "conversionNote", "meetingLinkInput", "additionalNote", "generateBtn",
    "outputMessage", "copyBtn", "copyFeedback", "sendSlackBtn", "slackFeedback", "resetBtn", "toast",
    "openSlackSettingsBtn", "slackDialog", "slackForm", "closeSlackDialogBtn", "cancelSlackDialogBtn",
    "clearSlackWebhookBtn", "slackWebhookInput", "rememberSlackWebhook", "saveSlackWebhookBtn"
  ].forEach((id) => { elements[id] = document.getElementById(id); });
}

function bindEvents() {
  elements.uploadBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });
  elements.replaceImageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });
  elements.dropZone.addEventListener("click", (event) => {
    if (!event.target.closest("button")) elements.fileInput.click();
  });
  elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files?.[0];
    if (file) handleImageFile(file);
    elements.fileInput.value = "";
  });
  elements.pasteBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await pasteImageFromClipboard();
  });
  document.addEventListener("paste", handlePasteEvent);

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  });
  elements.dropZone.addEventListener("drop", (event) => {
    const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith("image/"));
    if (file) handleImageFile(file);
    else showToast("Please drop a valid image file.");
  });

  elements.clearImageBtn.addEventListener("click", clearImage);
  elements.runOcrBtn.addEventListener("click", runOcr);
  elements.fetchDetailsBtn.addEventListener("click", () => extractAndApplyDetails(elements.extractedText.value, true));

  elements.brandSelect.addEventListener("change", updateRepresentativeCard);
  elements.editCurrentRepBtn.addEventListener("click", () => openSettings(elements.brandSelect.value));
  [elements.sourceDate, elements.sourceTime, elements.sourceTimezone].forEach((element) => {
    element.addEventListener("input", updateConversionPreview);
    element.addEventListener("change", updateConversionPreview);
  });

  elements.generateBtn.addEventListener("click", generateReminder);
  elements.outputMessage.addEventListener("input", updateCopyState);
  elements.copyBtn.addEventListener("click", copyOutput);
  elements.sendSlackBtn.addEventListener("click", sendToSlack);
  elements.resetBtn.addEventListener("click", resetForm);

  elements.openSlackSettingsBtn.addEventListener("click", openSlackSettings);
  elements.closeSlackDialogBtn.addEventListener("click", closeSlackSettings);
  elements.cancelSlackDialogBtn.addEventListener("click", closeSlackSettings);
  elements.clearSlackWebhookBtn.addEventListener("click", clearSlackConnection);
  elements.slackForm.addEventListener("submit", saveSlackSettings);
  elements.slackDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSlackSettings();
  });

  elements.openSettingsBtn.addEventListener("click", () => openSettings());
  elements.closeSettingsBtn.addEventListener("click", closeSettingsWithoutSaving);
  elements.cancelSettingsBtn.addEventListener("click", closeSettingsWithoutSaving);
  elements.clearSettingsBtn.addEventListener("click", clearRepresentativeInputs);
  elements.settingsForm.addEventListener("submit", saveRepresentativeSettings);
  elements.settingsDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettingsWithoutSaving();
  });
}

function loadSlackWebhook() {
  try {
    return String(localStorage.getItem(SLACK_STORAGE_KEY) || "").trim();
  } catch (error) {
    console.warn("Could not load Slack webhook settings.", error);
    return "";
  }
}

function isValidSlackWebhook(value) {
  return /^https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9/_-]+$/i.test(String(value || "").trim());
}

function openSlackSettings() {
  elements.slackWebhookInput.value = slackWebhookUrl;
  elements.rememberSlackWebhook.checked = Boolean(localStorage.getItem(SLACK_STORAGE_KEY));
  elements.slackDialog.showModal();
  requestAnimationFrame(() => elements.slackWebhookInput.focus());
}

function closeSlackSettings() {
  elements.slackDialog.close();
}

function saveSlackSettings(event) {
  event.preventDefault();
  const value = elements.slackWebhookInput.value.trim();
  if (!isValidSlackWebhook(value)) {
    elements.slackWebhookInput.focus();
    showToast("Add a valid Slack Incoming Webhook URL.");
    return;
  }

  slackWebhookUrl = value;
  try {
    if (elements.rememberSlackWebhook.checked) localStorage.setItem(SLACK_STORAGE_KEY, value);
    else localStorage.removeItem(SLACK_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not save Slack webhook settings.", error);
  }
  elements.slackDialog.close();
  showToast("Slack connection saved.");
}

function clearSlackConnection() {
  slackWebhookUrl = "";
  elements.slackWebhookInput.value = "";
  elements.rememberSlackWebhook.checked = false;
  try { localStorage.removeItem(SLACK_STORAGE_KEY); } catch (error) { console.warn(error); }
  elements.slackDialog.close();
  elements.slackFeedback.textContent = "";
  showToast("Slack connection removed.");
}

function populateBrands() {
  elements.brandSelect.innerHTML = BRANDS
    .map((brand) => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`)
    .join("");
}

function defaultRepresentatives() {
  return Object.fromEntries(BRAND_CONFIG.map((item) => [
    String(item.brand || "").trim(),
    {
      name: String(item.representativeName || "").trim(),
      slackId: normalizeSlackId(item.slackId || "")
    }
  ]));
}

function loadRepresentatives() {
  const defaults = defaultRepresentatives();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    BRANDS.forEach((brand) => {
      if (!Object.prototype.hasOwnProperty.call(saved, brand)) return;
      defaults[brand] = {
        name: String(saved[brand]?.name || "").trim(),
        slackId: normalizeSlackId(saved[brand]?.slackId || "")
      };
    });
  } catch (error) {
    console.warn("Could not load representative settings.", error);
  }
  return defaults;
}

function renderRepresentativeRows() {
  elements.representativeRows.innerHTML = BRANDS.map((brand) => {
    const rep = representatives[brand] || { name: "", slackId: "" };
    return `
      <tr data-brand="${escapeHtml(brand)}">
        <td>${escapeHtml(brand)}</td>
        <td><input type="text" data-field="name" value="${escapeHtml(rep.name)}" placeholder="Representative name" /></td>
        <td><input type="text" data-field="slackId" value="${escapeHtml(rep.slackId)}" placeholder="U012AB3CD" /></td>
      </tr>`;
  }).join("");
}

function openSettings(focusBrand = "") {
  settingsSnapshot = JSON.stringify(representatives);
  renderRepresentativeRows();
  elements.settingsDialog.showModal();
  if (focusBrand) {
    requestAnimationFrame(() => {
      const row = [...elements.representativeRows.querySelectorAll("tr")]
        .find((item) => item.dataset.brand === focusBrand);
      row?.scrollIntoView({ block: "center" });
      row?.querySelector('[data-field="name"]')?.focus();
    });
  }
}

function closeSettingsWithoutSaving() {
  if (settingsSnapshot) representatives = JSON.parse(settingsSnapshot);
  settingsSnapshot = null;
  elements.settingsDialog.close();
  updateRepresentativeCard();
}

function clearRepresentativeInputs() {
  elements.representativeRows.querySelectorAll("input").forEach((input) => { input.value = ""; });
}

function saveRepresentativeSettings(event) {
  event.preventDefault();
  const next = {};
  elements.representativeRows.querySelectorAll("tr").forEach((row) => {
    next[row.dataset.brand] = {
      name: row.querySelector('[data-field="name"]').value.trim(),
      slackId: normalizeSlackId(row.querySelector('[data-field="slackId"]').value)
    };
  });
  representatives = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  settingsSnapshot = null;
  elements.settingsDialog.close();
  updateRepresentativeCard();
  showToast("Representative settings saved.");
}

function normalizeSlackId(value) {
  return String(value || "")
    .trim()
    .replace(/^<@/, "")
    .replace(/>$/, "")
    .replace(/^@/, "")
    .toUpperCase();
}

function updateRepresentativeCard() {
  const rep = representatives[elements.brandSelect.value] || { name: "", slackId: "" };
  elements.representativeName.textContent = rep.name || "Not configured";
  if (rep.slackId) {
    elements.representativeMention.textContent = `Greeting will mention <@${rep.slackId}>`;
  } else if (rep.name) {
    elements.representativeMention.textContent = `Greeting will address ${rep.name}`;
  } else {
    elements.representativeMention.textContent = "The default greeting will use “bhai”";
  }
}

async function pasteImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    showToast("Clipboard image access is unavailable. Press Ctrl+V instead.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      await handleImageFile(new File([blob], `pasted-meeting-${Date.now()}.png`, { type: imageType }));
      return;
    }
    showToast("No screenshot image was found in the clipboard.");
  } catch (error) {
    console.warn(error);
    showToast("Clipboard access was blocked. Press Ctrl+V instead.");
  }
}

function handlePasteEvent(event) {
  const item = [...(event.clipboardData?.items || [])].find((candidate) => candidate.type.startsWith("image/"));
  if (!item) return;
  event.preventDefault();
  const file = item.getAsFile();
  if (file) handleImageFile(new File([file], `pasted-meeting-${Date.now()}.png`, { type: file.type }));
}

async function handleImageFile(file) {
  if (!file.type.startsWith("image/")) {
    showToast("Please select a valid screenshot image.");
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast("The screenshot is larger than 15 MB. Please use a smaller image.");
    return;
  }

  currentImage = file;
  const objectUrl = URL.createObjectURL(file);
  elements.previewImage.onload = () => URL.revokeObjectURL(objectUrl);
  elements.previewImage.src = objectUrl;
  elements.imageName.textContent = file.name || "Pasted screenshot";
  elements.emptyDropState.hidden = true;
  elements.imageState.hidden = false;
  elements.clearImageBtn.disabled = false;
  elements.runOcrBtn.disabled = false;
  await runOcr();
}

async function runOcr() {
  if (!currentImage || isOcrRunning) return;
  if (!window.Tesseract) {
    showToast("OCR could not load. Check the internet connection and refresh.");
    return;
  }

  isOcrRunning = true;
  elements.runOcrBtn.disabled = true;
  elements.ocrStatus.hidden = false;
  elements.extractionResult.hidden = true;
  setOcrProgress(0, "Starting OCR…");

  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(currentImage);
    const text = cleanText(result.data.text || "");
    elements.extractedText.value = text;
    setOcrProgress(100, "Meeting details extracted");
    extractAndApplyDetails(text, false);
    window.setTimeout(() => { elements.ocrStatus.hidden = true; }, 1200);
  } catch (error) {
    console.error(error);
    setOcrProgress(0, "OCR failed");
    showToast("OCR failed. Try a clearer screenshot or paste the text manually.");
  } finally {
    isOcrRunning = false;
    elements.runOcrBtn.disabled = !currentImage;
  }
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("eng", 1, {
      logger: (message) => {
        if (typeof message.progress !== "number" || !isOcrRunning) return;
        const labels = {
          "loading tesseract core": "Loading OCR engine…",
          "initializing tesseract": "Initialising OCR…",
          "loading language traineddata": "Loading English recognition data…",
          "initializing api": "Preparing recognition…",
          "recognizing text": "Reading meeting screenshot…"
        };
        setOcrProgress(Math.round(message.progress * 100), labels[message.status] || "Processing screenshot…");
      }
    }).then((worker) => {
      ocrWorker = worker;
      return worker;
    }).catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

function setOcrProgress(percent, label) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.ocrStatusText.textContent = label;
  elements.ocrPercent.textContent = `${safe}%`;
  elements.progressBar.style.width = `${safe}%`;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function extractAndApplyDetails(text, manualRun) {
  const source = cleanText(text);
  if (!source) {
    showToast("Add OCR text before fetching meeting details.");
    return;
  }

  const details = extractReminderDetails(source);
  const found = [];

  if (details.brand) {
    elements.brandSelect.value = details.brand;
    updateRepresentativeCard();
    found.push("brand");
  }
  if (details.partnerBrand) {
    elements.partnerBrandInput.value = details.partnerBrand;
    found.push("partner brand");
  }
  if (details.email) {
    elements.emailInput.value = details.email;
    found.push("email");
  }
  if (details.date) {
    elements.sourceDate.value = details.date;
    found.push("date");
  }
  if (details.time) {
    elements.sourceTime.value = details.time;
    found.push("time");
  }
  if (details.timezone) {
    elements.sourceTimezone.value = details.timezone;
    found.push(details.timezone === "Europe/London" ? "UK time zone" : "Bangladesh time zone");
  }
  if (details.meetingLink) {
    elements.meetingLinkInput.value = details.meetingLink;
    found.push("meeting link");
  }

  updateConversionPreview();
  const missing = [
    [details.email, "email"], [details.date, "date"], [details.time, "time"], [details.meetingLink, "meeting link"]
  ].filter(([value]) => !value).map(([, label]) => label);

  elements.extractionResult.hidden = false;
  if (found.length) {
    elements.extractionResult.className = "extraction-result success";
    elements.extractionResult.innerHTML = `<strong>Fetched:</strong> ${escapeHtml(found.join(", "))}${missing.length ? `<br><small>Please review or add: ${escapeHtml(missing.join(", "))}.</small>` : ""}`;
    showToast(manualRun ? "Meeting details fetched from the text." : "Screenshot processed. Review the fetched details.");
  } else {
    elements.extractionResult.className = "extraction-result warning";
    elements.extractionResult.innerHTML = "<strong>No structured details were recognised.</strong><br><small>Edit the OCR text or complete the fields manually.</small>";
    showToast("No meeting details were recognised. Please complete the fields manually.");
  }
}

function extractReminderDetails(text) {
  return {
    brand: extractBrand(text),
    partnerBrand: extractPartnerBrand(text),
    email: extractEmail(text),
    date: extractDate(text),
    time: extractTime(text),
    timezone: extractTimezone(text),
    meetingLink: extractMeetingLink(text)
  };
}

function extractBrand(text) {
  const compact = normalizeSearchText(text);
  return BRANDS.find((brand) => compact.includes(normalizeSearchText(brand))) || "";
}

function extractPartnerBrand(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(?:meeting\s+with(?:\s+partner\s+brand)?|partner\s+brand|partner|organisation|organization)\s*[:\-]\s*(.+)$/i);
    if (!match) continue;
    const value = cleanText(match[1]).replace(/[|]+$/g, "").trim();
    if (value && !/@|https?:\/\//i.test(value) && value.length <= 120) return value;
  }
  return "";
}

function extractEmail(text) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].replace(/[),.;]+$/, "") : "";
}

function extractTimezone(text) {
  const value = text.toLowerCase();
  if (/united\s*kingdom\s*time|uk\s*time|british\s*summer\s*time|greenwich\s*mean\s*time|europe\s*\/\s*london|london\s*time/.test(value)) {
    return "Europe/London";
  }
  if (/bangladesh\s*standard\s*time|bangladesh\s*time|asia\s*\/\s*dhaka|dhaka\s*time|\bbdt\b/.test(value)) {
    return "Asia/Dhaka";
  }
  if (/\b(?:gmt|bst)\b/.test(value) && /\b(?:uk|british|london|kingdom)\b/.test(value)) {
    return "Europe/London";
  }
  return "";
}

function extractMeetingLink(text) {
  const repaired = repairOcrUrlText(text);
  const direct = repaired.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const www = repaired.match(/\bwww\.[^\s<>"'`]+/gi) || [];
  const candidates = [...direct, ...www.map((url) => `https://${url}`)]
    .map(cleanUrlCandidate)
    .filter(Boolean);

  const unique = [...new Set(candidates)];
  if (!unique.length) return "";
  const meetingDomains = /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|join\.gong\.io|gong\.io|webex\.com|gotomeet\.me|whereby\.com|calendly\.com)/i;
  return unique.find((url) => meetingDomains.test(url)) || unique.sort((a, b) => b.length - a.length)[0];
}

function repairOcrUrlText(text) {
  let value = String(text || "")
    .replace(/h\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//gi, (match) => match.toLowerCase().includes("s") ? "https://" : "http://")
    .replace(/w\s*w\s*w\s*\.\s*/gi, "www.")
    .replace(/\s*([./:?=&_%#-])\s*/g, "$1");

  // Join a wrapped URL only when the next line starts like a URL continuation.
  value = value.replace(/(https?:\/\/[^\s\n]+)\n([A-Za-z0-9_%#?=&./-]{4,})/g, "$1$2");
  return value;
}

function cleanUrlCandidate(value) {
  let url = String(value || "").trim().replace(/[),.;\]}]+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).href;
  } catch (error) {
    return "";
  }
}

function extractDate(text) {
  const normalized = String(text || "").replace(/[|]/g, " ");
  let match = normalized.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (match) return toDateInput(Number(match[1]), Number(match[2]), Number(match[3]));

  match = normalized.match(/\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[\s\-/.]+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s\-/.]+(20\d{2})\b/i);
  if (match) return toDateInput(Number(match[3]), MONTH_LOOKUP[match[2].toLowerCase()], Number(match[1]));

  match = normalized.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s\-/.]+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[,]?[\s\-/.]+(20\d{2})\b/i);
  if (match) return toDateInput(Number(match[3]), MONTH_LOOKUP[match[1].toLowerCase()], Number(match[2]));

  match = normalized.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/);
  if (match) return toDateInput(Number(match[3]), Number(match[2]), Number(match[1]));

  return "";
}

function extractTime(text) {
  const normalized = String(text || "")
    .replace(/\b([0-2]?\d)\s*[.·]\s*([0-5]\d)\b/g, "$1:$2")
    .replace(/\bA\s*\.?\s*M\.?\b/gi, "AM")
    .replace(/\bP\s*\.?\s*M\.?\b/gi, "PM");

  let match = normalized.match(/\b(1[0-2]|0?[1-9])\s*:\s*([0-5]\d)\s*(AM|PM)\b/i);
  if (match) return twelveToTwentyFour(Number(match[1]), Number(match[2]), match[3]);

  match = normalized.match(/\b(1[0-2]|0?[1-9])\s*(AM|PM)\b/i);
  if (match) return twelveToTwentyFour(Number(match[1]), 0, match[2]);

  match = normalized.match(/(?:\btime\b\s*[:\-]?\s*)\b([01]?\d|2[0-3])\s*:\s*([0-5]\d)\b/i);
  if (match) return `${pad(Number(match[1]))}:${pad(Number(match[2]))}`;

  match = normalized.match(/\b([01]\d|2[0-3])\s*:\s*([0-5]\d)\b/);
  if (match) return `${match[1]}:${match[2]}`;

  return "";
}

function twelveToTwentyFour(hours, minutes, period) {
  let value = hours % 12;
  if (String(period).toUpperCase() === "PM") value += 12;
  return `${pad(value)}:${pad(minutes)}`;
}

function toDateInput(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${pad(month)}-${pad(day)}`;
}

function updateConversionPreview() {
  const converted = getBangladeshMeetingDateTime();
  if (!converted) {
    elements.convertedDateTime.textContent = "Add the meeting date and time";
    elements.conversionNote.textContent = "The final message always uses Bangladesh Standard Time.";
    elements.conversionCard.classList.remove("converted");
    return;
  }

  elements.convertedDateTime.textContent = `${formatDateForMessage(converted.date)} at ${formatTimeForMessage(converted.time)}`;
  if (elements.sourceTimezone.value === "Europe/London") {
    elements.conversionNote.textContent = `Converted automatically from United Kingdom Time (${converted.ukZoneName}) to Bangladesh Standard Time.`;
    elements.conversionCard.classList.add("converted");
  } else {
    elements.conversionNote.textContent = "No conversion needed; the screenshot time is already Bangladesh Standard Time.";
    elements.conversionCard.classList.remove("converted");
  }
}

function getBangladeshMeetingDateTime() {
  const dateValue = elements.sourceDate.value;
  const timeValue = elements.sourceTime.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return null;

  if (elements.sourceTimezone.value === "Asia/Dhaka") {
    return { date: dateValue, time: timeValue, ukZoneName: "" };
  }

  const instant = zonedLocalToUtc(dateValue, timeValue, "Europe/London");
  if (!instant || Number.isNaN(instant.getTime())) return null;
  const dhaka = formatDateTimeInZone(instant, "Asia/Dhaka");
  return {
    date: dhaka.date,
    time: dhaka.time,
    ukZoneName: getTimeZoneName(instant, "Europe/London")
  };
}

function zonedLocalToUtc(dateValue, timeValue, timeZone) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const base = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = base;
  for (let i = 0; i < 3; i += 1) {
    guess = base - getTimeZoneOffsetMs(new Date(guess), timeZone);
  }
  return new Date(guess);
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function getZonedParts(date, timeZone) {
  const result = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).forEach((part) => {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  });
  return result;
}

function formatDateTimeInZone(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`
  };
}

function getTimeZoneName(date, timeZone) {
  const part = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "short",
    hour: "2-digit"
  }).formatToParts(date).find((item) => item.type === "timeZoneName");
  return part?.value || "UK time";
}

function generateReminder() {
  const brand = elements.brandSelect.value;
  const partnerBrand = cleanText(elements.partnerBrandInput.value);
  const email = elements.emailInput.value.trim();
  const meetingLink = elements.meetingLinkInput.value.trim();
  const converted = getBangladeshMeetingDateTime();

  const required = [
    [email, elements.emailInput, "Add the email address."],
    [elements.sourceDate.value, elements.sourceDate, "Add the meeting date."],
    [elements.sourceTime.value, elements.sourceTime, "Add the meeting time."],
    [meetingLink, elements.meetingLinkInput, "Add the meeting link."]
  ];
  const missing = required.find(([value]) => !value);
  if (missing) {
    missing[1].focus();
    showToast(missing[2]);
    return;
  }
  if (!converted) {
    showToast("The meeting date or time is invalid.");
    return;
  }

  const rep = representatives[brand] || { name: "", slackId: "" };
  const greeting = rep.slackId
    ? `Assalamu Alaikum <@${rep.slackId}>,`
    : rep.name
      ? `Assalamu Alaikum ${rep.name} bhai,`
      : "Assalamu Alaikum bhai,";

  const lines = [
    greeting,
    "",
    "This is an automated reminder.",
    "",
    `Brand: ${brand}`,
    ...(partnerBrand ? [`Meeting with: ${partnerBrand}`] : []),
    email,
    "",
    `Date: ${formatDateForMessage(converted.date)}`,
    `Time: ${formatTimeForMessage(converted.time)} (Bangladesh Standard Time)`,
    `Meeting Link: ${meetingLink}`
  ];

  const note = cleanText(elements.additionalNote.value);
  if (note) lines.push("", note);

  elements.outputMessage.value = lines.join("\n");
  updateCopyState();
  elements.copyFeedback.textContent = elements.sourceTimezone.value === "Europe/London"
    ? "Reminder generated with UK time converted to Bangladesh time."
    : "Reminder generated and ready to copy.";
}

function formatDateForMessage(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return value;
  return `${match[3]}-${MONTH_NAMES[Number(match[2]) - 1]}-${match[1]}`;
}

function formatTimeForMessage(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) return value;
  const hour24 = Number(match[1]);
  return `${hour24 % 12 || 12}:${match[2]} ${hour24 >= 12 ? "PM" : "AM"}`;
}

async function copyOutput() {
  const text = elements.outputMessage.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    elements.outputMessage.select();
    document.execCommand("copy");
  }
  elements.copyFeedback.textContent = "Copied to clipboard.";
  showToast("Reminder copied.");
}

async function sendToSlack() {
  const text = elements.outputMessage.value.trim();
  if (!text) {
    showToast("Generate the reminder message first.");
    return;
  }
  if (!isValidSlackWebhook(slackWebhookUrl)) {
    showToast("Connect Slack before sending the reminder.");
    openSlackSettings();
    return;
  }

  elements.sendSlackBtn.disabled = true;
  elements.sendSlackBtn.textContent = "Sending…";
  elements.slackFeedback.textContent = "";
  try {
    const response = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text })
    });
    const responseText = await response.text();
    if (!response.ok || responseText.trim().toLowerCase() !== "ok") {
      throw new Error(responseText || `Slack returned HTTP ${response.status}`);
    }
    elements.slackFeedback.textContent = "Sent directly to Slack.";
    showToast("Reminder sent to Slack.");
  } catch (error) {
    console.error("Slack send failed.", error);
    elements.slackFeedback.textContent = "Slack could not confirm delivery. Check the webhook and browser network permissions.";
    showToast("Could not send to Slack. Check Slack Settings.");
  } finally {
    elements.sendSlackBtn.textContent = "Send to Slack";
    updateCopyState();
  }
}

function updateCopyState() {
  const empty = !elements.outputMessage.value.trim();
  elements.copyBtn.disabled = empty;
  elements.sendSlackBtn.disabled = empty;
  if (empty) {
    elements.copyFeedback.textContent = "";
    elements.slackFeedback.textContent = "";
  }
}

function clearImage() {
  currentImage = null;
  elements.previewImage.removeAttribute("src");
  elements.emptyDropState.hidden = false;
  elements.imageState.hidden = true;
  elements.clearImageBtn.disabled = true;
  elements.runOcrBtn.disabled = true;
  elements.ocrStatus.hidden = true;
  elements.extractionResult.hidden = true;
  elements.extractedText.value = "";
}

function resetForm() {
  clearImage();
  elements.brandSelect.selectedIndex = 0;
  elements.partnerBrandInput.value = "";
  elements.emailInput.value = "";
  elements.sourceDate.value = "";
  elements.sourceTime.value = "";
  elements.sourceTimezone.value = "Asia/Dhaka";
  elements.meetingLinkInput.value = "";
  elements.additionalNote.value = "";
  elements.outputMessage.value = "";
  updateRepresentativeCard();
  updateConversionPreview();
  updateCopyState();
  showToast("Reminder form reset. Representative settings were kept.");
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Exposed for lightweight automated tests without affecting normal use.
window.ReminderGeneratorTest = {
  extractReminderDetails,
  extractPartnerBrand,
  extractDate,
  extractTime,
  extractTimezone,
  extractMeetingLink,
  zonedLocalToUtc,
  formatDateTimeInZone
};
