/* Server-owned room world with local steering and interpolated snapshots. */
class OceanMultiplayer {
    constructor(game) {
        this.game = game;
        this.peers = new Map();
        this.ready = false;
        this.playing = false;
        this.hostId = null;
        this.starting = false;
        this.worldTime = 0;
        this.worldSamples = [];
        this.poseRevision = -1;
        this.generation = -1;
        this.controls = { x: 0, y: 0 };
        const params = new URLSearchParams(location.search);
        this.hosting = params.get('action') === 'host';
        this.room = (params.get('room') || '').trim().toUpperCase();
        this.status = document.getElementById('networkStatus');
        this.roomCodeHud = document.getElementById('roomCodeHud');
        this.roomCode = document.getElementById('roomCode');
        this.feedback = document.getElementById('roomFeedback');
        this.waitingPanel = document.getElementById('roomWaiting');
        this.startButton = document.getElementById('startGameButton');
        this.startButton.addEventListener('click', () => {
            if (this.id !== this.hostId || this.playing || !this.ready || this.starting) return;
            if (this.action('start')) { this.starting = true; this.syncLobby(); }
        });
        document.getElementById('roomLobbyLink').hidden = false;
        this.retry = 500;
        this.closed = false;
        this.rtt = null;
        window.addEventListener('pagehide', () => {
            this.closed = true;
            clearTimeout(this.reconnect);
            clearInterval(this.sender);
            this.socket?.close();
        });
        window.addEventListener('pageshow', event => {
            if (event.persisted) location.reload();
        });
        if (!this.hosting && !/^[A-Z]{4}$/.test(this.room)) {
            this.failRoom('Enter a four-letter room code to join.');
            return;
        }
        this.connect();
        this.sender = setInterval(() => this.tick(), 1000 / 30);
    }

    connect() {
        this.status.textContent = this.hosting ? 'CREATING ROOM…' : 'JOINING ROOM…';
        const endpoint = new URL(window.OCEAN_RELAY_URL || '/multiplayer', location.href);
        endpoint.protocol = endpoint.protocol === 'http:' ? 'ws:' : endpoint.protocol === 'https:' ? 'wss:' : endpoint.protocol;
        endpoint.searchParams.set('action', this.hosting ? 'host' : 'join');
        if (this.hosting) endpoint.searchParams.delete('room');
        else endpoint.searchParams.set('room', this.room);
        const socket = this.socket = new WebSocket(endpoint);
        const timeout = setTimeout(() => socket.close(), 8000);
        socket.addEventListener('open', () => {
            clearTimeout(timeout);
            this.retry = 500;
            this.lastPong = performance.now();
            this.nextPing = 0;
            this.tick();
        });
        socket.addEventListener('message', event => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            const now = performance.now();
            if (msg.type === 'welcome') {
                const code = (msg.room || '').toUpperCase();
                if (!/^[A-Z]{4}$/.test(code)) {
                    this.failRoom('The room service needs updating. Please try again later.');
                    return;
                }
                this.room = code; this.hosting = false;
                this.roomCode.textContent = code;
                this.roomCodeHud.hidden = false;
                this.feedback.hidden = true;
                const url = new URL(location.href);
                url.searchParams.set('room', code); url.searchParams.delete('action');
                window.history?.replaceState(null, '', url.href);
                this.id = msg.id;
                if (msg.protocol !== 3 || !msg.world || !msg.layout || !msg.you) {
                    this.failRoom('This room needs the shared-world server update. Refresh after the update.');
                    return;
                }
                this.layout = msg.layout;
                this.game.islands = JSON.parse(JSON.stringify(this.layout));
                this.game.navigation = null;
                this.poseRevision = -1; this.generation = -1;
                this.worldSamples = [];
                this.receiveWorld(msg.world, now);
                this.applyPersonal(msg.you, true);
                this.ready = true;
                this.tick();
                for (const p of msg.players) this.receive(p.id, p.state, now);
                this.syncLobby();
            } else if (msg.type === 'room_error') {
                this.failRoom(msg.message || 'Unable to join this room.');
                return;
            } else if (msg.type === 'world') {
                this.receiveWorld(msg.world, now);
                this.applyPersonal(msg.you);
                const present = new Set(msg.players.map(p => p.id));
                for (const id of this.peers.keys()) if (!present.has(id)) this.peers.delete(id);
                for (const p of msg.players) this.receive(p.id, p.state, now);
                this.syncLobby();
            } else if (msg.type === 'personal') {
                this.applyPersonal(msg.you, true);
            } else if (msg.type === 'state') this.receive(msg.id, msg.state, now);
            else if (msg.type === 'leave') this.peers.delete(msg.id);
            else if (msg.type === 'pong') {
                this.rtt = Math.round(now - msg.at);
                this.lastPong = now;
            }
            this.updateStatus();
        });
        socket.addEventListener('error', () => socket.close());
        socket.addEventListener('close', () => {
            clearTimeout(timeout);
            this.peers.clear(); this.rtt = null; this.ready = false; this.playing = false; this.starting = false; this.worldSamples = [];
            this.syncLobby();
            if (this.closed) return;
            this.status.textContent = 'OFFLINE · RETRYING';
            if (!this.closed) {
                this.reconnect = setTimeout(() => this.connect(), this.retry + Math.random() * 300);
                this.retry = Math.min(this.retry * 2, 10000);
            }
        });
    }

    failRoom(message) {
        this.closed = true;
        clearTimeout(this.reconnect); clearInterval(this.sender);
        this.roomCodeHud.hidden = true;
        this.status.textContent = 'ROOM UNAVAILABLE';
        this.feedback.textContent = message;
        this.feedback.hidden = false;
        this.waitingPanel.hidden = true;
        this.socket?.close();
    }

    send(message) {
        if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 8192) return;
        this.socket.send(JSON.stringify(message));
    }

    tick() {
        if (this.socket?.readyState !== WebSocket.OPEN || !this.ready) return;
        const now = performance.now();
        if (now - this.lastPong > 12000) { this.socket.close(); return; }
        const g = this.game;
        if (this.playing) {
            const aimAngle = g.onPirateShip ? g.pirateCannonPose(true).angle : (g.aimAngle?.() ?? g.rider.angle - Math.PI / 2);
            this.send({ type: 'state', revision: this.poseRevision, slot: g.selectedSlot, controls: { ...this.controls, aimAngle }, state: { ...g.rider, onFoot: g.onFoot,
                onPirateShip: g.onPirateShip, boosting: g.boosting, dead: g.gameOver } });
        }
        if (now >= this.nextPing) {
            this.send({ type: 'ping', at: now });
            this.nextPing = now + 2000;
        }
    }

    action(action, values = {}) {
        if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
        if (action !== 'start' && !this.playing) return false;
        this.tick();
        this.send({ type: 'action', action, slot: this.game.selectedSlot, ...values });
        return true;
    }

    shot(angle) { return this.action('fire', { angle }); }

    fire() {
        const g = this.game, gun = g.inventory[g.selectedSlot];
        if (!this.ready || !this.playing || g.gameOver || !gun || gun.type === 'coconut' || g.time < g.nextShotAt ||
            (gun.type !== 'cannon' && gun.durability <= 0)) return false;
        const cannon = gun.type === 'cannon';
        const angle = cannon ? g.pirateCannonPose(true).angle : g.aimAngle();
        if (!this.shot(angle)) return false;
        g.nextShotAt = g.time + (cannon ? 3 : 0.2);
        g.muzzleFlash = { x: g.rider.x + Math.cos(angle) * 48, y: g.rider.y + Math.sin(angle) * 48,
            angle, startedAt: g.time, duration: 0.14 };
        return true;
    }

    applyPersonal(you, selection = false) {
        const g = this.game;
        if (you.generation !== this.generation) {
            this.generation = you.generation;
            g.releaseControls();
            g.boost = 100; g.wake = []; g.islandCollision = null;
            g.nextShotAt = 0; g.muzzleFlash = null;
        }
        if (you.poseRevision > this.poseRevision) {
            this.poseRevision = you.poseRevision;
            Object.assign(g.rider, { x: you.x, y: you.y, vx: you.vx, vy: you.vy, angle: you.angle });
            g.islandCollision = null;
            g.updateCamera();
        }
        g.health = you.health;
        g.inventory = you.inventory;
        if (selection) g.selectedSlot = you.selectedSlot;
        g.invulnerable = you.invulnerable;
        g.onFoot = you.onFoot; g.onPirateShip = you.onPirateShip;
        g.parkedBoat = you.parkedBoat;
        g.walkIsland = g.islands[you.walkIsland] || null;
        g.stowedCannonSlot = you.stowedCannonSlot;
        g.boardReadyAt = g.time + you.boardReadyIn;
        g.survivalSeconds = you.survivalSeconds;
        if (you.dead && !g.gameOver) g.finishRun(you.cause);
        else if (!you.dead) { g.gameOver = false; g.gameOverPanel.hidden = true; }
        g.updateInventory(); g.updateHealthDisplay(); g.updatePickupPrompt();
    }

    receiveWorld(world, now) {
        const g = this.game;
        const wasPlaying = this.playing;
        this.playing = world.phase === 'running';
        this.hostId = world.hostId;
        if (this.playing !== wasPlaying) { this.worldSamples = []; this.starting = false; }
        this.worldTime = world.time;
        this.pilotId = world.pilotId;
        this.worldSamples.push({ ...world, at: now });
        if (this.worldSamples.length > 6) this.worldSamples.shift();
        g.floatingGuns = world.guns;
        for (let i = 0; i < g.islands.length; i++) {
            const remaining = new Set(world.coconuts[i]);
            g.islands[i].coconuts = this.layout[i].coconuts.filter(c => remaining.has(c.id));
            const chests = new Map((world.chests?.[i] || []).map(chest => [chest.id, chest.opened]));
            g.islands[i].chests = (this.layout[i].chests || []).map(chest => ({
                ...chest, opened: chests.get(chest.id) ?? chest.opened
            }));
        }
        g.blood = world.blood;
        if (this.worldSamples.length === 1) {
            g.time = world.time;
            g.sharks = world.sharks; g.pirateShip = world.pirateShip;
            g.projectiles = world.projectiles; g.cannonballs = world.cannonballs;
        }
    }

    advance() {
        if (!this.ready || !this.worldSamples.length) return;
        const now = performance.now(), target = now - 75;
        let a = this.worldSamples[0], b = a;
        for (const sample of this.worldSamples) {
            b = sample;
            if (sample.at >= target) break;
            a = sample;
        }
        const t = b.at === a.at ? 1 : Math.max(0, Math.min(1, (target - a.at) / (b.at - a.at)));
        const interpolate = (first, last) => {
            if (!first || first.state !== last.state) return { ...last };
            const angle = Math.atan2(Math.sin((last.angle || 0) - (first.angle || 0)), Math.cos((last.angle || 0) - (first.angle || 0)));
            return { ...last, x: first.x + (last.x - first.x) * t, y: first.y + (last.y - first.y) * t,
                angle: (first.angle || 0) + angle * t,
                ...(Number.isFinite(last.timer) ? { timer: first.timer + (last.timer - first.timer) * t } : {}) };
        };
        const entities = (first, last) => {
            const byId = new Map(first.map(item => [item.id, item]));
            return last.map(item => interpolate(byId.get(item.id), item));
        };
        const g = this.game;
        g.sharks = entities(a.sharks, b.sharks);
        g.pirateShip = interpolate(a.pirateShip, b.pirateShip);
        g.projectiles = entities(a.projectiles, b.projectiles);
        g.cannonballs = entities(a.cannonballs, b.cannonballs);
        g.time = a.time + (b.time - a.time) * t;
        this.worldTime = this.worldSamples.at(-1).time;
    }

    updateStatus() {
        this.status.textContent = `${this.peers.size + 1} RIDERS · ${this.rtt === null ? '…' : this.rtt + ' MS RTT'} · ${this.room.toUpperCase()}`;
    }

    syncLobby() {
        this.waitingPanel.hidden = !this.ready || this.playing;
        this.startButton.hidden = this.id !== this.hostId;
        this.startButton.disabled = !this.ready || this.starting;
        this.startButton.textContent = this.starting ? 'Starting…' : 'Start Game';
        const count = document.getElementById('waitingPlayers');
        const text = `${this.peers.size + 1} ${(this.peers.size + 1) === 1 ? 'rider' : 'riders'} connected`;
        if (count.textContent !== text) count.textContent = text;
        document.getElementById('waitingMessage').textContent = this.id === this.hostId ?
            'Start when everyone has joined. Players will spawn across the ocean.' : 'Waiting for the host to start the game.';
        document.getElementById('minimapLegend').hidden = !this.playing;
    }

    minimapPlayers() {
        const now = performance.now();
        return [...this.peers].filter(([, peer]) => !peer.state.dead)
            .map(([id, peer]) => ({ id, ...this.position(peer, now) }));
    }

    receive(id, state, now) {
        if (id === this.id) return;
        const peer = this.peers.get(id);
        // Keep two samples for a short interpolation buffer; no network wait for local controls.
        const samples = peer?.samples || [];
        samples.push({ ...state, at: now });
        if (samples.length > 8) samples.shift();
        this.peers.set(id, { state, samples });
    }

    position(peer, now) {
        const target = now - 50;
        const samples = peer.samples;
        let a = samples[0], b = a;
        for (const sample of samples) {
            b = sample;
            if (sample.at >= target) break;
            a = sample;
        }
        if (target > b.at) {
            const dt = Math.min((target - b.at) / 1000, 0.1);
            return { ...b, x: Math.max(0, Math.min(6000, b.x + b.vx * dt)),
                y: Math.max(0, Math.min(4000, b.y + b.vy * dt)) };
        }
        const t = b.at === a.at ? 1 : Math.max(0, Math.min(1, (target - a.at) / (b.at - a.at)));
        const angle = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle));
        return { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: a.angle + angle * t };
    }

    draw() {
        const now = performance.now(), g = this.game, ctx = g.ctx;
        for (const [id, peer] of this.peers) {
            if (peer.state.dead) continue;
            const p = this.position(peer, now);
            if (!g.isOnScreen(p)) continue;
            ctx.save();
            ctx.globalAlpha = now - peer.samples.at(-1).at > 2000 ? 0.35 : 0.85;
            // Reuse the boat art without reading or changing local boost state.
            if (!p.onFoot && !p.onPirateShip) g.drawJetSki(p, false);
            g.ellipse(p.x, p.y - 7, 9, 12, '#58f7bd');
            g.ellipse(p.x, p.y - 20, 7, 7, '#f2c4a0');
            ctx.fillStyle = '#8fffd3'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Rider ' + id.slice(0, 4), p.x, p.y - 60);
            ctx.restore();
        }

    }
}
window.OceanMultiplayer = OceanMultiplayer;
