import type { ServerResponse } from "node:http";

interface SseClient {
  id: string;
  userId: string;
  companyId: string | null;
  res: ServerResponse;
}

class EventBroadcaster {
  private clients = new Set<SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.clients.size === 0) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(": heartbeat\n\n");
        } catch {
          this.clients.delete(client);
        }
      }
      if (this.clients.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }, 25000);
    this.heartbeatTimer.unref?.();
  }

  addClient(id: string, userId: string, res: ServerResponse, companyId: string | null = null): () => void {
    const client: SseClient = { id, userId, companyId, res };
    this.clients.add(client);
    this.ensureHeartbeat();

    res.write(`event: connected\ndata: ${JSON.stringify({ id, ts: Date.now() })}\n\n`);

    return () => {
      this.clients.delete(client);
    };
  }

  broadcast(type: string, payload: Record<string, unknown> = {}, companyId?: string | null): void {
    if (this.clients.size === 0) return;
    const targetCompanyId =
      companyId !== undefined
        ? companyId
        : typeof payload.companyId === "string" && payload.companyId
          ? payload.companyId
          : null;
    const data = JSON.stringify({ type, payload, ts: Date.now() });
    const message = `event: erp_update\ndata: ${data}\n\n`;
    for (const client of this.clients) {
      if (targetCompanyId && client.companyId && client.companyId !== targetCompanyId) {
        continue;
      }
      try {
        client.res.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const eventBroadcaster = new EventBroadcaster();
