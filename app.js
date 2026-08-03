"use strict";

const BRAND_CONFIG = Array.isArray(window.BRAND_CONFIG) ? window.BRAND_CONFIG : [];
const BRANDS = BRAND_CONFIG.map((item) => String(item.brand || "").trim()).filter(Boolean);
const STORAGE_KEY = "slack-message-generator-representatives-v1";
const PADDLE_OCR_MODULE_URL = "https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm";
const ONNX_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
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
let paddleOcr = null;
let paddleOcrPromise = null;
let paddleOcrUnavailable = false;

window.addEventListener("DOMContentLoaded", init);

function init() {
  cacheElements();
  populateBrands();
  renderRepresentativeRows();
  bindEvents();
  updateRepresentativeCard();
  updateConversionPreview();
  updateCopyState();
  updateShareButtonLabel();
}

function cacheElements() {
  [
    "openSettingsBtn", "settingsDialog", "settingsForm", "closeSettingsBtn", "cancelSettingsBtn",
    "clearSettingsBtn", "representativeRows", "dropZone", "fileInput", "uploadBtn", "pasteBtn",
    "replaceImageBtn", "clearImageBtn", "emptyDropState", "imageState", "previewImage", "imageName",
    "ocrStatus", "ocrStatusText", "ocrPercent", "progressBar", "extractionResult", "runOcrBtn",
    "fetchDetailsBtn", "extractedText", "brandSelect", "representativeName", "representativeMention",
    "editCurrentRepBtn", "partnerBrandInput", "emailInput", "sourceDate", "sourceTime", "sourceEndTime", "sourceTimezone", "conversionCard",
    "convertedDateTime", "conversionNote", "meetingLinkInput", "additionalNote", "generateBtn",
    "outputMessage", "copyBtn", "copyFeedback", "shareSlackBtn", "shareFeedback", "resetBtn", "toast"
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
  [elements.sourceDate, elements.sourceTime, elements.sourceEndTime, elements.sourceTimezone].forEach((element) => {
    element.addEventListener("input", updateConversionPreview);
    element.addEventListener("change", updateConversionPreview);
  });

  elements.generateBtn.addEventListener("click", generateReminder);
  elements.outputMessage.addEventListener("input", updateCopyState);
  elements.copyBtn.addEventListener("click", copyOutput);
  elements.shareSlackBtn.addEventListener("click", shareToSlack);
  elements.resetBtn.addEventListener("click", resetForm);


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

  isOcrRunning = true;
  elements.runOcrBtn.disabled = true;
  elements.ocrStatus.hidden = false;
  elements.extractionResult.hidden = true;
  setOcrProgress(0, "Preparing screenshot…");

  try {
    const prepared = await prepareOcrImages(currentImage);
    const candidates = [];
    let engineLabel = "Enhanced OCR";

    try {
      setOcrProgress(8, "Loading enhanced OCR model…");
      const paddleText = await recognizeWithPaddleOcr(prepared.color);
      if (paddleText) candidates.push({ engine: "PaddleOCR", text: paddleText });
    } catch (error) {
      paddleOcrUnavailable = true;
      console.warn("Enhanced PaddleOCR was unavailable; using fallback OCR.", error);
      engineLabel = "Fallback OCR";
    }

    const paddleBest = selectBestOcrCandidate(candidates);
    if (!paddleBest || scoreOcrText(paddleBest.text) < 15) {
      setOcrProgress(58, paddleBest ? "Checking missed details…" : "Reading screenshot with fallback OCR…");
      const fallbackTexts = await recognizeWithTesseract(prepared);
      fallbackTexts.forEach((text, index) => {
        if (text) candidates.push({ engine: index === 0 ? "Tesseract enhanced" : "Tesseract high contrast", text });
      });
      if (paddleBest && fallbackTexts.some(Boolean)) engineLabel = "Enhanced OCR + verification";
    }

    const best = selectBestOcrCandidate(candidates);
    if (!best?.text) throw new Error("No text was recognized.");

    const text = cleanText(buildOcrConsensusText(candidates, best));
    elements.extractedText.value = text;
    setOcrProgress(100, `${engineLabel} complete`);
    extractAndApplyDetails(text, false);
    elements.extractionResult.dataset.engine = best.engine;
    window.setTimeout(() => { elements.ocrStatus.hidden = true; }, 1400);
  } catch (error) {
    console.error(error);
    setOcrProgress(0, "OCR failed");
    showToast("OCR could not read the screenshot. Try a tighter crop or paste the text manually.");
  } finally {
    isOcrRunning = false;
    elements.runOcrBtn.disabled = !currentImage;
  }
}

async function recognizeWithPaddleOcr(imageCanvas) {
  const ocr = await getPaddleOcr();
  setOcrProgress(28, "Detecting text regions…");
  const [result] = await ocr.predict(imageCanvas, {
    textDetLimitSideLen: 1920,
    textDetLimitType: "max",
    textDetMaxSideLimit: 3200,
    textDetThresh: 0.25,
    textDetBoxThresh: 0.45,
    textDetUnclipRatio: 1.6,
    textRecScoreThresh: 0.25
  });
  setOcrProgress(54, "Recognising meeting details…");
  return formatPaddleOcrItems(result?.items || []);
}

async function getPaddleOcr() {
  if (paddleOcr) return paddleOcr;
  if (paddleOcrUnavailable) throw new Error("PaddleOCR is disabled for this session.");
  if (!paddleOcrPromise) {
    paddleOcrPromise = import(PADDLE_OCR_MODULE_URL)
      .then(({ PaddleOCR }) => PaddleOCR.create({
        lang: "en",
        ocrVersion: "PP-OCRv6",
        ortOptions: {
          backend: "wasm",
          wasmPaths: ONNX_WASM_PATH,
          numThreads: 1,
          simd: true
        }
      }))
      .then((instance) => {
        paddleOcr = instance;
        return instance;
      })
      .catch((error) => {
        paddleOcrPromise = null;
        throw error;
      });
  }
  return paddleOcrPromise;
}

function formatPaddleOcrItems(items) {
  const positioned = items
    .filter((item) => cleanText(item?.text || "") && Number(item?.score ?? 1) >= 0.22)
    .map((item) => {
      const points = Array.isArray(item.poly) ? item.poly : [];
      const xs = points.map((point) => Number(point?.[0])).filter(Number.isFinite);
      const ys = points.map((point) => Number(point?.[1])).filter(Number.isFinite);
      const x = xs.length ? Math.min(...xs) : 0;
      const y = ys.length ? Math.min(...ys) : 0;
      const height = ys.length ? Math.max(8, Math.max(...ys) - Math.min(...ys)) : 16;
      return { text: cleanText(item.text), x, y, centerY: y + height / 2, height };
    })
    .sort((a, b) => a.centerY - b.centerY || a.x - b.x);

  const rows = [];
  positioned.forEach((item) => {
    const row = rows.find((candidate) => Math.abs(candidate.centerY - item.centerY) <= Math.max(candidate.height, item.height) * 0.55);
    if (row) {
      row.items.push(item);
      row.centerY = (row.centerY * (row.items.length - 1) + item.centerY) / row.items.length;
      row.height = Math.max(row.height, item.height);
    } else {
      rows.push({ centerY: item.centerY, height: item.height, items: [item] });
    }
  });

  return rows
    .sort((a, b) => a.centerY - b.centerY)
    .map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(" "))
    .join("\n");
}

async function recognizeWithTesseract(prepared) {
  if (!window.Tesseract) throw new Error("Tesseract fallback could not load.");
  const worker = await getOcrWorker();
  const outputs = [];

  await worker.setParameters({
    tessedit_pageseg_mode: "3",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300"
  });
  const enhanced = await worker.recognize(prepared.enhanced);
  outputs.push(cleanText(enhanced.data.text || ""));

  if (scoreOcrText(outputs[0]) < 15) {
    setOcrProgress(82, "Running high-contrast verification…");
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300"
    });
    const highContrast = await worker.recognize(prepared.binary);
    outputs.push(cleanText(highContrast.data.text || ""));
  }
  return outputs;
}

async function prepareOcrImages(file) {
  const source = await loadImageSource(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const desiredScale = Math.min(3, Math.max(1, 2200 / Math.max(1, width)));
  const maximumScale = 4200 / Math.max(1, width, height);
  const scale = Math.min(desiredScale, maximumScale);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));

  const color = document.createElement("canvas");
  color.width = outputWidth;
  color.height = outputHeight;
  const colorContext = color.getContext("2d", { willReadFrequently: true });
  colorContext.imageSmoothingEnabled = true;
  colorContext.imageSmoothingQuality = "high";
  colorContext.drawImage(source, 0, 0, outputWidth, outputHeight);

  const enhanced = cloneCanvas(color);
  enhanceCanvasForText(enhanced, false);
  const binary = cloneCanvas(color);
  enhanceCanvasForText(binary, true);
  if (typeof source.close === "function") source.close();
  return { color, enhanced, binary };
}

async function loadImageSource(file) {
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

function cloneCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

function enhanceCanvasForText(canvas, makeBinary) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
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
  const high = histogramPercentile(histogram, luminance.length, 0.98);
  const threshold = makeBinary ? otsuThreshold(histogram, luminance.length) : 0;
  const range = Math.max(24, high - low);

  for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
    let value = Math.max(0, Math.min(255, Math.round(((luminance[pixel] - low) * 255) / range)));
    if (makeBinary) value = luminance[pixel] > threshold ? 255 : 0;
    else value = Math.max(0, Math.min(255, Math.round((value - 128) * 1.18 + 128)));
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
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
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > maximumVariance) {
      maximumVariance = variance;
      threshold = value;
    }
  }
  return threshold;
}

function scoreOcrText(text) {
  if (!text) return 0;
  const details = extractReminderDetails(text);
  let score = 0;
  if (details.meetingLink) score += /meet\.google\.com\/[a-z0-9]{3,}(?:-[a-z0-9]{2,})?/i.test(details.meetingLink) ? 7 : 5;
  if (details.date) score += 4;
  if (details.time) score += 4;
  if (details.endTime) score += 2;
  if (details.timezone) score += 2;
  if (details.email) score += 1;
  if (details.brand) score += 1;
  if (details.partnerBrand) score += 1;
  score += Math.min(2, Math.floor(cleanText(text).length / 150));
  return score;
}

function selectBestOcrCandidate(candidates) {
  return [...candidates]
    .filter((candidate) => cleanText(candidate?.text || ""))
    .sort((a, b) => scoreOcrText(b.text) - scoreOcrText(a.text) || b.text.length - a.text.length)[0] || null;
}

function buildOcrConsensusText(candidates, bestCandidate) {
  const baseText = cleanText(bestCandidate?.text || "");
  const baseDetails = extractReminderDetails(baseText);
  const consensus = { ...baseDetails };
  const sorted = [...candidates].sort((a, b) => scoreOcrText(b.text) - scoreOcrText(a.text));

  sorted.forEach((candidate) => {
    const details = extractReminderDetails(candidate.text);
    Object.keys(consensus).forEach((key) => {
      if (!consensus[key] && details[key]) consensus[key] = details[key];
    });
  });

  const supplemental = [];
  if (!baseDetails.brand && consensus.brand) supplemental.push(`Brand: ${consensus.brand}`);
  if (!baseDetails.partnerBrand && consensus.partnerBrand) supplemental.push(`Meeting with: ${consensus.partnerBrand}`);
  if (!baseDetails.email && consensus.email) supplemental.push(consensus.email);
  if (!baseDetails.meetingLink && consensus.meetingLink) supplemental.push("Meeting link", consensus.meetingLink);
  if ((!baseDetails.date || !baseDetails.time || !baseDetails.timezone) && consensus.date && consensus.time) {
    const timezoneLabel = consensus.timezone === "Europe/London" ? "United Kingdom Time" : "Bangladesh Standard Time";
    supplemental.push("When", `${consensus.date} - ${formatTimeForOcrConsensus(consensus.time)}${consensus.endTime ? ` ~ ${formatTimeForOcrConsensus(consensus.endTime)}` : ""} (${timezoneLabel})`);
  }
  return supplemental.length ? `${baseText}\n\nOCR verification\n${supplemental.join("\n")}` : baseText;
}

function formatTimeForOcrConsensus(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]}${hour >= 12 ? "pm" : "am"}`;
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("eng", 1, {
      logger: (message) => {
        if (typeof message.progress !== "number" || !isOcrRunning) return;
        const labels = {
          "loading tesseract core": "Loading fallback OCR engine…",
          "initializing tesseract": "Initialising fallback OCR…",
          "loading language traineddata": "Loading English recognition data…",
          "initializing api": "Preparing fallback recognition…",
          "recognizing text": "Verifying screenshot text…"
        };
        const scaledProgress = 58 + Math.round(message.progress * 34);
        setOcrProgress(scaledProgress, labels[message.status] || "Verifying screenshot…");
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
    found.push("start time");
  }
  if (details.endTime) {
    elements.sourceEndTime.value = details.endTime;
    found.push("end time");
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
    [details.email, "email"], [details.date, "date"], [details.time, "start time"], [details.meetingLink, "meeting link"]
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
  const timeRange = extractTimeRange(text);
  return {
    brand: extractBrand(text),
    partnerBrand: extractPartnerBrand(text),
    email: extractEmail(text),
    date: extractDate(text),
    time: timeRange.startTime,
    endTime: timeRange.endTime,
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
  const lines = repaired.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^meeting\s*link\s*[:\-]?$/i.test(lines[index])) continue;
    const nextLine = lines[index + 1] || "";
    const labelledCandidate = extractMeetingUrlCandidate(nextLine);
    if (labelledCandidate) return labelledCandidate;
  }

  const direct = repaired.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const www = repaired.match(/\bwww\.[^\s<>"'`]+/gi) || [];
  const bareDomains = repaired.match(/\b(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|(?:[a-z0-9-]+\.)?join\.gong\.io|gong\.io|(?:[a-z0-9-]+\.)?webex\.com|gotomeet\.me|whereby\.com)(?:\/[^\s<>"'`]*)?/gi) || [];
  const candidates = [...direct, ...www.map((url) => `https://${url}`), ...bareDomains.map((url) => `https://${url}`)]
    .map(cleanUrlCandidate)
    .filter(Boolean);

  const unique = [...new Set(candidates)];
  if (!unique.length) return "";
  const meetingDomains = /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|join\.gong\.io|gong\.io|webex\.com|gotomeet\.me|whereby\.com)/i;
  return unique.find((url) => meetingDomains.test(url)) || unique.sort((a, b) => b.length - a.length)[0];
}

function extractMeetingUrlCandidate(value) {
  const match = String(value || "").match(/(?:https?:\/\/)?(?:www\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|(?:[a-z0-9-]+\.)?join\.gong\.io|gong\.io|(?:[a-z0-9-]+\.)?webex\.com|gotomeet\.me|whereby\.com)(?:\/[^\s<>"'`]*)?/i);
  return match ? cleanUrlCandidate(match[0]) : "";
}

function repairOcrUrlText(text) {
  let value = String(text || "")
    .replace(/h\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//gi, (match) => match.toLowerCase().includes("s") ? "https://" : "http://")
    .replace(/w\s*w\s*w\s*\.\s*/gi, "www.")
    .replace(/\bmeet\s*[.,]?\s*goog(?:l|1|i)e\s*[.,]?\s*co(?:m|rn)\b/gi, "meet.google.com")
    .replace(/\bmeet[.,]\s*google[.,]\s*com\b/gi, "meet.google.com")
    .replace(/\bmeet\.goog(?:1|i)e\.co(?:rn|m)\b/gi, "meet.google.com")
    .replace(/\bmeet\.google\.com\s*[\\|]\s*/gi, "meet.google.com/")
    .replace(/\bmeet\.google\.com\s*\/\s*/gi, "meet.google.com/");

  value = value.replace(/(meet\.google\.com\/)([a-z0-9]{2,4})\s*[-–—~_]\s*([a-z0-9]{2,5})\s*[-–—~_]\s*([a-z0-9]{2,4})/gi, "$1$2-$3-$4");
  value = value.replace(/(https?:\/\/[^\s\n]+)\n([A-Za-z0-9_%#?=&./-]{3,})/g, (full, base, continuation) =>
    /[-/?=&_%#]/.test(continuation) ? `${base}${continuation}` : full);
  value = value.replace(/((?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|(?:[a-z0-9-]+\.)?join\.gong\.io|gong\.io|(?:[a-z0-9-]+\.)?webex\.com|gotomeet\.me|whereby\.com)\/?[^\s\n]*)\n([A-Za-z0-9_%#?=&./-]{3,})/gi, (full, base, continuation) =>
    /[-/?=&_%#]/.test(continuation) ? `${base}${continuation}` : full);
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

function extractTimeRange(text) {
  const normalized = normalizeTimeText(text);
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let candidate = "";

  const whenIndex = lines.findIndex((line) => /^when\s*[:\-]?$/i.test(line));
  if (whenIndex >= 0) candidate = lines.slice(whenIndex + 1, whenIndex + 4).join(" ");
  if (!candidate) {
    candidate = lines.find((line) => /(?:~|–|—|\bto\b)/i.test(line) && containsTimeToken(line)) || "";
  }
  if (!candidate) candidate = normalized;

  const tokens = candidate.match(/\b(?:1[0-2]|0?[1-9])(?:\s*:\s*[0-5]\d)?\s*(?:AM|PM)\b|\b(?:[01]?\d|2[0-3])\s*:\s*[0-5]\d\b/gi) || [];
  const parsed = tokens.map(parseTimeToken).filter(Boolean);
  return {
    startTime: parsed[0] || "",
    endTime: parsed[1] || ""
  };
}

function normalizeTimeText(text) {
  return String(text || "")
    .replace(/\b([0-2]?\d)\s*[.·]\s*([0-5]\d)\b/g, "$1:$2")
    .replace(/\bA\s*\.?\s*M\.?\b/gi, "AM")
    .replace(/\bP\s*\.?\s*M\.?\b/gi, "PM");
}

function containsTimeToken(value) {
  return /\b(?:1[0-2]|0?[1-9])(?:\s*:\s*[0-5]\d)?\s*(?:AM|PM)\b|\b(?:[01]?\d|2[0-3])\s*:\s*[0-5]\d\b/i.test(value);
}

function parseTimeToken(token) {
  const value = String(token || "").trim().toUpperCase().replace(/\s+/g, "");
  let match = /^(1[0-2]|0?[1-9])(?::([0-5]\d))?(AM|PM)$/.exec(value);
  if (match) return twelveToTwentyFour(Number(match[1]), Number(match[2] || 0), match[3]);
  match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match) return `${pad(Number(match[1]))}:${pad(Number(match[2]))}`;
  return "";
}

function extractTime(text) {
  return extractTimeRange(text).startTime;
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
    elements.convertedDateTime.textContent = "Add the meeting date and start time";
    elements.conversionNote.textContent = "The final message always uses Bangladesh Standard Time.";
    elements.conversionCard.classList.remove("converted");
    return;
  }

  elements.convertedDateTime.textContent = formatConvertedRange(converted);
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
  const endTimeValue = elements.sourceEndTime.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return null;

  const endSourceDate = endTimeValue && endTimeValue <= timeValue ? addDaysToDateInput(dateValue, 1) : dateValue;
  if (elements.sourceTimezone.value === "Asia/Dhaka") {
    return {
      date: dateValue,
      time: timeValue,
      endDate: endTimeValue ? endSourceDate : "",
      endTime: endTimeValue,
      ukZoneName: ""
    };
  }

  const instant = zonedLocalToUtc(dateValue, timeValue, "Europe/London");
  if (!instant || Number.isNaN(instant.getTime())) return null;
  const dhaka = formatDateTimeInZone(instant, "Asia/Dhaka");
  let endDhaka = null;
  if (endTimeValue) {
    const endInstant = zonedLocalToUtc(endSourceDate, endTimeValue, "Europe/London");
    if (endInstant && !Number.isNaN(endInstant.getTime())) endDhaka = formatDateTimeInZone(endInstant, "Asia/Dhaka");
  }
  return {
    date: dhaka.date,
    time: dhaka.time,
    endDate: endDhaka?.date || "",
    endTime: endDhaka?.time || "",
    ukZoneName: getTimeZoneName(instant, "Europe/London")
  };
}

function addDaysToDateInput(dateValue, days) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function formatConvertedRange(converted) {
  const start = `${formatDateForMessage(converted.date)} at ${formatTimeForMessage(converted.time)}`;
  if (!converted.endTime) return start;
  if (converted.endDate === converted.date) return `${start} – ${formatTimeForMessage(converted.endTime)}`;
  return `${start} – ${formatDateForMessage(converted.endDate)} at ${formatTimeForMessage(converted.endTime)}`;
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
    `Time: ${formatReminderTimeRange(converted)} (Bangladesh Standard Time)`,
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

function formatReminderTimeRange(converted) {
  const start = formatTimeForMessage(converted.time);
  if (!converted.endTime) return start;
  const end = formatTimeForMessage(converted.endTime);
  return converted.endDate && converted.endDate !== converted.date
    ? `${start} - ${end} (ends ${formatDateForMessage(converted.endDate)})`
    : `${start} - ${end}`;
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
  await copyTextToClipboard(text);
  elements.copyFeedback.textContent = "Copied to clipboard.";
  showToast("Reminder copied.");
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    elements.outputMessage.focus();
    elements.outputMessage.select();
    document.execCommand("copy");
  }
}

async function shareToSlack() {
  const text = elements.outputMessage.value.trim();
  if (!text) {
    showToast("Generate the reminder message first.");
    return;
  }

  const shareData = { title: "Meeting reminder", text };
  if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(shareData))) {
    try {
      await navigator.share(shareData);
      elements.shareFeedback.textContent = "Share menu opened. Select Slack to choose the conversation.";
      showToast("Choose Slack from the share menu.");
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        elements.shareFeedback.textContent = "Sharing was cancelled.";
        return;
      }
      console.warn("Native sharing failed; using desktop fallback.", error);
    }
  }

  await copyTextToClipboard(text);
  elements.shareFeedback.textContent = "Copied to clipboard. Slack is opening; paste the message into the required channel or chat.";
  showToast("Copied. Paste the reminder in Slack.");
  const slackWindow = window.open("https://app.slack.com/client", "_blank", "noopener,noreferrer");
  if (!slackWindow) window.location.href = "https://app.slack.com/client";
}

function updateShareButtonLabel() {
  const nativeShareAvailable = typeof navigator.share === "function";
  elements.shareSlackBtn.textContent = nativeShareAvailable ? "Share to Slack" : "Copy & open Slack";
  elements.shareSlackBtn.title = nativeShareAvailable
    ? "Open your device share menu and choose Slack"
    : "Copy the reminder and open Slack in a new tab";
}

function updateCopyState() {
  const empty = !elements.outputMessage.value.trim();
  elements.copyBtn.disabled = empty;
  elements.shareSlackBtn.disabled = empty;
  if (empty) {
    elements.copyFeedback.textContent = "";
    elements.shareFeedback.textContent = "";
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
  elements.sourceEndTime.value = "";
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
  extractTimeRange,
  extractTimezone,
  extractMeetingLink,
  zonedLocalToUtc,
  formatDateTimeInZone,
  repairOcrUrlText,
  scoreOcrText,
  formatPaddleOcrItems
};
