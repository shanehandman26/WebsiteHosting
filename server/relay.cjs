const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { RoomWorld } = require('./room-world.cjs');

const PUBLIC = path.resolve(__dirname, '../public');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const finite = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

function cleanState(s) {
    if (!s || !finite(s.x, 0, 6000) || !finite(s.y, 0, 4000) ||
        !finite(s.vx, -600, 600) || !finite(s.vy, -600, 600) || !finite(s.angle, -1e6, 1e6)) return null;
    return { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle,
        onFoot: s.onFoot === true, onPirateShip: s.onPirateShip === true,
        boosting: s.boosting === true, dead: s.dead === true };
}

function generateRoomCode(rooms, choose = randomInt) {
    for (let attempt = 0; attempt < 128; attempt++) {
        const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + choose(26))).join('');
        if (!rooms.has(code)) return code;
    }
    return null;
}

function selectRoom(rooms, params) {
    const action = params.get('action');
    const error = (status, code, message) => ({ error: true, status, code, message });
    if (action === 'host') {
        if (rooms.size >= 32) return error(503, 4009, 'All rooms are busy. Please try again shortly.');
        const room = generateRoomCode(rooms);
        return room ? { room, hosted: true } : error(503, 4009, 'Unable to create a room. Please try again.');
    }
    if (action === 'join') {
        const room = (params.get('room') || '').trim().toUpperCase();
        if (!/^[A-Z]{4}$/.test(room)) return error(400, 4000, 'Enter a four-letter room code.');
        const peers = rooms.get(room);
        if (!peers?.hosted || (peers.expiresAt && peers.expiresAt <= Date.now())) {
            if (peers?.expiresAt && peers.expiresAt <= Date.now()) rooms.delete(room);
            return error(404, 4004, 'Room not found. Check the code or ask your friend to host a room.');
        }
        if (peers.size >= 16) return error(503, 4009, 'This room is full. Ask your friend to host another room.');
        return { room, hosted: true };
    }
    // Existing relay clients can continue using their original room links.
    const room = params.get('room') || 'ocean';
    if (action || !/^[a-z0-9-]{1,24}$/.test(room)) return error(400, 4000, 'Invalid room.');
    if ((rooms.get(room)?.size || 0) >= 16 || (!rooms.has(room) && rooms.size >= 32)) return error(503, 4009, 'Room unavailable.');
    return { room, hosted: false };
}

function createRelay() {
    const rooms = new Map();
    const expireRooms = () => {
        for (const [code, peers] of rooms) {
            if (!peers.size && peers.expiresAt && peers.expiresAt <= Date.now()) rooms.delete(code);
        }
    };
    const server = http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
        if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: wss.clients.size }));
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
        const file = path.resolve(PUBLIC, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(PUBLIC + path.sep) || !mime[path.extname(file)]) {
            res.writeHead(404); return res.end();
        }
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : data);
        });
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
    const send = (ws, message) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Slow receivers reconnect instead of accumulating stale movement.
        if (ws.bufferedAmount > 64 * 1024) return ws.terminate();
        ws.send(JSON.stringify(message));
    };
    server.on('upgrade', (req, socket, head) => {
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
        const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
        if (url.pathname !== '/multiplayer') return reject('400 Bad Request');
        if (wss.clients.size >= 128) return reject('503 Service Unavailable');
        expireRooms();
        const admission = selectRoom(rooms, url.searchParams);
        if (admission.error) {
            if (!url.searchParams.has('action')) return reject(admission.status === 400 ? '400 Bad Request' : '503 Service Unavailable');
            return wss.handleUpgrade(req, socket, head, ws => {
                ws.on('error', () => {});
                send(ws, { type: 'room_error', message: admission.message });
                ws.close(admission.code, admission.message);
            });
        }
        wss.handleUpgrade(req, socket, head, ws => {
            socket.setNoDelay(true);
            wss.emit('connection', ws, admission.room, admission.hosted);
        });
    });
    wss.on('connection', (ws, room, hosted = false) => {
        const peers = rooms.get(room) || new Set();
        peers.hosted = peers.hosted || hosted;
        peers.expiresAt = 0;
        rooms.set(room, peers);
        ws.id = randomUUID(); ws.alive = true;
        ws.state = null;
        ws.tokens = 90; ws.refillAt = Date.now(); ws.lastShot = 0;
        peers.add(ws);
        if (hosted && !peers.world) peers.world = new RoomWorld();
        const world = peers.world;
        if (world) world.addPlayer(ws.id);
        const broadcast = message => { for (const peer of peers) if (peer !== ws) send(peer, message); };
        send(ws, { type: 'welcome', id: ws.id, room,
            ...(world ? { protocol: 4, layout: world.layout, world: world.snapshot(), you: world.personal(ws.id) } : {}),
            players: [...peers].filter(p => p !== ws && (p.state || world)).map(p => ({ id: p.id,
                state: world ? world.stateFor(world.players.get(p.id)) : p.state })) });
        ws.on('pong', () => { ws.alive = true; });
        ws.on('error', () => {});
        ws.on('message', (data, binary) => {
            const now = Date.now();
            ws.tokens = Math.min(90, ws.tokens + (now - ws.refillAt) * 0.06); ws.refillAt = now;
            if (binary || --ws.tokens < 0) return ws.close(1008, 'Message limit');
            let msg;
            try { msg = JSON.parse(data); } catch { return ws.close(1008, 'Invalid JSON'); }
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'ping' && finite(msg.at, 0, 1e16)) return send(ws, { type: 'pong', at: msg.at });
            if (msg.type === 'profile' && world) {
                if (world.setUsername(ws.id, msg.username)) send(ws, { type: 'personal', you: world.personal(ws.id) });
            } else if (msg.type === 'state') {
                const state = cleanState(msg.state);
                if (!state) return;
                ws.state = world ? world.updatePlayer(ws.id, state, msg.revision ?? 0, msg.slot, msg.controls) : state;
                if (!ws.state) return;
                broadcast({ type: 'state', id: ws.id, state: ws.state });
            } else if (msg.type === 'action' && world) {
                if (world.action(ws.id, msg)) send(ws, { type: 'personal', you: world.personal(ws.id) });
            } else if (msg.type === 'shot' && !world && ws.state && !ws.state.dead && now - ws.lastShot >= 150 &&
                finite(msg.angle, -1e6, 1e6)) {
                ws.lastShot = now;
                broadcast({ type: 'shot', id: ws.id, x: ws.state.x, y: ws.state.y,
                    angle: msg.angle, cannon: msg.cannon === true });
            }
        });
        ws.on('close', () => {
            peers.delete(ws);
            world?.removePlayer(ws.id);
            broadcast({ type: 'leave', id: ws.id });
            if (!peers.size) {
                if (peers.hosted) peers.expiresAt = Date.now() + 60000;
                else rooms.delete(room);
            }
        });
    });
    // Fixed 60 Hz physics, 20 Hz snapshots. An empty room is retained but paused.
    let lastStep = Date.now();
    let accumulator = 0, snapshotClock = 0;
    const simulation = setInterval(() => {
        const now = Date.now();
        accumulator += Math.min(0.1, (now - lastStep) / 1000); lastStep = now;
        while (accumulator >= 1 / 60) {
            for (const peers of rooms.values()) if (peers.size && peers.world) peers.world.stepWorld(1 / 60);
            accumulator -= 1 / 60;
            snapshotClock += 1 / 60;
        }
        if (snapshotClock >= 0.05) {
            snapshotClock %= 0.05;
            for (const peers of rooms.values()) {
                if (!peers.size || !peers.world) continue;
                const world = peers.world;
                const snapshot = world.snapshot();
                const players = [...world.players.values()].map(p => ({ id: p.id, state: world.stateFor(p) }));
                for (const peer of peers) send(peer, { type: 'world', world: snapshot, players, you: world.personal(peer.id) });
            }
        }
    }, 1000 / 30);
    simulation.unref();
    const heartbeat = setInterval(() => {
        expireRooms();
        for (const ws of wss.clients) {
            if (!ws.alive) ws.terminate();
            else { ws.alive = false; ws.ping(); }
        }
    }, 15000);
    heartbeat.unref();
    server.on('close', () => { clearInterval(heartbeat); clearInterval(simulation); });
    return { server, wss, rooms };
}

if (require.main === module) {
    const port = Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PORT to your assigned service port');
    const { server, wss } = createRelay();
    server.listen(port, '0.0.0.0', () => console.log('Ocean relay ready on assigned port'));
    const stop = () => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createRelay, cleanState, generateRoomCode, selectRoom };
