const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
    let now = 100;
    const elements = Object.fromEntries(['networkStatus', 'roomName', 'roomForm'].map(id => [id, { addEventListener() {} }]));
    const timers = [], intervals = [];
    class Socket {
        static OPEN = 1;
        constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.events = {}; this.sent = []; }
        addEventListener(name, fn) { this.events[name] = fn; }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; this.events.close(); }
    }
    const window = { OCEAN_RELAY_URL: 'wss://relay.example/multiplayer', addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/scripts/multiplayer.js'), 'utf8'), {
        window, document: { getElementById: id => elements[id] },
        location: { href: 'https://game.example/game.html?room=crew', search: '?room=crew' },
        URL, URLSearchParams, WebSocket: Socket, performance: { now: () => now },
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
        setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {}
    });
    const game = { rider: { x: 3000, y: 2000, vx: 280, vy: 0, angle: 0 }, onFoot: false, onPirateShip: false, gameOver: false };
    const client = new window.OceanMultiplayer(game);
    const socket = client.socket;
    socket.readyState = 1; socket.events.open();
    const receive = msg => socket.events.message({ data: JSON.stringify(msg) });
    return { client, socket, receive, elements, timers, intervals, now: value => { now = value; } };
}

test('client joins the selected room, sends state and actions, and measures RTT', () => {
    const f = setup();
    assert.equal(new URL(f.socket.url).searchParams.get('room'), 'crew');
    assert.equal(f.socket.sent[0].type, 'state');
    assert.equal(f.socket.sent[0].state.x, 3000);
    f.receive({ type: 'welcome', id: 'self', players: [] });
    f.now(145);
    f.receive({ type: 'pong', at: 100 });
    assert.match(f.elements.networkStatus.textContent, /45 MS RTT/);
    f.client.shot(1, true);
    assert.deepEqual(f.socket.sent.at(-1), { type: 'shot', angle: 1, cannon: true });
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

test('home screen offers separate singleplayer and multiplayer links', () => {
    const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    assert.match(html, />Singleplayer<\/button>/);
    assert.match(html, /name="room" value="ocean"/);
    assert.match(html, />Multiplayer<\/button>/);
});
