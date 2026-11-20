class Game {
    constructor(options = {}) {
        if (options.headless) {
            this.initializeSimulation();
            return;
        }
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.speedDisplay = document.getElementById('speed');
        this.boostBar = document.getElementById('boostBar');
        this.boostAmount = document.getElementById('boostAmount');
        this.boostStatus = document.getElementById('boostStatus');
        this.healthBar = document.getElementById('healthBar');
        this.healthAmount = document.getElementById('healthAmount');
        this.gameOverPanel = document.getElementById('gameOver');
        this.deathCause = document.getElementById('deathCause');
        this.gameOverTime = document.getElementById('gameOverTime');
        this.minimapCanvas = document.getElementById('minimapCanvas');
        this.minimapContext = this.minimapCanvas.getContext('2d');
        this.survivalHud = document.getElementById('survivalHud');
        this.survivalTimeDisplay = document.getElementById('survivalTime');
        this.bestSurvivalDisplay = document.getElementById('bestSurvival');
        const multiplayerParams = new URLSearchParams(window.location?.search || '');
        this.isSingleplayer = !multiplayerParams.has('room') && multiplayerParams.get('action') !== 'host';
        this.survivalSeconds = 0;
        this.zoneDamageCarry = 0;
        this.bestSurvivalSeconds = 0;
        if (this.isSingleplayer) {
            try {
                const saved = Number(window.localStorage?.getItem('ocean-rush-best-survival'));
                if (Number.isFinite(saved) && saved >= 0) this.bestSurvivalSeconds = Math.floor(saved);
            } catch { /* Storage may be unavailable; the timer still works for this session. */ }
        }
        this.survivalHud.hidden = !this.isSingleplayer;
        this.oceanScreen = document.getElementById('oceanScreen');
        this.fullscreenButton = document.getElementById('fullscreenButton');
        this.fullscreenFallback = false;
        this.keys = new Set();
        this.touchDirections = new Set();
        this.maxSpeed = 280;
        this.boostSpeed = 560;
        this.boost = 100;
        this.boostDrain = 25;
        this.boostRefill = 15;
        this.boosting = false;
        this.world = { width: 6000, height: 4000 };
        this.territories = { columns: 5, rows: 2 };
        this.riderStillTime = 0;
        this.inventory = Array(6).fill(null);
        this.selectedSlot = 0;
        this.gunMaxDurability = 12;
        this.nextGunId = 7;
        this.inventorySlots = Array.from({ length: 6 }, (_, index) => document.getElementById('inventorySlot' + (index + 1)));
        this.inventoryLabels = Array.from({ length: 6 }, (_, index) => document.getElementById('inventoryItem' + (index + 1)));
        this.durabilityBars = Array.from({ length: 6 }, (_, index) => document.getElementById('inventoryDurability' + (index + 1)));
        this.inventoryCount = document.getElementById('inventoryCount');
        this.pickupPrompt = document.getElementById('pickupPrompt');
        this.islandCollision = null;
        this.boatRadius = 32;
        this.floatingGuns = this.createGuns();
        this.projectiles = [];
        this.nextShotAt = 0;
        this.muzzleFlash = null;
        this.aim = { u: 0.5, v: 0.3, active: false };
        this.camera = { x: 0, y: 0 };
        this.margin = 60;
        this.pixelsPerMeter = 14.4;
        this.rider = { x: this.world.width / 2, y: this.world.height / 2, vx: 0, vy: 0, angle: 0 };
        this.onFoot = false;
        this.onPirateShip = false;
        this.stowedCannonSlot = null;
        this.boardReadyAt = 0;
        this.parkedBoat = null;
        this.walkIsland = null;
        this.sharkClearance = 64;
        this.navigation = null;
        this.nearLightRadius = 300;
        this.headlightRange = 650;
        this.headlightHalfAngle = 0.65;
        this.nightCanvas = document.createElement('canvas');
        this.nightContext = this.nightCanvas.getContext('2d');
        this.sharkSpeed = 30 * 1609.344 / 3600 * this.pixelsPerMeter;
        this.health = 100;
        this.invulnerable = 0;
        this.gameOver = false;
        this.sharks = this.createSharks();
        this.islands = this.createIslands();
        this.fish = this.createFish();
        this.blood = [];
        this.bloodLifetime = 12;
        this.bloodAttractionRadius = 1400;
        this.wake = [];
        this.wakeTimer = 0;
        this.time = 0;
        this.pirateShip = this.createPirateShip();
        this.cannonballs = [];
        this.lastTime = null;
        this.gameStarted = false;
        this.analyticsReady = import('./analytics.js').catch(() => null);

        document.addEventListener('keydown', event => this.handleKey(event, true));
        document.addEventListener('keyup', event => this.handleKey(event, false));
        window.addEventListener('blur', () => this.releaseControls());
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.releaseControls();
        });
        document.getElementById('resetButton').addEventListener('click', () => this.reset());
        document.getElementById('restartButton').addEventListener('click', () => this.reset());
        this.fullscreenButton.addEventListener('click', () => this.toggleFullscreen());
        document.addEventListener('fullscreenchange', () => this.syncFullscreen());
        document.addEventListener('webkitfullscreenchange', () => this.syncFullscreen());
        window.addEventListener('resize', () => this.resizeViewport());
        this.canvas.addEventListener('pointermove', event => this.updateAim(event));
        this.canvas.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.updateAim(event);
            this.fireGun();
        });
        for (const [id, key] of [['moveUp', 'w'], ['moveLeft', 'a'], ['moveDown', 's'], ['moveRight', 'd'], ['boostButton', 'q']]) {
            this.bindTouchButton(id, key);
            this.bindTouchButton('fullscreen-' + id, key);
        }
        this.multiplayer = window.OceanMultiplayer && !this.isSingleplayer ? new window.OceanMultiplayer(this) : null;
        this.updateCamera();
        this.updateBoostDisplay();
        this.updateHealthDisplay();
        this.updateSurvivalDisplay();
        this.updateInventory();
        this.updatePickupPrompt();
        requestAnimationFrame(time => this.frame(time));
    }

    // The server uses the same terrain, navigation, weapon, and enemy rules without a DOM.
    initializeSimulation() {
        Object.assign(this, {
            world: { width: 6000, height: 4000 }, territories: { columns: 5, rows: 2 },
            canvas: { width: 1200, height: 660 }, camera: { x: 2400, y: 1670 },
            rider: { x: 3000, y: 2000, vx: 0, vy: 0, angle: 0 },
            margin: 60, boatRadius: 32, sharkClearance: 64, navigation: null,
            sharkSpeed: 30 * 1609.344 / 3600 * 14.4,
            gunMaxDurability: 12, nextGunId: 7, inventory: Array(6).fill(null), selectedSlot: 0,
            projectiles: [], cannonballs: [], blood: [], bloodLifetime: 12, bloodAttractionRadius: 1400,
            time: 0, survivalSeconds: 0, health: 100, gameOver: false, invulnerable: 0,
            onFoot: false, onPirateShip: false, parkedBoat: null, walkIsland: null,
            boardReadyAt: 0, riderStillTime: 0, zoneDamageCarry: 0,
            boost: 100, boosting: false, nextShotAt: 0,
            aim: { u: 0.5, v: 0.3, active: false }
        });
        this.floatingGuns = this.createGuns();
        this.sharks = this.createSharks();
        this.islands = this.createIslands();
        this.pirateShip = this.createPirateShip();
    }

    handleKey(event, pressed) {
        if (pressed && event.key === 'Escape' && this.fullscreenFallback) {
            this.fullscreenFallback = false;
            this.syncFullscreen();
            return;
        }
        if (this.gameOver) return;
        const key = /^Key[WASDQE]$/.test(event.code) ? event.code.slice(3).toLowerCase() :
            /^(Digit|Numpad)[1-6]$/.test(event.code) ? event.code.slice(-1) : event.key.toLowerCase();
        if (!['w', 'a', 's', 'd', 'q', 'e', '1', '2', '3', '4', '5', '6'].includes(key)) return;
        if (pressed && (event.ctrlKey || event.metaKey || event.altKey ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable)) return;
        event.preventDefault();
        if (/^[1-6]$/.test(key)) {
            if (pressed) {
                this.selectedSlot = Number(key) - 1;
                this.updateInventory();
            }
            return;
        }
        const freshPress = pressed && !this.keys.has(key);
        if (pressed) this.keys.add(key);
        else this.keys.delete(key);
        if (key === 'q' && freshPress) this.beginBoost();
        if (key === 'e' && freshPress && !event.repeat) this.interact();
    }

    createGuns() {
        const guns = [];
        for (let index = 0; index < 6; index++) {
            const position = this.randomGunPosition(guns, index === 0);
            guns.push({ id: 'gun-' + (index + 1), name: 'Spear gun',
                ...position, durability: this.gunMaxDurability });
        }
        return guns;
    }

    randomGunPosition(existing, nearStart = false) {
        const spawn = { x: this.world.width / 2, y: this.world.height / 2 };
        // Keep one random pickup within reach of the starting view; scatter the rest.
        for (let attempt = 0; attempt < 100; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = 180 + Math.random() * 80;
            const point = nearStart ? { x: spawn.x + Math.cos(angle) * radius, y: spawn.y + Math.sin(angle) * radius } :
                { x: 120 + Math.random() * (this.world.width - 240), y: 120 + Math.random() * (this.world.height - 240) };
            if (Math.hypot(point.x - spawn.x, point.y - spawn.y) >= 170 &&
                existing.every(gun => Math.hypot(gun.x - point.x, gun.y - point.y) >= 180) &&
                !this.pointOnLand(point.x, point.y, 90)) return point;
        }
        // Extremely crowded fallback still uses a fresh random map position.
        return this.randomWaterPoint(120);
    }

    updateInventory() {
        for (let index = 0; index < this.inventory.length; index++) {
            const item = this.inventory[index];
            this.inventorySlots[index].classList.toggle('selected', index === this.selectedSlot);
            this.inventorySlots[index].setAttribute('aria-selected', String(index === this.selectedSlot));
            this.inventorySlots[index].setAttribute('aria-label', 'Inventory slot ' + (index + 1) + ': ' + (item ? item.name : 'empty'));
            this.inventoryLabels[index].hidden = !item;
            const cannon = item?.type === 'cannon';
            const coconut = item?.type === 'coconut';
            this.inventoryLabels[index].src = cannon ? 'assets/cannon.svg' : coconut ? 'assets/coconut.svg' : 'assets/spear.svg';
            this.inventoryLabels[index].alt = cannon ? 'Cannon' : coconut ? 'Coconut' : 'Spear';
            this.durabilityBars[index].hidden = !item || cannon || coconut;
            this.durabilityBars[index].value = item && !cannon && !coconut ? item.durability : 0;
            this.durabilityBars[index].setAttribute('aria-valuetext', cannon ? 'Cannon: one shot every 3 seconds' :
                coconut ? 'Coconut' : item ? item.durability + ' of ' + this.gunMaxDurability + ' shots remaining' : 'Empty slot');
        }
        this.inventoryCount.textContent = this.inventory.filter(Boolean).length + ' / 6';
    }

    nearbyGun() {
        let closest = null;
        let distance = 80;
        for (const gun of this.floatingGuns) {
            const separation = Math.hypot(gun.x - this.rider.x, gun.y - this.rider.y);
            if (separation <= distance) {
                closest = gun;
                distance = separation;
            }
        }
        return closest;
    }

    nearbyCoconut() {
        if (!this.onFoot || !this.walkIsland || !this.canWalkAt(this.rider.x, this.rider.y)) return null;
        let closest = null, distance = 48;
        for (const coconut of this.walkIsland.coconuts || []) {
            const separation = Math.hypot(this.walkIsland.x + coconut.x - this.rider.x,
                this.walkIsland.y + coconut.y - this.rider.y);
            if (separation <= distance) { closest = coconut; distance = separation; }
        }
        return closest;
    }

    pickUpCoconut() {
        if (this.gameOver) return false;
        const coconut = this.nearbyCoconut();
        const slot = this.inventory.indexOf(null);
        if (!coconut || slot < 0) return false;
        this.inventory[slot] = { id: coconut.id, type: 'coconut', name: 'Coconut' };
        this.walkIsland.coconuts = this.walkIsland.coconuts.filter(item => item !== coconut);
        this.selectedSlot = slot;
        this.updateInventory(); this.updatePickupPrompt();
        return true;
    }

    eatCoconut() {
        if (this.gameOver || this.inventory[this.selectedSlot]?.type !== 'coconut') return false;
        this.health = Math.min(100, this.health + 12);
        this.inventory[this.selectedSlot] = null;
        this.updateHealthDisplay(); this.updateInventory(); this.updatePickupPrompt();
        return true;
    }

    updatePickupPrompt() {
        if (this.gameOver) { this.pickupPrompt.hidden = true; return; }
        if (this.inventory[this.selectedSlot]?.type === 'coconut') {
            this.pickupPrompt.hidden = false;
            this.pickupPrompt.textContent = 'E · EAT COCONUT';
            return;
        }
        if (this.onPirateShip || this.canBoardPirateShip()) {
            this.pickupPrompt.hidden = false;
            this.pickupPrompt.textContent = this.onPirateShip ? 'E · RETURN TO JET SKI' : 'E · BOARD PIRATE SHIP';
            return;
        }
        const coconut = this.nearbyCoconut();
        if (coconut && this.inventory.includes(null)) {
            this.pickupPrompt.hidden = false;
            this.pickupPrompt.textContent = 'E · PICK UP COCONUT';
            return;
        }
        if (this.onFoot && this.canBoardBoat()) {
            this.pickupPrompt.hidden = false;
            this.pickupPrompt.textContent = 'E · BOARD JET SKI';
            return;
        }
        if (coconut) {
            this.pickupPrompt.hidden = false;
            this.pickupPrompt.textContent = 'INVENTORY FULL';
            return;
        }
        if (!this.onFoot && !(this.nearbyGun() && this.inventory.includes(null)) && this.landingSpot()) {
            this.pickupPrompt.hidden = false;
            this.pickupPrompt.textContent = 'E · GET ON ISLAND';
            return;
        }
        this.pickupPrompt.hidden = this.gameOver || !!this.islandCollision || !this.nearbyGun();
        this.pickupPrompt.textContent = this.inventory.includes(null) ? 'E · PICK UP SPEAR GUN' : 'INVENTORY FULL';
    }

    canWalkAt(x, y, island = this.walkIsland) {
        if (!island) return false;
        const shore = this.islandContact(x, y, island);
        return shore !== null && Math.hypot(x - shore.x, y - shore.y) >= 18;
    }

    landingSpot() {
        let closest = null;
        let distance = 100;
        for (const island of this.islands) {
            const shore = this.islandContact(this.rider.x, this.rider.y, island, 100);
            if (!shore) continue;
            const separation = Math.hypot(this.rider.x - shore.x, this.rider.y - shore.y);
            if (separation > distance) continue;
            for (const inset of [24, 36, 48, 60]) {
                const x = shore.x - shore.nx * inset;
                const y = shore.y - shore.ny * inset;
                if (this.canWalkAt(x, y, island)) {
                    closest = { island, x, y }; distance = separation; break;
                }
            }
        }
        return closest;
    }

    canBoardBoat() {
        return this.onFoot && this.parkedBoat &&
            Math.hypot(this.rider.x - this.parkedBoat.x, this.rider.y - this.parkedBoat.y) <= 100;
    }

    interact() {
        if (this.multiplayer) return this.multiplayer.action('interact');
        if (this.gameOver) return;
        if (this.eatCoconut()) return;
        if (this.onPirateShip) {
            const saved = this.stowedCannonSlot;
            this.inventory[saved.slot] = saved.item;
            this.selectedSlot = saved.previousSelection;
            this.stowedCannonSlot = null;
            Object.assign(this.rider, this.parkedBoat, { vx: 0, vy: 0 });
            this.onPirateShip = false; this.parkedBoat = null;
            this.pirateShip.cruiseDirection = null;
            this.boardReadyAt = this.time + 2;
            this.updateInventory();
        } else if (this.canBoardPirateShip()) {
            let slot = this.inventory.indexOf(null);
            if (slot < 0) slot = this.selectedSlot;
            this.stowedCannonSlot = { slot, item: this.inventory[slot], previousSelection: this.selectedSlot };
            this.inventory[slot] = { id: 'ship-cannon', type: 'cannon', name: 'Cannon' };
            this.selectedSlot = slot;
            this.parkedBoat = { x: this.rider.x, y: this.rider.y, angle: this.rider.angle };
            this.onPirateShip = true;
            this.islandCollision = null;
            this.syncPirateRider();
            this.updateInventory();
        } else if (this.onFoot) {
            if (this.nearbyCoconut() && this.inventory.includes(null)) {
                this.pickUpCoconut();
            } else if (this.canBoardBoat()) {
                Object.assign(this.rider, this.parkedBoat, { vx: 0, vy: 0 });
                this.onFoot = false; this.parkedBoat = null; this.walkIsland = null;
                this.boardReadyAt = this.time + 2;
            } else this.pickUpGun();
        } else if (this.nearbyGun() && this.inventory.includes(null)) {
            this.pickUpGun();
        } else {
            const landing = this.landingSpot();
            if (!landing) return;
            this.parkedBoat = { x: this.rider.x, y: this.rider.y, angle: this.rider.angle };
            this.walkIsland = landing.island;
            this.onFoot = true;
            this.islandCollision = null;
            Object.assign(this.rider, { x: landing.x, y: landing.y, vx: 0, vy: 0 });
        }
        this.boosting = false;
        this.updateCamera(); this.updateSpeedDisplay(); this.updateBoostDisplay(); this.updatePickupPrompt();
    }

    canBoardPirateShip() {
        if (this.multiplayer?.pilotId && this.multiplayer.pilotId !== this.multiplayer.id) return false;
        if (this.onFoot || this.onPirateShip || !this.pirateShip.disarmed) return false;
        const ship = this.pirateShip;
        const dx = this.rider.x - ship.x, dy = this.rider.y - ship.y;
        const x = dx * Math.cos(ship.angle) + dy * Math.sin(ship.angle);
        const y = -dx * Math.sin(ship.angle) + dy * Math.cos(ship.angle);
        return (x / 235) ** 2 + (y / 115) ** 2 <= 1;
    }

    syncPirateRider(vx = 0, vy = 0) {
        const ship = this.pirateShip;
        Object.assign(this.rider, { x: ship.x, y: ship.y, vx, vy, angle: ship.angle + Math.PI / 2 });
        // Tow alongside in open water, or behind the ship in a narrow channel.
        for (const [along, across] of [[0, 100], [-225, 0], [0, -100], [225, 0]]) {
            const x = ship.x + Math.cos(ship.angle) * along - Math.sin(ship.angle) * across;
            const y = ship.y + Math.sin(ship.angle) * along + Math.cos(ship.angle) * across;
            if (x >= this.margin && x <= this.world.width - this.margin &&
                y >= this.margin && y <= this.world.height - this.margin && !this.pointOnLand(x, y, this.boatRadius)) {
                this.parkedBoat = { x, y, angle: ship.angle + Math.PI / 2 };
                break;
            }
        }
    }

    moveCapturedShip(dx, dy, dt) {
        const ship = this.pirateShip;
        if (dt <= 0) { this.syncPirateRider(); return; }
        if (dx || dy) ship.cruiseDirection = { x: dx, y: dy };
        else if (ship.cruiseDirection) {
            dx = ship.cruiseDirection.x; dy = ship.cruiseDirection.y;
        }
        const x = ship.x, y = ship.y;
        this.movePirateHull(x + dx * 95 * dt, y + dy * 95 * dt,
            dx || dy ? Math.atan2(dy, dx) : ship.angle, dt);
        this.syncPirateRider((ship.x - x) / dt, (ship.y - y) / dt);
    }

    walkOnIsland(dx, dy, dt) {
        const rider = this.rider;
        rider.vx = dx * 90; rider.vy = dy * 90;
        const x = rider.x + rider.vx * dt;
        const y = rider.y + rider.vy * dt;
        if (this.canWalkAt(x, y)) { rider.x = x; rider.y = y; }
        else {
            if (this.canWalkAt(x, rider.y)) rider.x = x; else rider.vx = 0;
            if (this.canWalkAt(rider.x, y)) rider.y = y; else rider.vy = 0;
        }
    }

    pickUpGun() {
        if (this.gameOver) return;
        const gun = this.nearbyGun();
        const slot = this.inventory.indexOf(null);
        if (!gun || slot === -1) return;
        this.inventory[slot] = { id: gun.id, name: gun.name, durability: gun.durability };
        this.floatingGuns = this.floatingGuns.filter(item => item !== gun);
        this.selectedSlot = slot;
        this.updateInventory();
        this.updatePickupPrompt();
    }

    updateAim(event) {
        const bounds = this.canvas.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        // Normalized canvas coordinates keep trackpad aim correct after resizing/fullscreen.
        this.aim.u = (event.clientX - bounds.left) / bounds.width;
        this.aim.v = (event.clientY - bounds.top) / bounds.height;
        this.aim.active = true;
    }

    aimAngle() {
        if (!this.aim.active) return this.rider.angle - Math.PI / 2;
        return Math.atan2(this.camera.y + this.aim.v * this.canvas.height - this.rider.y,
            this.camera.x + this.aim.u * this.canvas.width - this.rider.x);
    }

    fireGun() {
        if (this.multiplayer) return this.multiplayer.fire();
        const gun = this.inventory[this.selectedSlot];
        if (gun?.type === 'cannon') return this.firePlayerCannon();
        if (this.gameOver || !gun || !Number.isInteger(gun.durability) || gun.durability <= 0 || this.time < this.nextShotAt) return false;
        const angle = this.aimAngle();
        this.projectiles.push({
            x: this.rider.x + Math.cos(angle) * 43,
            y: this.rider.y + Math.sin(angle) * 43,
            vx: Math.cos(angle) * 1100, vy: Math.sin(angle) * 1100, life: 1.2
        });
        this.multiplayer?.shot(angle);
        this.nextShotAt = this.time + 0.2;
        this.muzzleFlash = {
            x: this.rider.x + Math.cos(angle) * 48, y: this.rider.y + Math.sin(angle) * 48,
            angle, startedAt: this.time, duration: 0.14
        };
        gun.durability--;
        if (gun.durability === 0) {
            this.inventory[this.selectedSlot] = null;
            this.spawnReplacementGun();
        }
        this.updateInventory();
        this.updatePickupPrompt();
        return true;
    }

    spawnReplacementGun() {
        const id = this.nextGunId++;
        // Replacement is a new world pickup, not a free refill of the broken gun.
        this.floatingGuns.push({
            id: 'gun-' + id, name: 'Spear gun', durability: this.gunMaxDurability,
            ...this.randomGunPosition(this.floatingGuns)
        });
    }

    segmentHit(x, y, endX, endY, shark) {
        const lift = shark.state === 'leap' ? Math.sin(Math.min(1, shark.timer / (shark.leapDuration || 0.65)) * Math.PI) : 0;
        const dx = endX - x;
        const dy = endY - y;
        const fx = x - shark.x;
        const fy = y - (shark.y - lift * 22);
        const radius = 34 * (1 + lift * 0.25);
        const c = fx * fx + fy * fy - radius * radius;
        if (c <= 0) return 0;
        const a = dx * dx + dy * dy;
        if (a === 0) return null;
        const b = 2 * (fx * dx + fy * dy);
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) return null;
        const t = (-b - Math.sqrt(discriminant)) / (2 * a);
        return t >= 0 && t <= 1 ? t : null;
    }

    damageShark(shark, damage = 1) {
        if (shark.state === 'dead') return;
        shark.health = Math.max(0, shark.health - damage);
        this.blood.push({ x: shark.x, y: shark.y, life: this.bloodLifetime, source: 'shark' });
        shark.hitUntil = this.time + 0.12;
        if (shark.health === 0) {
            shark.state = 'dead';
            shark.respawnAt = this.time + 10;
            shark.leapX = shark.leapY = 0;
        }
    }

    updateProjectiles(dt) {
        for (const shot of this.projectiles) {
            const travelTime = Math.min(dt, shot.life);
            const endX = shot.x + shot.vx * travelTime;
            const endY = shot.y + shot.vy * travelTime;
            let hit = null;
            let nearest = Infinity;
            // Sweep the entire travelled segment so fast bullets cannot skip sharks.
            for (const shark of this.sharks) {
                if (shark.state === 'dead') continue;
                const t = this.segmentHit(shot.x, shot.y, endX, endY, shark);
                if (t !== null && t < nearest) { nearest = t; hit = shark; }
            }
            const shipHit = this.pirateShip.disarmed ? null : this.pirateHullHit(shot.x, shot.y, endX, endY);
            if (shipHit !== null && shipHit < nearest) {
                this.damagePirateShip();
                shot.life = 0;
                continue;
            }
            if (hit) {
                this.damageShark(hit);
                shot.life = 0;
                continue;
            }
            shot.x = endX;
            shot.y = endY;
            shot.life -= dt;
        }
        this.projectiles = this.projectiles.filter(shot => shot.life > 0 &&
            shot.x >= 0 && shot.x <= this.world.width && shot.y >= 0 && shot.y <= this.world.height);
    }

    isFullscreen() {
        return document.fullscreenElement === this.oceanScreen ||
            document.webkitFullscreenElement === this.oceanScreen || this.fullscreenFallback;
    }

    async toggleFullscreen() {
        try {
            if (this.fullscreenFallback) {
                this.fullscreenFallback = false;
            } else if (this.isFullscreen()) {
                if (document.exitFullscreen) await document.exitFullscreen();
                else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
            } else if (this.oceanScreen.requestFullscreen) {
                await this.oceanScreen.requestFullscreen();
            } else if (this.oceanScreen.webkitRequestFullscreen) {
                await this.oceanScreen.webkitRequestFullscreen();
            } else {
                this.fullscreenFallback = true;
            }
        } catch {
            // If browser fullscreen is unavailable, fill the browser window instead.
            this.fullscreenFallback = !this.isFullscreen();
        }
        this.syncFullscreen();
    }

    syncFullscreen() {
        this.releaseControls();
        this.oceanScreen.classList.toggle('fullscreen-fallback', this.fullscreenFallback);
        document.body.classList.toggle('ocean-fullscreen', this.isFullscreen());
        this.fullscreenButton.textContent = this.isFullscreen() ? '⤡ Exit' : '⛶ Fullscreen';
        this.fullscreenButton.setAttribute('aria-label', this.isFullscreen() ? 'Exit fullscreen' : 'Enter fullscreen');
        this.fullscreenButton.setAttribute('aria-pressed', String(this.isFullscreen()));
        this.resizeViewport();
    }

    resizeViewport() {
        const bounds = this.oceanScreen.getBoundingClientRect();
        // Change the view's aspect ratio rather than stretching the rider or adding borders.
        const width = this.isFullscreen() && bounds.height > 0 ? Math.round(660 * bounds.width / bounds.height) : 1200;
        if (this.canvas.width !== width || this.canvas.height !== 660) {
            this.canvas.width = Math.max(1, width);
            this.canvas.height = 660;
        }
        this.updateCamera();
    }

    bindTouchButton(id, direction) {
        const button = document.getElementById(id);
        button.addEventListener('pointerdown', event => {
            if (this.gameOver) return;
            event.preventDefault();
            button.setPointerCapture(event.pointerId);
            this.touchDirections.add(direction);
            if (direction === 'q') this.beginBoost();
        });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            button.addEventListener(event, () => this.touchDirections.delete(direction));
        }
    }

    releaseControls() {
        this.keys.clear();
        this.touchDirections.clear();
        this.rider.vx = 0;
        this.rider.vy = 0;
        this.boosting = false;
        this.updateBoostDisplay();
        this.speedDisplay.textContent = '0';
        this.lastTime = null;
    }

    reset() {
        if (this.multiplayer) return this.multiplayer.action('respawn');
        this.releaseControls();
        Object.assign(this.rider, { x: this.world.width / 2, y: this.world.height / 2, angle: 0 });
        this.onFoot = false; this.parkedBoat = null; this.walkIsland = null;
        this.onPirateShip = false; this.stowedCannonSlot = null;
        this.boardReadyAt = 0;
        this.boost = 100;
        this.health = 100;
        this.invulnerable = 0;
        this.gameOver = false;
        this.gameOverPanel.hidden = true;
        this.gameOverTime.textContent = '';
        this.survivalSeconds = 0;
        this.zoneDamageCarry = 0;
        this.updateSurvivalDisplay();
        if (this.deathCause) this.deathCause.textContent = 'Shark Attack';
        this.cannonballs = [];
        this.sharks = this.createSharks();
        this.islands = this.createIslands();
        this.pirateShip = this.createPirateShip();
        this.islandCollision = null;
        this.fish = this.createFish();
        this.blood = [];
        this.wake = [];
        this.riderStillTime = 0;
        this.inventory.fill(null);
        this.selectedSlot = 0;
        this.nextGunId = 7;
        this.floatingGuns = this.createGuns();
        this.projectiles = [];
        this.nextShotAt = 0;
        this.muzzleFlash = null;
        this.aim.active = false;
        this.wakeTimer = 0;
        this.updateCamera();
        this.updateBoostDisplay();
        this.updateHealthDisplay();
        this.updateInventory();
        this.updatePickupPrompt();
    }

    createPirateShip() {
        const ship = { angle: 0,
            fireTimer: 0, roamIndex: 0, route: [], clearance: 48, hullHalfLength: 140,
            cruiseDirection: null,
            hits: 0, disarmed: false, nextPlayerShotAt: 0,
            scaleX: 1.8, scaleY: 1.3 };
        // Compute the starting view directly: reset may still have the previous camera position.
        const view = {
            x: Math.max(0, Math.min(this.world.width - this.canvas.width, this.rider.x - this.canvas.width / 2)),
            y: Math.max(0, Math.min(this.world.height - this.canvas.height, this.rider.y - this.canvas.height / 2))
        };
        const radius = 220; // Includes the hull, sails, and wake in any orientation.
        const safe = ({ x, y }) => x >= radius && x <= this.world.width - radius &&
            y >= radius && y <= this.world.height - radius &&
            (x + radius < view.x || x - radius > view.x + this.canvas.width ||
                y + radius < view.y || y - radius > view.y + this.canvas.height) &&
            this.waterSegmentClear(x - ship.hullHalfLength, y, x + ship.hullHalfLength, y, ship.clearance);
        const candidates = [
            { x: this.rider.x, y: view.y - radius - 160 },
            { x: view.x - radius - 160, y: this.rider.y },
            { x: this.rider.x, y: view.y + this.canvas.height + radius + 160 },
            { x: view.x + this.canvas.width + radius + 160, y: this.rider.y }
        ];
        let spawn = candidates.find(safe);
        // Search the rest of the ocean if an island blocks the nearby offscreen positions.
        for (let y = radius; !spawn && y <= this.world.height - radius; y += 100) {
            for (let x = radius; x <= this.world.width - radius; x += 100) {
                if (safe({ x, y })) { spawn = { x, y }; break; }
            }
        }
        if (!spawn) throw new Error('No open-water pirate spawn outside the starting view');
        return Object.assign(ship, spawn);
    }

    pirateHullHit(x, y, endX, endY) {
        const ship = this.pirateShip;
        const local = (px, py) => ({
            x: ((px - ship.x) * Math.cos(ship.angle) + (py - ship.y) * Math.sin(ship.angle)) / 180,
            y: (-(px - ship.x) * Math.sin(ship.angle) + (py - ship.y) * Math.cos(ship.angle)) / 42
        });
        const start = local(x, y), end = local(endX, endY);
        const dx = end.x - start.x, dy = end.y - start.y;
        const c = start.x ** 2 + start.y ** 2 - 1;
        if (c <= 0) return 0;
        const a = dx * dx + dy * dy;
        if (a === 0) return null;
        const b = 2 * (start.x * dx + start.y * dy);
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) return null;
        const t = (-b - Math.sqrt(discriminant)) / (2 * a);
        return t >= 0 && t <= 1 ? t : null;
    }

    damagePirateShip() {
        const ship = this.pirateShip;
        if (ship.disarmed) return;
        ship.hits++;
        if (ship.hits >= 16) {
            ship.disarmed = true;
            ship.route = [];
            ship.fireTimer = 0;
            ship.flashUntil = ship.smokeUntil = 0;
            this.updatePickupPrompt();
        }
    }

    firePlayerCannon() {
        const ship = this.pirateShip;
        if (this.gameOver || !this.onPirateShip || !ship.disarmed || this.time + 1e-8 < ship.nextPlayerShotAt) return false;
        const cannon = this.pirateCannonPose(true);
        ship.shotAngle = cannon.angle;
        ship.flashUntil = this.time + 0.18;
        ship.smokeUntil = this.time + 0.65;
        this.multiplayer?.shot(cannon.angle, true);
        ship.nextPlayerShotAt = this.time + 3;
        this.cannonballs.push({ x: cannon.muzzleX, y: cannon.muzzleY,
            vx: Math.cos(cannon.angle) * 320, vy: Math.sin(cannon.angle) * 320,
            life: 30, owner: 'player' });
        return true;
    }

    planPirateRoute() {
        const ship = this.pirateShip;
        // Tour every part of the map, choosing fresh water destinations in each area.
        const zones = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1],
            [1, 1], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2]];
        const [col, row] = zones[ship.roamIndex++ % zones.length];
        const cellWidth = this.world.width / 4, cellHeight = this.world.height / 3;
        for (let attempt = 0; attempt < 12; attempt++) {
            const goal = { x: (col + 0.2 + Math.random() * 0.6) * cellWidth,
                y: (row + 0.2 + Math.random() * 0.6) * cellHeight };
            if (this.pointOnLand(goal.x, goal.y, ship.clearance)) continue;
            const route = this.pirateRouteClear(ship.x, ship.y, goal.x, goal.y) ? [goal] :
                this.waterRoute(ship, goal, ship.clearance, true);
            if (route.length) {
                ship.route = route; ship.routeIslands = this.islands;
                return;
            }
        }
        ship.route = [];
    }

    steerPirateShip(dt) {
        const ship = this.pirateShip;
        const frameX = ship.x, frameY = ship.y;
        if (!ship.route.length || ship.routeIslands !== this.islands) this.planPirateRoute();
        let travel = 95 * dt;
        for (let i = 0; i < 16 && ship.route.length && travel > 1e-6; i++) {
            // Skip grid corners when a hull-sized straight route is available.
            for (let next = ship.route.length - 1; next > 0; next--) {
                const p = ship.route[next];
                if (this.pirateRouteClear(ship.x, ship.y, p.x, p.y)) { ship.route.splice(0, next); break; }
            }
            const goal = ship.route[0];
            const dx = goal.x - ship.x, dy = goal.y - ship.y;
            const distance = Math.hypot(dx, dy);
            if (distance < 0.001) { ship.route.shift(); continue; }
            const step = Math.min(travel, distance);
            const x = ship.x + dx / distance * step, y = ship.y + dy / distance * step;
            const heading = Math.atan2(dy, dx);
            const oldX = ship.x, oldY = ship.y, oldAngle = ship.angle;
            this.movePirateHull(x, y, heading, dt);
            // Multiple waypoints in one update can make the resulting chord cut
            // across a shore, even when each individual hull pose is safe.
            if (!this.waterSegmentClear(frameX, frameY, ship.x, ship.y, ship.clearance)) {
                Object.assign(ship, { x: oldX, y: oldY, angle: oldAngle });
                break;
            }
            const moved = Math.hypot(ship.x - oldX, ship.y - oldY);
            if (moved < 0.001) {
                if (Math.abs(ship.angle - oldAngle) < 0.001) ship.route = [];
                break;
            }
            travel -= moved;
            if (step >= distance) ship.route.shift();
        }
    }

    piratePoseClear(x, y, angle) {
        const ship = this.pirateShip;
        const dx = Math.cos(angle) * ship.hullHalfLength, dy = Math.sin(angle) * ship.hullHalfLength;
        const extentX = Math.abs(dx) + ship.clearance, extentY = Math.abs(dy) + ship.clearance;
        return x >= extentX && x <= this.world.width - extentX &&
            y >= extentY && y <= this.world.height - extentY &&
            this.waterSegmentClear(x - dx, y - dy, x + dx, y + dy, ship.clearance);
    }

    pirateRouteClear(ax, ay, bx, by) {
        const ship = this.pirateShip;
        const angle = Math.atan2(by - ay, bx - ax);
        if (!this.piratePoseClear(ax, ay, angle) || !this.piratePoseClear(bx, by, angle)) return false;
        const dx = Math.cos(angle) * ship.hullHalfLength, dy = Math.sin(angle) * ship.hullHalfLength;
        return this.waterSegmentClear(ax - dx, ay - dy, bx + dx, by + dy, ship.clearance);
    }

    pirateMotionClear(x, y, angle) {
        const ship = this.pirateShip;
        const turn = Math.atan2(Math.sin(angle - ship.angle), Math.cos(angle - ship.angle));
        const steps = Math.max(1, Math.ceil(Math.hypot(x - ship.x, y - ship.y) / 6), Math.ceil(Math.abs(turn) / 0.025));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            // Small extra clearance covers the space between sampled poses.
            if (!this.piratePoseClear(ship.x + (x - ship.x) * t, ship.y + (y - ship.y) * t, ship.angle + turn * t)) return false;
        }
        return true;
    }

    movePirateHull(x, y, heading, dt) {
        const ship = this.pirateShip;
        const turn = Math.atan2(Math.sin(heading - ship.angle), Math.cos(heading - ship.angle));
        const angle = ship.angle + Math.max(-1.4 * dt, Math.min(1.4 * dt, turn));
        const reverseTurn = Math.atan2(Math.sin(heading + Math.PI - ship.angle), Math.cos(heading + Math.PI - ship.angle));
        const reverseAngle = ship.angle + Math.max(-1.4 * dt, Math.min(1.4 * dt, reverseTurn));
        // Align for reverse instead of forcing a full turn inside a narrow channel.
        for (const pose of [[x, y, angle], [x, y, reverseAngle], [x, y, ship.angle],
            [ship.x, ship.y, angle], [ship.x, ship.y, reverseAngle]]) {
            if (this.pirateMotionClear(...pose)) {
                [ship.x, ship.y, ship.angle] = pose;
                return;
            }
        }
    }

    pirateOnScreen() {
        const ship = this.pirateShip;
        const rx = Math.abs(Math.cos(ship.angle)) * 190 + Math.abs(Math.sin(ship.angle)) * 58;
        const ry = Math.abs(Math.sin(ship.angle)) * 190 + Math.abs(Math.cos(ship.angle)) * 58;
        return ship.x + rx >= this.camera.x && ship.x - rx <= this.camera.x + this.canvas.width &&
            ship.y + ry >= this.camera.y && ship.y - ry <= this.camera.y + this.canvas.height;
    }

    updatePirateShip(dt) {
        if (this.gameOver) return;
        const ship = this.pirateShip;
        if (ship.disarmed) return;
        this.steerPirateShip(dt);
        if (this.pirateOnScreen()) {
            ship.fireTimer += dt;
            if (ship.fireTimer + 1e-8 >= 3) {
                ship.fireTimer = Math.max(0, ship.fireTimer - 3);
                // Aim at the current position; shots can be dodged after launch.
                const cannon = this.pirateCannonPose(true);
                ship.shotAngle = cannon.angle;
                this.cannonballs.push({ x: cannon.muzzleX, y: cannon.muzzleY,
                    vx: Math.cos(cannon.angle) * 320, vy: Math.sin(cannon.angle) * 320, life: 30 });
                ship.flashUntil = this.time + 0.18;
                ship.smokeUntil = this.time + 0.65;
            }
        } else ship.fireTimer = 0;
    }

    updateCannonballs(dt) {
        for (const ball of this.cannonballs) {
            if (this.gameOver) break;
            const travelTime = Math.min(dt, ball.life);
            const x = ball.x + ball.vx * travelTime, y = ball.y + ball.vy * travelTime;
            if (ball.owner === 'player') {
                let hit = null, nearest = Infinity;
                for (const shark of this.sharks) {
                    if (shark.state === 'dead') continue;
                    const t = this.segmentHit(ball.x, ball.y, x, y, shark);
                    if (t !== null && t < nearest) { hit = shark; nearest = t; }
                }
                if (hit) { this.damageShark(hit, hit.maxHealth); ball.life = 0; }
                else { ball.x = x; ball.y = y; ball.life -= dt; }
                continue;
            }
            const hit = this.pointSegmentDistanceSq(this.rider.x, this.rider.y, ball.x, ball.y, x, y) <= 30 * 30;
            ball.x = x; ball.y = y; ball.life -= dt;
            if (hit) {
                ball.life = 0;
                this.health = Math.max(0, this.health - 75);
                if (this.health === 0) {
                    this.finishRun('Cannonball Attack');
                }
                this.updateHealthDisplay();
            }
        }
        this.cannonballs = this.cannonballs.filter(ball => ball.life > 0 &&
            ball.x >= -100 && ball.x <= this.world.width + 100 && ball.y >= -100 && ball.y <= this.world.height + 100);
    }

    pirateCannonPose(ignoreFlash = false) {
        const ship = this.pirateShip;
        const x = ship.x - Math.cos(ship.angle) * 65 * ship.scaleX;
        const y = ship.y - Math.sin(ship.angle) * 65 * ship.scaleX;
        const angle = !ignoreFlash && this.time < ship.flashUntil ? ship.shotAngle :
            this.multiplayer && !this.onPirateShip && Number.isFinite(ship.aimAngle) ? ship.aimAngle :
            this.onPirateShip ? (this.aim.active ? Math.atan2(
                this.camera.y + this.aim.v * this.canvas.height - y,
                this.camera.x + this.aim.u * this.canvas.width - x) : ship.angle) :
            ship.disarmed ? ship.angle : Math.atan2(this.rider.y - y, this.rider.x - x);
        return { x, y, angle, muzzleX: x + Math.cos(angle) * 44, muzzleY: y + Math.sin(angle) * 44 };
    }

    drawPirateCannon() {
        const ctx = this.ctx, ship = this.pirateShip, cannon = this.pirateCannonPose();
        const firing = this.time < ship.flashUntil;
        const recoil = firing ? Math.sin((ship.flashUntil - this.time) / 0.18 * Math.PI) * 6 : 0;
        ctx.save(); ctx.translate(cannon.x, cannon.y); ctx.rotate(cannon.angle);
        // The gunner stands behind the breech with both hands on the cannon.
        if (!ship.disarmed || this.onPirateShip) {
            ctx.fillStyle = '#211d32'; ctx.fillRect(-30 - recoil, -11, 9, 7); ctx.fillRect(-30 - recoil, 4, 9, 7);
            ctx.fillStyle = this.onPirateShip ? '#29d9f5' : '#cf385c'; ctx.fillRect(-25 - recoil, -10, 18, 20);
            ctx.strokeStyle = '#f2bd8d'; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.moveTo(-14 - recoil, -9); ctx.lineTo(4 - recoil, -11);
            ctx.moveTo(-14 - recoil, 9); ctx.lineTo(4 - recoil, 11); ctx.stroke();
            ctx.fillStyle = '#f2bd8d'; ctx.beginPath(); ctx.arc(-18 - recoil, 0, 8, 0, Math.PI * 2); ctx.fill();
            this.sharkShape([[-30 - recoil, -4], [-18 - recoil, -11], [-8 - recoil, -4], [-12 - recoil, 2], [-27 - recoil, 2]], '#211d32');
            ctx.fillStyle = '#ffd684'; ctx.fillRect(-20 - recoil, -7, 4, 3);
        }
        ctx.fillStyle = '#6d4256'; ctx.fillRect(-5, -16, 30, 32);
        ctx.fillStyle = '#211d32'; ctx.fillRect(0, -20, 12, 7); ctx.fillRect(0, 13, 12, 7);
        ctx.fillStyle = '#292e42'; ctx.fillRect(-4 - recoil, -10, 48, 20);
        ctx.fillStyle = '#627182'; ctx.fillRect(2 - recoil, -8, 36, 4);
        ctx.fillStyle = '#d3b791'; ctx.fillRect(37 - recoil, -12, 7, 24);
        ctx.fillStyle = '#101522'; ctx.fillRect(41 - recoil, -8, 4, 16);
        if (this.time < ship.smokeUntil) {
            const age = 0.65 - (ship.smokeUntil - this.time);
            ctx.fillStyle = 'rgba(192, 187, 211, ' + (0.5 * (1 - age / 0.65)) + ')';
            for (let i = 0; i < 3; i++) {
                ctx.beginPath(); ctx.arc(52 + age * 70 + i * 13, (i - 1) * (8 + age * 18), 9 + age * 22, 0, Math.PI * 2); ctx.fill();
            }
        }
        if (firing) {
            this.sharkShape([[44 - recoil, -8], [60, -19], [66, -7], [94, 0], [66, 8], [60, 19], [44 - recoil, 8]], '#ff863c');
            this.sharkShape([[44 - recoil, -6], [63, -9], [78, 0], [63, 9], [44 - recoil, 6]], '#ffe998');
        }
        ctx.restore();
    }

    drawPirateShip() {
        if (!this.pirateOnScreen()) return;
        const ctx = this.ctx, ship = this.pirateShip;
        ctx.save(); ctx.translate(ship.x, ship.y); ctx.rotate(ship.angle);
        ctx.scale(ship.scaleX, ship.scaleY);
        ctx.strokeStyle = '#40dbf5'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(-15, 0, 103, 38, 0, 0, Math.PI * 2); ctx.stroke();
        this.sharkShape([[-94, -24], [51, -32], [100, 0], [51, 32], [-94, 24]], '#391e48');
        this.sharkShape([[-78, -18], [46, -24], [78, 0], [46, 24], [-78, 18]], '#a65c72');
        ctx.strokeStyle = '#efb87b'; ctx.lineWidth = 2;
        for (let x = -65; x <= 45; x += 18) {
            ctx.beginPath(); ctx.moveTo(x, -19); ctx.lineTo(x, 19); ctx.stroke();
        }
        // Two canvas sails and a skull flag identify the large pirate ship.
        for (const x of [-38, 24]) {
            ctx.fillStyle = '#291830'; ctx.fillRect(x - 3, -41, 6, 82);
            this.sharkShape([[x - 20, -37], [x + 20, -27], [x + 20, 27], [x - 20, 37]], '#e8c8df');
            ctx.fillStyle = '#704572'; ctx.fillRect(x - 2, -28, 3, 56);
        }
        ctx.fillStyle = '#181426'; ctx.fillRect(-83, -32, 28, 25);
        ctx.fillStyle = '#fff1ea'; ctx.beginPath(); ctx.arc(-69, -22, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(-73, -18, 8, 5);
        ctx.fillStyle = '#181426'; ctx.fillRect(-73, -24, 3, 3); ctx.fillRect(-68, -24, 3, 3);
        ctx.strokeStyle = '#fff1ea'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-79, -12); ctx.lineTo(-59, -7);
        ctx.moveTo(-79, -7); ctx.lineTo(-59, -12); ctx.stroke();
        ctx.fillStyle = '#252339';
        for (const x of [-57, 0, 52]) { ctx.fillRect(x - 5, -37, 10, 16); ctx.fillRect(x - 5, 21, 10, 16); }
        ctx.restore();
        this.drawPirateCannon();
    }

    drawCannonballs() {
        const ctx = this.ctx;
        for (const ball of this.cannonballs) {
            ctx.strokeStyle = '#ffab62'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(ball.x - ball.vx * 0.06, ball.y - ball.vy * 0.06);
            ctx.lineTo(ball.x, ball.y); ctx.stroke();
            ctx.fillStyle = '#17182a'; ctx.strokeStyle = '#ffd497'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(ball.x, ball.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
    }

    createIslands() {
        const islands = [];
        for (let attempt = 0; attempt < 600 && islands.length < 14; attempt++) {
            const size = 60 + Math.random() * 100;
            const rx = size * (0.8 + Math.random() * 0.8);
            const ry = size * (0.55 + Math.random() * 0.75);
            const rotation = Math.random() * Math.PI * 2;
            const phase = Math.random() * Math.PI * 2;
            const points = Array.from({ length: 28 }, (_, index) => {
                const angle = index / 28 * Math.PI * 2;
                const wave = 1 + Math.sin(angle * 3 + phase) * 0.08 + Math.cos(angle * 2 - phase) * 0.03;
                const px = Math.cos(angle) * rx * wave;
                const py = Math.sin(angle) * ry * wave;
                return [px * Math.cos(rotation) - py * Math.sin(rotation), px * Math.sin(rotation) + py * Math.cos(rotation)];
            });
            const radius = Math.max(...points.map(([px, py]) => Math.hypot(px, py)));
            const x = radius + 90 + Math.random() * (this.world.width - (radius + 90) * 2);
            const y = radius + 90 + Math.random() * (this.world.height - (radius + 90) * 2);
            if (Math.hypot(x - this.world.width / 2, y - this.world.height / 2) < radius + 600) continue;
            if (islands.some(island => Math.hypot(x - island.x, y - island.y) < radius + island.radius + 180)) continue;
            if (this.floatingGuns.some(gun => Math.hypot(x - gun.x, y - gun.y) < radius + 100)) continue;
            if (this.sharks.some(shark => Math.hypot(x - shark.homeX, y - shark.homeY) < radius + 100)) continue;
            const palms = islands.length % 3 === 0 ? [] : Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => {
                const angle = Math.random() * Math.PI * 2;
                const distance = Math.random() * 0.4;
                const px = Math.cos(angle) * rx * distance;
                const py = Math.sin(angle) * ry * distance;
                return { x: px * Math.cos(rotation) - py * Math.sin(rotation),
                    y: px * Math.sin(rotation) + py * Math.cos(rotation), angle };
            });
            islands.push({ x, y, radius, points, palms, coconuts: [] });
        }
        const coconutIslands = islands.map((island, index) => ({ island, index }));
        for (let i = coconutIslands.length - 1; i > 0; i--) {
            const other = Math.floor(Math.random() * (i + 1));
            [coconutIslands[i], coconutIslands[other]] = [coconutIslands[other], coconutIslands[i]];
        }
        for (const { island, index } of coconutIslands.slice(0, Math.floor(islands.length / 2))) {
            const count = 2;
            island.coconuts = Array.from({ length: count }, (_, item) => {
                const angle = item / count * Math.PI * 2 + Math.random() * 0.3;
                const distance = item === 0 ? Math.min(24, island.radius * 0.15) :
                    island.radius * (0.15 + Math.random() * 0.4);
                let x = Math.cos(angle) * distance, y = Math.sin(angle) * distance;
                for (let attempt = 0; attempt < 12 && !this.canWalkAt(island.x + x, island.y + y, island); attempt++) {
                    x *= 0.65; y *= 0.65;
                }
                return { id: 'coconut-' + index + '-' + item, x, y };
            });
        }
        return islands;
    }

    pointOnLand(x, y, padding = 0) {
        return (this.islands || []).some(island => this.islandContact(x, y, island, padding) !== null);
    }

    islandContact(x, y, island, padding = 0) {
        const px = x - island.x;
        const py = y - island.y;
        if (Math.hypot(px, py) >= island.radius + padding) return null;
        const points = island.points || Array.from({ length: 28 }, (_, i) =>
            [Math.cos(i / 28 * Math.PI * 2) * island.radius, Math.sin(i / 28 * Math.PI * 2) * island.radius]);
        let inside = false;
        let closest = null;
        let best = Infinity;
        for (let i = 0; i < points.length; i++) {
            const [ax, ay] = points[i];
            const [bx, by] = points[(i + 1) % points.length];
            if ((ay > py) !== (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax) inside = !inside;
            const ex = bx - ax;
            const ey = by - ay;
            const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
            const qx = ax + ex * t;
            const qy = ay + ey * t;
            const distance = Math.hypot(px - qx, py - qy);
            if (distance < best) { best = distance; closest = { x: qx, y: qy }; }
        }
        if (!inside && best >= padding) return null;
        let nx = inside ? closest.x - px : px - closest.x;
        let ny = inside ? closest.y - py : py - closest.y;
        if (best < 1e-8) { nx = closest.x; ny = closest.y; }
        const length = Math.hypot(nx, ny) || 1;
        return { x: island.x + closest.x, y: island.y + closest.y, nx: nx / length, ny: ny / length };
    }

    randomWaterPoint(padding = 60) {
        for (let attempt = 0; attempt < 100; attempt++) {
            const point = { x: padding + Math.random() * (this.world.width - padding * 2),
                y: padding + Math.random() * (this.world.height - padding * 2) };
            if (!this.pointOnLand(point.x, point.y, 25)) return point;
        }
        return { x: this.world.width / 2, y: this.world.height / 2 };
    }

    checkIslandCollision() {
        for (const island of this.islands) {
            const contact = this.islandContact(this.rider.x, this.rider.y, island, this.boatRadius);
            if (!contact) continue;
            const { nx, ny } = contact;
            this.rider.x = contact.x + nx * (this.boatRadius + 0.5);
            this.rider.y = contact.y + ny * (this.boatRadius + 0.5);
            this.rider.vx = this.rider.vy = 0;
            this.boosting = false;
            this.islandCollision = { nx, ny, reversed: 0 };
            break;
        }
    }

    backOffIsland(dx, dy, dt) {
        const collision = this.islandCollision;
        this.rider.vx = this.rider.vy = 0;
        if (dx * collision.nx + dy * collision.ny < 0.5) return;
        const reversingTime = Math.min(dt, 2 - collision.reversed);
        this.rider.vx = collision.nx * 25;
        this.rider.vy = collision.ny * 25;
        this.rider.x += this.rider.vx * reversingTime;
        this.rider.y += this.rider.vy * reversingTime;
        collision.reversed += reversingTime;
        if (collision.reversed >= 2 - 1e-8) this.islandCollision = null;
    }

    drawIslands() {
        const ctx = this.ctx;
        for (const island of this.islands) {
            const { x, y, radius } = island;
            if (x + radius + 30 < this.camera.x || x - radius - 30 > this.camera.x + this.canvas.width ||
                y + radius + 30 < this.camera.y || y - radius - 30 > this.camera.y + this.canvas.height) continue;
            const points = island.points || Array.from({ length: 28 }, (_, i) =>
                [Math.cos(i / 28 * Math.PI * 2) * radius, Math.sin(i / 28 * Math.PI * 2) * radius]);
            ctx.save(); ctx.translate(x, y); ctx.scale(1.12, 1.12);
            this.sharkShape(points, 'rgba(37, 192, 255, 0.16)'); ctx.restore();
            ctx.save(); ctx.translate(x, y + 14); this.sharkShape(points, '#532caa'); ctx.restore();
            for (let edge = 0; edge < points.length; edge++) {
                const a = points[edge]; const b = points[(edge + 1) % points.length];
                this.sharkShape([[x + a[0], y + a[1]], [x + b[0], y + b[1]],
                    [x + b[0], y + b[1] + 14], [x + a[0], y + a[1] + 14]],
                    ['#7333c5', '#b343e1', '#50329e'][edge % 3]);
            }
            ctx.save(); ctx.translate(x, y);
            this.sharkShape(points, '#b657df');
            ctx.scale(0.92, 0.92); this.sharkShape(points, '#d28cee'); ctx.restore();
            for (const coconut of island.coconuts || []) {
                this.ellipse(x + coconut.x, y + coconut.y + 3, 10, 5, 'rgba(43, 18, 65, 0.35)');
                this.ellipse(x + coconut.x, y + coconut.y, 8, 7, '#995d3d');
                this.ellipse(x + coconut.x - 2, y + coconut.y - 2, 4, 3, '#d7a36b');
                for (const [cx, cy] of [[1, -2], [4, -1], [2, 2]]) {
                    this.ellipse(x + coconut.x + cx, y + coconut.y + cy, 1.2, 1.2, '#422b2c');
                }
            }
            for (const palm of island.palms) {
                ctx.save(); ctx.translate(x + palm.x, y + palm.y); ctx.rotate(palm.angle);
                ctx.strokeStyle = '#743bb3'; ctx.lineWidth = 6;
                ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(5, -7); ctx.stroke();
                for (let leaf = 0; leaf < 5; leaf++) {
                    const angle = leaf * Math.PI * 2 / 5;
                    this.sharkShape([[5, -7], [5 + Math.cos(angle - 0.3) * 18, -7 + Math.sin(angle - 0.3) * 18],
                        [5 + Math.cos(angle) * 42, -7 + Math.sin(angle) * 42]], leaf % 2 ? '#e257f1' : '#a943ed');
                }
                for (const [cx, cy] of [[1, -5], [6, -3], [9, -7]]) this.ellipse(cx, cy, 2.7, 2.5, '#713b67');
                ctx.restore();
            }
        }
    }

    createFish() {
        return Array.from({ length: 60 }, (_, id) => {
            const school = Math.floor(id / 6);
            return { id, ...this.randomWaterPoint(), angle: school * 0.8,
                speed: 24 + id % 5 * 5, color: ['#5fe7f2', '#a7a2ff', '#fa9cdb'][id % 3] };
        });
    }

    updateFish(dt) {
        // Decorative swimmers are independent of pickups, bullets, sharks, and the rider.
        for (const fish of this.fish) {
            fish.angle += Math.sin(this.time * 0.45 + fish.id * 0.17) * 0.3 * dt;
            const x = (fish.x + Math.cos(fish.angle) * fish.speed * dt + this.world.width) % this.world.width;
            const y = (fish.y + Math.sin(fish.angle) * fish.speed * dt + this.world.height) % this.world.height;
            if (this.pointOnLand(x, y, 12)) fish.angle += Math.PI / 2;
            else { fish.x = x; fish.y = y; }
        }
    }

    drawFish() {
        const ctx = this.ctx;
        for (const fish of this.fish) {
            if (!this.isOnScreen(fish)) continue;
            ctx.save(); ctx.translate(fish.x, fish.y); ctx.rotate(fish.angle);
            ctx.globalAlpha = 0.65;
            const tail = Math.sin(this.time * 9 + fish.id) * 2;
            this.sharkShape([[-7, 0], [-17, -5 + tail], [-16, 5 + tail]], fish.color);
            this.ellipse(0, 0, 10, 4, fish.color);
            this.ellipse(6, -1, 1.2, 1.2, '#1a5363');
            ctx.restore();
        }
    }

    createSharks() {
        const width = this.world.width / this.territories.columns;
        const height = this.world.height / this.territories.rows;
        // Permanent assignments: a chase never transfers another territory's guard.
        return Array.from({ length: 10 }, (_, id) => {
            const territory = { x: id % 5 * width, y: Math.floor(id / 5) * height, width, height };
            const homeX = id === 7 ? 3450 : territory.x + width / 2;
            const homeY = id === 7 ? 2350 : territory.y + height / 2;
            return {
                id, territory, homeX, homeY, x: homeX, y: homeY,
                patrolIndex: id % 5, angle: 0, state: 'patrol', timer: 0, cooldown: 0,
                leapX: 0, leapY: 0, hasBitten: false, splashAge: 1,
                landAttack: false, shoreLeap: false, leapDuration: 0.65,
                health: 3, maxHealth: 3, respawnAt: 0, hitUntil: 0
            };
        });
    }

    isOnScreen(shark) {
        const radius = 55;
        return shark.x + radius >= this.camera.x && shark.x - radius <= this.camera.x + this.canvas.width &&
            shark.y + radius >= this.camera.y && shark.y - radius <= this.camera.y + this.canvas.height;
    }

    lightOrigin() {
        const boat = this.onFoot || this.onPirateShip ? this.parkedBoat : this.rider;
        return { x: boat.x + Math.sin(boat.angle) * 30,
            y: boat.y - Math.cos(boat.angle) * 30,
            heading: boat.angle - Math.PI / 2 };
    }

    isPointLit(x, y) {
        if (Math.hypot(x - this.rider.x, y - this.rider.y) <= this.nearLightRadius) return true;
        const origin = this.lightOrigin();
        const dx = x - origin.x;
        const dy = y - origin.y;
        const distance = Math.hypot(dx, dy);
        return distance <= this.headlightRange && distance > 0 &&
            (dx * Math.cos(origin.heading) + dy * Math.sin(origin.heading)) / distance >= Math.cos(this.headlightHalfAngle);
    }

    clipToLight(ctx) {
        const origin = this.lightOrigin();
        ctx.beginPath();
        ctx.arc(this.rider.x, this.rider.y, this.nearLightRadius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.moveTo(origin.x, origin.y);
        ctx.arc(origin.x, origin.y, this.headlightRange,
            origin.heading - this.headlightHalfAngle, origin.heading + this.headlightHalfAngle);
        ctx.closePath();
        ctx.clip();
    }

    drawNightLighting() {
        const { width, height } = this.canvas;
        if (this.nightCanvas.width !== width || this.nightCanvas.height !== height) {
            this.nightCanvas.width = width;
            this.nightCanvas.height = height;
        }
        const mask = this.nightContext;
        const x = this.rider.x - this.camera.x;
        const y = this.rider.y - this.camera.y;
        const origin = this.lightOrigin();
        const ox = origin.x - this.camera.x;
        const oy = origin.y - this.camera.y;
        mask.clearRect(0, 0, width, height);
        mask.fillStyle = 'rgba(0, 5, 18, 0.86)';
        mask.fillRect(0, 0, width, height);
        mask.save();
        // Remove darkness from a separate mask, never erase the ocean itself.
        mask.globalCompositeOperation = 'destination-out';
        const nearby = mask.createRadialGradient(x, y, 0, x, y, this.nearLightRadius);
        nearby.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
        nearby.addColorStop(0.6, 'rgba(255, 255, 255, 0.8)');
        nearby.addColorStop(1, 'rgba(255, 255, 255, 0)');
        mask.fillStyle = nearby;
        mask.beginPath(); mask.arc(x, y, this.nearLightRadius, 0, Math.PI * 2); mask.fill();
        const beam = mask.createRadialGradient(ox, oy, 0, ox, oy, this.headlightRange);
        beam.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
        beam.addColorStop(0.65, 'rgba(255, 255, 255, 0.72)');
        beam.addColorStop(1, 'rgba(255, 255, 255, 0)');
        mask.fillStyle = beam;
        mask.beginPath(); mask.moveTo(ox, oy);
        mask.arc(ox, oy, this.headlightRange,
            origin.heading - this.headlightHalfAngle, origin.heading + this.headlightHalfAngle);
        mask.closePath(); mask.fill();
        mask.restore();
        this.ctx.drawImage(this.nightCanvas, 0, 0);
    }

    drawHiddenSharkRipples(shark) {
        const ctx = this.ctx;
        ctx.save();
        ctx.lineWidth = 1.5;
        for (let ring = 0; ring < 2; ring++) {
            const phase = (this.time * 0.65 + shark.id * 0.173 + ring * 0.5) % 1;
            const radius = 15 + phase * 35;
            ctx.strokeStyle = 'rgba(165, 211, 224, ' + (1 - phase) * 0.42 + ')';
            ctx.beginPath();
            ctx.ellipse(shark.x, shark.y, radius, radius * 0.5, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    safeAreaBounds() {
        const progress = Math.min(1, Math.max(0, (this.multiplayer ? this.multiplayer.worldTime : this.survivalSeconds) / 180));
        // Use the standard game view so fullscreen changes cannot alter the safe area.
        const minWidth = Math.min(this.world.width, 1200 * 4);
        const minHeight = Math.min(this.world.height, 660 * 4);
        const width = this.world.width + (minWidth - this.world.width) * progress;
        const height = this.world.height + (minHeight - this.world.height) * progress;
        return { x: (this.world.width - width) / 2, y: (this.world.height - height) / 2, width, height };
    }

    updateSafeArea(dt) {
        if (this.gameOver) return;
        const area = this.safeAreaBounds();
        const outside = this.rider.x < area.x || this.rider.x > area.x + area.width ||
            this.rider.y < area.y || this.rider.y > area.y + area.height;
        if (!outside) { this.zoneDamageCarry = 0; return; }
        // Carry sub-point damage between frames for an exact two points per second.
        this.zoneDamageCarry += dt * 2;
        const damage = Math.floor(this.zoneDamageCarry + 1e-8);
        if (damage > 0) {
            this.zoneDamageCarry = Math.max(0, this.zoneDamageCarry - damage);
            this.health = Math.max(0, this.health - damage);
            if (this.health === 0) this.finishRun('Outside Safe Area');
            this.updateHealthDisplay();
        }
    }

    drawSafeArea(ctx, sx = 1, sy = 1) {
        const area = this.safeAreaBounds();
        const x = area.x * sx, y = area.y * sy, width = area.width * sx, height = area.height * sy;
        const worldWidth = this.world.width * sx, worldHeight = this.world.height * sy;
        ctx.save();
        ctx.fillStyle = 'rgba(238, 48, 101, 0.22)';
        ctx.fillRect(0, 0, worldWidth, y);
        ctx.fillRect(0, y + height, worldWidth, worldHeight - y - height);
        ctx.fillRect(0, y, x, height);
        ctx.fillRect(x + width, y, worldWidth - x - width, height);
        ctx.strokeStyle = '#ff759f'; ctx.lineWidth = sx === 1 ? 4 : 1.5;
        ctx.strokeRect(x, y, width, height);
        ctx.restore();
    }

    formatSurvivalTime(elapsed) {
        const seconds = Math.floor(elapsed + 1e-8);
        return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }

    finishRun(cause) {
        this.gameOver = true;
        this.releaseControls();
        this.gameOverPanel.hidden = false;
        if (this.deathCause) this.deathCause.textContent = cause;
        this.gameOverTime.textContent = 'Survived ' + this.formatSurvivalTime(this.survivalSeconds);
    }

    updateSurvivalDisplay() {
        if (!this.isSingleplayer) return;
        const seconds = Math.floor(this.survivalSeconds + 1e-8);
        if (seconds > this.bestSurvivalSeconds) {
            this.bestSurvivalSeconds = seconds;
            try {
                window.localStorage?.setItem('ocean-rush-best-survival', String(seconds));
            } catch { /* Keep the session best even if persistent storage is blocked. */ }
        }
        this.survivalTimeDisplay.textContent = this.formatSurvivalTime(seconds);
        this.bestSurvivalDisplay.textContent = this.formatSurvivalTime(this.bestSurvivalSeconds);
    }

    updateHealthDisplay() {
        this.healthBar.value = this.health;
        this.healthAmount.textContent = this.health + '%';
    }

    canPursue(shark) {
        if (this.onPirateShip) return false;
        if (shark.state === 'dead') return false;
        if (this.isOnScreen(shark)) return true;
        // Rider wounds attract sharks nearby; shot-shark blood also attracts sharks near the hit.
        return this.blood.some(pool => pool.life > 0 &&
            (Math.hypot(shark.x - this.rider.x, shark.y - this.rider.y) <= this.bloodAttractionRadius ||
            (pool.source === 'shark' && Math.hypot(shark.x - pool.x, shark.y - pool.y) <= this.bloodAttractionRadius)));
    }

    takeBite() {
        if (this.invulnerable > 0 || this.gameOver || this.onPirateShip) return;
        this.health = Math.max(0, this.health - 25);
        // Store the bite location in world space so the patch stays in the water.
        this.blood.push({ x: this.rider.x, y: this.rider.y, life: this.bloodLifetime });
        this.invulnerable = 1.2;
        if (this.health === 0) {
            this.finishRun('Shark Attack');
        }
        this.updateHealthDisplay();
    }

    returnToTerritory(shark) {
        shark.state = 'return';
        shark.timer = 0;
        shark.leapX = shark.leapY = 0;
    }

    pointSegmentDistanceSq(px, py, ax, ay, bx, by) {
        const dx = bx - ax; const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
    }

    waterSegmentClear(ax, ay, bx, by, padding = this.sharkClearance) {
        for (const island of this.islands) {
            if (this.pointSegmentDistanceSq(island.x, island.y, ax, ay, bx, by) > (island.radius + padding) ** 2) continue;
            if (this.islandContact(ax, ay, island, padding) || this.islandContact(bx, by, island, padding)) return false;
            const points = island.points || Array.from({ length: 28 }, (_, i) =>
                [Math.cos(i / 28 * Math.PI * 2) * island.radius, Math.sin(i / 28 * Math.PI * 2) * island.radius]);
            for (let i = 0; i < points.length; i++) {
                const [cx, cy] = [island.x + points[i][0], island.y + points[i][1]];
                const next = points[(i + 1) % points.length];
                const [dx, dy] = [island.x + next[0], island.y + next[1]];
                const denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
                if (Math.abs(denominator) > 1e-9) {
                    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator;
                    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator;
                    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return false;
                }
                if (Math.min(this.pointSegmentDistanceSq(ax, ay, cx, cy, dx, dy),
                    this.pointSegmentDistanceSq(bx, by, cx, cy, dx, dy),
                    this.pointSegmentDistanceSq(cx, cy, ax, ay, bx, by),
                    this.pointSegmentDistanceSq(dx, dy, ax, ay, bx, by)) < padding * padding) return false;
            }
        }
        return true;
    }

    waterTarget(x, y) {
        let point = { x, y };
        for (const island of this.islands) {
            const contact = this.islandContact(point.x, point.y, island, this.sharkClearance + 1);
            if (contact) point = { x: contact.x + contact.nx * (this.sharkClearance + 2),
                y: contact.y + contact.ny * (this.sharkClearance + 2) };
        }
        const valid = p => p.x >= this.margin && p.x <= this.world.width - this.margin &&
            p.y >= this.margin && p.y <= this.world.height - this.margin && !this.pointOnLand(p.x, p.y, this.sharkClearance);
        // An edge channel can fit the rider but be too narrow for a shark's body.
        if (!valid(point)) {
            for (let radius = 40; radius <= 600; radius += 40) {
                for (let i = 0; i < 24; i++) {
                    const candidate = { x: x + Math.cos(i / 24 * Math.PI * 2) * radius,
                        y: y + Math.sin(i / 24 * Math.PI * 2) * radius };
                    if (valid(candidate)) return candidate;
                }
            }
            return { x: this.world.width / 2, y: this.world.height / 2 };
        }
        return point;
    }

    waterRoute(start, goal, padding = this.sharkClearance, pirateHull = false) {
        const cacheKey = padding === this.sharkClearance ? 'navigation' : 'pirateNavigation';
        const margin = Math.max(this.margin, padding);
        if (!this[cacheKey] || this[cacheKey].islands !== this.islands || this[cacheKey].padding !== padding || this[cacheKey].pirateHull !== pirateHull) {
            const spacing = pirateHull ? 50 : 100;
            const cols = Math.ceil(this.world.width / spacing), rows = Math.ceil(this.world.height / spacing);
            const points = Array.from({ length: cols * rows }, (_, i) => ({
                x: Math.max(margin, Math.min(this.world.width - margin, (i % cols + 0.5) * spacing)),
                y: Math.max(margin, Math.min(this.world.height - margin, (Math.floor(i / cols) + 0.5) * spacing))
            }));
            this[cacheKey] = { islands: this.islands, padding, pirateHull, cols, rows, points,
                blocked: points.map(p => this.pointOnLand(p.x, p.y, padding)), edges: new Map() };
        }
        const nav = this[cacheKey];
        const segmentClear = (ax, ay, bx, by) => pirateHull ? this.pirateRouteClear(ax, ay, bx, by) :
            this.waterSegmentClear(ax, ay, bx, by, padding);
        const nearest = point => {
            let best = -1; let distance = Infinity;
            for (let i = 0; i < nav.points.length; i++) {
                if (nav.blocked[i]) continue;
                const p = nav.points[i]; const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
                if (d < distance && segmentClear(point.x, point.y, p.x, p.y)) { best = i; distance = d; }
            }
            return best;
        };
        const first = nearest(start); const last = nearest(goal);
        if (first < 0 || last < 0) return [];
        const scores = new Float64Array(nav.points.length).fill(Infinity);
        const previous = new Int32Array(nav.points.length).fill(-1);
        const closed = new Uint8Array(nav.points.length);
        const heap = [];
        const push = entry => {
            let i = heap.length; heap.push(entry);
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (heap[parent].score <= entry.score) break;
                heap[i] = heap[parent]; i = parent;
            }
            heap[i] = entry;
        };
        const pop = () => {
            const firstEntry = heap[0]; const tail = heap.pop();
            if (heap.length) {
                let i = 0;
                while (i * 2 + 1 < heap.length) {
                    let child = i * 2 + 1;
                    if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++;
                    if (heap[child].score >= tail.score) break;
                    heap[i] = heap[child]; i = child;
                }
                heap[i] = tail;
            }
            return firstEntry;
        };
        const heuristic = i => Math.hypot(nav.points[i].x - nav.points[last].x, nav.points[i].y - nav.points[last].y);
        scores[first] = 0; push({ id: first, score: heuristic(first) });
        while (heap.length) {
            const current = pop().id;
            if (closed[current]) continue;
            if (current === last) {
                const route = [goal];
                for (let node = last; node !== -1; node = previous[node]) route.push(nav.points[node]);
                return route.reverse();
            }
            closed[current] = 1;
            const cx = current % nav.cols; const cy = Math.floor(current / nav.cols);
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
                if ((!ox && !oy) || cx + ox < 0 || cx + ox >= nav.cols || cy + oy < 0 || cy + oy >= nav.rows) continue;
                const next = (cy + oy) * nav.cols + cx + ox;
                if (closed[next] || nav.blocked[next]) continue;
                const a = nav.points[current]; const b = nav.points[next];
                const key = Math.min(current, next) * nav.points.length + Math.max(current, next);
                if (!nav.edges.has(key)) nav.edges.set(key, segmentClear(a.x, a.y, b.x, b.y));
                if (!nav.edges.get(key)) continue;
                const cost = scores[current] + Math.hypot(b.x - a.x, b.y - a.y);
                if (cost >= scores[next]) continue;
                scores[next] = cost; previous[next] = current;
                push({ id: next, score: cost + heuristic(next) });
            }
        }
        return [];
    }

    moveShark(shark, targetX, targetY, travel) {
        const goal = this.waterTarget(targetX, targetY);
        let waypoint = goal;
        if (!this.waterSegmentClear(shark.x, shark.y, goal.x, goal.y)) {
            if (!shark.route || shark.routeIslands !== this.islands || this.time >= shark.routeUntil ||
                Math.hypot(goal.x - shark.routeGoal.x, goal.y - shark.routeGoal.y) > 100) {
                shark.route = this.waterRoute(shark, goal);
                shark.routeGoal = goal; shark.routeUntil = this.time + 1;
                shark.routeIslands = this.islands;
            }
            while (shark.route.length && Math.hypot(shark.route[0].x - shark.x, shark.route[0].y - shark.y) < 10) shark.route.shift();
            for (let i = shark.route.length - 1; i > 0; i--) {
                const p = shark.route[i];
                if (this.waterSegmentClear(shark.x, shark.y, p.x, p.y)) { shark.route.splice(0, i); break; }
            }
            waypoint = shark.route[0];
            if (!waypoint) return false;
        } else shark.route = null;
        const dx = waypoint.x - shark.x; const dy = waypoint.y - shark.y;
        const distance = Math.hypot(dx, dy);
        const step = Math.min(distance, travel);
        if (distance > 0) {
            const x = shark.x + dx / distance * step;
            const y = shark.y + dy / distance * step;
            if (!this.waterSegmentClear(shark.x, shark.y, x, y)) return false;
            shark.x = x; shark.y = y; shark.angle = Math.atan2(dy, dx) + Math.PI / 2;
        }
        return Math.hypot(shark.x - goal.x, shark.y - goal.y) < 1;
    }

    patrolShark(shark, dt) {
        const area = shark.territory;
        const riderArea = Math.min(4, Math.floor(this.rider.x / area.width)) +
            Math.min(1, Math.floor(this.rider.y / area.height)) * 5;
        const investigate = this.riderStillTime >= 5 && riderArea === shark.id;
        const waypoints = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.5, 0.5]];
        const point = waypoints[shark.patrolIndex];
        // An area's guard investigates a stationary rider rather than leaving them safe forever.
        const targetX = investigate ? this.rider.x : shark.state === 'return' ? shark.homeX : area.x + point[0] * area.width;
        const targetY = investigate ? this.rider.y : shark.state === 'return' ? shark.homeY : area.y + point[1] * area.height;
        if (this.moveShark(shark, targetX, targetY, this.sharkSpeed * dt) && !investigate) {
            if (shark.state === 'return') shark.state = 'patrol';
            else shark.patrolIndex = (shark.patrolIndex + 1) % waypoints.length;
        }
    }

    leapAim(shark, leadTime) {
        const dx = this.rider.x + this.rider.vx * leadTime - shark.x;
        const dy = this.rider.y + this.rider.vy * leadTime - shark.y;
        const length = Math.hypot(dx, dy);
        return length > 0 ? { x: dx / length, y: dy / length } :
            { x: Math.sin(shark.angle), y: -Math.cos(shark.angle) };
    }

    rollLandAttack(random = Math.random) {
        return random() < 0.15;
    }

    updateSharks(dt) {
        if (this.gameOver) return;
        for (const shark of this.sharks) {
            if (shark.state === 'dead') {
                if (this.time + 1e-8 >= shark.respawnAt) {
                    Object.assign(shark, {
                        x: shark.homeX, y: shark.homeY, health: shark.maxHealth,
                        state: 'patrol', timer: 0, cooldown: 0, angle: 0,
                        leapX: 0, leapY: 0, hasBitten: false, splashAge: 0,
                        landAttack: false, shoreLeap: false, leapDuration: 0.65,
                        respawnAt: 0, hitUntil: 0
                    });
                }
                continue;
            }
            shark.cooldown = Math.max(0, shark.cooldown - dt);
            shark.splashAge += dt;
            // Normally sight is required; fresh blood temporarily extends detection.
            if (!this.canPursue(shark) && !(shark.state === 'leap' && shark.shoreLeap)) {
                if (shark.state !== 'patrol' && shark.state !== 'return') this.returnToTerritory(shark);
                this.patrolShark(shark, dt);
                continue;
            }
            if (this.gameOver) break;
            if (shark.state === 'patrol' || shark.state === 'return') shark.state = 'chase';
            const dx = this.rider.x - shark.x;
            const dy = this.rider.y - shark.y;
            const distance = Math.hypot(dx, dy);
            if (shark.state !== 'leap' && distance > 0) shark.angle = Math.atan2(dy, dx) + Math.PI / 2;
            if (shark.state === 'chase') {
                if (distance <= 130 && shark.cooldown === 0) {
                    shark.state = 'windup';
                    shark.timer = 0;
                } else if (distance > 0) {
                    const travel = Math.min(distance, this.sharkSpeed * dt);
                    this.moveShark(shark, this.rider.x, this.rider.y, travel);
                }
            } else if (shark.state === 'windup') {
                shark.timer += dt;
                if (shark.timer >= 0.35) {
                    shark.state = 'leap';
                    shark.timer = 0;
                    const aim = this.leapAim(shark, Math.min(0.32, distance / this.sharkSpeed * 0.5));
                    shark.leapX = aim.x;
                    shark.leapY = aim.y;
                    shark.landAttack = this.rollLandAttack();
                    shark.shoreLeap = shark.landAttack && this.onFoot;
                    shark.leapDuration = 0.65;
                    if (shark.shoreLeap) {
                        // A rare airborne lunge returns to its water launch point.
                        shark.launchX = shark.x; shark.launchY = shark.y;
                        shark.leapReach = Math.min(120, Math.hypot(
                            this.rider.x + this.rider.vx * 0.2 - shark.x,
                            this.rider.y + this.rider.vy * 0.2 - shark.y));
                        shark.leapDuration = Math.max(0.65, 2 * shark.leapReach / this.sharkSpeed);
                    }
                    shark.angle = Math.atan2(aim.y, aim.x) + Math.PI / 2;
                    shark.hasBitten = false;
                    shark.splashAge = 0;
                }
            } else if (shark.state === 'leap') {
                shark.timer += dt;
                // Track early turns, then commit for the last part of the leap.
                if (!shark.shoreLeap && shark.timer <= 0.38) {
                    const aim = this.leapAim(shark, Math.min(0.18, 0.65 - shark.timer));
                    const heading = Math.atan2(shark.leapY, shark.leapX);
                    const target = Math.atan2(aim.y, aim.x);
                    const difference = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));
                    const turn = Math.max(-2.8 * dt, Math.min(2.8 * dt, difference));
                    shark.leapX = Math.cos(heading + turn);
                    shark.leapY = Math.sin(heading + turn);
                    shark.angle = heading + turn + Math.PI / 2;
                }
                const leapX = shark.x + shark.leapX * this.sharkSpeed * dt;
                const leapY = shark.y + shark.leapY * this.sharkSpeed * dt;
                if (shark.shoreLeap) {
                    const progress = Math.min(1, shark.timer / shark.leapDuration);
                    const travel = (1 - Math.abs(2 * progress - 1)) * shark.leapReach;
                    shark.x = shark.launchX + shark.leapX * travel;
                    shark.y = shark.launchY + shark.leapY * travel;
                } else if (this.waterSegmentClear(shark.x, shark.y, leapX, leapY)) {
                    shark.x = leapX; shark.y = leapY;
                } else {
                    this.moveShark(shark, this.rider.x, this.rider.y, this.sharkSpeed * dt);
                }
                if (!this.canPursue(shark) && !shark.shoreLeap) {
                    this.returnToTerritory(shark);
                    continue;
                }
                const biteEnds = shark.shoreLeap ? shark.leapDuration * 0.85 : 0.55;
                if ((!this.onFoot || shark.landAttack) && !shark.hasBitten &&
                    shark.timer >= 0.12 && shark.timer <= biteEnds &&
                    Math.hypot(this.rider.x - shark.x, this.rider.y - shark.y) <= 48) {
                    shark.hasBitten = true;
                    this.takeBite();
                }
                if (shark.timer >= (shark.leapDuration || 0.65)) {
                    shark.state = 'recover';
                    shark.shoreLeap = false;
                    shark.landAttack = false;
                    shark.timer = 0;
                    shark.cooldown = 1.6;
                    shark.splashAge = 0;
                }
            } else if (shark.state === 'recover') {
                shark.timer += dt;
                if (shark.cooldown === 0) shark.state = 'chase';
            }
            shark.x = Math.max(this.margin, Math.min(this.world.width - this.margin, shark.x));
            shark.y = Math.max(this.margin, Math.min(this.world.height - this.margin, shark.y));
        }
    }

    updateCamera() {
        this.camera.x = Math.max(0, Math.min(this.world.width - this.canvas.width,
            this.rider.x - this.canvas.width / 2));
        this.camera.y = Math.max(0, Math.min(this.world.height - this.canvas.height,
            this.rider.y - this.canvas.height / 2));
    }

    updateBoostDisplay() {
        this.boostBar.value = this.boost;
        this.boostAmount.textContent = Math.round(this.boost) + '%';
        this.boostStatus.textContent = this.boosting ? 'BOOSTING' :
            this.boost === 0 ? 'EMPTY' : 'BOOST';
    }

    beginBoost() {
        if (this.gameOver || this.onFoot || this.onPirateShip || this.time < this.boardReadyAt || this.islandCollision || this.boost <= 0 || this.boosting) return;
        this.boosting = true;
        const held = key => this.keys.has(key) || this.touchDirections.has(key);
        let dx = Number(held('d')) - Number(held('a'));
        let dy = Number(held('s')) - Number(held('w'));
        let length = Math.hypot(dx, dy);
        if (!length) {
            dx = this.rider.vx;
            dy = this.rider.vy;
            length = Math.hypot(dx, dy);
        }
        if (!length) {
            dx = Math.sin(this.rider.angle);
            dy = -Math.cos(this.rider.angle);
            length = 1;
        }
        // A real velocity kick makes even the first Q press visible on the MPH gauge.
        const speed = Math.max(this.maxSpeed * 1.4, Math.hypot(this.rider.vx, this.rider.vy));
        this.rider.vx = dx / length * speed;
        this.rider.vy = dy / length * speed;
        this.updateSpeedDisplay();
        this.updateBoostDisplay();
    }

    updateSpeedDisplay() {
        const speed = Math.hypot(this.rider.vx, this.rider.vy);
        this.speedDisplay.textContent = this.onFoot ? 0 : Math.round(speed / this.pixelsPerMeter * 3600 / 1609.344);
    }

    step(dt) {
        if (this.multiplayer && !this.multiplayer.ready) return;
        this.time += dt;
        if (this.muzzleFlash && this.time >= this.muzzleFlash.startedAt + this.muzzleFlash.duration) this.muzzleFlash = null;
        for (const pool of this.blood) pool.life = Math.max(0, pool.life - dt);
        this.blood = this.blood.filter(pool => pool.life > 0);
        if (this.gameOver) return;
        this.survivalSeconds += dt;
        if (this.isSingleplayer) this.updateSurvivalDisplay();
        this.invulnerable = Math.max(0, this.invulnerable - dt);
        this.updateFish(dt);
        const held = key => this.keys.has(key) || this.touchDirections.has(key);
        let dx = Number(held('d')) - Number(held('a'));
        let dy = Number(held('s')) - Number(held('w'));
        const boardLocked = !this.onFoot && this.time - dt < this.boardReadyAt - 1e-8;
        const wantsBoost = held('q') && !this.islandCollision && !this.onFoot && !this.onPirateShip && !boardLocked;
        // Holding an empty tank never refills it: release Q to recharge.
        // Scale the final partial step so a nearly empty tank gives only its remaining thrust.
        const boostFraction = wantsBoost ? Math.min(1, this.boost / (this.boostDrain * dt || 1)) : 0;
        this.boosting = wantsBoost && this.boost > 0;
        if (wantsBoost) this.boost = Math.max(0, this.boost - this.boostDrain * dt);
        else this.boost = Math.min(100, this.boost + this.boostRefill * dt);
        // Q alone drives forward along the current heading; WASD chooses direction.
        if (this.boosting && dx === 0 && dy === 0) {
            dx = Math.sin(this.rider.angle);
            dy = -Math.cos(this.rider.angle);
        }
        const length = Math.hypot(dx, dy);
        if (length > 0) {
            // Diagonal movement has the same top speed as a single direction.
            dx /= length;
            dy /= length;
            if (!this.gameStarted) {
                this.gameStarted = true;
                this.analyticsReady.then(analytics => analytics?.trackEvent('game_start', { mode: 'jet_ski' }))
                    .catch(() => {});
            }
        }
        const targetSpeed = this.maxSpeed + (this.boostSpeed - this.maxSpeed) * boostFraction;
        const blend = 1 - Math.exp(-(length ? (this.boosting ? 12 : 5) : 4) * dt);
        const rider = this.rider;
        const backingOff = !!this.islandCollision;
        if (this.multiplayer) this.multiplayer.controls = { x: dx, y: dy };
        if (this.onPirateShip) {
            if (this.multiplayer) this.syncPirateRider();
            else this.moveCapturedShip(dx, dy, dt);
        } else if (this.onFoot) {
            this.walkOnIsland(dx, dy, dt);
        } else if (boardLocked) {
            rider.vx = rider.vy = 0;
        } else if (backingOff) {
            this.backOffIsland(dx, dy, dt);
        } else {
            rider.vx += (dx * targetSpeed - rider.vx) * blend;
            rider.vy += (dy * targetSpeed - rider.vy) * blend;
            if (!length && Math.hypot(rider.vx, rider.vy) < 0.5) rider.vx = rider.vy = 0;
            rider.x += rider.vx * dt;
            rider.y += rider.vy * dt;
            const x = Math.max(this.margin, Math.min(this.world.width - this.margin, rider.x));
            const y = Math.max(this.margin, Math.min(this.world.height - this.margin, rider.y));
            if (x !== rider.x) rider.vx = 0;
            if (y !== rider.y) rider.vy = 0;
            rider.x = x;
            rider.y = y;
            this.checkIslandCollision();
        }
        this.updateCamera();
        const speed = Math.hypot(rider.vx, rider.vy);
        this.riderStillTime = speed < 5 ? this.riderStillTime + dt : 0;
        if (speed > 1 && !backingOff) {
            const target = Math.atan2(rider.vy, rider.vx) + Math.PI / 2;
            const difference = Math.atan2(Math.sin(target - rider.angle), Math.cos(target - rider.angle));
            rider.angle += difference * (1 - Math.exp(-12 * dt));
        }

        for (const ripple of this.wake) ripple.life -= dt;
        this.wake = this.wake.filter(ripple => ripple.life > 0);
        this.wakeTimer += dt;
        if (!this.onFoot && !this.onPirateShip && speed > 20 && this.wakeTimer >= 0.035) {
            this.wakeTimer = 0;
            this.wake.push({
                x: rider.x - rider.vx / speed * 35,
                y: rider.y - rider.vy / speed * 35,
                angle: Math.atan2(rider.vy, rider.vx),
                life: 1.1
            });
        }
        // Never leave flames on after the final fuel has been spent.
        if (this.boost === 0) this.boosting = false;
        this.updateSpeedDisplay();
        this.updateBoostDisplay();
        if (!this.multiplayer) {
            this.updateProjectiles(dt);
            this.updatePirateShip(dt);
            this.updateCannonballs(dt);
            this.updateSharks(dt);
            this.updateSafeArea(dt);
        }
        this.updateHealthDisplay();
        this.updatePickupPrompt();
    }

    frame(time) {
        const elapsed = this.lastTime === null ? 0 : Math.min((time - this.lastTime) / 1000, 0.05);
        this.lastTime = time;
        this.multiplayer?.advance();
        let remaining = elapsed;
        while (remaining > 0) {
            const dt = Math.min(remaining, 1 / 120);
            this.step(dt);
            remaining -= dt;
        }
        this.draw();
        requestAnimationFrame(nextTime => this.frame(nextTime));
    }

    ellipse(x, y, rx, ry, color) {
        const ctx = this.ctx;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    drawSynthwaveOcean() {
        const ctx = this.ctx;
        const { width, height } = this.canvas;
        const ocean = ctx.createLinearGradient(0, 0, width * 0.2, height);
        ocean.addColorStop(0, '#271047');
        ocean.addColorStop(0.35, '#14164b');
        ocean.addColorStop(1, '#09244c');
        ctx.fillStyle = ocean;
        ctx.fillRect(0, 0, width, height);
    }

    draw() {
        const ctx = this.ctx;
        const { width, height } = this.canvas;
        this.drawSynthwaveOcean();
        if (this.multiplayer && !this.multiplayer.ready) return;
        // Draw only the visible slice of the larger ocean in world coordinates.
        ctx.save();
        ctx.translate(-this.camera.x, -this.camera.y);

        // World-anchored, stepped reflections scroll beneath the rider.
        for (let row = Math.floor(this.camera.y / 34) - 1; row <= Math.ceil((this.camera.y + height) / 34) + 1; row++) {
            for (let col = Math.floor(this.camera.x / 72) - 1; col <= Math.ceil((this.camera.x + width) / 72) + 1; col++) {
                const phase = this.time * 0.9 + row * 1.8 + col * 0.7;
                const x = Math.round((col * 72 + Math.sin(phase) * 8) / 2) * 2;
                const y = row * 34 + Math.round(Math.cos(phase + col) * 3) * 2;
                const bright = (row * 7 + col * 3) % 11 === 0;
                ctx.fillStyle = bright ? 'rgba(232, 61, 220, 0.55)' : 'rgba(94, 87, 205, 0.27)';
                ctx.fillRect(x, y, 18 + (Math.sin(phase) + 1) * 14, 2);
                ctx.fillStyle = bright ? 'rgba(61, 229, 255, 0.35)' : 'rgba(53, 85, 172, 0.22)';
                ctx.fillRect(x + 8, y + 4, 12, 2);
            }
        }
        this.drawIslands();
        this.drawFish();
        this.drawBlood();
        for (const gun of this.floatingGuns) {
            if (!this.isOnScreen(gun)) continue;
            const bob = Math.sin(this.time * 2.5 + gun.x) * 4;
            this.ellipse(gun.x, gun.y + 6, 25, 14, 'rgba(222, 255, 246, 0.25)');
            this.drawGun(gun.x, gun.y + bob, -0.3);
        }
        // Spaced navigation buoys make travel through the larger ocean visible.
        for (let row = Math.max(1, Math.floor(this.camera.y / 500)); row <= Math.min(7, Math.ceil((this.camera.y + height) / 500)); row++) {
            for (let col = Math.max(1, Math.floor(this.camera.x / 500)); col <= Math.min(11, Math.ceil((this.camera.x + width) / 500)); col++) {
                const x = col * 500;
                const y = row * 500;
                this.ellipse(x + 3, y + 5, 12, 12, 'rgba(0, 40, 60, 0.2)');
                ctx.save(); ctx.shadowColor = '#ff38d1'; ctx.shadowBlur = 12;
                this.ellipse(x, y, 13, 13, '#b537ee');
                this.ellipse(x, y - 3, 10, 10, '#ff5cbf');
                ctx.restore();
                this.ellipse(x, y - 7, 6, 6, '#ffd26b');
            }
        }
        ctx.strokeStyle = 'rgba(137, 110, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([14, 18]);
        ctx.strokeRect(35, 35, this.world.width - 70, this.world.height - 70);
        ctx.setLineDash([]);
        for (const ripple of this.wake) {
            const age = 1.1 - ripple.life;
            ctx.save();
            ctx.translate(ripple.x, ripple.y);
            ctx.rotate(ripple.angle);
            ctx.strokeStyle = 'rgba(105, 245, 255, ' + ripple.life / 1.1 * 0.9 + ')';
            ctx.shadowColor = '#29e6ff'; ctx.shadowBlur = 6;
            ctx.lineWidth = 3.5;
            ctx.beginPath();
            ctx.moveTo(-age * 20, -7 - age * 18);
            ctx.quadraticCurveTo(age * 10, 0, -age * 20, 7 + age * 18);
            ctx.stroke();
            ctx.restore();
        }
        for (const shark of this.sharks) {
            if (this.isOnScreen(shark) && shark.state !== 'dead' && shark.state !== 'leap' && this.isPointLit(shark.x, shark.y)) this.drawShark(shark);
        }
        if (this.onPirateShip) {
            this.drawJetSki(this.parkedBoat, false);
        } else if (this.onFoot) {
            this.drawJetSki(this.parkedBoat, false);
            this.drawWalkingRider();
        } else this.drawJetSki();
        if (this.inventory[this.selectedSlot] && !['cannon', 'coconut'].includes(this.inventory[this.selectedSlot].type)) {
            const angle = this.aimAngle();
            this.drawGun(this.rider.x + Math.cos(angle) * 26, this.rider.y + Math.sin(angle) * 26, angle);
        }
        this.multiplayer?.draw();
        this.drawMuzzleFire();
        for (const shark of this.sharks) {
            if (this.isOnScreen(shark) && shark.state === 'leap' && this.isPointLit(shark.x, shark.y)) this.drawShark(shark);
        }
        for (const shot of this.projectiles) {
            ctx.save(); ctx.translate(shot.x, shot.y); ctx.rotate(Math.atan2(shot.vy, shot.vx));
            ctx.strokeStyle = '#dcecf0'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(-32, 0); ctx.lineTo(-5, 0); ctx.stroke();
            this.sharkShape([[0, 0], [-9, -4], [-9, 4]], '#e6f4f5');
            this.sharkShape([[-29, 0], [-34, -3], [-34, 3]], '#efa85b');
            ctx.restore();
        }
        if (this.aim.active && this.inventory[this.selectedSlot] && this.inventory[this.selectedSlot].type !== 'coconut' && !this.gameOver) {
            const x = this.camera.x + this.aim.u * width;
            const y = this.camera.y + this.aim.v * height;
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.moveTo(x - 12, y); ctx.lineTo(x - 4, y);
            ctx.moveTo(x + 4, y); ctx.lineTo(x + 12, y);
            ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 4);
            ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 12);
            ctx.stroke();
        }
        ctx.restore();
        this.drawNightLighting();
        ctx.save(); ctx.translate(-this.camera.x, -this.camera.y);
        for (const shark of this.sharks) {
            if (shark.state !== 'dead' && this.isOnScreen(shark) && !this.isPointLit(shark.x, shark.y)) this.drawHiddenSharkRipples(shark);
        }
        // Lantern-lit hull and burning cannonballs remain readable in the night.
        this.drawPirateShip();
        this.drawCannonballs();
        this.drawSafeArea(ctx);
        ctx.restore();
        if (this.invulnerable > 0 && !this.gameOver) {
            ctx.fillStyle = 'rgba(255, 106, 83, ' + (0.08 + Math.sin(this.time * 25) * 0.04) + ')';
            ctx.fillRect(0, 0, width, height);
        }
        this.drawMinimap();
    }

    drawMinimap() {
        const ctx = this.minimapContext, { width, height } = this.minimapCanvas;
        const sx = width / this.world.width, sy = height / this.world.height;
        ctx.save();
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#10233e'; ctx.fillRect(0, 0, width, height);
        this.drawSafeArea(ctx, sx, sy);
        ctx.strokeStyle = 'rgba(143, 245, 255, 0.55)'; ctx.lineWidth = 1;
        ctx.strokeRect(this.camera.x * sx, this.camera.y * sy,
            Math.min(this.canvas.width, this.world.width - this.camera.x) * sx,
            Math.min(this.canvas.height, this.world.height - this.camera.y) * sy);
        const ship = this.pirateShip;
        ctx.save(); ctx.translate(ship.x * sx, ship.y * sy); ctx.rotate(ship.angle);
        ctx.fillStyle = ship.disarmed ? '#ffd684' : '#ff8a63';
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -3); ctx.lineTo(-4, 3); ctx.closePath(); ctx.fill(); ctx.restore();
        ctx.translate(this.rider.x * sx, this.rider.y * sy); ctx.rotate(this.rider.angle);
        ctx.fillStyle = '#8ff5ff'; ctx.strokeStyle = '#0b1730'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(0, 3); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
    }

    drawMuzzleFire() {
        const flash = this.muzzleFlash;
        if (!flash) return;
        const age = this.time - flash.startedAt;
        if (age < 0 || age >= flash.duration) return;
        const ctx = this.ctx;
        const fade = 1 - age / flash.duration;
        const length = (32 + Math.sin(age * 100) * 6) * (0.4 + fade * 0.6);
        ctx.save();
        ctx.translate(flash.x, flash.y);
        ctx.rotate(flash.angle);
        ctx.globalAlpha = fade;
        ctx.shadowColor = '#ff822c'; ctx.shadowBlur = 14;
        for (const [scale, width, color] of [[1, 9, '#ff6b25'], [0.7, 5, '#ffc64a'], [0.4, 2.5, '#fff6cd']]) {
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.moveTo(0, -width);
            ctx.lineTo(length * scale * 0.45, -width * 0.5);
            ctx.lineTo(length * scale, Math.sin(age * 130) * width * 0.3);
            ctx.lineTo(length * scale * 0.45, width * 0.5);
            ctx.lineTo(0, width); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
    }

    drawGun(x, y, angle) {
        const ctx = this.ctx;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
        ctx.fillStyle = '#a47549'; ctx.fillRect(-20, -3, 34, 6);
        this.sharkShape([[-14, 2], [-5, 2], [-8, 13], [-16, 12]], '#60472e');
        ctx.strokeStyle = '#36c8cf'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-8, -6); ctx.lineTo(18, -2);
        ctx.moveTo(-8, 6); ctx.lineTo(18, 2); ctx.stroke();
        ctx.strokeStyle = '#e2eef0'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(-15, 0); ctx.lineTo(22, 0); ctx.stroke();
        this.sharkShape([[27, 0], [19, -4], [19, 4]], '#e2eef0');
        ctx.restore();
    }

    drawBlood() {
        const ctx = this.ctx;
        for (const pool of this.blood) {
            const age = this.bloodLifetime - pool.life;
            const radius = 35 + Math.min(4, age) * 12;
            if (pool.x + radius < this.camera.x || pool.x - radius > this.camera.x + this.canvas.width ||
                pool.y + radius < this.camera.y || pool.y - radius > this.camera.y + this.canvas.height) continue;
            ctx.save();
            ctx.translate(pool.x, pool.y);
            ctx.globalAlpha = pool.life / this.bloodLifetime;
            // Overlapping soft lobes spread and fade like a cloud in the water.
            for (let i = 0; i < 5; i++) {
                const angle = i * Math.PI * 2 / 5;
                const x = Math.cos(angle) * radius * 0.25;
                const y = Math.sin(angle) * radius * 0.18;
                const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 0.7);
                gradient.addColorStop(0, 'rgba(182, 20, 44, 0.55)');
                gradient.addColorStop(0.5, 'rgba(169, 21, 50, 0.28)');
                gradient.addColorStop(1, 'rgba(169, 21, 50, 0)');
                this.ellipse(x, y, radius * 0.7, radius * 0.5, gradient);
            }
            ctx.restore();
        }
    }

    sharkShape(points, color) {
        const ctx = this.ctx;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(...points[0]);
        for (const point of points.slice(1)) ctx.lineTo(...point);
        ctx.closePath();
        ctx.fill();
    }

    drawShark(shark) {
        if (shark.state === 'dead' || !this.isPointLit(shark.x, shark.y)) return;
        const ctx = this.ctx;
        const jumping = shark.state === 'leap';
        const lift = jumping ? Math.sin(Math.min(1, shark.timer / (shark.leapDuration || 0.65)) * Math.PI) : 0;
        ctx.save();
        this.clipToLight(ctx);
        ctx.translate(shark.x, shark.y);
        if (shark.state === 'windup') {
            ctx.strokeStyle = '#ffb468';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(0, 0, 58 + Math.sin(this.time * 25) * 4, 0, Math.PI * 2); ctx.stroke();
        }
        if (shark.splashAge < 0.5) {
            ctx.strokeStyle = 'rgba(225, 255, 252, ' + (1 - shark.splashAge * 2) + ')';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.ellipse(0, 0, 25 + shark.splashAge * 95, 17 + shark.splashAge * 65, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.save();
        ctx.rotate(shark.angle);
        this.ellipse(5, 7, 20 + lift * 5, 47, 'rgba(0, 35, 55, 0.24)');
        ctx.restore();
        ctx.translate(0, -lift * 22);
        ctx.rotate(shark.angle);
        ctx.scale(1 + lift * 0.25, 1 + lift * 0.25);
        const tail = Math.sin(this.time * 10 + shark.id) * 6;
        this.sharkShape([[0, 25], [-20 + tail, 54], [tail, 44], [20 + tail, 54]], '#6654ac');
        this.sharkShape([[-10, -8], [-38, 14], [-11, 8]], '#7f69bd');
        this.sharkShape([[10, -8], [38, 14], [11, 8]], '#7f69bd');
        ctx.fillStyle = this.time < shark.hitUntil ? '#f3d3ae' : jumping ? '#c4b4fa' : '#a295dc';
        ctx.beginPath(); ctx.moveTo(0, -48);
        ctx.bezierCurveTo(21, -35, 23, 8, 0, 39);
        ctx.bezierCurveTo(-23, 8, -21, -35, 0, -48); ctx.fill();
        this.sharkShape([[-4, -11], [7, 12], [-7, 7]], '#52458e');
        this.ellipse(-8, -28, 2, 2, '#102938');
        this.ellipse(8, -28, 2, 2, '#102938');
        if (jumping) {
            this.ellipse(0, -36, 9, 7, '#334854');
            for (const x of [-5, 0, 5]) {
                this.sharkShape([[x - 2, -41], [x + 2, -41], [x, -35]], '#ffffff');
                this.sharkShape([[x - 2, -31], [x + 2, -31], [x, -36]], '#ffffff');
            }
        }
        ctx.restore();
    }

    drawBoostFlame() {
        if (!this.boosting || this.boost <= 0) return;
        const ctx = this.ctx;
        const flicker = Math.sin(this.time * 65) * 8 + Math.sin(this.time * 103) * 4;
        ctx.save();
        ctx.shadowColor = '#2eefff';
        ctx.shadowBlur = 18;
        // Local +Y is behind the ski; rotating the ski rotates the exhaust too.
        for (const [width, length, color] of [[14, 65 + flicker, '#9d35ff'], [9, 46 + flicker * 0.7, '#20e4ff'], [4, 25 + flicker * 0.3, '#edffff']]) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(-width, 34);
            ctx.quadraticCurveTo(-width * 0.8, 56, Math.sin(this.time * 48) * 4, 34 + length);
            ctx.quadraticCurveTo(width * 0.8, 56, width, 34);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    drawWalkingRider() {
        const ctx = this.ctx;
        const { x, y, angle, vx, vy } = this.rider;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
        this.ellipse(2, 6, 11, 16, 'rgba(20, 8, 43, 0.25)');
        const stride = Math.hypot(vx, vy) > 1 ? Math.sin(this.time * 13) * 3 : 0;
        ctx.strokeStyle = '#38245e'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(-4, 5); ctx.lineTo(-5, 14 + stride);
        ctx.moveTo(4, 5); ctx.lineTo(5, 14 - stride); ctx.stroke();
        this.ellipse(0, 1, 8, 11, '#34d5e8');
        ctx.strokeStyle = '#f2c4a0'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(-7, -2); ctx.lineTo(-10, 6 - stride);
        ctx.moveTo(7, -2); ctx.lineTo(10, 6 + stride); ctx.stroke();
        this.ellipse(0, -10, 6.5, 7, '#f2c4a0');
        this.ellipse(0, -13, 6.5, 4, '#542966');
        ctx.restore();
    }

    drawJetSki(boat = this.rider, occupied = true) {
        const ctx = this.ctx;
        const { x, y, angle } = boat;
        ctx.save();
        ctx.translate(x + 5, y + 7);
        ctx.rotate(angle);
        this.ellipse(0, 0, 22, 49, 'rgba(0, 39, 66, 0.23)');
        ctx.restore();
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        if (occupied) this.drawBoostFlame();
        // The pointed bow faces up before rotation.
        ctx.fillStyle = '#e63bbe'; ctx.shadowColor = '#36eaff'; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(0, -48);
        ctx.bezierCurveTo(18, -32, 23, 10, 17, 36);
        ctx.quadraticCurveTo(0, 46, -17, 36);
        ctx.bezierCurveTo(-23, 10, -18, -32, 0, -48);
        ctx.fill();
        ctx.strokeStyle = '#7ff8ff'; ctx.lineWidth = 2.5; ctx.stroke(); ctx.shadowBlur = 0;
        this.ellipse(0, -13, 13, 26, '#6b31a8');
        this.ellipse(0, 17, 11, 19, '#221b58');
        ctx.fillStyle = '#37dff4';
        ctx.fillRect(-4, -37, 8, 25);
        // Rider's legs, life jacket, arms reaching forward, and head.
        if (occupied) {
        ctx.strokeStyle = '#172c41';
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-6, 7); ctx.lineTo(-13, 24);
        ctx.moveTo(6, 7); ctx.lineTo(13, 24);
        ctx.stroke();
        this.ellipse(0, 5, 11, 16, '#34d5e8');
        ctx.strokeStyle = '#f2c4a0';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-8, -3); ctx.lineTo(-14, -16);
        ctx.moveTo(8, -3); ctx.lineTo(14, -16);
        ctx.stroke();
        ctx.strokeStyle = '#18364b';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(-16, -18); ctx.lineTo(16, -18); ctx.stroke();
        this.ellipse(0, -9, 8, 9, '#f2c4a0');
        this.ellipse(0, -12, 8, 6, '#542966');
        }
        ctx.restore();
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Game };
else document.myGame = new Game();
