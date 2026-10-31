import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, DISCORD_MAX_LENGTH } from "./chunk";

// 24 characters are kept free for code fences, so this leaves 10 characters of text per chunk.
const SMALL_MAX = 34;

const SPLIT_CASES = [
  { name: "keeps short text whole", text: "hello", expected: ["hello"] },
  { name: "packs paragraphs together while they fit", text: "aaa\n\nbbb", expected: ["aaa\n\nbbb"] },
  { name: "splits on blank lines first", text: "aaaaaaaa\n\nbbbbbbbb", expected: ["aaaaaaaa", "bbbbbbbb"] },
  { name: "splits a long paragraph on line breaks", text: "aaaa\nbbbb\ncccc", expected: ["aaaa\nbbbb", "cccc"] },
  {
    name: "cuts a line without breaks at the limit",
    text: "x".repeat(25),
    expected: ["x".repeat(10), "x".repeat(10), "x".repeat(5)],
  },
  {
    name: "closes a split code block and reopens it with its language",
    text: "```ts\naaaa\nbbbb\n```",
    expected: ["```ts\naaaa\n```", "```ts\nbbbb\n```"],
  },
];

for (const { name, text, expected } of SPLIT_CASES) {
  void test(name, () => {
    assert.deepEqual(chunkText(text, SMALL_MAX), expected);
  });
}

const LONG_CASES = [
  {
    name: "a long code block",
    text: "```ts\n" + Array.from({ length: 300 }, (_, i) => `console.log(${i});`).join("\n") + "\n```",
  },
  { name: "a long line inside a code block", text: "```\n" + "x".repeat(5000) + "\n```" },
  { name: "many paragraphs", text: Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. `.repeat(5)).join("\n\n") },
];

for (const { name, text } of LONG_CASES) {
  void test(`every chunk of ${name} fits in a Discord message and renders its code blocks`, () => {
    const chunks = chunkText(text);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= DISCORD_MAX_LENGTH, `chunk is ${chunk.length} characters`);
      assert.equal((chunk.match(/```/g) ?? []).length % 2, 0, `unbalanced code fence in ${chunk.slice(0, 40)}`);
    }
  });
}
