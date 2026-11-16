"use strict";

/*
 * Web app UI. All parsing, time conversion and message building lives in
 * core.js (window.MeetingCore); this file only wires it to the page.
 */

const core = window.MeetingCore;
const BRAND_CONFIG = Array.isArray(window.BRAND_CONFIG) ? window.BRAND_CONFIG : [];
const BRANDS = BRAND_CONFIG.map((item) => String(item.brand || "").trim()).filter(Boolean);

const STORAGE_KEY = "slack-message-generator-representatives-v1";
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";
const PADDLE_OCR_MODULE_URL = "https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm";
const ONNX_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const GOOD_OCR_SCORE = 15;

/* Form fields that feed the reminder, keyed by the name core.js uses. */
const FIELD_IDS = {
  brand: "brandSelect",
  partnerBrand: "partnerBrandInput",
  email: "emailInput",
  date: "sourceDate",
  time: "sourceTime",
  endTime: "sourceEndTime",
  timezone: "sourceTimezone",
  meetingLink: "meetingLinkInput",
  note: "additionalNote"
};
const FIELD_LABELS = {
  brand: "brand",
  partnerBrand: "partner brand",
  email: "email",
  date: "date",
  time: "start time",
  endTime: "end time",
  timezone: "time zone",
  meetingLink: "meeting link"
};

const el = {};
const state = {
  image: null,
  representatives: {},
  ocrRunning: false,
  ocrQueued: false,
  outputEdited: false,
  lastGenerated: "",
  statusHtml: "",
  toastTimer: null
};
const ocr = { worker: null, workerPromise: null, paddle: null, paddlePromise: null, paddleUnavailable: false, tesseractScript: null };

window.addEventListener("DOMContentLoaded", init);

function init() {
  document.querySelectorAll("[id]").forEach((node) => { el[node.id] = node; });
  state.representatives = loadRepresentatives();

  el.brandSelect.replaceChildren(...BRANDS.map((brand) => new Option(brand, brand)));
  el.sourceTimezone.replaceChildren(...core.orderedTimezones().map((zone) => new Option(zone.label, zone.id)));

  bindImageEvents();
  bindFormEvents();
  bindSettingsEvents();
  updateShareButtonLabel();
  updateRepresentativeCard();
  applyPrefillFromHash();
  refreshOutput();
}

/* ---------- events ---------- */

function bindImageEvents() {
  const openPicker = (event) => {
    event.stopPropagation();
    el.fileInput.click();
  };
  el.uploadBtn.addEventListener("click", openPicker);
  el.replaceImageBtn.addEventListener("click", openPicker);
  el.dropZone.addEventListener("click", (event) => {
    if (!event.target.closest("button")) el.fileInput.click();
  });
  el.dropZone.addEventListener("keydown", (event) => {
    if (event.target !== el.dropZone || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    el.fileInput.click();
  });
  el.fileInput.addEventListener("change", () => {
    const file = el.fileInput.files?.[0];
    if (file) handleImageFile(file);
    el.fileInput.value = "";
  });
  el.pasteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    pasteFromClipboard();
  });
  document.addEventListener("paste", handlePasteEvent);

  // Accept a drop anywhere on the page, not only on the drop zone.
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    el.dropZone.classList.add("dragging");
  });
  document.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropZone.classList.remove("dragging");
  });
  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    el.dropZone.classList.remove("dragging");
    const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith("image/"));
    if (file) handleImageFile(file);
    else showToast("That file is not an image. Drop a PNG, JPG or WebP screenshot.");
  });

  el.clearImageBtn.addEventListener("click", clearImage);
  el.runOcrBtn.addEventListener("click", runOcr);
  el.fetchDetailsBtn.addEventListener("click", () => readDetailsFromText(el.extractedText.value, "text"));
}

function bindFormEvents() {
  Object.values(FIELD_IDS).forEach((id) => {
    const field = el[id];
    const onEdit = () => {
      field.classList.remove("autofilled");
      refreshOutput();
    };
    field.addEventListener("input", onEdit);
    field.addEventListener("change", onEdit);
  });
  el.brandSelect.addEventListener("change", updateRepresentativeCard);
  el.editCurrentRepBtn.addEventListener("click", () => openSettings(el.brandSelect.value));
  el.meetingLinkInput.addEventListener("blur", () => {
    const value = el.meetingLinkInput.value.trim();
    // People often paste "meet.google.com/…" without the scheme.
    if (value && !/^https?:\/\//i.test(value) && /^[^\s/]+\.[^\s/]+/.test(value)) {
      el.meetingLinkInput.value = `https://${value}`;
      refreshOutput();
    }
  });

  el.outputMessage.addEventListener("input", () => {
    state.outputEdited = el.outputMessage.value.trim() !== "" && el.outputMessage.value !== state.lastGenerated;
    refreshOutput();
  });
  el.outputStatus.addEventListener("click", (event) => {
    const target = event.target.closest("[data-focus], [data-action]");
    if (!target) return;
    if (target.dataset.action === "rebuild") {
      state.outputEdited = false;
      refreshOutput();
    } else {
      focusField(target.dataset.focus);
    }
  });
  el.copyBtn.addEventListener("click", copyOutput);
  el.shareSlackBtn.addEventListener("click", shareToSlack);
  el.resetBtn.addEventListener("click", resetForm);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !el.copyBtn.disabled && !el.settingsDialog.open) {
      event.preventDefault();
      copyOutput();
    }
  });
  window.addEventListener("hashchange", () => {
    if (applyPrefillFromHash()) refreshOutput();
  });
}

function bindSettingsEvents() {
  el.openSettingsBtn.addEventListener("click", () => openSettings());
  el.closeSettingsBtn.addEventListener("click", () => el.settingsDialog.close());
  el.cancelSettingsBtn.addEventListener("click", () => el.settingsDialog.close());
  el.clearSettingsBtn.addEventListener("click", () => {
    el.representativeRows.querySelectorAll("input").forEach((input) => { input.value = ""; });
  });
  el.settingsSearch.addEventListener("input", filterRepresentativeRows);
  el.settingsForm.addEventListener("submit", saveRepresentativeSettings);
  // Clicking the dimmed backdrop closes the dialog without saving.
  el.settingsDialog.addEventListener("click", (event) => {
    if (event.target === el.settingsDialog) el.settingsDialog.close();
  });
}

/* ---------- representatives ---------- */

function loadRepresentatives() {
  const reps = Object.fromEntries(BRAND_CONFIG.map((item) => [
    String(item.brand || "").trim(),
    { name: String(item.representativeName || "").trim(), slackId: core.normalizeSlackId(item.slackId) }
  ]));
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    BRANDS.forEach((brand) => {
      if (!Object.prototype.hasOwnProperty.call(saved, brand)) return;
      reps[brand] = {
        name: String(saved[brand]?.name || "").trim(),
        slackId: core.normalizeSlackId(saved[brand]?.slackId)
      };
    });
  } catch (error) {
    console.warn("Could not load representative settings.", error);
  }
  return reps;
}

function currentRepresentative() {
  return state.representatives[el.brandSelect.value] || { name: "", slackId: "" };
}

function updateRepresentativeCard() {
  const rep = currentRepresentative();
  el.representativeName.textContent = rep.name || (rep.slackId ? `<@${rep.slackId}>` : "Not set");
  if (rep.slackId) el.representativeMention.textContent = "Greeting will @mention them in Slack";
  else if (rep.name) el.representativeMention.textContent = `Greeting will say “${rep.name} bhai”`;
  else el.representativeMention.textContent = "Greeting will say “bhai”";
  el.editCurrentRepBtn.textContent = rep.name || rep.slackId ? "Change" : "Set";
}

function openSettings(focusBrand = "") {
  el.settingsSearch.value = "";
  el.representativeRows.innerHTML = BRANDS.map((brand) => {
    const rep = state.representatives[brand] || { name: "", slackId: "" };
    return `
      <tr data-brand="${escapeHtml(brand)}">
        <td>${escapeHtml(brand)}</td>
        <td><input type="text" data-field="name" value="${escapeHtml(rep.name)}" placeholder="Name" aria-label="Representative for ${escapeHtml(brand)}" /></td>
        <td><input type="text" data-field="slackId" value="${escapeHtml(rep.slackId)}" placeholder="U012AB3CD" aria-label="Slack member ID for ${escapeHtml(brand)}" /></td>
      </tr>`;
  }).join("");
  el.settingsDialog.showModal();
  if (!focusBrand) return;
  const row = [...el.representativeRows.rows].find((item) => item.dataset.brand === focusBrand);
  if (!row) return;
  row.classList.add("is-focus");
  row.scrollIntoView({ block: "center" });
  row.querySelector('[data-field="name"]').focus();
}

function filterRepresentativeRows() {
  const query = core.normalizeSearchText(el.settingsSearch.value);
  [...el.representativeRows.rows].forEach((row) => {
    row.hidden = Boolean(query) && !core.normalizeSearchText(row.dataset.brand).includes(query);
  });
}

function saveRepresentativeSettings(event) {
  event.preventDefault();
  const next = {};
  [...el.representativeRows.rows].forEach((row) => {
    next[row.dataset.brand] = {
      name: row.querySelector('[data-field="name"]').value.trim(),
      slackId: core.normalizeSlackId(row.querySelector('[data-field="slackId"]').value)
    };
  });
  state.representatives = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    showToast("Representatives saved.");
  } catch (error) {
    showToast("Saved for this visit only. This browser is blocking storage.");
  }
  el.settingsDialog.close();
  updateRepresentativeCard();
  refreshOutput();
}

/* ---------- getting the meeting in: image or text ---------- */

async function pasteFromClipboard() {
  if (!navigator.clipboard?.read) {
    showToast("This browser can't read the clipboard from a button. Press Ctrl + V instead.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      handleImageFile(new File([blob], "Pasted screenshot", { type: imageType }));
      return;
    }
    const textItem = items.find((item) => item.types.includes("text/plain"));
    if (textItem) {
      readDetailsFromText(await (await textItem.getType("text/plain")).text(), "paste");
      return;
    }
    showToast("The clipboard has no screenshot or text. Copy one and try again.");
  } catch (error) {
    console.warn(error);
    showToast("Clipboard access was blocked. Press Ctrl + V instead.");
  }
}

function handlePasteEvent(event) {
  if (el.settingsDialog.open) return;
  const data = event.clipboardData;
  const imageItem = [...(data?.items || [])].find((candidate) => candidate.type.startsWith("image/"));
  if (imageItem) {
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    handleImageFile(new File([file], "Pasted screenshot", { type: file.type }));
    return;
  }
  // Text pasted outside a form field is treated as meeting text to read.
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const text = data?.getData("text/plain") || "";
  if (!text.trim()) return;
  event.preventDefault();
  readDetailsFromText(text, "paste");
}

function handleImageFile(file) {
  if (!file.type.startsWith("image/")) {
    showToast("That file is not an image. Use a PNG, JPG or WebP screenshot.");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast("That screenshot is over 15 MB. Crop it to the meeting details and try again.");
    return;
  }
  state.image = file;
  const objectUrl = URL.createObjectURL(file);
  el.previewImage.onload = () => URL.revokeObjectURL(objectUrl);
  el.previewImage.src = objectUrl;
  el.imageName.textContent = file.name || "Pasted screenshot";
  el.emptyDropState.hidden = true;
  el.imageState.hidden = false;
  el.clearImageBtn.hidden = false;
  el.runOcrBtn.disabled = false;
  runOcr();
}

function clearImage() {
  state.image = null;
  el.previewImage.removeAttribute("src");
  el.emptyDropState.hidden = false;
  el.imageState.hidden = true;
  el.clearImageBtn.hidden = true;
  el.runOcrBtn.disabled = true;
  el.ocrStatus.hidden = true;
  el.extractionResult.hidden = true;
  el.extractedText.value = "";
}

/* ---------- OCR ---------- */

async function runOcr() {
  if (!state.image) return;
  if (state.ocrRunning) {
    // A new screenshot arrived mid-scan; scan it as soon as the current run ends.
    state.ocrQueued = true;
    return;
  }

  const image = state.image;
  state.ocrRunning = true;
  el.runOcrBtn.disabled = true;
  el.ocrStatus.hidden = false;
  el.ocrStatus.classList.remove("failed");
  el.ocrHint.hidden = Boolean(ocr.paddle || ocr.worker);
  el.extractionResult.hidden = true;
  setOcrProgress(0, "Preparing screenshot…");

  try {
    const prepared = await prepareOcrImages(image);
    const candidates = [];

    try {
      setOcrProgress(8, "Loading the text reader…");
      const paddleText = await recognizeWithPaddleOcr(prepared.color);
      if (paddleText) candidates.push(paddleText);
    } catch (error) {
      ocr.paddleUnavailable = true;
      console.warn("PaddleOCR was unavailable; using Tesseract instead.", error);
    }

    const paddleBest = selectBestOcrText(candidates);
    if (!paddleBest || core.scoreOcrText(paddleBest, BRANDS) < GOOD_OCR_SCORE) {
      setOcrProgress(58, paddleBest ? "Double-checking missed details…" : "Reading the screenshot…");
      candidates.push(...(await recognizeWithTesseract(prepared)).filter(Boolean));
    }

    const best = selectBestOcrText(candidates);
    if (!best) throw new Error("No text was recognised.");
    if (state.image !== image) return; // replaced or removed while scanning

    const text = core.cleanText(buildOcrConsensusText(candidates, best));
    el.extractedText.value = text;
    setOcrProgress(100, "Screenshot read");
    readDetailsFromText(text, "screenshot");
    window.setTimeout(() => {
      if (!state.ocrRunning) el.ocrStatus.hidden = true;
    }, 1200);
  } catch (error) {
    console.error(error);
    if (state.image === image) {
      el.ocrStatus.classList.add("failed");
      el.ocrHint.hidden = true;
      setOcrProgress(0, "Couldn't read this screenshot. Try a tighter crop, or paste the meeting text below.");
      el.textDetails.open = true;
    }
  } finally {
    state.ocrRunning = false;
    el.runOcrBtn.disabled = !state.image;
    if (state.ocrQueued) {
      state.ocrQueued = false;
      runOcr();
    }
  }
}

async function recognizeWithPaddleOcr(imageCanvas) {
  const engine = await getPaddleOcr();
  setOcrProgress(28, "Finding the text…");
  const [result] = await engine.predict(imageCanvas, {
    textDetLimitSideLen: 1920,
    textDetLimitType: "max",
    textDetMaxSideLimit: 3200,
    textDetThresh: 0.25,
    textDetBoxThresh: 0.45,
    textDetUnclipRatio: 1.6,
    textRecScoreThresh: 0.25
  });
  setOcrProgress(54, "Reading the meeting details…");
  return core.formatPaddleOcrItems(result?.items || []);
}

function getPaddleOcr() {
  if (ocr.paddle) return Promise.resolve(ocr.paddle);
  if (ocr.paddleUnavailable) return Promise.reject(new Error("PaddleOCR is disabled for this session."));
  if (!ocr.paddlePromise) {
    ocr.paddlePromise = import(PADDLE_OCR_MODULE_URL)
      .then(({ PaddleOCR }) => PaddleOCR.create({
        lang: "en",
        ocrVersion: "PP-OCRv6",
        ortOptions: { backend: "wasm", wasmPaths: ONNX_WASM_PATH, numThreads: 1, simd: true }
      }))
      .then((instance) => {
        ocr.paddle = instance;
        return instance;
      })
      .catch((error) => {
        ocr.paddlePromise = null;
        throw error;
      });
  }
  return ocr.paddlePromise;
}

async function recognizeWithTesseract(prepared) {
  const worker = await getTesseractWorker();
  const outputs = [];

  await worker.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1", user_defined_dpi: "300" });
  outputs.push(core.cleanText((await worker.recognize(prepared.enhanced)).data.text));

  if (core.scoreOcrText(outputs[0], BRANDS) < GOOD_OCR_SCORE) {
    setOcrProgress(82, "Trying a high-contrast pass…");
    await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1", user_defined_dpi: "300" });
    outputs.push(core.cleanText((await worker.recognize(prepared.binary)).data.text));
  }
  return outputs;
}

/* Tesseract is only downloaded if PaddleOCR fails or misses details. */
function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!ocr.tesseractScript) {
    ocr.tesseractScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TESSERACT_URL;
      script.onload = resolve;
      script.onerror = () => {
        ocr.tesseractScript = null;
        script.remove();
        reject(new Error("Tesseract could not be downloaded."));
      };
      document.head.appendChild(script);
    });
  }
  return ocr.tesseractScript;
}

async function getTesseractWorker() {
  if (ocr.worker) return ocr.worker;
  await loadTesseractScript();
  if (!ocr.workerPromise) {
    const labels = {
      "loading tesseract core": "Loading the backup text reader…",
      "initializing tesseract": "Starting the backup text reader…",
      "loading language traineddata": "Loading English recognition data…",
      "initializing api": "Almost ready…",
      "recognizing text": "Reading the screenshot…"
    };
    ocr.workerPromise = window.Tesseract.createWorker("eng", 1, {
      logger: (message) => {
        if (typeof message.progress !== "number" || !state.ocrRunning) return;
        setOcrProgress(58 + Math.round(message.progress * 34), labels[message.status] || "Reading the screenshot…");
      }
    }).then((worker) => {
      ocr.worker = worker;
      return worker;
    }).catch((error) => {
      ocr.workerPromise = null;
      throw error;
    });
  }
  return ocr.workerPromise;
}

function selectBestOcrText(texts) {
  return texts
    .filter((text) => core.cleanText(text))
    .sort((a, b) => core.scoreOcrText(b, BRANDS) - core.scoreOcrText(a, BRANDS) || b.length - a.length)[0] || "";
}

/* Start from the best reading and append any detail only another pass caught. */
function buildOcrConsensusText(texts, bestText) {
  const baseText = core.cleanText(bestText);
  const base = core.extractReminderDetails(baseText, BRANDS);
  const consensus = { ...base };
  [...texts]
    .sort((a, b) => core.scoreOcrText(b, BRANDS) - core.scoreOcrText(a, BRANDS))
    .forEach((text) => {
      const details = core.extractReminderDetails(text, BRANDS);
      Object.keys(consensus).forEach((key) => {
        if (!consensus[key] && details[key]) consensus[key] = details[key];
      });
    });

  const extra = [];
  if (!base.brand && consensus.brand) extra.push(`Brand: ${consensus.brand}`);
  if (!base.partnerBrand && consensus.partnerBrand) extra.push(`Meeting with: ${consensus.partnerBrand}`);
  if (!base.email && consensus.email) extra.push(consensus.email);
  if (!base.meetingLink && consensus.meetingLink) extra.push("Meeting link", consensus.meetingLink);
  if ((!base.date || !base.time || !base.timezone) && consensus.date && consensus.time) {
    const range = [consensus.time, consensus.endTime].filter(Boolean).map(core.formatTimeForMessage).join(" ~ ");
    extra.push("When", `${consensus.date} - ${range} (${core.timezoneLabel(consensus.timezone || core.TARGET_ZONE)})`);
  }
  return extra.length ? `${baseText}\n\nAlso found on a second pass\n${extra.join("\n")}` : baseText;
}

async function prepareOcrImages(file) {
  const source = await loadImageSource(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  // Upscale small screenshots for sharper text, but cap the canvas so phones don't run out of memory.
  const scale = Math.min(3, Math.max(1, 2200 / Math.max(1, width)), 4200 / Math.max(1, width, height));

  const color = document.createElement("canvas");
  color.width = Math.max(1, Math.round(width * scale));
  color.height = Math.max(1, Math.round(height * scale));
  const context = color.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, color.width, color.height);
  if (typeof source.close === "function") source.close();

  return { color, enhanced: toTextCanvas(color, false), binary: toTextCanvas(color, true) };
}

function loadImageSource(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The screenshot could not be decoded."));
    };
    image.src = url;
  });
}

/* Greyscale copy with stretched contrast, or pure black and white (Otsu) when `binary` is set. */
function toTextCanvas(source, binary) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0);

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const luminance = new Uint8Array(pixels.length / 4);
  const histogram = new Uint32Array(256);
  for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
    const gray = Math.round(0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2]);
    luminance[pixel] = gray;
    histogram[gray] += 1;
  }

  const low = histogramPercentile(histogram, luminance.length, 0.02);
  const range = Math.max(24, histogramPercentile(histogram, luminance.length, 0.98) - low);
  const threshold = binary ? otsuThreshold(histogram, luminance.length) : 0;
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

  for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
    const value = binary
      ? (luminance[pixel] > threshold ? 255 : 0)
      : clamp((clamp(((luminance[pixel] - low) * 255) / range) - 128) * 1.18 + 128);
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function histogramPercentile(histogram, total, percentile) {
  const target = total * percentile;
  let count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (count >= target) return value;
  }
  return 255;
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maximumVariance = -1;
  let threshold = 127;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const difference = backgroundSum / backgroundWeight - (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * difference ** 2;
    if (variance > maximumVariance) {
      maximumVariance = variance;
      threshold = value;
    }
  }
  return threshold;
}

function setOcrProgress(percent, label) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  el.ocrStatusText.textContent = label;
  el.ocrPercent.textContent = safe ? `${safe}%` : "";
  el.progressBar.style.width = `${safe}%`;
}

/* ---------- details ---------- */

function readDetailsFromText(text, origin) {
  const source = core.cleanText(text);
  if (!source) {
    showToast("There's no text to read yet. Paste the invite or email first.");
    el.textDetails.open = true;
    el.extractedText.focus();
    return;
  }
  if (origin === "paste") {
    el.extractedText.value = source;
    el.textDetails.open = true;
  }

  const found = applyDetails(core.extractReminderDetails(source, BRANDS));
  const from = origin === "screenshot" ? "the screenshot" : "the text";
  el.extractionResult.hidden = false;
  if (found.length) {
    el.extractionResult.innerHTML = `<p>Read from ${from}. Check each one before you copy.</p>
      <div class="chip-row">${found.map((key) => `<span class="chip">${escapeHtml(FIELD_LABELS[key])}</span>`).join("")}</div>`;
  } else {
    el.extractionResult.innerHTML = `<p>No meeting details were recognised in ${from}. Fill in the details by hand, or edit the text and read it again.</p>`;
    el.textDetails.open = true;
  }
  refreshOutput();
}

/* Fill the form from a details object; returns the keys that were applied. */
function applyDetails(details) {
  const applied = [];
  Object.entries(FIELD_IDS).forEach(([key, id]) => {
    const value = details?.[key];
    if (!value) return;
    const field = el[id];
    if (field.tagName === "SELECT" && ![...field.options].some((option) => option.value === value)) return;
    field.value = value;
    field.classList.add("autofilled");
    applied.push(key);
  });
  if (applied.includes("brand")) updateRepresentativeCard();
  return applied;
}

/* The extension hands a meeting over as index.html#prefill=… */
function applyPrefillFromHash() {
  const details = core.decodePrefill(window.location.hash);
  if (!details) return false;
  applyDetails(details);
  history.replaceState(null, "", window.location.pathname + window.location.search);
  showToast("Meeting details loaded from the extension.");
  return true;
}

function readForm() {
  return {
    brand: el.brandSelect.value,
    partnerBrand: el.partnerBrandInput.value,
    email: el.emailInput.value.trim(),
    date: el.sourceDate.value,
    time: el.sourceTime.value,
    endTime: el.sourceEndTime.value,
    timezone: el.sourceTimezone.value,
    meetingLink: el.meetingLinkInput.value.trim(),
    note: el.additionalNote.value
  };
}

function focusField(key) {
  const field = el[FIELD_IDS[key]];
  if (!field) return;
  field.scrollIntoView({ block: "center", behavior: "smooth" });
  field.focus({ preventScroll: true });
}

/* ---------- live output ---------- */

function refreshOutput() {
  const form = readForm();
  const converted = core.convertToDhaka(form);
  const missing = core.findMissingFields(form);
  renderTicket(form, converted);
  renderFieldHints(form);

  const ready = !missing.length && converted;
  state.lastGenerated = ready ? core.buildReminderMessage({ ...form, rep: currentRepresentative(), converted }) : "";
  if (!state.outputEdited) el.outputMessage.value = state.lastGenerated;

  const hasMessage = Boolean(el.outputMessage.value.trim());
  el.copyBtn.disabled = !hasMessage;
  el.shareSlackBtn.disabled = !hasMessage;
  if (!hasMessage) el.shareFeedback.textContent = "";

  el.outputStatus.classList.toggle("is-ready", Boolean(ready) && !state.outputEdited);
  let status;
  if (state.outputEdited) {
    status = 'You edited the message, so changes to the details no longer update it. <button class="text-btn" type="button" data-action="rebuild">Rebuild from details</button>';
  } else if (ready) {
    status = "Ready to copy. It updates as you change the details.";
  } else {
    status = `Still needed to write the reminder:
      <div class="chip-row">${missing.map((key) => `<button class="chip missing" type="button" data-focus="${key}">${escapeHtml(FIELD_LABELS[key])}</button>`).join("")}</div>`;
  }
  // Only touch the DOM when the status changes: re-rendering mid-click would
  // swallow a press on the buttons inside it.
  if (status !== state.statusHtml) {
    state.statusHtml = status;
    el.outputStatus.innerHTML = status;
  }
}

function renderTicket(form, converted) {
  el.conversionCard.classList.toggle("is-empty", !converted);
  el.conversionCard.classList.toggle("same-zone", Boolean(converted) && !converted.wasConverted);
  if (!converted) {
    el.ticketSourceLabel.textContent = "On the screenshot";
    el.ticketSourceTime.textContent = "--:--";
    el.ticketSourceDate.textContent = "Add a date and start time";
    el.convertedTime.textContent = "--:--";
    el.convertedDate.textContent = " ";
    el.conversionNote.textContent = "The reminder always uses Bangladesh Standard Time.";
    return;
  }

  const describe = (date, endTime, endDate) => {
    const day = `${core.formatWeekday(date)}, ${core.formatDateForMessage(date)}`;
    if (!endTime) return day;
    const until = `until ${core.formatTimeForMessage(endTime)}`;
    return endDate && endDate !== date ? `${day}, ${until} next day` : `${day}, ${until}`;
  };
  const sourceEndDate = form.endTime && form.endTime <= form.time ? core.addDaysToDateInput(form.date, 1) : form.date;

  el.ticketSourceLabel.textContent = converted.sourceZoneName
    ? `${core.timezoneLabel(converted.sourceZone)} (${converted.sourceZoneName})`
    : core.timezoneLabel(converted.sourceZone);
  el.ticketSourceTime.textContent = core.formatTimeForMessage(form.time);
  el.ticketSourceDate.textContent = describe(form.date, form.endTime, sourceEndDate);
  el.convertedTime.textContent = core.formatTimeForMessage(converted.time);
  el.convertedDate.textContent = describe(converted.date, converted.endTime, converted.endDate);

  if (!converted.wasConverted) el.conversionNote.textContent = "Already in Bangladesh time, so nothing to convert.";
  else if (converted.date !== form.date) el.conversionNote.textContent = "Note the date: in Bangladesh this meeting falls on a different day.";
  else el.conversionNote.textContent = "Converted to Bangladesh Standard Time, with daylight saving handled for that date.";
}

function renderFieldHints(form) {
  const hints = {
    emailInput: form.email && !el.emailInput.validity.valid ? "This doesn't look like a complete email address." : "",
    meetingLinkInput: form.meetingLink && !core.cleanUrlCandidate(form.meetingLink) ? "This doesn't look like a link. It should start with https://" : ""
  };
  Object.entries(hints).forEach(([id, message]) => {
    const hint = document.querySelector(`[data-error-for="${id}"]`);
    hint.textContent = message;
    hint.hidden = !message;
    el[id].classList.toggle("needs-attention", Boolean(message));
  });
}

/* ---------- copy and share ---------- */

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    // Older browsers and non-HTTPS pages: fall back to selecting the text.
    el.outputMessage.focus();
    el.outputMessage.select();
    return document.execCommand("copy");
  }
}

async function copyOutput() {
  const text = el.outputMessage.value.trim();
  if (!text) return;
  if (await copyTextToClipboard(text)) {
    showToast("Message copied.");
    flashButton(el.copyBtn, "Copied");
  } else {
    showToast("Couldn't copy automatically. The message is selected, so press Ctrl + C.");
  }
}

function isLikelyMobileDevice() {
  if (typeof navigator.userAgentData?.mobile === "boolean") return navigator.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}

function canUseShareSheet() {
  return isLikelyMobileDevice() && typeof navigator.share === "function";
}

function updateShareButtonLabel() {
  el.shareSlackBtn.textContent = canUseShareSheet() ? "Share to Slack" : "Copy and open Slack";
}

async function shareToSlack() {
  const text = el.outputMessage.value.trim();
  if (!text) return;

  if (canUseShareSheet()) {
    try {
      await navigator.share({ text });
      el.shareFeedback.textContent = "Pick Slack in the share menu, then choose the conversation.";
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.warn("The share menu failed; opening Slack directly.", error);
    }
  }

  const copied = await copyTextToClipboard(text);
  el.shareFeedback.innerHTML = `${copied ? "Message copied. " : ""}Slack is opening, so paste the message into the right channel. If nothing opens, <a href="https://app.slack.com/client" target="_blank" rel="noopener noreferrer">use Slack in the browser</a>.`;
  showToast(copied ? "Message copied. Paste it in Slack." : "Opening Slack…");
  const link = Object.assign(document.createElement("a"), { href: "slack://open" });
  link.click();
}

/* ---------- reset and small utilities ---------- */

function resetForm() {
  clearImage();
  Object.values(FIELD_IDS).forEach((id) => {
    const field = el[id];
    if (field.tagName === "SELECT") field.selectedIndex = 0;
    else field.value = "";
    field.classList.remove("autofilled");
  });
  el.textDetails.open = false;
  state.outputEdited = false;
  el.shareFeedback.textContent = "";
  updateRepresentativeCard();
  refreshOutput();
  showToast("Cleared. Your representatives are still saved.");
}

function flashButton(button, label) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  window.clearTimeout(button.flashTimer);
  button.flashTimer = window.setTimeout(() => { button.textContent = original; }, 1500);
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => el.toast.classList.remove("visible"), 3200);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
