const { Game } = require('../public/scripts/game.js');

// Run the existing game's simulation rules once per room. Rendering and local
// steering stay in the browser; inventory, combat, terrain and ship ownership do not.
const PLAYER_FIELDS = ['health', 'gameOver', 'invulnerable', 'inventory', 'selectedSlot',
    'onFoot', 'onPirateShip', 'parkedBoat', 'walkIsland', 'stowedCannonSlot',
    'boardReadyAt', 'riderStillTime', 'zoneDamageCarry', 'survivalSeconds', 'nextShotAt'];
const visibleEntity = entity => Object.fromEntries(Object.entries(entity).filter(([key]) => !key.startsWith('route')));

class RoomWorld extends Game {
    constructor() {
        super({ headless: true });
        this.players = new Map();
        this.pilotId = null;
        this.tickNumber = 0;
        this.nextEntityId = 1;
        this.layout = structuredClone(this.islands);
        this.activePlayer = null;
    }

    addPlayer(id) {
        const player = {
            id, pose: { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0 }, health: 100,
            gameOver: false, invulnerable: 3, inventory: Array(6).fill(null), selectedSlot: 0,
            onFoot: false, onPirateShip: false, parkedBoat: null, walkIsland: null,
            stowedCannonSlot: null, boardReadyAt: 0, riderStillTime: 0, zoneDamageCarry: 0,
            survivalSeconds: 0, nextShotAt: 0, cause: '', poseRevision: 0, generation: 0,
            controls: { x: 0, y: 0 }, lastInputAt: this.time, lastActionAt: -1
        };
        this.players.set(id, player);
        return player;
    }

    dropInventory(player) {
        for (const item of player.inventory) {
            if (item && !item.type) this.floatingGuns.push({ ...item, ...this.randomWaterPoint(120) });
        }
        // A boarded cannon is a ship fixture, not a pickup; recover its stowed gun.
        const stowed = player.stowedCannonSlot?.item;
        if (stowed && !stowed.type) this.floatingGuns.push({ ...stowed, ...this.randomWaterPoint(120) });
    }

    removePlayer(id) {
        const player = this.players.get(id);
        if (!player) return;
        this.dropInventory(player);
        if (this.pilotId === id) { this.pilotId = null; this.pirateShip.cruiseDirection = null; }
        this.players.delete(id);
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
        return { ...player.pose, onFoot: player.onFoot, onPirateShip: player.onPirateShip,
            boosting: player.boosting === true, dead: player.gameOver };
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
        if (!p || p.gameOver || revision !== p.poseRevision) return p && this.stateFor(p);
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
        return this.stateFor(p);
    }

    action(id, message) {
        const p = this.players.get(id);
        if (!p) return false;
        if (message.action === 'respawn') {
            if (this.time - p.lastActionAt < 0.2) return false;
            const revision = p.poseRevision + 1, generation = p.generation + 1;
            this.removePlayer(id);
            const fresh = this.addPlayer(id);
            fresh.poseRevision = revision; fresh.generation = generation; fresh.lastActionAt = this.time;
            return true;
        }
        if (p.gameOver || !['interact', 'fire'].includes(message.action)) return false;
        if (Number.isInteger(message.slot) && message.slot >= 0 && message.slot < 6) p.selectedSlot = message.slot;
        this.usePlayer(p);
        if (message.action === 'interact') {
            if (this.time - p.lastActionAt < 0.15) return false;
            p.lastActionAt = this.time;
            if (!p.onPirateShip && this.canBoardPirateShip() && this.pilotId) return false;
            const mode = [this.onFoot, this.onPirateShip];
            super.interact();
            if (mode[0] !== this.onFoot || mode[1] !== this.onPirateShip) p.poseRevision++;
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
            super.fireGun();
            for (const shot of this.projectiles.slice(count)) shot.shooter = id;
            for (const ball of this.cannonballs.slice(balls)) ball.shooter = id;
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
            if (p.gameOver || (sharks && p.onPirateShip)) continue;
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
        this.time += dt; this.tickNumber++;
        this.blood = this.blood.filter(pool => (pool.life -= dt) > 0);
        for (const p of this.players.values()) {
            if (p.gameOver) continue;
            p.survivalSeconds += dt;
            p.invulnerable = Math.max(0, p.invulnerable - dt);
            p.riderStillTime = Math.hypot(p.pose.vx, p.pose.vy) < 5 ? p.riderStillTime + dt : 0;
            this.usePlayer(p); this.updateSafeArea(dt); this.savePlayer();
        }
        const sharks = this.sharks;
        for (const shark of sharks) {
            const target = this.nearest(shark, true);
            if (target) this.usePlayer(target);
            else { this.activePlayer = null; this.gameOver = false; this.riderStillTime = 0; }
            shark.targetId = target?.id || null;
            this.sharks = [shark];
            super.updateSharks(dt);
            this.savePlayer();
        }
        this.sharks = sharks;
        const pilot = this.players.get(this.pilotId);
        if (pilot && !pilot.gameOver) {
            this.usePlayer(pilot);
            const controls = this.time - pilot.lastInputAt > 1 ? { x: 0, y: 0 } : pilot.controls;
            if (this.time - pilot.lastInputAt > 1) this.pirateShip.cruiseDirection = null;
            const length = Math.hypot(controls.x, controls.y) || 1;
            this.moveCapturedShip(controls.x / length, controls.y / length, dt); this.savePlayer();
        } else {
            const target = this.nearest(this.pirateShip);
            if (target) this.usePlayer(target);
            else { this.activePlayer = null; this.gameOver = false; }
            this.pirateShip.targetId = target?.id || null;
            super.updatePirateShip(dt);
        }
        super.updateProjectiles(dt);
        this.advanceCannonballs(dt);
        const gunner = this.players.get(this.pilotId) || this.nearest(this.pirateShip);
        if (gunner) this.usePlayer(gunner);
        else this.activePlayer = null;
        this.pirateCannonPose(true);
    }

    advanceCannonballs(dt) {
        for (const ball of this.cannonballs) {
            const travel = Math.min(dt, ball.life);
            const x = ball.x + ball.vx * travel, y = ball.y + ball.vy * travel;
            let nearest = Infinity, hit = null;
            if (ball.owner === 'player') {
                for (const shark of this.sharks) {
                    if (shark.state === 'dead') continue;
                    const t = this.segmentHit(ball.x, ball.y, x, y, shark);
                    if (t !== null && t < nearest) { nearest = t; hit = shark; }
                }
                if (hit) { this.damageShark(hit, hit.maxHealth); ball.life = 0; }
            } else {
                for (const p of this.players.values()) {
                    if (p.gameOver) continue;
                    const t = this.segmentHit(ball.x, ball.y, x, y, { ...p.pose, state: 'chase' });
                    if (t !== null && t < nearest) { nearest = t; hit = p; }
                }
                if (hit) {
                    this.usePlayer(hit); this.health = Math.max(0, this.health - 75);
                    if (!this.health) this.finishRun('Cannonball Attack');
                    this.savePlayer(); ball.life = 0;
                }
            }
            ball.x = x; ball.y = y; ball.life -= dt;
        }
        this.cannonballs = this.cannonballs.filter(ball => ball.life > 0 && ball.x >= -100 && ball.x <= 6100 && ball.y >= -100 && ball.y <= 4100);
    }

    snapshot() {
        for (const entity of [...this.projectiles, ...this.cannonballs]) entity.id ??= this.nextEntityId++;
        return { protocol: 2, tick: this.tickNumber, time: this.time,
            sharks: this.sharks.map(visibleEntity), pirateShip: visibleEntity(this.pirateShip),
            pilotId: this.pilotId, projectiles: this.projectiles, cannonballs: this.cannonballs,
            blood: this.blood, guns: this.floatingGuns,
            coconuts: this.islands.map(island => island.coconuts.map(c => c.id)) };
    }
}

module.exports = { RoomWorld };
