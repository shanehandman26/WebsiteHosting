const { Game } = require('../public/scripts/game.js');
const { clean: cleanUsername } = require('../public/scripts/profile.js');

// Run the existing game's simulation rules once per room. Rendering and local
// steering stay in the browser; inventory, combat, terrain and ship ownership do not.
const PLAYER_FIELDS = ['health', 'gameOver', 'invulnerable', 'inventory', 'selectedSlot',
    'onFoot', 'onPirateShip', 'parkedBoat', 'walkIsland', 'stowedCannonSlot',
    'boardReadyAt', 'riderStillTime', 'zoneDamageCarry', 'survivalSeconds', 'nextShotAt'];
const visibleEntity = entity => Object.fromEntries(Object.entries(entity).filter(([key]) => !key.startsWith('route')));
const SHARK_RENDER_FIELDS = ['id', 'x', 'y', 'vx', 'vy', 'angle', 'state', 'timer', 'health',
    'maxHealth', 'hitUntil', 'splashAge', 'leapDuration', 'targetId', 'respawnAt'];
const renderShark = shark => Object.fromEntries(SHARK_RENDER_FIELDS.filter(key => shark[key] !== undefined)
    .map(key => [key, typeof shark[key] === 'number' ? Math.round(shark[key] * 1000) / 1000 : shark[key]]));

class RoomWorld extends Game {
    constructor() {
        super({ headless: true });
        this.players = new Map();
        this.phase = 'waiting';
        this.hostId = null;
        this.roundNumber = 0;
        this.participants = new Set();
        this.result = null;
        this.pilotId = null;
        this.tickNumber = 0;
        this.nextEntityId = 1;
        this.layout = structuredClone(this.islands);
        this.activePlayer = null;
    }

    addPlayer(id) {
        const player = {
            id, username: 'Rider ' + id.slice(0, 4), pose: { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0 }, health: 100,
            gameOver: false, invulnerable: 3, inventory: Array(6).fill(null), selectedSlot: 0,
            onFoot: false, onPirateShip: false, parkedBoat: null, walkIsland: null,
            stowedCannonSlot: null, boardReadyAt: 0, riderStillTime: 0, zoneDamageCarry: 0,
            survivalSeconds: 0, nextShotAt: 0, cause: '', poseRevision: 0, generation: 0,
            controls: { x: 0, y: 0 }, motionSeq: 0, lastInputAt: this.time, lastActionAt: -1
        };
        player.spectator = this.phase !== 'waiting';
        if (player.spectator) { player.gameOver = true; player.health = 0; player.cause = 'Spectating'; }
        this.players.set(id, player);
        if (!this.hostId) this.hostId = id;
        return player;
    }

    setUsername(id, value) {
        const p = this.players.get(id);
        if (!p || p.profileSet) return false;
        p.username = cleanUsername(value) || p.username;
        p.profileSet = true;
        return true;
    }

    spawnPosition(excludeId, occupied = null) {
        const positions = occupied || [...this.players.values()]
            .filter(p => p.id !== excludeId && !p.gameOver).map(p => p.pose);
        // Stay inside even the final safe area, with room for the entire jet ski.
        const candidates = [];
        for (let y = 800; y <= 3200; y += 160) {
            for (let x = 720; x <= 5280; x += 160) {
                if (this.pointOnLand(x, y, this.boatRadius + 40) ||
                    Math.hypot(x - this.pirateShip.x, y - this.pirateShip.y) < 280 ||
                    this.sharks.some(s => s.state !== 'dead' && Math.hypot(x - s.x, y - s.y) < 220)) continue;
                candidates.push({ x, y });
            }
        }
        // Terrain generation always leaves central open water; retain a safe fallback.
        if (!candidates.length) candidates.push(this.randomWaterPoint(120));
        if (!positions.length) return candidates[Math.floor(Math.random() * candidates.length)];
        let best = candidates[0], bestDistance = -1;
        for (const point of candidates) {
            const distance = Math.min(...positions.map(p => Math.hypot(point.x - p.x, point.y - p.y)));
            if (distance > bestDistance) { best = point; bestDistance = distance; }
        }
        return best;
    }

    start(id) {
        if (this.phase !== 'waiting' || id !== this.hostId || this.players.size < 2) return false;
        const occupied = [];
        for (const player of this.players.values()) {
            Object.assign(player.pose, this.spawnPosition(player.id, occupied), { vx: 0, vy: 0, angle: 0 });
            occupied.push(player.pose);
            player.poseRevision++; player.generation++;
            player.controls = { x: 0, y: 0 };
        }
        this.phase = 'running';
        this.roundNumber++;
        this.participants = new Set(this.players.keys());
        this.result = null;
        return true;
    }

    alive(player) { return !!player && !player.gameOver && !player.spectator && player.health > 0; }

    checkWinner() {
        if (this.phase !== 'running' || this.participants.size < 2) return;
        const survivors = [...this.participants].map(id => this.players.get(id)).filter(p => this.alive(p));
        if (survivors.length > 1) return;
        const winner = survivors[0];
        this.result = { winnerId: winner?.id || null,
            winnerLabel: winner?.username || null, round: this.roundNumber };
        this.phase = 'finished';
        for (const p of this.players.values()) p.controls = { x: 0, y: 0 };
    }

    nextRound(id) {
        if (this.phase !== 'finished' || id !== this.hostId || this.players.size < 2) return false;
        const previous = [...this.players.values()];
        const hostId = this.hostId;
        this.islands = structuredClone(this.layout);
        this.navigation = this.pirateNavigation = null;
        this.time = 0; this.tickNumber = 0;
        this.projectiles = []; this.cannonballs = []; this.blood = [];
        this.loot = []; this.fireworkBursts = [];
        this.nextGunId = 7;
        this.sharks = this.createSharks();
        this.floatingGuns = this.createGuns();
        this.rider = { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0 };
        this.pirateShip = this.createPirateShip();
        this.pilotId = null; this.activePlayer = null;
        this.phase = 'waiting';
        this.players.clear();
        for (const old of previous) {
            const p = this.addPlayer(old.id);
            p.username = old.username; p.profileSet = old.profileSet;
            p.generation = old.generation; p.poseRevision = old.poseRevision;
        }
        this.hostId = hostId;
        return this.start(id);
    }

    dropInventory(player) {
        for (const item of player.inventory) {
            if (item && !item.type) this.floatingGuns.push({ ...item, ...this.randomWaterPoint(120) });
        }
        // A boarded cannon is a ship fixture, not a pickup; recover its stowed gun.
        const stowed = player.stowedCannonSlot?.item;
        if (stowed && !stowed.type) this.floatingGuns.push({ ...stowed, ...this.randomWaterPoint(120) });
    }

    removePlayer(id, preserveHost = false) {
        const player = this.players.get(id);
        if (!player) return;
        this.dropInventory(player);
        if (this.pilotId === id) { this.pilotId = null; this.pirateShip.cruiseDirection = null; }
        this.players.delete(id);
        if (!preserveHost && this.hostId === id) this.hostId = this.players.keys().next().value || null;
        this.checkWinner();
    }

    usePlayer(player) {
        this.activePlayer = player;
        this.rider = player.pose;
        for (const key of PLAYER_FIELDS) this[key] = player[key];
        this.updateCamera();
    }

    savePlayer() {
        if (!this.activePlayer) return;
        for (const key of PLAYER_FIELDS) this.activePlayer[key] = this[key];
        if (this.gameOver && this.pilotId === this.activePlayer.id) {
            this.pilotId = null; this.pirateShip.cruiseDirection = null;
        }
    }

    stateFor(player) {
        return { ...player.pose, motionSeq: player.motionSeq, username: player.username, onFoot: player.onFoot, onPirateShip: player.onPirateShip,
            boosting: player.boosting === true, dead: player.gameOver, spectator: player.spectator };
    }

    personal(id) {
        const p = this.players.get(id);
        return { ...this.stateFor(p), health: p.health, inventory: p.inventory,
            selectedSlot: p.selectedSlot, invulnerable: p.invulnerable,
            parkedBoat: p.parkedBoat, walkIsland: this.islands.indexOf(p.walkIsland),
            stowedCannonSlot: p.stowedCannonSlot, boardReadyIn: Math.max(0, p.boardReadyAt - this.time),
            cause: p.cause, survivalSeconds: p.survivalSeconds,
            poseRevision: p.poseRevision, generation: p.generation };
    }

    updatePlayer(id, state, revision, selectedSlot, controls) {
        const p = this.players.get(id);
        if (!p || this.phase !== 'running' || !this.alive(p) || revision !== p.poseRevision) return p && this.stateFor(p);
        if (Number.isInteger(selectedSlot) && selectedSlot >= 0 && selectedSlot < 6) p.selectedSlot = selectedSlot;
        p.controls = { x: Number.isFinite(controls?.x) ? Math.max(-1, Math.min(1, controls.x)) : 0,
            y: Number.isFinite(controls?.y) ? Math.max(-1, Math.min(1, controls.y)) : 0 };
        if (Number.isFinite(controls?.aimAngle) && Math.abs(controls.aimAngle) <= 1e6) p.aimAngle = controls.aimAngle;
        if (!p.onPirateShip) {
            const dt = Math.max(1 / 30, this.time - p.lastInputAt);
            const maxTravel = 600 * dt + 100;
            if (Math.hypot(state.x - p.pose.x, state.y - p.pose.y) > maxTravel ||
                (p.onFoot && !this.canWalkAt(state.x, state.y, p.walkIsland))) {
                p.poseRevision++;
                return this.stateFor(p);
            }
            Object.assign(p.pose, { x: state.x, y: state.y, vx: state.vx, vy: state.vy, angle: state.angle });
            if (!p.onFoot && this.pointOnLand(state.x, state.y, this.boatRadius)) {
                this.usePlayer(p); this.checkIslandCollision(); p.poseRevision++;
            }
        }
        p.boosting = state.boosting;
        p.lastInputAt = this.time;
        p.motionSeq++;
        return this.stateFor(p);
    }

    action(id, message) {
        const p = this.players.get(id);
        if (!p) return false;
        if (message.action === 'start') return this.start(id);
        if (message.action === 'next_round') return this.nextRound(id);
        if (this.phase !== 'running') return false;
        if (message.action === 'respawn') return false;
        if (!this.alive(p) || !['interact', 'fire', 'open_chest'].includes(message.action)) return false;
        if (Number.isInteger(message.slot) && message.slot >= 0 && message.slot < 6) p.selectedSlot = message.slot;
        this.usePlayer(p);
        if (message.action === 'open_chest') {
            if (this.time - p.lastActionAt < 0.15) return false;
            p.lastActionAt = this.time;
            const opened = super.openChest();
            this.savePlayer();
            return opened;
        }
        if (message.action === 'interact') {
            if (this.time - p.lastActionAt < 0.15) return false;
            p.lastActionAt = this.time;
            if (!p.onPirateShip && this.canBoardPirateShip() && this.pilotId) return false;
            const mode = [this.onFoot, this.onPirateShip];
            super.interact();
            if (mode[0] !== this.onFoot || mode[1] !== this.onPirateShip) { p.poseRevision++; p.motionSeq++; }
            if (this.onPirateShip) { this.pilotId = id; p.aimAngle ??= this.pirateShip.angle; }
            else if (this.pilotId === id) this.pilotId = null;
        } else {
            if (!Number.isFinite(message.angle) || Math.abs(message.angle) > 1e6) return false;
            this.actionAngle = message.angle;
            p.aimAngle = message.angle;
            this.aim = { active: true,
                u: (this.rider.x + Math.cos(message.angle) * 1000 - this.camera.x) / this.canvas.width,
                v: (this.rider.y + Math.sin(message.angle) * 1000 - this.camera.y) / this.canvas.height };
            const count = this.projectiles.length, balls = this.cannonballs.length;
            const fired = super.fireGun();
            const clientShotId = Number.isInteger(message.shotId) && message.shotId > 0 && message.shotId < 1e9 ? message.shotId : undefined;
            for (const shot of this.projectiles.slice(count)) { shot.shooter = id; shot.clientShotId = clientShotId; }
            for (const ball of this.cannonballs.slice(balls)) { ball.shooter = id; ball.clientShotId = clientShotId; }
            this.savePlayer();
            return fired === true;
        }
        this.savePlayer();
        return true;
    }

    aimAngle() { return this.actionAngle || 0; }
    pirateCannonPose(ignoreFlash = false) {
        const pose = super.pirateCannonPose(ignoreFlash);
        if (this.onPirateShip && this.activePlayer?.id === this.pilotId && Number.isFinite(this.activePlayer.aimAngle)) {
            pose.angle = this.activePlayer.aimAngle;
            pose.muzzleX = pose.x + Math.cos(pose.angle) * 44;
            pose.muzzleY = pose.y + Math.sin(pose.angle) * 44;
        }
        this.pirateShip.aimAngle = pose.angle;
        return pose;
    }
    finishRun(cause) { this.gameOver = true; if (this.activePlayer) this.activePlayer.cause = cause; }
    updateHealthDisplay() {}
    updateInventory() {}
    updatePickupPrompt() {}
    updateSpeedDisplay() {}
    updateBoostDisplay() {}

    nearest(entity, sharks = false) {
        let result = null, distance = Infinity;
        for (const p of this.players.values()) {
            if (!this.alive(p) || (sharks && p.onPirateShip)) continue;
            const d = Math.hypot(p.pose.x - entity.x, p.pose.y - entity.y);
            if (d < distance) { result = p; distance = d; }
        }
        return result;
    }

    canPursue(shark) {
        if (!this.activePlayer || this.activePlayer.gameOver || this.onPirateShip || shark.state === 'dead') return false;
        const distance = Math.hypot(shark.x - this.rider.x, shark.y - this.rider.y);
        return distance <= 900 || (distance <= this.bloodAttractionRadius && this.blood.some(pool => pool.life > 0));
    }

    pirateOnScreen() {
        return !!this.activePlayer && !this.activePlayer.gameOver &&
            Math.hypot(this.pirateShip.x - this.rider.x, this.pirateShip.y - this.rider.y) <= 1200;
    }

    safeAreaBounds() {
        const elapsed = this.survivalSeconds;
        this.survivalSeconds = this.time;
        const area = super.safeAreaBounds();
        this.survivalSeconds = elapsed;
        return area;
    }

    stepWorld(dt) {
        if (this.phase !== 'running') return;
        this.time += dt; this.tickNumber++;
        this.blood = this.blood.filter(pool => (pool.life -= dt) > 0);
        for (const p of this.players.values()) {
            if (!this.alive(p)) continue;
            p.survivalSeconds += dt;
            p.invulnerable = Math.max(0, p.invulnerable - dt);
            p.riderStillTime = Math.hypot(p.pose.vx, p.pose.vy) < 5 ? p.riderStillTime + dt : 0;
            this.usePlayer(p); this.updateSafeArea(dt); this.savePlayer();
        }
        const sharks = this.sharks;
        for (const shark of sharks) {
            const oldX = shark.x, oldY = shark.y;
            const target = this.nearest(shark, true);
            if (target) this.usePlayer(target);
            else { this.activePlayer = null; this.gameOver = false; this.riderStillTime = 0; }
            shark.targetId = target?.id || null;
            this.sharks = [shark];
            super.updateSharks(dt);
            const speed = Math.hypot(shark.x - oldX, shark.y - oldY) / dt;
            shark.vx = speed <= this.sharkSpeed * 1.2 ? (shark.x - oldX) / dt : 0;
            shark.vy = speed <= this.sharkSpeed * 1.2 ? (shark.y - oldY) / dt : 0;
            this.savePlayer();
        }
        this.sharks = sharks;
        const shipX = this.pirateShip.x, shipY = this.pirateShip.y;
        const pilot = this.players.get(this.pilotId);
        if (pilot && !pilot.gameOver) {
            this.usePlayer(pilot);
            const controls = this.time - pilot.lastInputAt > 1 ? { x: 0, y: 0 } : pilot.controls;
            if (this.time - pilot.lastInputAt > 1) this.pirateShip.cruiseDirection = null;
            const length = Math.hypot(controls.x, controls.y) || 1;
            this.moveCapturedShip(controls.x / length, controls.y / length, dt); this.savePlayer();
            pilot.motionSeq++;
        } else {
            const target = this.nearest(this.pirateShip);
            if (target) this.usePlayer(target);
            else { this.activePlayer = null; this.gameOver = false; }
            this.pirateShip.targetId = target?.id || null;
            super.updatePirateShip(dt);
        }
        this.pirateShip.vx = (this.pirateShip.x - shipX) / dt;
        this.pirateShip.vy = (this.pirateShip.y - shipY) / dt;
        this.updateProjectiles(dt);
        this.advanceCannonballs(dt);
        const gunner = this.players.get(this.pilotId) || this.nearest(this.pirateShip);
        if (gunner) this.usePlayer(gunner);
        else this.activePlayer = null;
        this.pirateCannonPose(true);
        this.checkWinner();
    }

    firstPlayerHit(shot, x, y) {
        let hit = null;
        for (const p of this.players.values()) {
            if (!this.alive(p) || p.id === shot.shooter || shot.hitTargets?.includes('player-' + p.id)) continue;
            const t = this.segmentHit(shot.x, shot.y, x, y, { ...p.pose, state: 'player' });
            if (t !== null && (!hit || t < hit.t)) hit = { player: p, t };
        }
        return hit;
    }

    damagePlayer(player, damage, cause, shooter) {
        if (!this.alive(player)) return;
        this.usePlayer(player);
        this.health = Math.max(0, this.health - damage);
        this.blood.push({ x: player.pose.x, y: player.pose.y, life: this.bloodLifetime });
        if (!this.health) this.finishRun(shooter ? cause + ' by ' + (this.players.get(shooter)?.username || 'Rider ' + shooter.slice(0, 4)) : cause);
        this.savePlayer();
        if (player.gameOver) { player.pose.vx = player.pose.vy = 0; player.controls = { x: 0, y: 0 }; }
    }

    updateProjectiles(dt) {
        this.fireworkBursts = this.fireworkBursts.filter(burst => this.time - burst.startedAt < burst.duration);
        for (const shot of this.projectiles) {
            if (shot.type === 'firecracker') { this.updateFirecracker(shot, dt); continue; }
            const travel = Math.min(dt, shot.life), x = shot.x + shot.vx * travel, y = shot.y + shot.vy * travel;
            let nearest = Infinity, hit = null, kind = '';
            for (const shark of this.sharks) {
                if (shark.state === 'dead') continue;
                const t = this.segmentHit(shot.x, shot.y, x, y, shark);
                if (t !== null && t < nearest) { nearest = t; hit = shark; kind = 'shark'; }
            }
            const shipHit = this.pirateShip.disarmed ? null : this.pirateHullHit(shot.x, shot.y, x, y);
            if (shipHit !== null && shipHit < nearest) { nearest = shipHit; hit = this.pirateShip; kind = 'ship'; }
            const playerHit = this.firstPlayerHit(shot, x, y);
            if (playerHit && playerHit.t < nearest) { hit = playerHit.player; kind = 'player'; }
            if (hit) {
                if (kind === 'player') this.damagePlayer(hit, 25, 'Spear hit', shot.shooter);
                else if (kind === 'ship') this.damagePirateShip();
                else this.damageShark(hit);
                shot.life = 0;
            } else { shot.x = x; shot.y = y; shot.life -= dt; }
        }
        this.projectiles = this.projectiles.filter(s => s.life > 0 && s.x >= 0 && s.x <= 6000 && s.y >= 0 && s.y <= 4000);
    }

    firecrackerImpact(shot) {
        super.firecrackerImpact(shot);
        for (const p of this.players.values()) {
            const key = 'player-' + p.id;
            if (!this.alive(p) || p.id === shot.shooter || shot.hitTargets.includes(key) ||
                Math.hypot(p.pose.x - shot.x, p.pose.y - shot.y) > 80) continue;
            shot.hitTargets.push(key);
            this.damagePlayer(p, 25, 'Firecracker hit', shot.shooter);
        }
    }

    updateFirecracker(shot, dt) {
        let remaining = Math.min(dt, shot.life);
        for (let step = 0; step < 6 && remaining > 1e-8 && shot.life > 0; step++) {
            const travel = Math.min(remaining, shot.hopRemaining);
            const x = shot.x + shot.vx * travel, y = shot.y + shot.vy * travel;
            let hit = this.firstPlayerHit(shot, x, y)?.t ?? null;
            for (const shark of this.sharks) {
                if (shark.state === 'dead' || shot.hitTargets.includes('shark-' + shark.id)) continue;
                const t = this.segmentHit(shot.x, shot.y, x, y, shark);
                if (t !== null && (hit === null || t < hit)) hit = t;
            }
            if (!this.pirateShip.disarmed && !shot.hitTargets.includes('pirate')) {
                const t = this.pirateHullHit(shot.x, shot.y, x, y);
                if (t !== null && (hit === null || t < hit)) hit = t;
            }
            const elapsed = travel * (hit ?? 1);
            shot.x += shot.vx * elapsed; shot.y += shot.vy * elapsed;
            shot.life -= elapsed; remaining -= elapsed; shot.hopRemaining -= elapsed;
            if (hit !== null || shot.hopRemaining <= 1e-8) {
                this.firecrackerImpact(shot); shot.impacts++;
                if (shot.impacts >= 3 || this.pointOnLand(shot.x, shot.y)) { shot.life = 0; break; }
                shot.hopRemaining = 0.42;
            }
        }
    }

    advanceCannonballs(dt) {
        for (const ball of this.cannonballs) {
            const travel = Math.min(dt, ball.life), x = ball.x + ball.vx * travel, y = ball.y + ball.vy * travel;
            let nearest = Infinity, hit = null, kind = '';
            if (ball.owner === 'player') {
                for (const shark of this.sharks) {
                    if (shark.state === 'dead') continue;
                    const t = this.segmentHit(ball.x, ball.y, x, y, shark);
                    if (t !== null && t < nearest) { nearest = t; hit = shark; kind = 'shark'; }
                }
            }
            const playerHit = this.firstPlayerHit(ball, x, y);
            if (playerHit && playerHit.t < nearest) { hit = playerHit.player; kind = 'player'; }
            if (hit) {
                if (kind === 'shark') this.damageShark(hit, hit.maxHealth);
                else this.damagePlayer(hit, 75, 'Cannonball hit', ball.shooter);
                ball.life = 0;
            }
            ball.x = x; ball.y = y; ball.life -= dt;
        }
        this.cannonballs = this.cannonballs.filter(b => b.life > 0 && b.x >= -100 && b.x <= 6100 && b.y >= -100 && b.y <= 4100);
    }

    snapshot() {
        for (const entity of [...this.projectiles, ...this.cannonballs]) entity.id ??= this.nextEntityId++;
        return { protocol: 4, phase: this.phase, hostId: this.hostId, round: this.roundNumber, result: this.result,
            aliveCount: [...this.participants].filter(id => this.alive(this.players.get(id))).length, tick: this.tickNumber, time: this.time,
            sharks: this.sharks.map(renderShark), pirateShip: visibleEntity(this.pirateShip),
            pilotId: this.pilotId, projectiles: this.projectiles, cannonballs: this.cannonballs,
            blood: this.blood, guns: this.floatingGuns, loot: this.loot, fireworkBursts: this.fireworkBursts,
            coconuts: this.islands.map(island => island.coconuts.map(c => c.id)),
            chests: this.islands.map(island => (island.chests || []).map(({ id, opened }) => ({ id, opened }))) };
    }
}

module.exports = { RoomWorld };
