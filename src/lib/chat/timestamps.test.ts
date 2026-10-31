import { test } from "node:test";
import assert from "node:assert/strict";
import { linkifyDates } from "./timestamps";

// Stockholm is UTC+2 in summer; US Eastern is UTC-4 in summer and UTC-5 in winter.
const SUMMER = "2026-07-15T10:00:00Z";
const WINTER = "2026-01-14T10:00:00Z";

const CASES = [
  {
    name: "a time with a bare US timezone, in summer",
    now: SUMMER,
    text: "The stream starts July 20 at 5 PM ET.",
    expected: `The stream starts <t:${unixTime("2026-07-20T21:00:00Z")}:f>.`,
  },
  {
    name: "a time with a bare US timezone, in winter",
    now: WINTER,
    text: "The stream starts January 20 at 5 PM ET.",
    expected: `The stream starts <t:${unixTime("2026-01-20T22:00:00Z")}:f>.`,
  },
  {
    name: "a time without a timezone is Stockholm time",
    now: SUMMER,
    text: "See you tomorrow at 18:00",
    expected: `See you <t:${unixTime("2026-07-16T16:00:00Z")}:f>`,
  },
  {
    name: "a date without a time",
    now: SUMMER,
    text: "It came out on March 3, 2024.",
    expected: `It came out on <t:${unixTime("2024-03-03T10:00:00Z")}:D>.`,
  },
  { name: "a duration in minutes", now: SUMMER, text: "It takes 10 minutes.", expected: "It takes 10 minutes." },
  { name: "a range of minutes", now: SUMMER, text: "Wait 30-35 minutes.", expected: "Wait 30-35 minutes." },
  { name: "a duration in hours", now: SUMMER, text: "We played for 2 hours.", expected: "We played for 2 hours." },
  {
    name: "a bare year",
    now: SUMMER,
    text: "Back in 2019 it was different.",
    expected: "Back in 2019 it was different.",
  },
  { name: "text without dates", now: SUMMER, text: "Hello there.", expected: "Hello there." },
];

for (const { name, now, text, expected } of CASES) {
  void test(name, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });

    assert.equal(linkifyDates(text), expected);
  });
}

function unixTime(iso: string): number {
  return Date.parse(iso) / 1000;
}
