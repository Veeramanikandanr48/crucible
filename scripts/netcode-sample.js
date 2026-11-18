// A two-player sample for crucible/addons/netcode. One page hosts (it owns the truth and plays "alice"), the other is a client
// that predicts "bob". Each player moves a square with the arrow keys or WASD; both pages draw both squares.
// Open scripts/netcode-sample.html?role=host and scripts/netcode-sample.html?role=client in two tabs; see docs/netcode.md.
import { createRuntime } from '../src/runtime.js';
import {
  createBroadcastChannelTransport,
  createDataChannelTransport,
  createNetcode,
  createWebSocketTransport,
} from '../src/netcode.js';

const HOST_ID = 'alice';
const CLIENT_ID = 'bob';
const WORLD_HALF_SIZE = 8;
const FIXED_RATE = 50;
const SNAPSHOT_EVERY_TICKS = 1;
const INTERPOLATION_DELAY_SECONDS = 0.04;
const KEY_DIRECTIONS = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
};

// The relay runs on the machine that serves this page: the socket URL takes the host from the page itself, ws or wss to
// match the page's protocol, and only a port number from the ?relayPort= query. No query text reaches the URL.
export const DEFAULT_RELAY_PORT = 8787;

export function relaySocketUrl(pageLocation, relayPort, playerId) {
  const port = Number(relayPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`The relay port must be a whole number from 1 to 65535, got ${JSON.stringify(relayPort)}. Pass ?relayPort=${DEFAULT_RELAY_PORT}.`);
  }
  const scheme = pageLocation.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${pageLocation.hostname}:${port}/?id=${encodeURIComponent(playerId)}`;
}

function openWebSocket(relayPort, playerId) {
  const socketUrl = relaySocketUrl(globalThis.location, relayPort, playerId);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`Could not reach the relay at ${socketUrl}. Start it on the machine that serves this page with: node scripts/netcode-relay.mjs --port ${relayPort}`)), { once: true });
  });
}

// Delays what a transport sends, to feel a slow connection on one machine. Everything else, including the live `stats`
// getter, is read from the real transport, and delayed sends that have not left yet are dropped when it closes.
export function withInjectedLatency(transport, delayMilliseconds) {
  if (delayMilliseconds <= 0) return transport;
  const pendingTimers = new Set();
  const delayed = Object.create(transport);
  delayed.send = (peerId, message) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      transport.send(peerId, message);
    }, delayMilliseconds);
    pendingTimers.add(timer);
  };
  delayed.close = () => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    transport.close();
  };
  return delayed;
}

// WebRTC in one browser needs no server: the two pages trade the offer and the answer over a BroadcastChannel. A real game
// sends the same two messages through its own signalling service. Candidates are gathered before the description is sent, so
// there is no trickle. The client says hello until the host answers, so either page may load first.
const SIGNALLING_CHANNEL_NAME = 'crucible-netcode-signalling';
const SIGNALLING_RETRY_MILLISECONDS = 250;
const ICE_GATHERING_TIMEOUT_MILLISECONDS = 2000;

function describeWhenGathered(connection) {
  return new Promise(resolve => {
    const finish = () => resolve(connection.localDescription.toJSON());
    if (connection.iceGatheringState === 'complete') {
      finish();
      return;
    }
    connection.addEventListener('icegatheringstatechange', () => { if (connection.iceGatheringState === 'complete') finish(); });
    setTimeout(finish, ICE_GATHERING_TIMEOUT_MILLISECONDS);
  });
}

function waitForOpen(channel) {
  return new Promise((resolve, reject) => {
    if (channel.readyState === 'open') {
      resolve();
      return;
    }
    channel.addEventListener('open', () => resolve(), { once: true });
    channel.addEventListener('error', () => reject(new Error('The WebRTC data channel failed to open.')), { once: true });
  });
}

async function createWebRtcTransport(playerId, remoteId, isHost) {
  const transport = createDataChannelTransport({ id: playerId });
  const signalling = new BroadcastChannel(SIGNALLING_CHANNEL_NAME);
  const connection = new RTCPeerConnection({ iceServers: [] });
  const channelOpen = new Promise(resolve => {
    if (isHost) {
      const channel = connection.createDataChannel('netcode', { ordered: false, maxRetransmits: 0 });
      transport.addChannel(remoteId, channel);
      resolve(waitForOpen(channel));
    } else {
      connection.addEventListener('datachannel', event => {
        transport.addChannel(remoteId, event.channel);
        resolve(waitForOpen(event.channel));
      });
    }
  });
  let offerSent = false;
  signalling.onmessage = async event => {
    const message = event.data;
    if (message.to !== playerId) return;
    if (isHost && message.type === 'hello' && !offerSent) {
      offerSent = true;
      await connection.setLocalDescription(await connection.createOffer());
      signalling.postMessage({ to: remoteId, type: 'offer', description: await describeWhenGathered(connection) });
    } else if (isHost && message.type === 'answer' && connection.signalingState === 'have-local-offer') {
      await connection.setRemoteDescription(message.description);
    } else if (!isHost && message.type === 'offer' && connection.signalingState === 'stable') {
      await connection.setRemoteDescription(message.description);
      await connection.setLocalDescription(await connection.createAnswer());
      signalling.postMessage({ to: remoteId, type: 'answer', description: await describeWhenGathered(connection) });
    }
  };
  const helloTimer = isHost ? null : setInterval(() => signalling.postMessage({ to: remoteId, type: 'hello' }), SIGNALLING_RETRY_MILLISECONDS);
  await channelOpen;
  clearInterval(helloTimer);
  const closeChannels = transport.close;
  transport.close = () => {
    closeChannels();
    connection.close();
    signalling.close();
  };
  return transport;
}

async function createSampleTransport(options, playerId, remoteId) {
  if (options.transport === 'broadcast') {
    return createBroadcastChannelTransport(new BroadcastChannel('crucible-netcode-sample'), { id: playerId });
  }
  if (options.transport === 'websocket') {
    const socket = await openWebSocket(options.relayPort ?? DEFAULT_RELAY_PORT, playerId);
    return createWebSocketTransport(socket, { id: playerId, remoteId, multiplexed: true });
  }
  if (options.transport === 'webrtc') return createWebRtcTransport(playerId, remoteId, options.role === 'host');
  throw new RangeError(`Sample transport must be "broadcast", "websocket" or "webrtc", got ${JSON.stringify(options.transport)}.`);
}

function readKeyboard(pressedKeys) {
  let moveX = 0;
  let moveZ = 0;
  for (const code of pressedKeys) {
    moveX += KEY_DIRECTIONS[code][0];
    moveZ += KEY_DIRECTIONS[code][1];
  }
  return { moveX: Math.sign(moveX), moveZ: Math.sign(moveZ) };
}

function drawPlayers(canvas, netcode, localId) {
  const context = canvas.getContext('2d');
  const scale = canvas.width / (WORLD_HALF_SIZE * 2);
  context.fillStyle = '#14161a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const [id, color] of [[HOST_ID, '#f0b429'], [CLIENT_ID, '#4fc3f7']]) {
    const state = netcode.getEntityState(id);
    if (!state) continue;
    const x = (state.position[0] + WORLD_HALF_SIZE) * scale;
    const y = (state.position[2] + WORLD_HALF_SIZE) * scale;
    context.fillStyle = color;
    context.fillRect(x - 10, y - 10, 20, 20);
    if (id === localId) {
      context.strokeStyle = '#ffffff';
      context.strokeRect(x - 12, y - 12, 24, 24);
    }
  }
}

// options: { role: 'host' | 'client', transport: 'broadcast' | 'websocket' | 'webrtc', relayPort, delayMilliseconds, canvas,
//            snapshotEveryTicks, interpolationDelaySeconds }
export async function startSample(options) {
  const isHost = options.role === 'host';
  const playerId = isHost ? HOST_ID : CLIENT_ID;
  const remoteId = isHost ? CLIENT_ID : HOST_ID;
  const transport = withInjectedLatency(await createSampleTransport(options, playerId, remoteId), options.delayMilliseconds ?? 0);

  const pressedKeys = new Set();
  let scriptedInput = null;
  const readInput = () => scriptedInput ?? readKeyboard(pressedKeys);
  window.addEventListener('keydown', event => { if (event.code in KEY_DIRECTIONS) pressedKeys.add(event.code); });
  window.addEventListener('keyup', event => pressedKeys.delete(event.code));

  // A snapshot every tick (20 ms) and a 40 ms interpolation delay: the drawn remote player trails by two snapshot intervals.
  const timing = {
    snapshotEveryTicks: options.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS,
    interpolationDelaySeconds: options.interpolationDelaySeconds ?? INTERPOLATION_DELAY_SECONDS,
  };
  const netcode = createNetcode(isHost
    ? { role: 'authority', authority: 'host', transport, readInput, ...timing }
    : { role: 'client', serverId: HOST_ID, localEntityId: CLIENT_ID, transport, readInput, ...timing });
  // A closed page tells the other one it left, so nobody keeps sending to a tab that is gone.
  window.addEventListener('pagehide', () => transport.close());
  if (isHost) {
    netcode.addEntity(HOST_ID, { owner: HOST_ID, tag: 'player', state: { position: [-3, 0, 0] } });
    netcode.addEntity(CLIENT_ID, { owner: CLIENT_ID, tag: 'player', state: { position: [3, 0, 0] } });
  }
  const runtime = createRuntime({ render() {} }, { fixedRate: FIXED_RATE, pauseWhenHidden: false, systems: [netcode] });
  runtime.start();

  const draw = () => {
    if (options.canvas) drawPlayers(options.canvas, netcode, playerId);
    requestAnimationFrame(draw);
  };
  draw();

  // Resolves with the wall-clock time at which an entity drawn on this page has moved `distance` away from where it is now.
  function whenEntityMoves(entityId, distance) {
    const start = netcode.getEntityState(entityId).position;
    return new Promise(resolve => {
      const check = () => {
        const position = netcode.getEntityState(entityId).position;
        if (Math.hypot(position[0] - start[0], position[2] - start[2]) >= distance) resolve(Date.now());
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  return {
    playerId,
    netcode,
    runtime,
    // Replaces the keyboard with a fixed input (or null to go back to the keyboard); used by tests and demos.
    setInput(input) {
      scriptedInput = input;
      return Date.now();
    },
    position(entityId) {
      return netcode.getEntityState(entityId)?.position ?? null;
    },
    whenEntityMoves,
  };
}
