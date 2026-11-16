"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");

const BRANDS = ["Alpha Academy", "Training Express", "Online Training Academy", "HF Online"];
const REF = new Date(Date.UTC(2026, 10, 16));

test("extracts a full booking screenshot", () => {
  const text = [
    "Brand: Training Express", "Meeting with: Acme Learning Ltd", "partner@acme.co.uk",
    "When", "Tuesday, 17 November 2026 - 2:00pm ~ 2:30pm (United Kingdom Time)",
    "Meeting link", "meet.google.com/abc-defg-hij"
  ].join("\n");
  assert.deepEqual(core.extractReminderDetails(text, BRANDS, REF), {
    brand: "Training Express", partnerBrand: "Acme Learning Ltd", email: "partner@acme.co.uk",
    date: "2026-11-17", time: "14:00", endTime: "14:30", timezone: "Europe/London",
    meetingLink: "https://meet.google.com/abc-defg-hij"
  });
});

test("prefers the longest brand name", () => {
  assert.equal(core.extractBrand("Online Training Academy weekly sync", [...BRANDS, "Training Academy"]), "Online Training Academy");
});

test("dates in several formats", () => {
  assert.equal(core.extractDate("2026-11-17"), "2026-11-17");
  assert.equal(core.extractDate("17th Nov 2026"), "2026-11-17");
  assert.equal(core.extractDate("November 17, 2026"), "2026-11-17");
  assert.equal(core.extractDate("17/11/2026"), "2026-11-17");
  assert.equal(core.extractDate("31/02/2026"), "");
});

test("dates without a year use the nearest sensible year", () => {
  assert.equal(core.extractDate("Monday, 16 November⋅10:00 – 11:00am", REF), "2026-11-16");
  assert.equal(core.extractDate("Jan 5 at 3pm", REF), "2027-01-05");
  assert.equal(core.extractDate("the top 5 may be late", REF), "");
});

test("time ranges", () => {
  assert.deepEqual(core.extractTimeRange("10:00 AM - 11:30 AM"), { startTime: "10:00", endTime: "11:30" });
  assert.deepEqual(core.extractTimeRange("14:00 to 15:00"), { startTime: "14:00", endTime: "15:00" });
  assert.deepEqual(core.extractTimeRange("2.30 pm"), { startTime: "14:30", endTime: "" });
  assert.deepEqual(core.extractTimeRange("3 p.m."), { startTime: "15:00", endTime: "" });
});

test("start time borrows AM/PM from the end", () => {
  assert.deepEqual(core.extractTimeRange("2:00 – 3:00pm"), { startTime: "14:00", endTime: "15:00" });
  assert.deepEqual(core.extractTimeRange("2 – 3pm"), { startTime: "14:00", endTime: "15:00" });
  assert.deepEqual(core.extractTimeRange("11:00 – 1:00pm"), { startTime: "11:00", endTime: "13:00" });
  assert.deepEqual(core.extractTimeRange("Nov 5 - 3pm"), { startTime: "15:00", endTime: "" });
});

test("dotted dates and links are not read as times", () => {
  assert.deepEqual(core.extractTimeRange("16.11.2026 10:00"), { startTime: "10:00", endTime: "" });
  assert.deepEqual(core.extractTimeRange("https://zoom.us/j/12:30 starts 9:15"), { startTime: "09:15", endTime: "" });
});

test("time zones", () => {
  assert.equal(core.extractTimezone("3pm UK time"), "Europe/London");
  assert.equal(core.extractTimezone("(GMT+06:00) Bangladesh Standard Time"), "Asia/Dhaka");
  assert.equal(core.extractTimezone("10:00 GMT"), "Europe/London");
  assert.equal(core.extractTimezone("10:00 GMT+6"), "Asia/Dhaka");
  assert.equal(core.extractTimezone("10:00 BST"), "");
  assert.equal(core.extractTimezone("nothing here"), "");
});

test("meeting links, including OCR damage and redirects", () => {
  assert.equal(core.extractMeetingLink("join at meet. goog1e .com / abc - defg - hij"), "https://meet.google.com/abc-defg-hij");
  assert.equal(core.extractMeetingLink("https://example.com/page and https://us02web.zoom.us/j/123?pwd=x."), "https://us02web.zoom.us/j/123?pwd=x");
  assert.equal(core.extractMeetingLink("https://teams.microsoft.com/l/meetup-join/19%3a\nmeeting_abc/0?context=x"), "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x");
  assert.equal(
    core.cleanUrlCandidate("https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij&data=x"),
    "https://meet.google.com/abc-defg-hij");
  assert.equal(core.meetingProvider("https://us02web.zoom.us/j/1"), "Zoom");
  assert.equal(core.isMeetingUrl("https://notzoom.us.example.com/"), false);
});

test("UK winter and summer times convert to Dhaka", () => {
  const winter = core.convertToDhaka({ date: "2026-11-17", time: "14:00", endTime: "14:30", timezone: "Europe/London" });
  assert.equal(`${winter.date} ${winter.time}-${winter.endTime}`, "2026-11-17 20:00-20:30");
  assert.equal(winter.sourceZoneName, "GMT");
  const summer = core.convertToDhaka({ date: "2026-07-01", time: "20:00", endTime: "21:00", timezone: "Europe/London" });
  assert.equal(`${summer.date} ${summer.time} → ${summer.endDate} ${summer.endTime}`, "2026-07-02 01:00 → 2026-07-02 02:00");
  assert.equal(summer.sourceZoneName, "BST");
});

test("Dhaka times pass through and overnight ends roll over", () => {
  const same = core.convertToDhaka({ date: "2026-11-17", time: "23:30", endTime: "00:30", timezone: "Asia/Dhaka" });
  assert.equal(same.wasConverted, false);
  assert.equal(`${same.date} ${same.time} ${same.endDate} ${same.endTime}`, "2026-11-17 23:30 2026-11-18 00:30");
  assert.equal(same.startUtc, Date.UTC(2026, 10, 17, 17, 30));
  assert.equal(core.convertToDhaka({ date: "", time: "10:00" }), null);
});

test("reminder message keeps the team format", () => {
  const converted = core.convertToDhaka({ date: "2026-11-17", time: "14:00", endTime: "14:30", timezone: "Europe/London" });
  const message = core.buildReminderMessage({
    brand: "Training Express", partnerBrand: "Acme", email: "a@b.co", meetingLink: "https://meet.google.com/abc-defg-hij",
    note: "Bring the deck.", rep: { name: "Rahim", slackId: "<@u012ab3cd>" }, converted
  });
  assert.equal(message, [
    "Assalamu Alaikum <@U012AB3CD>,", "", "This is an automated reminder.", "",
    "Brand: Training Express", "Meeting with: Acme", "a@b.co", "",
    "Date: 17-Nov-2026", "Time: 8:00 PM - 8:30 PM (Bangladesh Standard Time)",
    "Meeting Link: https://meet.google.com/abc-defg-hij", "", "Bring the deck."
  ].join("\n"));
  assert.equal(core.buildGreeting({ name: "Rahim" }), "Assalamu Alaikum Rahim bhai,");
  assert.equal(core.buildGreeting({}), "Assalamu Alaikum bhai,");
});

test("missing fields", () => {
  assert.deepEqual(core.findMissingFields({ email: "", date: "2026-11-17", time: "", meetingLink: "x" }), ["email", "time"]);
});

test("extension copies of shared files are in sync", () => {
  const rootDir = path.join(__dirname, "..");
  for (const file of ["core.js", "brand-config.js"]) {
    const copy = path.join(rootDir, "extension", file);
    if (!fs.existsSync(copy)) continue;
    assert.equal(fs.readFileSync(copy, "utf8"), fs.readFileSync(path.join(rootDir, file), "utf8"), `${file} differs; run "npm run sync"`);
  }
});
