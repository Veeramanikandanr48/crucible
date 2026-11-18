# Netcode: multiplayer state sync

`crucible/addons/netcode` is a [runtime](runtime.md) system for multiplayer. One side is the authority and owns the truth. It applies every client's input and sends bounded delta snapshots. A client predicts its own entity, corrects it when a snapshot arrives and draws the other entities slightly in the past, between two snapshots. It loads only when imported, adds no dependency and opens no connection or timer.

```js
import { createRuntime } from 'crucible/addons/runtime';
import { createNetcode, createWebSocketTransport } from 'crucible/addons/netcode';

// Server (or host): owns the truth.
const server = createNetcode({ role: 'authority', authority: 'server', transport: serverTransport });
server.addEntity('alice', { owner: 'alice', tag: 'player' });
server.addEntity('crate', { tag: 'prop', state: { position: [3, 1, 3], variables: { health: 10 } } });

// Client: predicts 'alice', interpolates the rest.
const client = createNetcode({
  role: 'client',
  serverId: 'server',
  localEntityId: 'alice',
  transport: createWebSocketTransport(socket, { id: 'alice', remoteId: 'server' }),
  readInput: () => ({ moveX: keys.right - keys.left, moveZ: keys.down - keys.up }),
});
createRuntime(renderer, { fixedRate: 50, systems: [client] }).start();
// each frame: client.getEntityState('crate') -> { position, rotation, velocity, variables }
```

## Authority

`authority: 'server'` is a dedicated authority with no player. `authority: 'host'` is a player who also runs the world: give it `readInput` and an entity it owns (`owner` is its own transport id) and it plays with no prediction. `'peer'` has no single authority: see Peer to peer below.

The authority methods are `addEntity(id, { owner, tag, state })`, `removeEntity(id)` and `setEntityState(id, partialState)`. `owner` is the transport peer id whose input drives the entity (one entity per peer). An entity without an owner is driven by game code: a physics prop, a door, a score. Write its state with `setEntityState` each step. Parts left out keep their value.

An entity state is `{ position: [x, y, z], rotation: [x, y, z, w], velocity: [x, y, z], variables: { name: number } }`. Parts you leave out start at zero, identity rotation and no variables.

## Peer to peer

`authority: 'peer'` (leave `role` out) has no server and no host. Every peer owns the entities it adds, runs them itself with no prediction or reconciliation, and sends their full state to every peer in the transport every `snapshotEveryTicks` steps. The other peers draw those entities `interpolationDelaySeconds` in the past, as a client does. Give a peer `localEntityId` and `readInput` to drive its own player with `simulate`; write any other entity it owns with `setEntityState`.

```js
const peer = createNetcode({ authority: 'peer', transport, localEntityId: 'alice', readInput });
peer.addEntity('alice', { tag: 'player' });   // owned by this peer, its transport id
peer.getEntityState('bob');                    // arrives from bob once he is connected
peer.claimEntity('ball');                      // take over an entity another peer owns
```

An entity has one owner and a term that starts at 0. When two peers claim the same entity, the higher term wins, and on equal terms the lower peer id, so every peer settles on the same owner whatever the arrival order. `claimEntity(id)` raises the term by one and starts from the state this peer sees, so a later claim beats the earlier owner. A peer that loses stops sending the entity, and `setEntityState` on an entity you do not own throws and names its owner (`getEntityOwner(id)`). An entity whose owner leaves the transport's `peers()` is dropped; `stats.ownershipChanges` counts owner changes. Each peer numbers its messages and tags them with a run id, so a late or reordered message is dropped as stale and a restart on the same id is followed.

Peers trust each other: nothing stops a peer from writing a state the game rules forbid, so use a server or host authority where cheating matters. There is no join handshake, since each message carries full state. Every peer must be on the transport's `peers()` list, a full mesh, so give each pair its own channel. Use the same `fixedRate` on every peer.

## Simulation and input

Client and authority run the same pure function `simulate(state, input, stepSeconds) -> state` for each input, so the client can predict. The default is `createPlanarMovement({ speed: 5 })`: input `{ moveX, moveZ }` from -1 to 1 sets a flat velocity. Pass your own `simulate` for jumping, collisions or anything else, and keep it deterministic. An input is an object of at most 16 numbers and booleans.

Each fixed step the client samples `readInput`, applies it to its predicted entity at once and sends it with a sequence number, the last `inputRedundancy` unconfirmed inputs together so one lost packet costs nothing. The authority applies each sequence once, in order. It holds a small jitter buffer (`inputBufferSteps`) so remote movement stays even, and catches up when a backlog builds.

## Snapshots

Every `snapshotEveryTicks` fixed steps (default 2) the authority builds one snapshot of all entities, quantised to integers (`positionStep` 0.01, `rotationStep` 0.001, `velocityStep` 0.01, `variableStep` 0.01) and sends each peer a delta against the last snapshot that peer acknowledged. A peer that has acknowledged nothing, or whose base is too old, gets a full snapshot. A lost snapshot is repaired by the next one, since the delta base only moves forward on acknowledgement. Stale and out-of-order snapshots are dropped.

A restart is recognised by a run id that every input and snapshot carries. A client that restarts on the same peer id gets a full snapshot, and its inputs count from sequence 1 again. When the authority restarts on the same peer id, a client drops its old snapshots, samples and pending inputs, resyncs from a full snapshot and counts it in `authorityRestarts`. Run ids sort by start time, so a late snapshot of an older run is dropped as stale even when it arrives before any snapshot of the newer one. Inputs also name the authority run the client follows, and the authority ignores an ack that names another run, so an authority restarted within its first frames is not given a base from the old run. A null ack on the newest input message makes the authority forget the base it remembered. A present but invalid `session` is counted in `rejectedMessages`. An authority restarted with a clock behind the first run gets an id that sorts before it; a client that sees 30 snapshots in a row of a lower run and none of the one it follows adopts the lower run and resyncs, so that case recovers after about 30 snapshots instead of staying stuck. Run ids use `crypto.getRandomValues`, so the runtime needs `globalThis.crypto` (Node 20 and every current browser).

## Prediction, reconciliation and interpolation

When a snapshot arrives the client takes the authoritative state of its entity, drops the inputs the authority has already applied (`lastProcessedInput`) and replays the rest through `simulate`. If the prediction was right the result does not move; if not, the entity is corrected in one step (`stats.lastCorrection`, `stats.maximumCorrection`). Smooth a big correction in your drawing code if the look needs it.

Other entities are drawn `interpolationDelaySeconds` (default 0.1) behind the newest snapshot, blended between the two samples around that time. Past the newest sample the entity carries on at its velocity for at most `maximumExtrapolationSeconds` (0.25). The drawing clock follows real time and is nudged by at most 10 percent toward the target, so a late packet slows the clock instead of jumping the entity. Raise the delay on a jittery connection.

`getEntityState(id)` returns the state to draw: the truth on the authority, the prediction for `localEntityId`, the interpolation for the rest.

## Transports

A transport is a plain object `{ id, peers(), send(peerId, message), receive(callback) }`. `peers()` returns the connected peer ids, `send` takes a JSON-compatible object and must not throw for a transient failure, and `receive(callback)` registers `callback(peerId, message)` and returns a function that unregisters it. Write your own for WebTransport.

- `createDataChannelTransport({ id })` is the WebRTC transport. Your signalling code opens each `RTCDataChannel` and hands it over with `transport.addChannel(peerId, channel)`: a host adds one per player, a client adds one channel for the host. `removeChannel(peerId)` drops one. A peer is listed while its channel is `open`, so a player who disconnects leaves `peers()` on its own. A channel that fires `close` or `error` is dropped from the transport, its listeners detached and its slot freed, so a long-lived host can see players come and go under new peer ids; a closed channel that never fired an event is dropped when `addChannel` reaches the 32-channel cap. Messages are JSON text, bounded by `maximumMessageBytes`; a malformed, oversized or non-object (`5`, `[]`, `"x"`, `null`) incoming message counts in `stats.rejected`. At most 32 channels. Use a reliable ordered channel, or `{ ordered: false, maxRetransmits: 0 }` for snapshots when you accept drops, which the delta scheme repairs. Signalling (offer, answer, ICE) is yours: this library opens no connection.

- `createLoopbackNetwork({ seed, latencyMilliseconds, jitterMilliseconds, lossRate })` is an in-memory network for tests. `network.createTransport(id)` adds a peer; `network.advance(milliseconds)` moves time and delivers what is due. Latency, jitter and loss come from the seeded generator, so a seed repeats a run exactly. Messages are copied through JSON and may arrive out of order.
- `createBroadcastChannelTransport(channel, { id })` wraps a `BroadcastChannel` so tabs, windows and workers of one browser play together with no server. Peers find each other with a hello the other side answers once, and a message to one peer reaches only that peer. A peer silent for `peerTimeoutMilliseconds` (default 5000) is forgotten until it speaks again, so a closed tab leaves the peer list; call `transport.close()` on `pagehide` to say goodbye at once. `now` swaps the clock for tests.
- `createWebSocketTransport(socket, { id, remoteId, multiplexed, maximumMessageBytes })` wraps a socket-like object you opened (`send(text)`, `addEventListener`, `readyState`, `close()`). By default it is a line to one peer, `remoteId`. With `multiplexed: true` it speaks to a relay that wraps messages as `{ to, data }` going out and `{ from, data }` coming in (and `{ from, left: true }` when a peer leaves), so a server or host can hear many clients.

## Options and bounds

| Option | Default | Meaning |
| --- | --- | --- |
| `role` | `'client'` | `'authority'` or `'client'` |
| `authority` | `'server'` | `'server'`, `'host'` or `'peer'` |
| `transport` | required | The transport above |
| `serverId` | required for a client | Peer id of the authority |
| `localEntityId` | none | The entity a client predicts |
| `simulate`, `readInput` | planar movement, none | See above |
| `snapshotEveryTicks` | 2 | 1 to 60 |
| `inputRedundancy`, `inputBufferSteps` | 3, 3 | Inputs resent per message (1 to 8), authority jitter buffer (0 to 16) |
| `interpolationDelaySeconds`, `maximumExtrapolationSeconds` | 0.1, 0.25 | 0 to 2 |
| `maximumMessageBytes` | 65536 | A snapshot over this throws; up to 1 MB |

`NETCODE_LIMITS` holds the hard bounds: 256 entities, 32 peers, 16 variables per entity, names up to 64 characters, 8 inputs per message, 64 queued inputs per peer, 64 snapshots of history. Network input is untrusted: a bad message is counted in `stats.rejectedMessages` and ignored, never thrown. Option and call errors say what to pass.

`stats` reports `snapshotsSent`, `fullSnapshotsSent`, `bytesSent`, `inputsProcessed`, `snapshotsReceived`, `staleSnapshots`, `missingBaseSnapshots`, `authorityRestarts`, `reconciliations`, `lastCorrection`, `maximumCorrection`, `rejectedMessages` and `ownershipChanges`.

## Sample game and relay

`scripts/netcode-sample.html` is a two-player sample: one page is the host (`?role=host`, plays `alice`, owns the truth) and the other is a client (`?role=client`, plays `bob` with prediction and reconciliation). Move with the arrow keys or WASD. `?transport=broadcast` (default) uses two tabs of one browser; `?transport=webrtc` connects the two pages with a WebRTC data channel, trading the offer and answer over a BroadcastChannel, so the two pages must be tabs of one browser (a real game sends those two messages through its own signalling service); `?transport=websocket` uses the relay on the machine that serves the page: the socket goes to the page's own host, `ws` or `wss` to match the page, and `?relayPort=` (default 8787) picks the port. To play across a LAN, run the relay with `--host 0.0.0.0` on the machine that serves the sample and open the page from the other machine by that machine's address. `?delay=50` adds that many milliseconds to everything a page sends. The sample sends a snapshot every tick and draws remote players 40 ms behind (`?snap=` and `?interp=` change them), which shows a move on the other page about 95 ms after the key with 50 ms of injected latency each way. Serve the repository root (for example with `npx vite`) and open both URLs.

`node scripts/netcode-relay.mjs --port 8787 [--host 0.0.0.0] [--latency 50]` is a reference relay of about 80 lines. Players connect to `/?id=<name>`; it forwards `{ to, data }` as `{ from, data }`, announces `{ from, left: true }`, refuses a repeated name and keeps no game state, so it runs on any free Node host. It needs the `ws` package, a dev dependency of this repository only; the library itself gains no dependency.

`tests/netcode-two-browsers.test.js` opens the host and client in two headless Chrome pages over each of the three transports with 50 ms injected per direction. It asserts that both pages end within 0.05 units of each other and that a move shows on the other page in under 450 ms. Measured on a loaded machine: a host move shows on the client after about 200 to 230 ms and a client move shows on the host after about 130 to 150 ms, the same over every transport. The 2026-11-18 run of this test, with the sample's 20 ms snapshots and 40 ms interpolation delay, measured a host move showing on the client after 80 to 88 ms and a client move showing on the host after 127 to 134 ms from the key press, over BroadcastChannel, WebSocket and WebRTC alike. The client's own player never waits, since it is predicted, and the largest correction was 0. The host-to-client figure holds the 50 ms line, up to one snapshot interval (40 ms) and the 100 ms interpolation delay.

## Not yet

A WebTransport transport and a relay on a real free host come in later work on #778. The data channel test covers a host with two clients and an ownerless prop driven by game code. Use the same `fixedRate` on the authority and every client.
