import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHub, type Hub } from '../src/ws/hub.ts';

/* ============================================================================
 * WebSocket hub.
 *
 * The hub fans frames out per channel, and the terminal relies on that to avoid
 * receiving (and re-rendering) an entire market. These cases drive it over a
 * real socket rather than calling the internal map, so serialisation and the
 * client protocol are covered too.
 * ==========================================================================*/

interface Frame {
  channel: string;
  seq: number;
  ts: number;
  payload: unknown;
}

interface Harness {
  url: string;
  hub: Hub;
  app: FastifyInstance;
  dispose: () => Promise<void>;
}

const open: Harness[] = [];

async function startHub(): Promise<Harness> {
  const app = Fastify();
  const hub = await createHub(app, { heartbeatMs: 5_000 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port');

  const harness: Harness = {
    url: `ws://127.0.0.1:${address.port}/ws`,
    hub,
    app,
    dispose: async () => {
      await hub.close();
      await app.close();
    },
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    await harness?.dispose();
  }
});

interface Client {
  socket: WebSocket;
  frames: Frame[];
}

async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${url}`)));
  });
  return { socket, frames };
}

async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await settle(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const channelsOf = (client: Client): string[] => {
  const seen = new Set<string>();
  for (const frame of client.frames) seen.add(frame.channel);
  return [...seen];
};

describe('websocket hub', () => {
  it('greets a client and names the channel it starts on', async () => {
    const harness = await startHub();
    const client = await connect(harness.url);
    await waitFor(() => client.frames.length > 0, 'welcome frame');

    const welcome = client.frames[0];
    expect(welcome?.channel).toBe('__welcome');
    expect(welcome?.seq).toBe(0);
    expect(welcome?.payload).toMatchObject({ channels: ['fleet'] });
    expect(harness.hub.clientCount()).toBe(1);

    client.socket.close();
    await waitFor(() => harness.hub.clientCount() === 0, 'client to disconnect');
  });

  it('fans a frame out only to sockets subscribed to its channel', async () => {
    const harness = await startHub();
    const client = await connect(harness.url);
    await waitFor(() => client.frames.length > 0, 'welcome frame');

    harness.hub.broadcast('market:ETH-USD', { price: 3_120.4 });
    await settle();
    expect(channelsOf(client)).not.toContain('market:ETH-USD');

    harness.hub.broadcast('fleet', { frozen: false });
    await waitFor(() => channelsOf(client).includes('fleet'), 'fleet frame');
    const frame = client.frames.find((candidate) => candidate.channel === 'fleet');
    expect(frame?.payload).toEqual({ frozen: false });
    // Sequence numbers must advance so the terminal can spot a dropped link.
    expect(frame?.seq).toBeGreaterThan(0);
  });

  it('subscribes and unsubscribes on request', async () => {
    const harness = await startHub();
    const client = await connect(harness.url);
    await waitFor(() => client.frames.length > 0, 'welcome frame');

    client.socket.send(JSON.stringify({ op: 'subscribe', channels: ['market:BTC-USD'] }));
    await waitFor(
      () => client.frames.some((frame) => frame.channel === '__subscribed' && (frame.payload as { channels: string[] }).channels.includes('market:BTC-USD')),
      'subscription acknowledgement',
    );
    expect(harness.hub.channelStats().get('market:BTC-USD')).toBe(1);

    harness.hub.broadcast('market:BTC-USD', { price: 91_420.5 });
    await waitFor(() => channelsOf(client).includes('market:BTC-USD'), 'market frame');

    client.socket.send(JSON.stringify({ op: 'unsubscribe', channels: ['market:BTC-USD'] }));
    await waitFor(
      () => client.frames.filter((frame) => frame.channel === '__subscribed').length >= 2,
      'unsubscription acknowledgement',
    );
    expect(harness.hub.channelStats().get('market:BTC-USD')).toBeUndefined();

    const delivered = client.frames.filter((frame) => frame.channel === 'market:BTC-USD').length;
    harness.hub.broadcast('market:BTC-USD', { price: 91_500 });
    await settle();
    expect(client.frames.filter((frame) => frame.channel === 'market:BTC-USD')).toHaveLength(delivered);
  });

  it('echoes a ping so the terminal can measure round-trip latency', async () => {
    const harness = await startHub();
    const client = await connect(harness.url);
    await waitFor(() => client.frames.length > 0, 'welcome frame');

    client.socket.send(JSON.stringify({ op: 'ping', sentAt: 1_234 }));
    await waitFor(() => client.frames.some((frame) => frame.channel === '__pong'), 'pong frame');

    const pong = client.frames.find((frame) => frame.channel === '__pong');
    expect(pong?.payload).toMatchObject({ sentAt: 1_234 });
    expect(typeof (pong?.payload as { serverMs: number }).serverMs).toBe('number');
  });

  it('answers malformed and unsupported frames with an error instead of dropping', async () => {
    const harness = await startHub();
    const client = await connect(harness.url);
    await waitFor(() => client.frames.length > 0, 'welcome frame');

    client.socket.send('not json');
    await waitFor(
      () => client.frames.some((frame) => frame.channel === '__error' && /Malformed JSON/.test(String((frame.payload as { message: string }).message))),
      'malformed-frame error',
    );

    client.socket.send(JSON.stringify({ op: 'launch_missiles' }));
    await waitFor(
      () => client.frames.some((frame) => frame.channel === '__error' && /Unsupported message/.test(String((frame.payload as { message: string }).message))),
      'unsupported-op error',
    );
  });

  it('stops delivering to a closed socket', async () => {
    const harness = await startHub();
    const client = await connect(harness.url);
    await waitFor(() => harness.hub.clientCount() === 1, 'client to register');

    client.socket.close();
    await waitFor(() => harness.hub.clientCount() === 0, 'client to be reaped');

    // Broadcasting into an empty hub must be a no-op, not a throw.
    expect(() => harness.hub.broadcast('fleet', { frozen: true })).not.toThrow();
    expect(harness.hub.channelStats().size).toBe(0);
  });
});
