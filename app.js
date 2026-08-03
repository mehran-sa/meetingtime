"use strict";

const BRAND_CONFIG = Array.isArray(window.BRAND_CONFIG) && window.BRAND_CONFIG.length
  ? window.BRAND_CONFIG
  : [];

const BRANDS = BRAND_CONFIG.map((item) => String(item.brand || "").trim()).filter(Boolean);

const STORAGE_KEY = "slack-message-generator-representatives-v1";
const ACTION_TEXT = {
  review: "Please review and advise on the next step.",
  reply: "Please prepare and send an appropriate response.",
  resolve: "Please investigate this matter and resolve it as soon as possible.",
  confirm: "Please confirm the appropriate next step.",
  contact: "Please contact the customer and provide an update."
};

const TYPE_LABELS = {
  general: "General enquiry",
  customer: "Customer issue",
  payment: "Payment issue",
  course: "Course/content issue",
  technical: "Technical issue",
  refund: "Refund request",
  urgent: "Urgent escalation"
};

const TEMPLATE_DEFAULTS = {
  timezone: "Bangladesh Time",
  greeting: "Assalamu Alaikum bhai,",
  intro: "This is an automated reminder."
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const elements = {};
let currentImage = null;
let currentImageName = "Screenshot";
let representatives = loadRepresentatives();
let settingsSnapshot = null;
let toastTimer = null;
let isOcrRunning = false;
let ocrWorker = null;
let ocrWorkerPromise = null;

window.addEventListener("DOMContentLoaded", init);

function init() {
  cacheElements();
  populateBrands();
  renderRepresentativeRows();
  bindEvents();
  switchView("screenshot");
  updateAllRepresentativeCards();
  updateTextCount();
  updateCopyState();
  updateTemplateCopyState();
}

function cacheElements() {
  [
    "screenshotModeBtn", "templateModeBtn", "screenshotView", "templateView",
    "openSettingsBtn", "settingsDialog", "settingsForm", "closeSettingsBtn", "cancelSettingsBtn",
    "saveSettingsBtn", "clearSettingsBtn", "representativeRows", "dropZone", "fileInput",
    "uploadBtn", "pasteBtn", "replaceImageBtn", "clearImageBtn", "emptyDropState", "imageState",
    "previewImage", "imageName", "ocrStatus", "ocrStatusText", "ocrPercent", "progressBar",
    "runOcrBtn", "cleanTextBtn", "extractedText", "textCount", "brandSelect", "representativeName",
    "representativeMention", "editCurrentRepBtn", "messageType", "toneSelect", "actionSelect",
    "customActionGroup", "customAction", "referenceInput", "generateBtn", "outputMessage",
    "copyBtn", "copyFeedback", "resetBtn", "toast", "templateBrandSelect",
    "templateRepresentativeName", "templateRepresentativeMention", "editTemplateRepBtn",
    "templateEmail", "templateDate", "templateTime", "templateTimezone", "templateMeetingLink",
    "templateGreeting", "templateIntro", "templateAdditionalNote", "setCurrentDateTimeBtn",
    "generateTemplateBtn", "templateOutputMessage", "copyTemplateBtn", "templateCopyFeedback",
    "resetTemplateBtn"
  ].forEach((id) => { elements[id] = document.getElementById(id); });
}

function bindEvents() {
  elements.screenshotModeBtn.addEventListener("click", () => switchView("screenshot"));
  elements.templateModeBtn.addEventListener("click", () => switchView("template"));

  elements.uploadBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });
  elements.replaceImageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });
  elements.dropZone.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    elements.fileInput.click();
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
    else showToast("Please drop an image file.");
  });

  elements.clearImageBtn.addEventListener("click", clearImage);
  elements.runOcrBtn.addEventListener("click", runOcr);
  elements.cleanTextBtn.addEventListener("click", () => {
    elements.extractedText.value = cleanExtractedText(elements.extractedText.value);
    updateTextCount();
    showToast("Extracted text cleaned.");
  });
  elements.extractedText.addEventListener("input", updateTextCount);

  elements.brandSelect.addEventListener("change", updateScreenshotRepresentativeCard);
  elements.editCurrentRepBtn.addEventListener("click", () => openSettings(elements.brandSelect.value));
  elements.actionSelect.addEventListener("change", () => {
    elements.customActionGroup.hidden = elements.actionSelect.value !== "custom";
    if (!elements.customActionGroup.hidden) elements.customAction.focus();
  });
  elements.generateBtn.addEventListener("click", generateMessage);
  elements.copyBtn.addEventListener("click", () => copyTextOutput(
    elements.outputMessage,
    elements.copyFeedback,
    "Slack message copied."
  ));
  elements.outputMessage.addEventListener("input", updateCopyState);
  elements.resetBtn.addEventListener("click", resetForm);

  elements.templateBrandSelect.addEventListener("change", updateTemplateRepresentativeCard);
  elements.editTemplateRepBtn.addEventListener("click", () => openSettings(elements.templateBrandSelect.value));
  elements.setCurrentDateTimeBtn.addEventListener("click", setCurrentBangladeshDateTime);
  elements.generateTemplateBtn.addEventListener("click", generateReminderTemplate);
  elements.copyTemplateBtn.addEventListener("click", () => copyTextOutput(
    elements.templateOutputMessage,
    elements.templateCopyFeedback,
    "Reminder message copied."
  ));
  elements.templateOutputMessage.addEventListener("input", updateTemplateCopyState);
  elements.resetTemplateBtn.addEventListener("click", resetTemplateForm);

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

function switchView(view) {
  const isTemplate = view === "template";
  elements.screenshotView.hidden = isTemplate;
  elements.templateView.hidden = !isTemplate;
  elements.screenshotModeBtn.classList.toggle("active", !isTemplate);
  elements.templateModeBtn.classList.toggle("active", isTemplate);
  elements.screenshotModeBtn.setAttribute("aria-pressed", String(!isTemplate));
  elements.templateModeBtn.setAttribute("aria-pressed", String(isTemplate));
}

function populateBrands() {
  const options = BRANDS
    .map((brand) => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`)
    .join("");
  elements.brandSelect.innerHTML = options;
  elements.templateBrandSelect.innerHTML = options;
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
    for (const brand of BRANDS) {
      if (!Object.prototype.hasOwnProperty.call(saved, brand)) continue;
      defaults[brand] = {
        name: String(saved?.[brand]?.name || ""),
        slackId: normalizeSlackId(saved?.[brand]?.slackId || "")
      };
    }
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
        <td><input type="text" data-field="name" value="${escapeHtml(rep.name)}" placeholder="Representative name" aria-label="${escapeHtml(brand)} representative name" /></td>
        <td><input type="text" data-field="slackId" value="${escapeHtml(rep.slackId)}" placeholder="U012AB3CD" aria-label="${escapeHtml(brand)} Slack member ID" /></td>
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
  if (settingsSnapshot) {
    representatives = JSON.parse(settingsSnapshot);
    renderRepresentativeRows();
  }
  settingsSnapshot = null;
  elements.settingsDialog.close();
}

function saveRepresentativeSettings(event) {
  event.preventDefault();
  const updated = defaultRepresentatives();
  for (const row of elements.representativeRows.querySelectorAll("tr")) {
    const brand = row.dataset.brand;
    const name = row.querySelector('[data-field="name"]').value.trim();
    const slackId = normalizeSlackId(row.querySelector('[data-field="slackId"]').value);
    updated[brand] = { name, slackId };
  }
  representatives = updated;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(representatives));
  settingsSnapshot = null;
  elements.settingsDialog.close();
  updateAllRepresentativeCards();
  showToast("Representative settings saved.");
}

function clearRepresentativeInputs() {
  for (const input of elements.representativeRows.querySelectorAll("input")) input.value = "";
}

function normalizeSlackId(value) {
  return String(value || "")
    .trim()
    .replace(/^<@/, "")
    .replace(/>$/, "")
    .replace(/^@/, "")
    .toUpperCase();
}

function updateAllRepresentativeCards() {
  updateScreenshotRepresentativeCard();
  updateTemplateRepresentativeCard();
}

function updateScreenshotRepresentativeCard() {
  updateRepresentativeCard(
    elements.brandSelect.value,
    elements.representativeName,
    elements.representativeMention
  );
}

function updateTemplateRepresentativeCard() {
  updateRepresentativeCard(
    elements.templateBrandSelect.value,
    elements.templateRepresentativeName,
    elements.templateRepresentativeMention
  );
}

function updateRepresentativeCard(brand, nameElement, mentionElement) {
  const rep = representatives[brand] || { name: "", slackId: "" };
  nameElement.textContent = rep.name || "Not configured";
  if (rep.slackId) {
    mentionElement.textContent = `Slack mention: <@${rep.slackId}>`;
  } else if (rep.name) {
    mentionElement.textContent = "No Slack member ID configured";
  } else {
    mentionElement.textContent = "Add a representative in settings";
  }
}

async function pasteImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    showToast("Use Ctrl+V to paste the screenshot in this browser.");
    return;
  }
  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        const file = new File([blob], `pasted-screenshot-${Date.now()}.png`, { type: imageType });
        await handleImageFile(file);
        return;
      }
    }
    showToast("No screenshot image was found in the clipboard.");
  } catch (error) {
    console.warn(error);
    showToast("Clipboard access was blocked. Press Ctrl+V instead.");
  }
}

function handlePasteEvent(event) {
  if (!elements.templateView.hidden) return;
  const item = [...(event.clipboardData?.items || [])].find((candidate) => candidate.type.startsWith("image/"));
  if (!item) return;
  event.preventDefault();
  const file = item.getAsFile();
  if (file) handleImageFile(new File([file], `pasted-screenshot-${Date.now()}.png`, { type: file.type }));
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
  currentImageName = file.name || "Pasted screenshot";
  const objectUrl = URL.createObjectURL(file);
  elements.previewImage.onload = () => URL.revokeObjectURL(objectUrl);
  elements.previewImage.src = objectUrl;
  elements.imageName.textContent = currentImageName;
  elements.emptyDropState.hidden = true;
  elements.imageState.hidden = false;
  elements.clearImageBtn.disabled = false;
  elements.runOcrBtn.disabled = false;
  await runOcr();
}

async function runOcr() {
  if (!currentImage || isOcrRunning) return;
  if (!window.Tesseract) {
    showToast("OCR library could not load. Check your internet connection and refresh.");
    return;
  }

  isOcrRunning = true;
  elements.runOcrBtn.disabled = true;
  elements.ocrStatus.hidden = false;
  setOcrProgress(0, "Starting OCR…");

  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(currentImage);
    elements.extractedText.value = cleanExtractedText(result.data.text || "");
    updateTextCount();
    setOcrProgress(100, "Text extraction complete");
    showToast("Screenshot text extracted.");
    window.setTimeout(() => { elements.ocrStatus.hidden = true; }, 1100);
  } catch (error) {
    console.error(error);
    setOcrProgress(0, "OCR failed");
    showToast("Text extraction failed. Try a clearer screenshot or enter the text manually.");
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
        if (typeof message.progress === "number" && isOcrRunning) {
          const label = formatOcrStatus(message.status);
          setOcrProgress(Math.round(message.progress * 100), label);
        }
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

function formatOcrStatus(status) {
  const labels = {
    "loading tesseract core": "Loading OCR engine…",
    "initializing tesseract": "Initialising OCR…",
    "loading language traineddata": "Loading English recognition data…",
    "initializing api": "Preparing recognition…",
    "recognizing text": "Reading screenshot text…"
  };
  return labels[status] || "Processing screenshot…";
}

function setOcrProgress(percent, label) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.ocrStatusText.textContent = label;
  elements.ocrPercent.textContent = `${safePercent}%`;
  elements.progressBar.style.width = `${safePercent}%`;
}

function cleanExtractedText(value) {
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

function generateMessage() {
  const brand = elements.brandSelect.value;
  const details = cleanExtractedText(elements.extractedText.value);
  const type = elements.messageType.value;
  const tone = elements.toneSelect.value;
  const reference = elements.referenceInput.value.trim();
  const rep = representatives[brand] || { name: "", slackId: "" };

  if (!details) {
    elements.extractedText.focus();
    showToast("Add or extract some text before generating the message.");
    return;
  }

  let action = elements.actionSelect.value === "custom"
    ? elements.customAction.value.trim()
    : ACTION_TEXT[elements.actionSelect.value];
  if (!action) action = "Please review and advise on the next step.";
  action = ensureSentence(action);

  const greeting = getGreeting(rep, tone, type);
  const lines = [greeting, ""];

  if (tone === "concise") {
    lines.push(`*${brand} — ${TYPE_LABELS[type]}*`);
    if (reference) lines.push(`*Reference:* ${reference}`);
    lines.push("", details, "", action);
  } else {
    lines.push(getIntroSentence(brand, type, tone), "");
    if (reference) lines.push(`*Reference:* ${reference}`, "");
    lines.push("*Details:*", details, "", `*Action required:* ${action}`);
    if (type === "urgent" || tone === "urgent") {
      lines.push("", "Please treat this as a priority and share an update once reviewed.");
    }
  }

  elements.outputMessage.value = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  updateCopyState();
  elements.copyFeedback.textContent = "Message generated and ready to copy.";
}

function getGreeting(rep, tone, type) {
  const mention = rep.slackId ? `<@${rep.slackId}>` : "";
  const name = rep.name ? rep.name : "team";
  const addressee = mention || name;
  if (type === "urgent" || tone === "urgent") return `:rotating_light: Hi ${addressee},`;
  if (tone === "friendly") return `Hi ${addressee}, hope you're well.`;
  return `Hi ${addressee},`;
}

function getIntroSentence(brand, type, tone) {
  const intros = {
    general: `We have received the following enquiry for *${brand}*.`,
    customer: `A customer-related issue has been received for *${brand}*.`,
    payment: `A payment-related issue has been received for *${brand}*.`,
    course: `A course or content issue has been reported for *${brand}*.`,
    technical: `A technical issue has been reported for *${brand}*.`,
    refund: `A refund request has been received for *${brand}*.`,
    urgent: `An urgent issue has been escalated for *${brand}*.`
  };
  const base = intros[type] || intros.general;
  return tone === "friendly" ? `${base} Could you please take a look?` : base;
}

function generateReminderTemplate() {
  const brand = elements.templateBrandSelect.value;
  const email = elements.templateEmail.value.trim();
  const date = elements.templateDate.value;
  const time = elements.templateTime.value;
  const timezone = elements.templateTimezone.value.trim();
  const meetingLink = elements.templateMeetingLink.value.trim();
  const greeting = elements.templateGreeting.value.trim();
  const intro = elements.templateIntro.value.trim();
  const additionalNote = cleanExtractedText(elements.templateAdditionalNote.value);

  const requiredFields = [
    [email, elements.templateEmail, "Add the email address."],
    [date, elements.templateDate, "Select the meeting date."],
    [time, elements.templateTime, "Select the meeting time."],
    [timezone, elements.templateTimezone, "Add the time-zone label."],
    [meetingLink, elements.templateMeetingLink, "Add the meeting link."]
  ];

  const missing = requiredFields.find(([value]) => !value);
  if (missing) {
    missing[1].focus();
    showToast(missing[2]);
    return;
  }

  const lines = [];
  if (greeting) lines.push(greeting, "");
  if (intro) lines.push(intro, "");
  lines.push(`Brand: ${brand}`);
  lines.push(email, "");
  lines.push(`Date: ${formatDateForTemplate(date)}`);
  lines.push(`Time: ${formatTimeForTemplate(time)} (${timezone})`);
  lines.push(`Meeting Link: ${meetingLink}`);
  if (additionalNote) lines.push("", additionalNote);

  elements.templateOutputMessage.value = lines.join("\n").trim();
  updateTemplateCopyState();
  elements.templateCopyFeedback.textContent = "Reminder generated and ready to copy.";
}

function formatDateForTemplate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value;
  const monthIndex = Number(match[2]) - 1;
  return `${match[3]}-${MONTH_NAMES[monthIndex]}-${match[1]}`;
}

function formatTimeForTemplate(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return value;
  const hours24 = Number(match[1]);
  const minutes = match[2];
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${minutes} ${period}`;
}

function setCurrentBangladeshDateTime() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );

  elements.templateDate.value = `${parts.year}-${parts.month}-${parts.day}`;
  elements.templateTime.value = `${parts.hour}:${parts.minute}`;
  elements.templateTimezone.value = TEMPLATE_DEFAULTS.timezone;
  showToast("Current Bangladesh date and time added.");
}

function ensureSentence(value) {
  const trimmed = String(value || "").trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

async function copyTextOutput(textarea, feedbackElement, toastMessage) {
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    feedbackElement.textContent = "Copied to clipboard.";
    showToast(toastMessage);
  } catch (error) {
    textarea.select();
    document.execCommand("copy");
    feedbackElement.textContent = "Copied to clipboard.";
    showToast(toastMessage);
  }
}

function updateCopyState() {
  elements.copyBtn.disabled = !elements.outputMessage.value.trim();
  if (!elements.outputMessage.value.trim()) elements.copyFeedback.textContent = "";
}

function updateTemplateCopyState() {
  elements.copyTemplateBtn.disabled = !elements.templateOutputMessage.value.trim();
  if (!elements.templateOutputMessage.value.trim()) elements.templateCopyFeedback.textContent = "";
}

function clearImage() {
  currentImage = null;
  currentImageName = "Screenshot";
  elements.previewImage.removeAttribute("src");
  elements.emptyDropState.hidden = false;
  elements.imageState.hidden = true;
  elements.clearImageBtn.disabled = true;
  elements.runOcrBtn.disabled = true;
  elements.ocrStatus.hidden = true;
}

function resetForm() {
  clearImage();
  elements.extractedText.value = "";
  elements.brandSelect.selectedIndex = 0;
  elements.messageType.value = "general";
  elements.toneSelect.value = "professional";
  elements.actionSelect.value = "review";
  elements.customAction.value = "";
  elements.customActionGroup.hidden = true;
  elements.referenceInput.value = "";
  elements.outputMessage.value = "";
  updateTextCount();
  updateCopyState();
  updateScreenshotRepresentativeCard();
  showToast("Screenshot form reset. Representative settings were kept.");
}

function resetTemplateForm() {
  elements.templateBrandSelect.selectedIndex = 0;
  elements.templateEmail.value = "";
  elements.templateDate.value = "";
  elements.templateTime.value = "";
  elements.templateTimezone.value = TEMPLATE_DEFAULTS.timezone;
  elements.templateMeetingLink.value = "";
  elements.templateGreeting.value = TEMPLATE_DEFAULTS.greeting;
  elements.templateIntro.value = TEMPLATE_DEFAULTS.intro;
  elements.templateAdditionalNote.value = "";
  elements.templateOutputMessage.value = "";
  updateTemplateCopyState();
  updateTemplateRepresentativeCard();
  showToast("Reminder template reset. Representative settings were kept.");
}

function updateTextCount() {
  const count = elements.extractedText.value.length;
  elements.textCount.textContent = `${count.toLocaleString()} character${count === 1 ? "" : "s"}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2800);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
