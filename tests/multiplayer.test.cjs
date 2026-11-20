const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup({ search = '?room=crew' } = {}) {
    let now = 100;
    const elements = Object.fromEntries(['networkStatus', 'roomCodeHud', 'roomCode', 'roomFeedback', 'roomLobbyLink']
        .map(id => [id, { hidden: true }]));
    const timers = [], intervals = [];
    class Socket {
        static OPEN = 1;
        constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.events = {}; this.sent = []; }
        addEventListener(name, fn) { this.events[name] = fn; }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; this.events.close(); }
    }
    const window = { OCEAN_RELAY_URL: 'wss://relay.example/multiplayer', addEventListener() {},
        history: { replaceState(_state, _title, url) { window.replacedUrl = url; } } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/scripts/multiplayer.js'), 'utf8'), {
        window, document: { getElementById: id => elements[id] },
        location: { href: 'https://game.example/game.html' + search, search },
        URL, URLSearchParams, WebSocket: Socket, performance: { now: () => now },
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
        setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {}
    });
    const game = {
        rider: { x: 3000, y: 2000, vx: 280, vy: 0, angle: 0 }, onFoot: false, onPirateShip: false, gameOver: false,
        inventory: Array(6).fill(null), selectedSlot: 0, time: 0, gameOverPanel: { hidden: true },
        releaseControls() {}, updateCamera() {}, updateInventory() {}, updateHealthDisplay() {}, updatePickupPrompt() {},
        finishRun(cause) { this.gameOver = true; this.gameOverPanel.hidden = false; this.cause = cause; }
    };
    const client = new window.OceanMultiplayer(game);
    const socket = client.socket;
    if (socket) { socket.readyState = 1; socket.events.open(); }
    const receive = msg => client.socket.events.message({ data: JSON.stringify(msg) });
    const welcome = (room = 'CREW', id = 'self') => receive({
        type: 'welcome', id, room, players: [], protocol: 2, layout: [],
        world: { time: 0, tick: 0, sharks: [], pirateShip: { x: 3000, y: 1000, angle: 0 },
            projectiles: [], cannonballs: [], blood: [], guns: [], coconuts: [], pilotId: null },
        you: { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0, generation: 0, poseRevision: 0,
            inventory: Array(6).fill(null), selectedSlot: 0, health: 100, dead: false,
            onFoot: false, onPirateShip: false, boardReadyIn: 0, survivalSeconds: 0 }
    });
    return { client, socket, receive, welcome, game, elements, timers, intervals, window, now: value => { now = value; } };
}

test('client joins the selected room, sends state and actions, and measures RTT', () => {
    const f = setup();
    assert.equal(new URL(f.socket.url).searchParams.get('room'), 'CREW');
    assert.equal(new URL(f.socket.url).searchParams.get('action'), 'join');
    assert.equal(f.socket.sent.length, 0, 'Movement waits for the server world');
    f.welcome();
    assert.equal(f.socket.sent[0].type, 'state');
    assert.equal(f.socket.sent[0].state.x, 3000);
    f.now(145);
    f.receive({ type: 'pong', at: 100 });
    assert.match(f.elements.networkStatus.textContent, /45 MS RTT/);
    f.client.shot(1, true);
    assert.deepEqual(f.socket.sent.at(-1), { type: 'action', action: 'fire', angle: 1, slot: 0 });
    f.socket.bufferedAmount = 10000;
    const count = f.socket.sent.length;
    f.client.tick();
    assert.equal(f.socket.sent.length, count, 'Congestion drops stale updates');
});

test('remote movement interpolates, predicts briefly, and handles leave and reconnect', () => {
    const f = setup();
    const state = { x: 100, y: 200, vx: 100, vy: 0, angle: Math.PI - 0.1 };
    f.receive({ type: 'state', id: 'peer', state });
    f.now(200);
    f.receive({ type: 'state', id: 'peer', state: { ...state, x: 110, angle: -Math.PI + 0.1 } });
    const peer = f.client.peers.get('peer');
    assert.equal(f.client.position(peer, 200).x, 105);
    assert.ok(Math.abs(f.client.position(peer, 200).angle - Math.PI) < 1e-10);
    assert.equal(f.client.position(peer, 5000).x, 120, 'Prediction is capped at 100 ms');
    f.receive({ type: 'leave', id: 'peer' });
    assert.equal(f.client.peers.size, 0);
    f.socket.close();
    assert.match(f.elements.networkStatus.textContent, /OFFLINE/);
    f.timers.at(-1)();
    assert.notEqual(f.client.socket, f.socket);
});

test('home multiplayer opens a host-or-join lobby with a four-letter join form', () => {
    const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    assert.match(html, />Singleplayer<\/button>/);
    assert.match(html, /action="multiplayer.html"/);
    assert.match(html, />Multiplayer<\/button>/);
    const lobby = fs.readFileSync(require.resolve('../public/multiplayer.html'), 'utf8');
    assert.match(lobby, /name="action" value="host"/);
    assert.match(lobby, />Host Room<\/button>/);
    assert.match(lobby, />Join Room<\/button>/);
    assert.match(lobby, /pattern="\[A-Za-z\]\{4\}"/);
    const game = fs.readFileSync(require.resolve('../public/game.html'), 'utf8');
    assert.match(game, /id="roomCodeHud"/);
    assert.match(game, /id="roomCode"/);
});

test('hosting uses a server-assigned code, displays it, and reconnects to the same room', () => {
    const f = setup({ search: '?action=host' });
    assert.equal(new URL(f.socket.url).searchParams.get('action'), 'host');
    assert.equal(new URL(f.socket.url).searchParams.has('room'), false);
    assert.equal(f.elements.roomCodeHud.hidden, true);
    f.welcome('ABCD', 'host');
    assert.equal(f.client.room, 'ABCD');
    assert.equal(f.elements.roomCode.textContent, 'ABCD');
    assert.equal(f.elements.roomCodeHud.hidden, false);
    assert.equal(new URL(f.window.replacedUrl).searchParams.get('room'), 'ABCD');
    assert.equal(new URL(f.window.replacedUrl).searchParams.has('action'), false);
    f.socket.close();
    f.timers.at(-1)();
    assert.equal(new URL(f.client.socket.url).searchParams.get('action'), 'join');
    assert.equal(new URL(f.client.socket.url).searchParams.get('room'), 'ABCD');
});

test('unknown and full rooms display an error and do not reconnect into another room', () => {
    for (const message of ['Room not found.', 'This room is full.']) {
        const f = setup({ search: '?room=ABCD' });
        const count = f.timers.length;
        f.receive({ type: 'room_error', message });
        assert.equal(f.client.closed, true);
        assert.equal(f.elements.roomFeedback.hidden, false);
        assert.equal(f.elements.roomFeedback.textContent, message);
        assert.equal(f.elements.roomCodeHud.hidden, true);
        assert.equal(f.timers.length, count);
    }
});

test('invalid codes are rejected before connecting and join input normalizes four letters', () => {
    const f = setup({ search: '?room=A1BC' });
    assert.equal(f.client.socket, undefined);
    assert.match(f.elements.roomFeedback.textContent, /four-letter/);
    const input = { value: ' ab-12cd ', addEventListener(_name, fn) { this.onInput = fn; } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/scripts/lobby.js'), 'utf8'), {
        document: { getElementById: () => input }
    });
    input.onInput();
    assert.equal(input.value, 'ABCD');
});

test('server health and inventory updates preserve immediate local steering until an explicit correction', () => {
    const f = setup();
    f.welcome();
    f.game.rider.x = 3040;
    const you = { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0, generation: 0, poseRevision: 0,
        inventory: [{ id: 'gun', durability: 12 }, null, null, null, null, null], selectedSlot: 0,
        health: 75, dead: false, onFoot: false, onPirateShip: false, boardReadyIn: 0, survivalSeconds: 3 };
    f.receive({ type: 'personal', you });
    assert.equal(f.game.rider.x, 3040, 'Ordinary acknowledgements do not roll back movement');
    assert.equal(f.game.health, 75);
    assert.equal(f.game.inventory[0].id, 'gun');
    const terrain = f.game.islands;
    f.receive({ type: 'personal', you: { ...you, generation: 1, poseRevision: 1, health: 100 } });
    assert.equal(f.game.rider.x, 3000);
    assert.equal(f.game.health, 100);
    assert.equal(f.game.islands, terrain, 'An individual respawn keeps room terrain');
});

test('shared enemy updates interpolate without moving the local rider and remove consumed coconuts', () => {
    const f = setup();
    f.welcome();
    const coconut = { id: 'c1', x: 1, y: 1 };
    f.client.layout = [{ coconuts: [coconut] }];
    f.game.islands = [{ coconuts: [coconut], points: [[0, 0], [10, 0], [0, 10]] }];
    const world = (time, x) => ({ time, tick: time * 60,
        sharks: [{ id: 0, x, y: 2000, angle: 0, state: 'chase', timer: 0 }],
        pirateShip: { x, y: 1000, angle: 0 }, projectiles: [], cannonballs: [], blood: [], guns: [], coconuts: [[]], pilotId: null });
    f.client.worldSamples = [];
    f.client.receiveWorld(world(0, 100), 100);
    f.client.receiveWorld(world(0.1, 110), 200);
    f.now(225); f.client.advance();
    assert.equal(f.game.sharks[0].x, 105);
    assert.equal(f.game.pirateShip.x, 105);
    assert.equal(f.game.rider.x, 3000);
    assert.equal(f.game.islands[0].coconuts.length, 0);
    assert.equal(f.game.islands[0].points[1][0], 10, 'Shared pickup changes preserve polygon geometry');
});

test('an outdated relay cannot silently start a locally simulated multiplayer world', () => {
    const f = setup();
    f.receive({ type: 'welcome', room: 'CREW', id: 'self', players: [] });
    assert.equal(f.client.ready, false);
    assert.equal(f.client.closed, true);
    assert.match(f.elements.roomFeedback.textContent, /shared-world/);
});
