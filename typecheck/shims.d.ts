// typecheck/shims.d.ts
// DEV-ONLY scaffolding so `npm run typecheck:core` can verify the invariant core
// WITHOUT installing @types/node (offline). Declares only the tiny Node/global surface
// the core touches. The production build (tsconfig.json) uses the real @types/node and
// does NOT include this file. Do not ship it.

declare module "node:crypto" {
  export function randomUUID(): string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
declare function fetch(input: string, init?: unknown): Promise<FetchResponse>;

declare function setTimeout(handler: (...args: any[]) => void, ms?: number): unknown;
declare function setInterval(handler: (...args: any[]) => void, ms?: number): unknown;

declare module "node:assert" {
  interface Assert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  exit(code?: number): never;
  exitCode?: number;
};
