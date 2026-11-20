/* Movement and cosmetic shot relay. World AI and damage remain local. */
class OceanMultiplayer {
    constructor(game) {
        this.game = game;
        this.peers = new Map();
        this.shots = [];
        const params = new URLSearchParams(location.search);
        this.hosting = params.get('action') === 'host';
        this.room = (params.get('room') || '').trim().toUpperCase();
        this.status = document.getElementById('networkStatus');
        this.roomCodeHud = document.getElementById('roomCodeHud');
        this.roomCode = document.getElementById('roomCode');
        this.feedback = document.getElementById('roomFeedback');
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
                for (const p of msg.players) this.receive(p.id, p.state, now);
            } else if (msg.type === 'room_error') {
                this.failRoom(msg.message || 'Unable to join this room.');
                return;
            } else if (msg.type === 'state') this.receive(msg.id, msg.state, now);
            else if (msg.type === 'leave') this.peers.delete(msg.id);
            else if (msg.type === 'pong') {
                this.rtt = Math.round(now - msg.at);
                this.lastPong = now;
            } else if (msg.type === 'shot') {
                const speed = msg.cannon ? 320 : 1100;
                this.shots.push({ x: msg.x, y: msg.y, vx: Math.cos(msg.angle) * speed,
                    vy: Math.sin(msg.angle) * speed, at: now, life: msg.cannon ? 3000 : 1200, cannon: msg.cannon });
                if (this.shots.length > 128) this.shots.shift();
            }
            this.updateStatus();
        });
        socket.addEventListener('error', () => socket.close());
        socket.addEventListener('close', () => {
            clearTimeout(timeout);
            this.peers.clear(); this.shots = []; this.rtt = null;
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
        this.socket?.close();
    }

    send(message) {
        if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 8192) return;
        this.socket.send(JSON.stringify(message));
    }

    tick() {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        const now = performance.now();
        if (now - this.lastPong > 12000) { this.socket.close(); return; }
        const g = this.game;
        this.send({ type: 'state', state: { ...g.rider, onFoot: g.onFoot,
            onPirateShip: g.onPirateShip, boosting: g.boosting, dead: g.gameOver } });
        if (now >= this.nextPing) {
            this.send({ type: 'ping', at: now });
            this.nextPing = now + 2000;
        }
    }

    shot(angle, cannon = false) {
        this.tick(); // Publish the firing position before the action.
        this.send({ type: 'shot', angle, cannon });
    }

    updateStatus() {
        this.status.textContent = `${this.peers.size + 1} RIDERS · ${this.rtt === null ? '…' : this.rtt + ' MS RTT'} · ${this.room.toUpperCase()}`;
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
        this.shots = this.shots.filter(s => now - s.at < s.life);
        for (const s of this.shots) {
            const dt = (now - s.at) / 1000;
            const x = s.x + s.vx * dt, y = s.y + s.vy * dt;
            if (g.isOnScreen({ x, y })) g.ellipse(x, y, s.cannon ? 9 : 4, s.cannon ? 9 : 4, '#8fffd3');
        }
    }
}
window.OceanMultiplayer = OceanMultiplayer;
