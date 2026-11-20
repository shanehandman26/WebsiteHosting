const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup({ search = '?room=crew' } = {}) {
    let now = 100;
    const elements = Object.fromEntries(['networkStatus', 'roomCodeHud', 'roomCode', 'roomFeedback', 'roomLobbyLink', 'roomWaiting', 'startGameButton', 'waitingPlayers', 'waitingMessage', 'minimapLegend', 'roundResult', 'nextRoundButton', 'resetButton', 'restartButton', 'roundWinner', 'roundResultMessage', 'spectatorBanner']
        .map(id => [id, { hidden: true, addEventListener(name, fn) { this[name] = fn; } }]));
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
    const welcome = (room = 'CREW', id = 'self', phase = 'running', hostId = id) => receive({
        type: 'welcome', id, room, players: [], protocol: 4, layout: [],
        world: { phase, hostId, round: 1, aliveCount: 2, result: null, time: 0, tick: 0, sharks: [], pirateShip: { x: 3000, y: 1000, angle: 0 },
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

test('shared chest snapshots update lids, dropped firecrackers, and firework effects', () => {
    const f = setup(); f.welcome();
    const chest = { id: 'chest-0', x: 20, y: 10, opened: false, items: [] };
    f.client.layout = [{ coconuts: [], chests: [chest] }];
    f.game.islands = [{ coconuts: [], chests: [chest] }];
    const loot = { id: 'loot-0', type: 'firecracker', durability: 5, x: 1000, y: 1000, islandIndex: 0 };
    const burst = { x: 1500, y: 1000, startedAt: 1, duration: 0.65 };
    f.client.receiveWorld({ phase: 'running', hostId: 'self', time: 1, tick: 60,
        sharks: [], pirateShip: { x: 1000, y: 1000, angle: 0 }, projectiles: [], cannonballs: [],
        guns: [], blood: [], coconuts: [[]], chests: [[{ id: 'chest-0', opened: true }]],
        loot: [loot], fireworkBursts: [burst] }, 100);
    const visible = f.game.islands[0].chests[0];
    assert.equal(visible.opened, true);
    assert.equal(visible.x, 20); assert.equal(visible.y, 10);
    assert.equal(visible.items.length, 0);
    assert.equal(chest.opened, false);
    assert.equal(f.game.loot[0].durability, 5);
    assert.equal(f.game.loot[0].id, 'loot-0');
    assert.equal(f.game.fireworkBursts[0].x, 1500);
});

test('an outdated relay cannot silently start a locally simulated multiplayer world', () => {
    const f = setup();
    f.receive({ type: 'welcome', room: 'CREW', id: 'self', players: [] });
    assert.equal(f.client.ready, false);
    assert.equal(f.client.closed, true);
    assert.match(f.elements.roomFeedback.textContent, /shared-world/);
});

test('the waiting lobby offers Start Game only to the host and blocks other game actions', () => {
    const f = setup();
    f.welcome('CREW', 'host', 'waiting');
    assert.equal(f.client.playing, false);
    assert.equal(f.elements.roomWaiting.hidden, false);
    assert.equal(f.elements.startGameButton.hidden, false);
    assert.equal(f.socket.sent.some(m => m.type === 'state'), false);
    assert.equal(f.client.action('interact'), false);
    assert.equal(f.client.action('respawn'), false);
    assert.equal(f.elements.startGameButton.disabled, true, 'Two connected players are required');
    f.receive({ type: 'state', id: 'guest', state: { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0, dead: false } });
    f.client.syncLobby();
    f.elements.startGameButton.click();
    assert.equal(f.socket.sent.at(-1).action, 'start');
    assert.equal(f.elements.startGameButton.disabled, true);
    const guest = setup();
    guest.welcome('CREW', 'guest', 'waiting', 'host');
    assert.equal(guest.elements.startGameButton.hidden, true);
    const count = guest.socket.sent.length;
    guest.elements.startGameButton.click();
    assert.equal(guest.socket.sent.length, count);
});

test('the server start snapshot dismisses the lobby and applies the assigned spawn before sending movement', () => {
    const f = setup();
    f.welcome('CREW', 'host', 'waiting');
    f.receive({ type: 'world',
        world: { phase: 'running', hostId: 'host', round: 1, aliveCount: 2, result: null, time: 0, tick: 0, sharks: [],
            pirateShip: { x: 3000, y: 1000, angle: 0 }, projectiles: [], cannonballs: [], blood: [], guns: [], coconuts: [] },
        players: [{ id: 'host', state: { x: 720, y: 800 } }],
        you: { x: 720, y: 800, vx: 0, vy: 0, angle: 0, generation: 1, poseRevision: 1,
            inventory: Array(6).fill(null), selectedSlot: 0, health: 100, dead: false,
            onFoot: false, onPirateShip: false, boardReadyIn: 0, survivalSeconds: 0 }
    });
    assert.equal(f.client.playing, true);
    assert.equal(f.elements.roomWaiting.hidden, true);
    assert.equal(f.elements.minimapLegend.hidden, false);
    assert.equal(f.game.rider.x, 720);
    f.client.tick();
    assert.equal(f.socket.sent.at(-1).type, 'state');
    assert.equal(f.socket.sent.at(-1).state.x, 720);
    assert.equal(f.socket.sent.at(-1).revision, 1);
});

test('the minimap includes distant living players and removes dead or disconnected players', () => {
    const f = setup();
    f.welcome();
    const state = { x: 5200, y: 3100, vx: 0, vy: 0, angle: 0, dead: false };
    f.receive({ type: 'state', id: 'far', state });
    f.receive({ type: 'state', id: 'dead', state: { ...state, dead: true } });
    assert.equal(f.client.minimapPlayers().length, 1);
    assert.equal(f.client.minimapPlayers()[0].x, 5200);
    f.receive({ type: 'leave', id: 'far' });
    assert.equal(f.client.minimapPlayers().length, 0);
});

function roundPacket({ phase = 'running', round = 1, result = null, you = {}, players = [] } = {}) {
    return { type: 'world', players,
        world: { phase, round, result, hostId: 'self', aliveCount: 2, time: 0, tick: 0,
            sharks: [], pirateShip: { x: 3000, y: 1000, angle: 0 },
            projectiles: [], cannonballs: [], blood: [], guns: [], coconuts: [] },
        you: { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0, generation: 1, poseRevision: 1,
            inventory: Array(6).fill(null), selectedSlot: 0, health: 100, dead: false, spectator: false,
            onFoot: false, onPirateShip: false, boardReadyIn: 0, survivalSeconds: 0, ...you }
    };
}

test('eliminated players spectate without respawn buttons, input messages, or a blocking death screen', () => {
    const f = setup(); f.welcome();
    f.receive(roundPacket({ you: { health: 0, dead: true, cause: 'Spear hit' },
        players: [{ id: 'other', state: { x: 5100, y: 3000, vx: 0, vy: 0, angle: 0, dead: false } }] }));
    assert.equal(f.client.spectating, true);
    assert.equal(f.game.gameOverPanel.hidden, true);
    assert.equal(f.elements.spectatorBanner.hidden, false);
    assert.match(f.elements.spectatorBanner.textContent, /ELIMINATED/);
    assert.equal(f.elements.restartButton.hidden, true); assert.equal(f.elements.resetButton.hidden, true);
    assert.equal(f.client.action('respawn'), false); assert.equal(f.client.action('interact'), false);
    const count = f.socket.sent.length;
    f.client.advance(); f.client.tick();
    assert.equal(f.game.rider.x, 5100, 'Spectator camera follows a living player');
    assert.equal(f.socket.sent.slice(count).some(m => m.type === 'state'), false);
});

test('late joiners see spectator status and everyone sees the authoritative winner screen', () => {
    const f = setup(); f.welcome();
    f.receive(roundPacket({ you: { spectator: true, dead: true, health: 0 } }));
    assert.match(f.elements.spectatorBanner.textContent, /SPECTATING/);
    f.receive(roundPacket({ phase: 'finished', result: { winnerId: 'other', winnerLabel: 'Rider othe' },
        you: { spectator: true, dead: true, health: 0 },
        players: [{ id: 'other', state: { x: 5000, y: 3000, vx: 0, vy: 0, angle: 0, dead: false } }] }));
    assert.equal(f.elements.roundResult.hidden, false);
    assert.equal(f.elements.roomWaiting.hidden, true);
    assert.equal(f.elements.roundWinner.textContent, 'Rider othe wins!');
    assert.equal(f.elements.spectatorBanner.hidden, true);
    assert.equal(f.elements.nextRoundButton.hidden, false);
    f.elements.nextRoundButton.click();
    assert.equal(f.socket.sent.at(-1).action, 'next_round');
    f.receive(roundPacket({ round: 2, you: { generation: 2, poseRevision: 2, x: 720, y: 800 },
        players: [{ id: 'other', state: { x: 5200, y: 3000, vx: 0, vy: 0, angle: 0, dead: false } }] }));
    assert.equal(f.elements.roundResult.hidden, true);
    assert.equal(f.client.playing, true); assert.equal(f.client.spectating, false);
    assert.equal(f.game.gameOver, false); assert.equal(f.game.health, 100);
    assert.equal(f.game.rider.x, 720);
});
