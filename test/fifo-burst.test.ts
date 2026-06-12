// Validates the per-JID FIFO lock under true concurrent (~0ms gap) arrival.
// Sequential arrival is trivially serialized; the burst case — two messages
// before either handler starts — is the original dual-responder trigger.
//
// Run: tsx test/fifo-burst.test.ts
//
// These tests exercise the real JidQueue class used by BaileysChannel, not a
// reimplementation. Deleting or breaking the lock in the adapter breaks these.

import assert from "node:assert";
import { JidQueue } from "../src/channel/jid-queue.js";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

// ── cases ─────────────────────────────────────────────────────────────────────

test("same-JID burst: h2 never starts while h1 is running", async () => {
  const q = new JidQueue();
  const jid = "12345@s.whatsapp.net";
  let h1Running = false;
  let overlap = false;
  const log: string[] = [];

  // No yield between these two enqueue calls — the ~1ms burst scenario.
  q.enqueue(jid, async () => {
    h1Running = true;
    log.push("h1:start");
    await new Promise<void>(r => setTimeout(r, 20));
    log.push("h1:end");
    h1Running = false;
  });
  q.enqueue(jid, async () => {
    overlap = h1Running; // true means h1 was still running — lock failed
    log.push("h2:start");
    log.push("h2:end");
  });

  await q.drain();

  assert.strictEqual(overlap, false, "h1 was still running when h2 started — FIFO lock failed");
  assert.deepStrictEqual(log, ["h1:start", "h1:end", "h2:start", "h2:end"]);
});

test("cross-JID: two different JIDs run concurrently (not serialized across JIDs)", async () => {
  const q = new JidQueue();
  let jid1Running = false;
  let jid2StartedWhileJid1Running = false;

  // jid1 holds for 30ms; jid2 starts immediately after (different JID — no chain).
  // jid2's fn fires in the same microtask batch as jid1's fn, while jid1 is awaiting.
  q.enqueue("aaa@s.whatsapp.net", async () => {
    jid1Running = true;
    await new Promise<void>(r => setTimeout(r, 30));
    jid1Running = false;
  });
  q.enqueue("bbb@s.whatsapp.net", async () => {
    jid2StartedWhileJid1Running = jid1Running;
  });

  await q.drain();

  assert.strictEqual(
    jid2StartedWhileJid1Running,
    true,
    "different-JID handlers should overlap — serializing across JIDs would break throughput",
  );
});

test("poison prevention: error in h1 does not skip h2", async () => {
  const q = new JidQueue();
  const jid = "12345@s.whatsapp.net";
  let h2Ran = false;

  q.enqueue(jid, async () => {
    throw new Error("h1 exploded");
  });
  q.enqueue(jid, async () => {
    h2Ran = true;
  });

  await q.drain();

  assert.strictEqual(h2Ran, true, "h2 must run even when h1 threw");
});

test("memory cleanup: queue entry removed after drain", async () => {
  const q = new JidQueue();
  q.enqueue("12345@s.whatsapp.net", async () => { /* noop */ });
  await q.drain();
  assert.strictEqual(q.size(), 0, "stale queue entry left after drain — memory leak");
});

// ── runner ─────────────────────────────────────────────────────────────────────

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
