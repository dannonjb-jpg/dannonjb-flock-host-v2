// sharp's package.json exports map lacks a "types" condition, so
// moduleResolution=Bundler can't locate types automatically.
// Declared as ambient any-typed; skipLibCheck prevents false positives
// inside the library itself. Runtime resolution is correct (tsx/node
// resolve the .mjs bundle normally — this shim is types-only).
declare module 'sharp';
