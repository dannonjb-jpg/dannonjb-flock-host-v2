// moderation/moderate.ts
// MVP keyword/regex content gate. Scans asset bytes (interpreted as latin1 text) for
// policy violations embedded in filenames, EXIF/comment fields, or plain-text content.
// Not a substitute for vision-model review — catches obvious text-embedded bad actors.
// Replace the scan body with a vision API call when calibration data justifies it.

export interface ModerationResult {
  ok: boolean;
  reason?: string;
}

// Patterns that always block (hard reject, no attestation path).
const EXPLICIT: RegExp[] = [
  /\bpornograph(?:ic|y)\b/i,
  /\bnudit(?:y|ies)\b/i,
  /\bexplicit\b/i,
  /\bnsfw\b/i,
  /\badult[\s_-]*content\b/i,
  /\bxxx\b/i,
];

const HATE_SPEECH: RegExp[] = [
  /\bheil\s+hitler\b/i,
  /\bwhite[\s_-]*(?:power|supremac(?:y|ist))\b/i,
  /\bgas\s+the\s+(?:jews?|blacks?)\b/i,
  /\b(?:kill|die|hang)\s+(?:all\s+)?(?:jews?|blacks?|muslims?|gays?|latinos?)\b/i,
];

/**
 * Scans asset bytes for policy violations.
 * Converts to latin1 (lossless for binary, finds text segments in EXIF/metadata).
 */
export async function moderateAsset(asset: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<ModerationResult> {
  const text = Buffer.from(asset.bytes).toString("latin1").toLowerCase();

  for (const p of EXPLICIT) {
    if (p.test(text)) return { ok: false, reason: "explicit content detected" };
  }
  for (const p of HATE_SPEECH) {
    if (p.test(text)) return { ok: false, reason: "hate speech detected" };
  }

  return { ok: true };
}
