// channel/baileys-adapter.ts
// Owns the single WhatsApp session (§2). Written against @whiskeysockets/baileys'
// documented surface; pin the version in package.json and adjust if the API drifts.
// Excluded from the offline typecheck (imports the SDK).
//
// Read receipts need the original message key, so we remember the last inbound key per
// JID and replay it on readMessages — matching the cadence step in §4.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
  type proto,
} from "@whiskeysockets/baileys";
import { WhatsAppChannel, InboundMessage } from "./channel.js";
import { JidQueue } from "./jid-queue.js";

// Opaque ref used for both download and quoting. Core never sees this type.
type MediaRef = { key: WAMessage["key"]; message: WAMessage["message"] };

function textOf(msg: proto.IWebMessageInfo): string {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.documentMessage?.caption ??
    m.videoMessage?.caption ??
    ""
  );
}

export class BaileysChannel implements WhatsAppChannel {
  private sock: WASocket | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private lastKey = new Map<string, proto.IMessageKey>();
  private qrCode: string | null = null;
  private messageQueue = new JidQueue(); // Per-JID FIFO serialization
  private seenMessageIds = new Set<string>(); // Dedup on WhatsApp message ID
  private logger?: any;
  private starting = false; // Prevent concurrent starts during reconnect

  constructor(private authDir: string, logger?: any) {
    this.logger = logger;
  }

  onInbound(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // (1) Overlap guard: prevent concurrent start() calls during reconnect storms
    if (this.starting) {
      console.log("[BAILEYS] start() already in progress, skipping");
      return;
    }
    this.starting = true;

    // (2) Tear down the previous socket BEFORE creating a new one.
    // - removeAllListeners() severs the old socket's connection.update
    // - end() closes its WS so it stops competing for the session
    // NEVER logout() — that invalidates creds and forces QR re-pair
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch { /* already dead */ }
      this.sock = undefined;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false });
    
    // Tag socket for instrumentation (confirms we're on the right one)
    (sock as any).__id = Math.random().toString(36).slice(2, 10);
    
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      console.log("[BAILEYS CONN UPDATE]", JSON.stringify({ qr: !!u.qr, connection: u.connection, socketId: (sock as any).__id }));
      
      if (u.qr) {
        this.qrCode = u.qr;
        console.log("[BAILEYS QR] ===== FRESH PAIRING QR CODE =====");
        console.log(u.qr);
        console.log("[BAILEYS QR] Scan with WhatsApp on +1-956-793-0580");
        console.log("[BAILEYS QR] =============================");
      }
      
      if (u.connection === "open") {
        this.starting = false; // stable; future reconnects allowed
        console.log(`[BAILEYS] ✅ open socket=${(sock as any).__id}`);
      }
      
      if (u.connection === "close") {
        // (3) Only the CURRENT socket may trigger reconnect
        if (this.sock !== sock) {
          console.log(`[BAILEYS] close from superseded socket=${(sock as any).__id} — ignored`);
          return;
        }
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        console.log(`[BAILEYS] close socket=${(sock as any).__id} code=${code}`);
        if (code !== DisconnectReason.loggedOut) {
          this.sock = undefined; // clean slate for next start()
          this.starting = false; // allow reconnect to run
          void this.start();
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`[BAILEYS MESSAGE EVENT] type=${type}, count=${messages.length}, socketId=${(sock as any).__id}`);
      if (type !== "notify") return;
      for (const msg of messages) {
        console.log(`[BAILEYS INBOUND] from=${msg.key.remoteJid}, fromMe=${msg.key.fromMe}, id=${msg.key.id}`);
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        
        // Dedup on message ID (before enqueue)
        const msgId = msg.key.id;
        if (msgId && this.seenMessageIds.has(msgId)) {
          console.log(`[baileys:dedup] skipping duplicate message ${msgId}`);
          continue;
        }
        if (msgId) this.seenMessageIds.add(msgId);
        if (!this.handler) {
          console.error(`[BAILEYS NO HANDLER] Message received but no handler attached!`);
          continue;
        }
        
        this.lastKey.set(jid, msg.key);
        
        // FIFO per-JID serialization via JidQueue (tested in test/fifo-burst.test.ts)
        this.messageQueue.enqueue(jid, async () => {
          if (this.handler) await this.handler(this.toInbound(msg));
        });
        console.log(`[BAILEYS ENQUEUED] from=${jid}, queue size=${this.messageQueue.size()}`);
      }
    });
  }

  async readMessages(jid: string): Promise<void> {
    const key = this.lastKey.get(jid);
    if (this.sock && key) await this.sock.readMessages([key]);
  }

  async setPresence(jid: string, presence: "composing" | "paused"): Promise<void> {
    if (this.sock) await this.sock.sendPresenceUpdate(presence, jid);
  }

  async sendMessage(jid: string, text: string, opts?: { quoted?: unknown }): Promise<void> {
    if (!this.sock) return;
    const quoted = opts?.quoted as MediaRef | undefined;
    await this.sock.sendMessage(
      jid,
      { text },
      quoted ? { quoted: quoted as WAMessage } : {},
    );
  }

  async downloadMedia(ref: unknown): Promise<Buffer> {
    if (!this.sock) throw new Error("Socket not ready");
    const msg = ref as MediaRef; // Only the adapter casts back
    const attempt = () =>
      downloadMediaMessage(
        msg as WAMessage,
        "buffer",
        {},
        { logger: this.logger, reuploadRequest: this.sock!.updateMediaMessage },
      ) as Promise<Buffer>;

    try {
      return await attempt();
    } catch (e1) {
      this.logger?.warn({ e1 }, "downloadMedia: retrying once");
      return await attempt(); // Hard failure throws to caller
    }
  }

  /**
   * Convert a Baileys WAMessage to core InboundMessage with opaque media ref.
   * This is the only place Baileys shape is touched to build the core interface.
   */
  private toInbound(m: WAMessage): InboundMessage {
    return {
      jid: m.key.remoteJid!,
      text: this.extractText(m),
      media: this.describeMedia(m),
    };
  }

  /**
   * Extract text from any message type. Handles conversation, extended text, captions.
   */
  private extractText(m: WAMessage): string {
    const msg = m.message;
    return (
      msg?.conversation ??
      msg?.extendedTextMessage?.text ??
      msg?.imageMessage?.caption ??
      msg?.documentMessage?.caption ??
      msg?.videoMessage?.caption ??
      ""
    );
  }

  /**
   * Describe media in a message (opaque to core). Returns { ref, mime } or undefined.
   * Handles both imageMessage and documentMessage paths.
   */
  private describeMedia(m: WAMessage): { ref: unknown; mime: string } | undefined {
    const msg = m.message;
    if (!msg) return undefined;
    if (!msg.imageMessage && !msg.documentMessage) return undefined; // sticker/video/audio: not assets
    const mime = msg.imageMessage?.mimetype ?? msg.documentMessage?.mimetype ?? "application/octet-stream";
    const ref: MediaRef = { key: m.key, message: m.message };
    return { ref, mime };
  }

  async sendMedia(jid: string, url: string, caption?: string): Promise<void> {
    if (this.sock) await this.sock.sendMessage(jid, { image: { url }, caption });
  }

  /**
   * Get the current QR code (if in pairing mode). Returns null when paired.
   */
  getQRCode(): string | null {
    return this.qrCode;
  }

  async stop(): Promise<void> {
    await this.messageQueue.drain().catch(() => {});
    this.sock?.end(undefined);
    this.sock = null;
  }
}
