import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DisTube, Song } from "distube";

// Covers the getStreamURL patch in patches/@distube+yt-dlp+2.0.1.patch, run against a fake
// yt-dlp that prints the JSON fields the plugin reads.

const STREAM_URL = "https://example.invalid/playlist/index.m3u8";
const SONG = { url: "https://www.youtube.com/watch?v=urn3wTOvgIk" } as Song;
const AVAILABLE_IN_SECONDS = 1.5;
const TIMER_SLACK_MS = 50;
const NO_WAIT_LIMIT_MS = 1000;

const fakeBinDir = mkdtempSync(path.join(tmpdir(), "fake-yt-dlp-"));
process.env.YTDLP_DIR = fakeBinDir;
const { YtDlpPlugin } = await import("@distube/yt-dlp");

after(() => {
  rmSync(fakeBinDir, { recursive: true, force: true });
});

void test("waits until available_at before returning the stream URL", async () => {
  writeFakeYtDlp(`{ url: ${JSON.stringify(STREAM_URL)}, available_at: Date.now() / 1000 + ${AVAILABLE_IN_SECONDS} }`);
  const started = Date.now();

  const url = await createPlugin().getStreamURL(SONG);

  assert.equal(url, STREAM_URL);
  assert.ok(Date.now() - started >= AVAILABLE_IN_SECONDS * 1000 - TIMER_SLACK_MS);
});

void test("returns at once when the format has no available_at", async () => {
  writeFakeYtDlp(`{ url: ${JSON.stringify(STREAM_URL)} }`);
  const started = Date.now();

  const url = await createPlugin().getStreamURL(SONG);

  assert.equal(url, STREAM_URL);
  assert.ok(Date.now() - started < NO_WAIT_LIMIT_MS);
});

function createPlugin(): InstanceType<typeof YtDlpPlugin> {
  const plugin = new YtDlpPlugin({ update: false });
  plugin.init({ plugins: [plugin], debug: () => {} } as unknown as DisTube);
  return plugin;
}

/** `info` is a JS expression, evaluated when the fake runs, so timestamps are relative to the call. */
function writeFakeYtDlp(info: string): void {
  const file = path.join(fakeBinDir, "yt-dlp");
  writeFileSync(file, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${info}));\n`);
  chmodSync(file, 0o755);
}
