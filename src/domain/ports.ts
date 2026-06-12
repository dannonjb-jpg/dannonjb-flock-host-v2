// domain/ports.ts
// Tiny injected utilities so the core is deterministic under test.

export interface Clock {
  /** ISO8601 string for "now". */
  nowIso(): string;
  /** epoch ms, for interval math in the scheduler. */
  nowMs(): number;
}

export interface IdGen {
  /** Opaque unique id (uuid/ulid). */
  next(): string;
}

import { randomUUID } from "node:crypto";

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export const uuidGen: IdGen = {
  next: () => randomUUID(),
};
