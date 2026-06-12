// Per-JID FIFO serialization queue.
// Chains each new task behind the current tail for its JID so handlers for the
// same JID run one-at-a-time in arrival order. Tasks across JIDs are independent
// and may overlap. One failing handler cannot poison the chain (caught inline).

export class JidQueue {
  private queues = new Map<string, Promise<void>>();

  enqueue(jid: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(jid) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((err: unknown) => {
        console.error(`[jid-queue] handler error for ${jid}:`, err);
      });
    this.queues.set(jid, next);
    void next.finally(() => {
      if (this.queues.get(jid) === next) this.queues.delete(jid);
    });
    return next;
  }

  /** Resolves when all currently-enqueued handlers have run. */
  drain(): Promise<void> {
    return Promise.all([...this.queues.values()]).then(() => undefined);
  }

  /** Number of JIDs with active or pending handlers (for assertions / logging). */
  size(): number {
    return this.queues.size;
  }
}
