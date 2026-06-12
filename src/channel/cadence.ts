// channel/cadence.ts
// §4 steps 5 & 8: read-receipt delay before marking read, and typing duration scaled
// to reply length. Pure functions so timing is testable; in production this is where
// `whatsapp-cadence` plugs in (the host executes the delays it returns).

export interface Cadence {
  /** ms to wait before sending the read receipt for an inbound message. */
  readDelayMs(message: string): number;
  /** ms to show "composing" before sending a reply of this length. */
  typingMs(reply: string): number;
}

export interface CadenceConfig {
  readBaseMs: number;
  readPerCharMs: number;
  readMaxMs: number;
  typeBaseMs: number;
  typePerCharMs: number;
  typeMaxMs: number;
}

export const DEFAULT_CADENCE: CadenceConfig = {
  readBaseMs: 800,
  readPerCharMs: 12,
  readMaxMs: 6000,
  typeBaseMs: 1200,
  typePerCharMs: 28,
  typeMaxMs: 12000,
};

export class LengthScaledCadence implements Cadence {
  constructor(private cfg: CadenceConfig = DEFAULT_CADENCE) {}
  readDelayMs(message: string): number {
    return Math.min(this.cfg.readMaxMs, this.cfg.readBaseMs + message.length * this.cfg.readPerCharMs);
  }
  typingMs(reply: string): number {
    return Math.min(this.cfg.typeMaxMs, this.cfg.typeBaseMs + reply.length * this.cfg.typePerCharMs);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
