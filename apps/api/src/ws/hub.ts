import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

import { WsClientMessageSchema } from '@kinetix/shared';

/* ============================================================================
 * WebSocket hub.
 *
 * Clients subscribe to named channels; the hub fans frames out only to sockets
 * that asked for them. A monotonic sequence number rides on every frame so the
 * terminal can detect a dropped connection rather than silently showing a stale
 * tape.
 * ==========================================================================*/

export interface Hub {
  close(): Promise<void>;
  /** Publish to every socket subscribed to `channel` (exact match). */
  broadcast(channel: string, payload: unknown): void;
  clientCount(): number;
  channelStats(): Map<string, number>;
}

interface HubOptions {
  path?: string;
  heartbeatMs?: number;
  log?: (message: string) => void;
}

export async function createHub(app: FastifyInstance, options: HubOptions = {}): Promise<Hub> {
  const path = options.path ?? '/ws';
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const log = options.log ?? (() => {});

  await app.register(websocket, {
    options: { maxPayload: 1_048_576 },
  });

  interface SocketState {
    id: number;
    channels: Set<string>;
    socket: {
      send: (data: string) => void;
      close: () => void;
      readyState: number;
    };
    lastPongAt: number;
  }

  const sockets = new Map<number, SocketState>();
  let nextId = 1;
  let sequence = 0;

  app.get(path, { websocket: true }, (socket, request) => {
    const state: SocketState = {
      id: nextId++,
      channels: new Set(['fleet']),
      socket: socket as unknown as SocketState['socket'],
      lastPongAt: Date.now(),
    };
    sockets.set(state.id, state);
    log(`[ws] client ${state.id} connected from ${request.ip} (${sockets.size} open)`);

    const send = (frame: unknown): void => {
      try {
        state.socket.send(JSON.stringify(frame));
      } catch {
        sockets.delete(state.id);
      }
    };

    send({
      channel: '__welcome',
      seq: sequence++,
      ts: Date.now(),
      payload: { clientId: state.id, channels: [...state.channels] },
    });

    socket.on('message', (raw: unknown) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(String(raw));
      } catch {
        send({ channel: '__error', seq: sequence++, ts: Date.now(), payload: { message: 'Malformed JSON frame' } });
        return;
      }

      const parsed = WsClientMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        send({
          channel: '__error',
          seq: sequence++,
          ts: Date.now(),
          payload: { message: 'Unsupported message', issues: parsed.error.issues.map((issue) => issue.message) },
        });
        return;
      }

      const message = parsed.data;
      if (message.op === 'subscribe') {
        for (const channel of message.channels) state.channels.add(channel);
        send({ channel: '__subscribed', seq: sequence++, ts: Date.now(), payload: { channels: [...state.channels] } });
        return;
      }
      if (message.op === 'unsubscribe') {
        for (const channel of message.channels) state.channels.delete(channel);
        send({ channel: '__subscribed', seq: sequence++, ts: Date.now(), payload: { channels: [...state.channels] } });
        return;
      }
      // Ping/pong lets the terminal measure real round-trip latency.
      state.lastPongAt = Date.now();
      send({
        channel: '__pong',
        seq: sequence++,
        ts: Date.now(),
        payload: { sentAt: message.sentAt, serverMs: Date.now() },
      });
    });

    socket.on('close', () => {
      sockets.delete(state.id);
      log(`[ws] client ${state.id} disconnected (${sockets.size} open)`);
    });

    socket.on('error', () => {
      sockets.delete(state.id);
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const state of sockets.values()) {
      if (now - state.lastPongAt > heartbeatMs * 3) {
        // A socket that has not answered for three intervals is presumed dead;
        // dropping it prevents publishing into a black hole.
        state.socket.close();
        sockets.delete(state.id);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    broadcast: (channel, payload) => {
      if (sockets.size === 0) return;
      const frame = JSON.stringify({ channel, seq: sequence++, ts: Date.now(), payload });
      for (const state of sockets.values()) {
        if (!state.channels.has(channel)) continue;
        try {
          state.socket.send(frame);
        } catch {
          sockets.delete(state.id);
        }
      }
    },
    clientCount: () => sockets.size,
    channelStats: () => {
      const stats = new Map<string, number>();
      for (const state of sockets.values()) {
        for (const channel of state.channels) stats.set(channel, (stats.get(channel) ?? 0) + 1);
      }
      return stats;
    },
    close: async () => {
      clearInterval(heartbeat);
      for (const state of sockets.values()) state.socket.close();
      sockets.clear();
    },
  };
}
