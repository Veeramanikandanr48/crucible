import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoopbackNetwork, createNetcode } from '../src/netcode.js';

const STEP_SECONDS = 0.02;

function startPeer(network, id) {
  const netcode = createNetcode({ authority: 'peer', transport: network.createTransport(id), snapshotEveryTicks: 1 });
  netcode.init({ fixedStepSeconds: STEP_SECONDS });
  return netcode;
}

function remoteEntity(overrides = {}) {
  return { p: [100, 0, 0], r: [0, 0, 0, 1000], v: [0, 0, 0], m: 0, ...overrides };
}

test('a peer that sends an entity without variables is read, not thrown on', () => {
  const network = createLoopbackNetwork();
  const peer = startPeer(network, 'alice');
  const peerMessage = { type: 'peer-state', session: 'a', tick: 1, entities: { crate: remoteEntity() } };
  const transport = network.createTransport('probe');
  transport.send('alice', peerMessage);
  assert.doesNotThrow(() => network.advance(1));
  assert.deepEqual(peer.getEntityState('crate').variables, {});
});

test('a peer entity with a deleted variable marker does not become a variable of zero', () => {
  const network = createLoopbackNetwork();
  const peer = startPeer(network, 'alice');
  const transport = network.createTransport('bob');
  transport.send('alice', { type: 'peer-state', session: 'a', tick: 1, entities: { crate: remoteEntity({ x: { gone: null, kept: 5 } }) } });
  network.advance(1);
  assert.deepEqual(Object.keys(peer.getEntityState('crate').variables), ['kept']);
});

test('peers that left free their sender slot for new peers', () => {
  const network = createLoopbackNetwork();
  const peer = startPeer(network, 'alice');
  for (let index = 0; index < 40; index += 1) {
    const id = `guest-${index}`;
    const guest = network.createTransport(id);
    guest.send('alice', { type: 'peer-state', session: 'a', tick: 1, entities: { [id]: remoteEntity({ x: {} }) } });
    network.advance(1);
    peer.fixedUpdate(STEP_SECONDS, {});
    guest.close();
    peer.fixedUpdate(STEP_SECONDS, {});
  }
  assert.equal(peer.stats.rejectedMessages, 0);
  assert.equal(peer.stats.snapshotsReceived, 40);
});

test('a non-finite frame time does not freeze the drawing clock', () => {
  const network = createLoopbackNetwork();
  const server = createNetcode({ role: 'authority', transport: network.createTransport('server'), snapshotEveryTicks: 1 });
  const client = createNetcode({ role: 'client', serverId: 'server', transport: network.createTransport('client') });
  server.init({ fixedStepSeconds: STEP_SECONDS });
  client.init({ fixedStepSeconds: STEP_SECONDS });
  server.addEntity('crate', { state: { velocity: [1, 0, 0] } });
  for (let frame = 0; frame < 20; frame += 1) {
    server.fixedUpdate(STEP_SECONDS, {});
    client.fixedUpdate(STEP_SECONDS, {});
    network.advance(20);
    client.update(STEP_SECONDS);
  }
  client.update(Number.NaN);
  client.update(STEP_SECONDS);
  const state = client.getEntityState('crate');
  assert.ok(state.position.every(Number.isFinite), `position ${state.position}`);
});
