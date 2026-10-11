import { useEffect, useRef, useState } from 'react';

import type { WsServerMessage } from '@kinetix/shared';

import { wsBacktestChannel, wsBookChannel, wsLogsChannel, wsMarketChannel } from '@kinetix/shared';

/* ============================================================================
 * WebSocket client.
 *
 * One socket is shared by every component: React StrictMode mounts effects twice
 * in development, and a per-component socket would leave orphaned connections
 * subscribed to the same channels. Subscriptions are reference-counted so a
 * channel is only released when the last consumer unmounts.
 * ==========================================================================*/

type PayloadListener = (payload: unknown, frame: WsServerMessage) => void;

interface ConnectionState {
  connected: boolean;
  latencyMs: number | null;
  reconnectAttempts: number;
  lastSeq: number;
}

class SocketManager {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<PayloadListener>>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = { connected: false, latencyMs: null, reconnectAttempts: 0, lastSeq: 0 };
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private pendingPings = new Map<number, number>();

  subscribe(channel: string, listener: PayloadListener): () => void {
    const existing = this.listeners.get(channel);
    if (existing) {
      existing.add(listener);
    } else {
      this.listeners.set(channel, new Set([listener]));
      this.send({ op: 'subscribe', channels: [channel] });
    }
    this.ensureConnected();

    return () => {
      const bucket = this.listeners.get(channel);
      if (!bucket) return;
      bucket.delete(listener);
      if (bucket.size === 0) {
        this.listeners.delete(channel);
        this.send({ op: 'unsubscribe', channels: [channel] });
      }
    };
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener(this.state);
  }

  private ensureConnected(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.setState({ connected: true, reconnectAttempts: 0 });
      // Re-assert every subscription: the server keeps no memory of a dropped
      // client, so a reconnect must replay them.
      const channels = [...this.listeners.keys()];
      if (channels.length > 0) this.send({ op: 'subscribe', channels });
      this.startPinging();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: WsServerMessage;
      try {
        frame = JSON.parse(event.data) as WsServerMessage;
      } catch {
        return;
      }

      if (frame.channel === '__pong') {
        const payload = frame.payload as { sentAt: number };
        const sentAt = this.pendingPings.get(payload.sentAt);
        if (sentAt !== undefined) {
          this.pendingPings.delete(payload.sentAt);
          // Round-trip latency measured against the server's own clock echo.
          this.setState({ latencyMs: Number((performance.now() - sentAt).toFixed(1)) });
        }
        return;
      }

      if (frame.channel.startsWith('__')) return;
      this.setState({ lastSeq: frame.seq });
      const bucket = this.listeners.get(frame.channel);
      if (!bucket) return;
      for (const listener of bucket) listener(frame.payload, frame);
    };

    socket.onclose = () => {
      this.setState({ connected: false });
      this.stopPinging();
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      this.setState({ connected: false });
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // Capped exponential backoff, so a stopped engine does not produce a hot
    // reconnect loop in the browser console.
    const delay = Math.min(8_000, 500 * 2 ** this.state.reconnectAttempts);
    this.setState({ reconnectAttempts: this.state.reconnectAttempts + 1 });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size > 0) this.ensureConnected();
    }, delay);
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      const sentAt = performance.now();
      this.pendingPings.set(sentAt, sentAt);
      this.send({ op: 'ping', sentAt });
      // Drop stale probes so the map cannot grow without bound.
      if (this.pendingPings.size > 8) {
        const oldest = [...this.pendingPings.keys()].sort((a, b) => a - b)[0];
        if (oldest !== undefined) this.pendingPings.delete(oldest);
      }
    }, 5_000);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

export const socketManager = new SocketManager();

/** Subscribe to a channel for the lifetime of the calling component. */
export function useChannel<T>(channel: string | null, onMessage: (payload: T) => void): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!channel) return undefined;
    return socketManager.subscribe(channel, (payload) => {
      handlerRef.current(payload as T);
    });
  }, [channel]);
}

/** Connection state for the header's status pills and latency readout. */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({
    connected: false,
    latencyMs: null,
    reconnectAttempts: 0,
    lastSeq: 0,
  });

  useEffect(() => socketManager.onState(setState), []);
  return state;
}

export { wsBacktestChannel, wsBookChannel, wsLogsChannel, wsMarketChannel };
