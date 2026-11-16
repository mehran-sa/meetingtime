/*
 * MeetingCore: the shared logic behind the Slack Reminder Generator.
 *
 * Everything here is pure (no DOM, no storage), so the same file runs in
 * the web app, the Chrome extension popup, the extension service worker and
 * the Node test suite. The extension keeps a copy of this file; run
 * `npm run sync` after editing it.
 */
(function (root) {
  "use strict";

  const TARGET_ZONE = "Asia/Dhaka";
  const TARGET_ZONE_LABEL = "Bangladesh Standard Time";

  /* Source time zones the reminder can be converted from. `match` patterns are
   * tested in order against lower-cased text, so more specific zones go first. */
  const TIMEZONES = [
    {
      id: "Europe/London",
      label: "United Kingdom Time",
      shortLabel: "UK time",
      match: [/united\s*kingdom\s*time|uk\s*time|british\s*summer\s*time|greenwich\s*mean\s*time|europe\s*\/\s*london|london\s*time/]
    },
    {
      id: "Asia/Dhaka",
      label: "Bangladesh Standard Time",
      shortLabel: "Bangladesh time",
      match: [/bangladesh\s*standard\s*time|bangladesh\s*time|asia\s*\/\s*dhaka|dhaka\s*time|\bbdt\b|\b(?:gmt|utc)\s*\+\s*0?6(?::?00)?\b/]
    }
  ];

  /* Order shown in the time zone pickers. */
  const TIMEZONE_ORDER = ["Asia/Dhaka", "Europe/London"];

  const MEETING_PROVIDERS = [
    { name: "Google Meet", host: "meet\\.google\\.com" },
    { name: "Zoom", host: "(?:[a-z0-9-]+\\.)?zoom\\.us" },
    { name: "Microsoft Teams", host: "teams\\.microsoft\\.com" },
    { name: "Microsoft Teams", host: "teams\\.live\\.com" },
    { name: "Gong", host: "(?:[a-z0-9-]+\\.)?join\\.gong\\.io" },
    { name: "Gong", host: "gong\\.io" },
    { name: "Webex", host: "(?:[a-z0-9-]+\\.)?webex\\.com" },
    { name: "GoTo Meeting", host: "gotomeet\\.me" },
    { name: "GoTo Meeting", host: "(?:[a-z0-9-]+\\.)?gotomeeting\\.com" },
    { name: "Whereby", host: "whereby\\.com" },
    { name: "Jitsi", host: "meet\\.jit\\.si" }
  ];
  const MEETING_HOST_SOURCE = `(?:${MEETING_PROVIDERS.map((p) => p.host).join("|")})`;
  const MEETING_HOST_RE = new RegExp(`^(?:www\\.)?${MEETING_HOST_SOURCE}$`, "i");
  const BARE_MEETING_URL_RE = new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?\\b${MEETING_HOST_SOURCE}(?:\\/[^\\s<>"'\`]*)?`, "gi");

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_LOOKUP = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  const MONTH_PATTERN = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
  const TIME_TOKEN_SOURCE = "\\b(?:1[0-2]|0?[1-9])(?:\\s*:\\s*[0-5]\\d)?\\s*(?:AM|PM)\\b|\\b(?:[01]?\\d|2[0-3])\\s*:\\s*[0-5]\\d\\b";

  /* ---------- small helpers ---------- */

  function pad(value) {
    return String(value).padStart(2, "0");
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

  function normalizeSearchText(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function normalizeSlackId(value) {
    return String(value || "")
      .trim()
      .replace(/^<@/, "")
      .replace(/>$/, "")
      .replace(/^@/, "")
      .toUpperCase();
  }

  function timezoneById(id) {
    return TIMEZONES.find((zone) => zone.id === id) || null;
  }

  function timezoneLabel(id) {
    return timezoneById(id)?.label || id;
  }

  function orderedTimezones() {
    return TIMEZONE_ORDER.map(timezoneById).filter(Boolean);
  }

  /* ---------- extraction ---------- */

  function extractReminderDetails(text, brands = [], referenceDate = new Date()) {
    const source = String(text || "");
    const timeRange = extractTimeRange(source);
    return {
      brand: extractBrand(source, brands),
      partnerBrand: extractPartnerBrand(source),
      email: extractEmail(source),
      date: extractDate(source, referenceDate),
      time: timeRange.startTime,
      endTime: timeRange.endTime,
      timezone: extractTimezone(source),
      meetingLink: extractMeetingLink(source)
    };
  }

  function extractBrand(text, brands = []) {
    const compact = normalizeSearchText(text);
    // Longest name first so "Online Training Academy" is not shadowed by a shorter brand.
    return [...brands]
      .sort((a, b) => b.length - a.length)
      .find((brand) => compact.includes(normalizeSearchText(brand))) || "";
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
    const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].replace(/[),.;]+$/, "") : "";
  }

  function extractTimezone(text) {
    const value = String(text || "").toLowerCase();
    for (const zone of TIMEZONES) {
      if (zone.match.some((pattern) => pattern.test(value))) return zone.id;
    }
    // "BST" alone is ambiguous (British Summer / Bangladesh Standard), so it needs a UK word nearby.
    if (/\b(?:gmt|bst)\b/.test(value) && /\b(?:uk|british|london|kingdom)\b/.test(value)) return "Europe/London";
    // A bare "GMT" with no offset is how UK winter times are usually written.
    if (/\bgmt\b(?!\s*[+-]\s*\d)/.test(value)) return "Europe/London";
    return "";
  }

  function isMeetingUrl(value) {
    try {
      return MEETING_HOST_RE.test(new URL(value).hostname);
    } catch (error) {
      return false;
    }
  }

  function meetingProvider(value) {
    try {
      const host = new URL(value).hostname.replace(/^www\./i, "");
      const provider = MEETING_PROVIDERS.find((item) => new RegExp(`^${item.host}$`, "i").test(host));
      return provider ? provider.name : "";
    } catch (error) {
      return "";
    }
  }

  /* Mail clients wrap links in tracking redirects; unwrap the common ones. */
  function unwrapRedirectUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      let inner = "";
      if (host.endsWith("safelinks.protection.outlook.com")) inner = url.searchParams.get("url") || "";
      else if (/^(?:www\.)?google\.[a-z.]+$/.test(host) && url.pathname === "/url") inner = url.searchParams.get("q") || url.searchParams.get("url") || "";
      else if (host === "l.facebook.com" || host === "slack-redir.net") inner = url.searchParams.get("u") || url.searchParams.get("url") || "";
      return inner && /^https?:\/\//i.test(inner) ? inner : value;
    } catch (error) {
      return value;
    }
  }

  function extractMeetingLink(text) {
    const repaired = repairOcrUrlText(text);
    const lines = repaired.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^meeting\s*link\s*[:\-]?$/i.test(lines[index])) continue;
      const labelled = extractMeetingUrlCandidate(lines[index + 1] || "");
      if (labelled) return labelled;
    }

    const direct = repaired.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
    const www = repaired.match(/\bwww\.[^\s<>"'`]+/gi) || [];
    const bare = repaired.match(BARE_MEETING_URL_RE) || [];
    const unique = [...new Set([...direct, ...www, ...bare].map(cleanUrlCandidate).filter(Boolean))];
    if (!unique.length) return "";
    return unique.find(isMeetingUrl) || [...unique].sort((a, b) => b.length - a.length)[0];
  }

  function extractMeetingUrlCandidate(value) {
    const match = String(value || "").match(new RegExp(BARE_MEETING_URL_RE.source, "i"));
    return match ? cleanUrlCandidate(match[0]) : "";
  }

  function repairOcrUrlText(text) {
    let value = String(text || "")
      .replace(/h\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//gi, (match) => (match.toLowerCase().includes("s") ? "https://" : "http://"))
      .replace(/w\s*w\s*w\s*\.\s*/gi, "www.")
      .replace(/\bmeet\s*[.,]?\s*goog(?:l|1|i)e\s*[.,]?\s*co(?:m|rn)\b/gi, "meet.google.com")
      .replace(/\bmeet\.google\.com\s*[\\|]\s*/gi, "meet.google.com/")
      .replace(/\bmeet\.google\.com\s*\/\s*/gi, "meet.google.com/");

    value = value.replace(/(meet\.google\.com\/)([a-z0-9]{2,4})\s*[-–—~_]\s*([a-z0-9]{2,5})\s*[-–—~_]\s*([a-z0-9]{2,4})/gi, "$1$2-$3-$4");
    // OCR often wraps a long URL onto the next line; rejoin when the continuation looks like a URL tail.
    const rejoin = (full, base, continuation) => (/[-/?=&_%#]/.test(continuation) ? `${base}${continuation}` : full);
    value = value.replace(/(https?:\/\/[^\s\n]+)\n([A-Za-z0-9_%#?=&./-]{3,})/g, rejoin);
    value = value.replace(new RegExp(`(${MEETING_HOST_SOURCE}\\/?[^\\s\\n]*)\\n([A-Za-z0-9_%#?=&./-]{3,})`, "gi"), rejoin);
    return value;
  }

  function cleanUrlCandidate(value) {
    let url = String(value || "").trim().replace(/[),.;\]}>]+$/, "");
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      return new URL(unwrapRedirectUrl(url)).href;
    } catch (error) {
      return "";
    }
  }

  function extractDate(text, referenceDate = new Date()) {
    const normalized = String(text || "").replace(/[|]/g, " ");
    let match = normalized.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
    if (match) return toDateInput(Number(match[1]), Number(match[2]), Number(match[3]));

    match = normalized.match(new RegExp(`\\b(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?[\\s\\-/.]+(${MONTH_PATTERN})[,\\s\\-/.]+(20\\d{2})\\b`, "i"));
    if (match) return toDateInput(Number(match[3]), MONTH_LOOKUP[match[2].toLowerCase()], Number(match[1]));

    match = normalized.match(new RegExp(`\\b(${MONTH_PATTERN})[\\s\\-/.]+(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?[,]?[\\s\\-/.]+(20\\d{2})\\b`, "i"));
    if (match) return toDateInput(Number(match[3]), MONTH_LOOKUP[match[1].toLowerCase()], Number(match[2]));

    // Numeric day-first dates (the UK convention used by the brands).
    match = normalized.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/);
    if (match) return toDateInput(Number(match[3]), Number(match[2]), Number(match[1]));

    // Calendar pages often omit the year ("Monday, 16 November"). Only capitalised
    // month names count here, so ordinary words like "may" are not read as dates.
    match = normalized.match(new RegExp(`\\b(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b`));
    if (match) return nearestYearDate(MONTH_LOOKUP[match[2].toLowerCase()], Number(match[1]), referenceDate);
    match = normalized.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\b(?!\\s*:)`));
    if (match) return nearestYearDate(MONTH_LOOKUP[match[1].toLowerCase()], Number(match[2]), referenceDate);

    return "";
  }

  /* Pick the year for a date written without one: this year, unless that is more than a month ago. */
  function nearestYearDate(month, day, referenceDate) {
    const reference = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? referenceDate : new Date();
    const year = reference.getUTCFullYear();
    const candidate = Date.UTC(year, month - 1, day);
    const cutoff = reference.getTime() - 30 * 24 * 60 * 60 * 1000;
    return toDateInput(candidate < cutoff ? year + 1 : year, month, day);
  }

  function extractTimeRange(text) {
    const normalized = normalizeTimeText(text);
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const hasSeparator = (line) => /(?:~|–|—|\s-\s|\bto\b)/i.test(line);
    const hasDateHint = (line) => new RegExp(`\\b(?:${MONTH_PATTERN}|mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b|\\b20\\d{2}\\b`, "i").test(line);

    let candidate = "";
    const whenIndex = lines.findIndex((line) => /^when\s*[:\-]?$/i.test(line));
    if (whenIndex >= 0) candidate = lines.slice(whenIndex + 1, whenIndex + 4).join(" ");
    if (!containsTimeToken(candidate)) candidate = lines.find((line) => hasSeparator(line) && containsTimeToken(line)) || "";
    if (!candidate) candidate = lines.find((line) => hasDateHint(line) && containsTimeToken(line)) || "";
    if (!candidate) candidate = normalized;

    const shared = parseSharedMeridiemRange(candidate);
    if (shared) return shared;

    const tokens = candidate.match(new RegExp(TIME_TOKEN_SOURCE, "gi")) || [];
    const parsed = tokens.map(parseTimeToken).filter(Boolean);
    return { startTime: parsed[0] || "", endTime: parsed[1] || "" };
  }

  /* "2:00 – 3:00pm" and "2 – 3pm": the start borrows AM/PM from the end. */
  function parseSharedMeridiemRange(candidate) {
    const pattern = /\b(1[0-2]|0?[1-9])(?:\s*:\s*([0-5]\d))?\s*(?:-|–|—|~|to)\s*(1[0-2]|0?[1-9])(?:\s*:\s*([0-5]\d))?\s*(AM|PM)\b/gi;
    let match;
    while ((match = pattern.exec(candidate)) !== null) {
      const before = candidate.slice(0, match.index);
      // "Nov 5 - 3pm": the 5 is a day of the month, not an hour.
      if (!match[2] && new RegExp(`(?:${MONTH_PATTERN})[a-z]*\\.?,?\\s*$`, "i").test(before)) continue;
      const end = twelveToTwentyFour(Number(match[3]), Number(match[4] || 0), match[5]);
      let start = twelveToTwentyFour(Number(match[1]), Number(match[2] || 0), match[5]);
      if (start > end) start = twelveToTwentyFour(Number(match[1]), Number(match[2] || 0), match[5].toUpperCase() === "PM" ? "AM" : "PM");
      return { startTime: start, endTime: end };
    }
    return null;
  }

  function normalizeTimeText(text) {
    return String(text || "")
      // Dates and links contain digit groups that would otherwise be read as times.
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " ")
      .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/g, " ")
      .replace(/(^|[^\d.])([0-2]?\d)\s*[.·]\s*([0-5]\d)(?![\d.])/g, "$1$2:$3")
      .replace(/\bA\s*\.?\s*M\.?(?![a-z])/gi, "AM")
      .replace(/\bP\s*\.?\s*M\.?(?![a-z])/gi, "PM");
  }

  function containsTimeToken(value) {
    return new RegExp(TIME_TOKEN_SOURCE, "i").test(value || "");
  }

  function parseTimeToken(token) {
    const value = String(token || "").trim().toUpperCase().replace(/\s+/g, "");
    let match = /^(1[0-2]|0?[1-9])(?::([0-5]\d))?(AM|PM)$/.exec(value);
    if (match) return twelveToTwentyFour(Number(match[1]), Number(match[2] || 0), match[3]);
    match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (match) return `${pad(Number(match[1]))}:${pad(Number(match[2]))}`;
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

  /* ---------- OCR scoring (web app only, kept here so it is testable) ---------- */

  function scoreOcrText(text, brands = []) {
    if (!text) return 0;
    const details = extractReminderDetails(text, brands);
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

  /* Turn PaddleOCR's positioned boxes into reading-order lines. */
  function formatPaddleOcrItems(items) {
    const positioned = (items || [])
      .filter((item) => cleanText(item?.text || "") && Number(item?.score ?? 1) >= 0.22)
      .map((item) => {
        const points = Array.isArray(item.poly) ? item.poly : [];
        const xs = points.map((point) => Number(point?.[0])).filter(Number.isFinite);
        const ys = points.map((point) => Number(point?.[1])).filter(Number.isFinite);
        const x = xs.length ? Math.min(...xs) : 0;
        const y = ys.length ? Math.min(...ys) : 0;
        const height = ys.length ? Math.max(8, Math.max(...ys) - Math.min(...ys)) : 16;
        return { text: cleanText(item.text), x, centerY: y + height / 2, height };
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

  /* ---------- time conversion ---------- */

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

  function getTimeZoneOffsetMs(date, timeZone) {
    const parts = getZonedParts(date, timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
  }

  function zonedLocalToUtc(dateValue, timeValue, timeZone) {
    const [year, month, day] = dateValue.split("-").map(Number);
    const [hour, minute] = timeValue.split(":").map(Number);
    const base = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = base;
    for (let i = 0; i < 3; i += 1) guess = base - getTimeZoneOffsetMs(new Date(guess), timeZone);
    return new Date(guess);
  }

  function formatDateTimeInZone(date, timeZone) {
    const parts = getZonedParts(date, timeZone);
    return {
      date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
      time: `${pad(parts.hour)}:${pad(parts.minute)}`
    };
  }

  function getTimeZoneName(date, timeZone) {
    const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short", hour: "2-digit" })
      .formatToParts(date).find((item) => item.type === "timeZoneName");
    return part?.value || "";
  }

  function addDaysToDateInput(dateValue, days) {
    const [year, month, day] = dateValue.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  /*
   * Convert a meeting written in `timezone` to Bangladesh time.
   * Returns null until both a valid date and start time are present.
   * An end time at or before the start is treated as ending the next day.
   */
  function convertToDhaka({ date, time, endTime = "", timezone = TARGET_ZONE } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(time || "")) return null;
    const validEnd = /^\d{2}:\d{2}$/.test(endTime || "") ? endTime : "";
    const zone = timezoneById(timezone) ? timezone : TARGET_ZONE;
    const endSourceDate = validEnd && validEnd <= time ? addDaysToDateInput(date, 1) : date;

    const startInstant = zonedLocalToUtc(date, time, zone);
    if (Number.isNaN(startInstant.getTime())) return null;
    const endInstant = validEnd ? zonedLocalToUtc(endSourceDate, validEnd, zone) : null;
    const start = formatDateTimeInZone(startInstant, TARGET_ZONE);
    const end = endInstant && !Number.isNaN(endInstant.getTime()) ? formatDateTimeInZone(endInstant, TARGET_ZONE) : null;

    return {
      date: start.date,
      time: start.time,
      endDate: end?.date || "",
      endTime: end?.time || "",
      startUtc: startInstant.getTime(),
      endUtc: endInstant ? endInstant.getTime() : null,
      sourceZone: zone,
      sourceZoneName: zone === TARGET_ZONE ? "" : getTimeZoneName(startInstant, zone),
      wasConverted: zone !== TARGET_ZONE
    };
  }

  /* ---------- formatting ---------- */

  function formatDateForMessage(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return value || "";
    return `${match[3]}-${MONTH_NAMES[Number(match[2]) - 1]}-${match[1]}`;
  }

  function formatTimeForMessage(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(value || "");
    if (!match) return value || "";
    const hour24 = Number(match[1]);
    return `${hour24 % 12 || 12}:${match[2]} ${hour24 >= 12 ? "PM" : "AM"}`;
  }

  function formatWeekday(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return "";
    return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    ];
  }

  function formatConvertedRange(converted) {
    const start = `${formatDateForMessage(converted.date)} at ${formatTimeForMessage(converted.time)}`;
    if (!converted.endTime) return start;
    if (converted.endDate === converted.date) return `${start} – ${formatTimeForMessage(converted.endTime)}`;
    return `${start} – ${formatDateForMessage(converted.endDate)} at ${formatTimeForMessage(converted.endTime)}`;
  }

  function formatReminderTimeRange(converted) {
    const start = formatTimeForMessage(converted.time);
    if (!converted.endTime) return start;
    const end = formatTimeForMessage(converted.endTime);
    return converted.endDate && converted.endDate !== converted.date
      ? `${start} - ${end} (ends ${formatDateForMessage(converted.endDate)})`
      : `${start} - ${end}`;
  }

  function buildGreeting(rep) {
    const slackId = normalizeSlackId(rep?.slackId);
    const name = String(rep?.name || "").trim();
    if (slackId) return `Assalamu Alaikum <@${slackId}>,`;
    if (name) return `Assalamu Alaikum ${name} bhai,`;
    return "Assalamu Alaikum bhai,";
  }

  /* The Slack reminder. `converted` is the result of convertToDhaka(). */
  function buildReminderMessage({ brand, partnerBrand, email, meetingLink, note, rep, converted }) {
    const partner = cleanText(partnerBrand);
    const lines = [
      buildGreeting(rep),
      "",
      "This is an automated reminder.",
      "",
      `Brand: ${brand}`,
      ...(partner ? [`Meeting with: ${partner}`] : []),
      ...(String(email || "").trim() ? [String(email).trim()] : []),
      "",
      `Date: ${formatDateForMessage(converted.date)}`,
      `Time: ${formatReminderTimeRange(converted)} (${TARGET_ZONE_LABEL})`,
      `Meeting Link: ${String(meetingLink || "").trim()}`
    ];
    const extra = cleanText(note);
    if (extra) lines.push("", extra);
    return lines.join("\n");
  }

  /* Which required fields are still empty or invalid; drives inline validation. */
  function findMissingFields({ email, date, time, meetingLink }) {
    const missing = [];
    if (!String(email || "").trim()) missing.push("email");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) missing.push("date");
    if (!/^\d{2}:\d{2}$/.test(time || "")) missing.push("time");
    if (!String(meetingLink || "").trim()) missing.push("meetingLink");
    return missing;
  }

  const api = {
    TARGET_ZONE, TARGET_ZONE_LABEL, TIMEZONES, MONTH_NAMES,
    pad, cleanText, normalizeSearchText, normalizeSlackId,
    timezoneById, timezoneLabel, orderedTimezones,
    extractReminderDetails, extractBrand, extractPartnerBrand, extractEmail, extractTimezone,
    extractMeetingLink, extractDate, extractTimeRange, repairOcrUrlText, cleanUrlCandidate,
    isMeetingUrl, meetingProvider, unwrapRedirectUrl,
    scoreOcrText, formatPaddleOcrItems,
    zonedLocalToUtc, formatDateTimeInZone, getTimeZoneName, addDaysToDateInput, convertToDhaka,
    formatDateForMessage, formatTimeForMessage, formatWeekday, formatConvertedRange, formatReminderTimeRange,
    buildGreeting, buildReminderMessage, findMissingFields
  };

  root.MeetingCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
