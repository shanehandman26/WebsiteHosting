const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateRoomCode, selectRoom, createRelay } = require('../server/relay.cjs');

test('four-letter room codes avoid occupied codes and handle repeated collisions', () => {
    const rooms = new Map([['AAAA', new Set()]]);
    let draws = 0;
    assert.equal(generateRoomCode(rooms, () => draws++ < 4 ? 0 : 1), 'BBBB');
    assert.equal(generateRoomCode(rooms, () => 0), null);
    assert.match(generateRoomCode(rooms), /^[A-Z]{4}$/);
});

test('joining requires an existing hosted code and respects room and service capacity', () => {
    const rooms = new Map();
    const host = selectRoom(rooms, new URLSearchParams('action=host'));
    assert.match(host.room, /^[A-Z]{4}$/);
    assert.equal(selectRoom(rooms, new URLSearchParams('action=join&room=' + host.room)).code, 4004);
    const peers = new Set(); peers.hosted = true;
    rooms.set(host.room, peers);
    assert.equal(selectRoom(rooms, new URLSearchParams('action=join&room=' + host.room.toLowerCase())).room, host.room);
    assert.equal(selectRoom(rooms, new URLSearchParams('action=join&room=A1BC')).code, 4000);
    for (let i = 0; i < 16; i++) peers.add(i);
    assert.equal(selectRoom(rooms, new URLSearchParams('action=join&room=' + host.room)).code, 4009);
    while (rooms.size < 32) rooms.set('legacy-' + rooms.size, new Set());
    assert.equal(selectRoom(rooms, new URLSearchParams('action=host')).status, 503);
});

class Peer extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.messages = []; }
    send(data) { this.messages.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
}

test('a guest joining a hosted code receives the host movement and shots while other rooms stay separate', t => {
    const relay = createRelay();
    const clients = [];
    t.after(() => {
        for (const peer of clients) if (peer.readyState === 1) peer.close();
        relay.wss.close(); relay.server.emit('close');
    });
    const open = params => {
        const admission = selectRoom(relay.rooms, new URLSearchParams(params));
        assert.equal(admission.error, undefined);
        const peer = new Peer(); clients.push(peer);
        relay.wss.emit('connection', peer, admission.room, admission.hosted);
        return peer;
    };
    const host = open('action=host');
    const code = host.messages[0].room;
    const guest = open('action=join&room=' + code.toLowerCase());
    const other = open('action=host');
    assert.equal(guest.messages[0].room, code);
    assert.notEqual(other.messages[0].room, code);
    const state = { x: 3000, y: 2000, vx: 20, vy: 0, angle: 0 };
    host.emit('message', Buffer.from(JSON.stringify({ type: 'state', state })), false);
    assert.equal(guest.messages.at(-1).type, 'state');
    assert.equal(guest.messages.at(-1).state.x, 3000);
    host.emit('message', Buffer.from(JSON.stringify({ type: 'shot', angle: 0 })), false);
    assert.equal(guest.messages.at(-1).type, 'shot');
    assert.equal(other.messages.length, 1);
    host.close();
    assert.equal(guest.messages.at(-1).type, 'leave');
    assert.equal(selectRoom(relay.rooms, new URLSearchParams('action=join&room=' + code)).room, code);
    guest.close();
    assert.ok(relay.rooms.get(code).expiresAt > Date.now());
    assert.equal(selectRoom(relay.rooms, new URLSearchParams('action=join&room=' + code)).room, code);
    relay.rooms.get(code).expiresAt = Date.now() - 1;
    assert.equal(selectRoom(relay.rooms, new URLSearchParams('action=join&room=' + code)).code, 4004);
    assert.equal(relay.rooms.has(code), false);
});
