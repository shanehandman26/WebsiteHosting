const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createRelay } = require('../server/relay.cjs');

const state = { x: 3000, y: 2000, vx: 280, vy: 0, angle: 1 };
function message(ws, type) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('No ' + type)); }, 1500);
        function onMessage(data) {
            const msg = JSON.parse(data);
            if (msg.type !== type) return;
            clearTimeout(timer); ws.off('message', onMessage); resolve(msg);
        }
        ws.on('message', onMessage);
    });
}
async function fixture(t) {
    const relay = createRelay();
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const base = `http://127.0.0.1:${relay.server.address().port}`;
    t.after(async () => {
        for (const ws of relay.wss.clients) ws.terminate();
        relay.wss.close();
        await new Promise(resolve => relay.server.close(resolve));
    });
    async function connect(room = 'ocean') {
        return connectRequest('room=' + room);
    }
    async function connectRequest(params) {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/multiplayer?' + params);
        const welcome = await message(ws, 'welcome');
        return { ws, welcome };
    }
    return { ...relay, base, connect, connectRequest };
}

test('hosting assigns a four-letter code, a guest joins it, and unknown codes return an error', async t => {
    const f = await fixture(t);
    const host = await f.connectRequest('action=host');
    const code = host.welcome.room;
    assert.match(code, /^[A-Z]{4}$/);
    const guest = await f.connectRequest('action=join&room=' + code.toLowerCase());
    assert.equal(guest.welcome.room, code);
    const stateReceived = message(guest.ws, 'state');
    host.ws.send(JSON.stringify({ type: 'state', state }));
    assert.equal((await stateReceived).id, host.welcome.id);
    const unknown = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const rejected = new WebSocket(f.base.replace('http:', 'ws:') + '/multiplayer?action=join&room=' + unknown);
    const closed = once(rejected, 'close');
    assert.match((await message(rejected, 'room_error')).message, /not found/);
    assert.equal((await closed)[0], 4004);
});

test('a hosted room admits sixteen simultaneous players and refuses a seventeenth', async t => {
    const f = await fixture(t);
    const host = await f.connectRequest('action=host');
    const code = host.welcome.room;
    const guests = await Promise.all(Array.from({ length: 15 }, () => f.connectRequest('action=join&room=' + code)));
    assert.equal(f.rooms.get(code).size, 16);
    const rejected = new WebSocket(f.base.replace('http:', 'ws:') + '/multiplayer?action=join&room=' + code);
    const closed = once(rejected, 'close');
    assert.match((await message(rejected, 'room_error')).message, /full/);
    assert.equal((await closed)[0], 4009);
    const deliveries = guests.map(guest => message(guest.ws, 'state'));
    host.ws.send(JSON.stringify({ type: 'state', state }));
    for (const update of await Promise.all(deliveries)) assert.equal(update.id, host.welcome.id);
});

test('host, guests and late joiners receive one current world and player respawns preserve it', async t => {
    const f = await fixture(t);
    const host = await f.connectRequest('action=host');
    const code = host.welcome.room;
    const guest = await f.connectRequest('action=join&room=' + code);
    assert.equal(host.welcome.protocol, 3);
    assert.deepEqual(guest.welcome.layout, host.welcome.layout);
    const world = f.rooms.get(code).world;
    world.start(host.welcome.id);
    for (const p of world.players.values()) Object.assign(p.pose, { x: 3000, y: 2000 });
    world.sharks[0].health = 1;
    world.pirateShip.hits = 7;
    world.floatingGuns = [{ id: 'race-gun', name: 'Spear gun', durability: 12, x: 3000, y: 2000 }];
    const picked = message(host.ws, 'personal');
    host.ws.send(JSON.stringify({ type: 'action', action: 'interact', slot: 0 }));
    assert.equal((await picked).you.inventory[0].id, 'race-gun');
    const guestSnapshot = await message(guest.ws, 'world');
    assert.equal(guestSnapshot.world.guns.length, 0);
    assert.equal(guestSnapshot.world.sharks[0].health, 1);
    assert.equal(guestSnapshot.world.pirateShip.hits, 7);
    assert.equal(guestSnapshot.you.inventory.filter(Boolean).length, 0);
    const late = await f.connectRequest('action=join&room=' + code);
    assert.deepEqual(late.welcome.layout, host.welcome.layout);
    assert.equal(late.welcome.world.guns.length, 0);
    assert.equal(late.welcome.world.sharks[0].health, 1);
    const gun = world.players.get(host.welcome.id).inventory[0];
    const fired = message(host.ws, 'personal');
    host.ws.send(JSON.stringify({ type: 'action', action: 'fire', slot: 0, angle: 0 }));
    assert.equal((await fired).you.inventory[0].durability, 11);
    assert.equal(gun.durability, 11);
    world.time += 0.21;
    const respawned = message(host.ws, 'personal');
    host.ws.send(JSON.stringify({ type: 'action', action: 'respawn' }));
    const response = await respawned;
    assert.equal(response.you.generation, 2);
    assert.equal(response.you.health, 100);
    assert.equal(response.you.inventory.filter(Boolean).length, 0);
    assert.equal(world.sharks[0].health, 1);
    assert.equal(world.pirateShip.hits, 7);
    assert.equal(world.players.get(guest.welcome.id).generation, 1);
});

test('network lobby stays paused until the host starts, then broadcasts scattered spawns to everyone', async t => {
    const f = await fixture(t);
    const host = await f.connectRequest('action=host');
    const code = host.welcome.room;
    const guest = await f.connectRequest('action=join&room=' + code);
    assert.equal(host.welcome.world.phase, 'waiting');
    assert.equal(host.welcome.world.hostId, host.welcome.id);
    guest.ws.send(JSON.stringify({ type: 'action', action: 'start' }));
    const waiting = await message(guest.ws, 'world');
    assert.equal(waiting.world.phase, 'waiting');
    assert.equal(waiting.world.time, 0);
    const started = message(host.ws, 'personal');
    host.ws.send(JSON.stringify({ type: 'action', action: 'start' }));
    assert.equal((await started).you.generation, 1);
    const snapshot = await message(guest.ws, 'world');
    assert.equal(snapshot.world.phase, 'running');
    assert.equal(snapshot.players.length, 2);
    const [a, b] = snapshot.players.map(p => p.state);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 500);
    const late = await f.connectRequest('action=join&room=' + code);
    assert.equal(late.welcome.world.phase, 'running');
    assert.ok(Math.hypot(late.welcome.you.x - a.x, late.welcome.you.y - a.y) >= 500);
});

test('relay forwards movement and shots, separates rooms, and reports disconnects', async t => {
    const f = await fixture(t);
    const a = await f.connect(), b = await f.connect(), c = await f.connect('other');
    const otherMessages = [], echo = [];
    c.ws.on('message', data => otherMessages.push(JSON.parse(data)));
    a.ws.on('message', data => echo.push(JSON.parse(data)));
    const received = message(b.ws, 'state');
    a.ws.send(JSON.stringify({ type: 'state', state: { ...state, id: 'spoof', extra: 'drop' } }));
    const update = await received;
    assert.equal(update.id, a.welcome.id);
    assert.equal(update.state.x, state.x);
    assert.equal(update.state.extra, undefined);
    const d = await f.connect();
    assert.equal(d.welcome.players[0].id, a.welcome.id);
    const shot = message(b.ws, 'shot');
    a.ws.send(JSON.stringify({ type: 'shot', angle: 0, x: 9999 }));
    assert.equal((await shot).x, state.x);
    const pong = message(a.ws, 'pong');
    a.ws.send(JSON.stringify({ type: 'ping', at: 123 }));
    assert.equal((await pong).at, 123);
    assert.equal(otherMessages.length, 0);
    assert.equal(echo.filter(m => m.type === 'state' || m.type === 'shot').length, 0);
    const left = message(b.ws, 'leave');
    a.ws.close();
    assert.equal((await left).id, a.welcome.id);
});

test('invalid state is dropped and malformed JSON closes only the offending client', async t => {
    const f = await fixture(t);
    const a = await f.connect(), b = await f.connect();
    const states = [];
    b.ws.on('message', data => { const m = JSON.parse(data); if (m.type === 'state') states.push(m); });
    a.ws.send(JSON.stringify({ type: 'state', state: { ...state, x: -10 } }));
    a.ws.send(JSON.stringify({ type: 'state', state: { ...state, vx: 'bad' } }));
    const pong = message(a.ws, 'pong');
    a.ws.send(JSON.stringify({ type: 'ping', at: 1 }));
    await pong;
    assert.equal(states.length, 0);
    const closed = once(a.ws, 'close');
    a.ws.send('{');
    assert.equal((await closed)[0], 1008);
    assert.equal(b.ws.readyState, WebSocket.OPEN);
});

test('room capacity, payload size, and message rate are bounded', async t => {
    const f = await fixture(t);
    const clients = [];
    for (let i = 0; i < 16; i++) clients.push(await f.connect('full'));
    const rejected = new WebSocket(f.base.replace('http:', 'ws:') + '/multiplayer?room=full');
    rejected.on('error', () => {});
    await once(rejected, 'unexpected-response').then(([, res]) => { assert.equal(res.statusCode, 503); res.resume(); rejected.terminate(); });
    const a = clients[0].ws;
    const closed = once(a, 'close');
    a.send('x'.repeat(3000));
    assert.equal((await closed)[0], 1009);
    const b = clients[1].ws, rateClosed = once(b, 'close');
    for (let i = 0; i < 100; i++) b.send('{"type":"unknown"}');
    assert.equal((await rateClosed)[0], 1008);
});

test('health and game are served without exposing repository files', async t => {
    const f = await fixture(t);
    assert.equal((await (await fetch(f.base + '/health')).json()).ok, true);
    const game = await fetch(f.base + '/game.html');
    assert.equal(game.status, 200);
    assert.match(await game.text(), /multiplayer.js/);
    const logo = await fetch(f.base + '/assets/ocean-rush-logo.png');
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(f.base + '/package.json')).status, 404);
    assert.equal((await fetch(f.base + '/%2e%2e%2fserver/relay.cjs')).status, 404);
});
