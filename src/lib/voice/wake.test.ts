import { test } from "node:test";
import assert from "node:assert/strict";
import { addressesBot } from "./wake";

const CASES = [
  { text: "Jarvis, what time is it?", addressed: true, cleaned: "what time is it?" },
  { text: "Hey Jarvis what's the weather", addressed: true, cleaned: "what's the weather" },
  { text: "what do you think, jarvis?", addressed: true, cleaned: "what do you think," },
  { text: "Jervis play something", addressed: true, cleaned: "play something" },
  { text: "Jarvas, turn it up", addressed: true, cleaned: "turn it up" },
  { text: "so then we went to see jarvas", addressed: false, cleaned: "so then we went to see jarvas" },
  { text: "Harvis said hi", addressed: false, cleaned: "Harvis said hi" },
  { text: "Jason is late again", addressed: false, cleaned: "Jason is late again" },
  { text: "James, can you hear me", addressed: false, cleaned: "James, can you hear me" },
  { text: "jarvisfan posted it", addressed: false, cleaned: "jarvisfan posted it" },
  { text: "I was   talking  to John", addressed: false, cleaned: "I was talking to John" },
];

for (const { text, addressed, cleaned } of CASES) {
  void test(`"${text}"`, () => {
    assert.deepEqual(addressesBot(text), { addressed, cleaned });
  });
}
