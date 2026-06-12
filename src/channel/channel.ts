// channel/channel.ts
// The socket PORT. Exactly one process owns the Baileys session (§2); the host talks
// to it only through this interface. The brain never reaches the socket (§1).

export interface InboundMessage {
  jid: string; // whatsapp_jid
  text: string;
  media?: { ref: unknown; mime: string }; // adapter-built; ref is opaque to the core
}

export interface WhatsAppChannel {
  /** Register the inbound handler (host.handleInbound). */
  onInbound(handler: (msg: InboundMessage) => Promise<void>): void;
  readMessages(jid: string): Promise<void>; // read-receipt
  setPresence(jid: string, presence: "composing" | "paused"): Promise<void>;
  /** Send a text message, optionally quoting another message (reply). quoted is opaque to core. */
  sendMessage(jid: string, text: string, opts?: { quoted?: unknown }): Promise<void>;
  /** Download media bytes from an inbound message. Retries once on transient failure. */
  downloadMedia(ref: unknown): Promise<Buffer>;
  /** Send an image to the client. url must be an externally reachable HTTPS URL. */
  sendMedia(jid: string, url: string, caption?: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
