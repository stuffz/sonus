import * as chrono from "chrono-node";

// Bare US timezone abbreviations chrono doesn't recognize -> concrete DST-aware ones.
const US_TZ: Record<string, [daylight: string, standard: string]> = {
  ET: ["EDT", "EST"],
  CT: ["CDT", "CST"],
  MT: ["MDT", "MST"],
  PT: ["PDT", "PST"],
};

/** Rough northern-hemisphere DST window (Apr–Oct) for normalizing bare US tz abbreviations. */
function isDaylight(d: Date): boolean {
  const m = d.getUTCMonth(); // 0-11
  return m >= 3 && m <= 9;
}

/** Current Europe/Stockholm UTC offset in minutes (DST-aware) — default tz for tz-less times. */
function homeOffsetMinutes(): number {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Stockholm" }));
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

/** Turn bare US tz abbreviations into ones chrono understands, so times like "5 PM ET" parse. */
function normalizeTimezones(text: string): string {
  const daylight = isDaylight(new Date());
  return text.replace(/\b(ET|CT|MT|PT)\b/g, (m) => US_TZ[m][daylight ? 0 : 1]);
}

/**
 * Whether a chrono match actually reads as a calendar date or clock time — as opposed to a
 * duration ("10 minutes", "30-35 minutes", "for 2 hours") or bare number, which chrono will
 * happily parse into an absolute instant but which we must NOT turn into a timestamp.
 */
function looksLikeRealDateTime(text: string): boolean {
  const t = text.toLowerCase();
  const hasClock = /\b\d{1,2}:\d{2}\b/.test(t) || /\b\d{1,2}\s?[ap]\.?m\.?\b/.test(t);
  const hasMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.test(t);
  const hasWeekday = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/.test(t);
  const hasRelWord = /\b(today|tonight|tomorrow|yesterday)\b/.test(t);
  const hasYear = /\b(19|20)\d{2}\b/.test(t);
  return hasClock || hasMonth || hasWeekday || hasRelWord || hasYear;
}

/**
 * Replace natural-language dates/times in `text` with Discord dynamic timestamps
 * (<t:unix:style>), so every viewer sees them in their own timezone. Uses chrono-node
 * (the same parser as /remind). Times explicitly tagged with a timezone are honored;
 * tz-less times default to Europe/Stockholm. Unlike reminders, forwardDate is OFF —
 * the bot's answers mix past and future dates, so we let chrono resolve naturally.
 */
export function linkifyDates(text: string): string {
  const normalized = normalizeTimezones(text);
  let results: chrono.ParsedResult[];
  try {
    results = chrono.parse(normalized, { instant: new Date(), timezone: homeOffsetMinutes() });
  } catch {
    return text; // never let date parsing break a reply
  }
  if (!results.length) return normalized;

  let out = normalized;
  // Replace from last to first so earlier indices stay valid.
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    const hasDay = r.start.isCertain("day");
    const hasTime = r.start.isCertain("hour");
    if (!hasDay && !hasTime) continue; // skip vague matches (e.g. a bare year)
    // Skip durations / bare numbers ("10 minutes", "for 2 hours") that chrono over-parses.
    if (!looksLikeRealDateTime(r.text)) continue;

    const unix = Math.floor(r.start.date().getTime() / 1000);
    if (!Number.isFinite(unix)) continue;

    const style = hasTime ? "f" : "D"; // f = date+time, D = date only
    out = out.slice(0, r.index) + `<t:${unix}:${style}>` + out.slice(r.index + r.text.length);
  }
  return out;
}
