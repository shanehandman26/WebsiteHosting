const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomWorld } = require('../server/room-world.cjs');

function fixture() {
    const world = new RoomWorld();
    world.islands = []; world.navigation = null; world.floatingGuns = [];
    world.pirateShip.x = 1000; world.pirateShip.y = 500;
    const a = world.addPlayer('a'), b = world.addPlayer('b');
    world.phase = 'running'; // Combat fixtures choose exact positions; lobby tests exercise start().
    a.invulnerable = b.invulnerable = 0;
    return { world, a, b };
}

test('only the host can start, and the lobby blocks movement, combat and the game clock', () => {
    const world = new RoomWorld();
    const host = world.addPlayer('host'), guest = world.addPlayer('guest');
    const before = JSON.stringify(world.snapshot());
    world.stepWorld(30);
    world.updatePlayer('guest', { ...guest.pose, x: 3100 }, 0, 0);
    for (const action of ['start', 'fire', 'interact', 'respawn']) {
        assert.equal(world.action('guest', { action, slot: 0, angle: 0 }), false);
    }
    assert.equal(guest.pose.x, 3000);
    assert.equal(world.time, 0);
    assert.equal(JSON.stringify(world.snapshot()), before);
    assert.equal(world.action('host', { action: 'start' }), true);
    assert.equal(world.phase, 'running');
    assert.equal(host.generation, 1);
    assert.equal(host.poseRevision, 1);
    const position = { ...host.pose };
    assert.equal(world.action('host', { action: 'start' }), false);
    assert.deepEqual(host.pose, position);
    world.stepWorld(1 / 60);
    assert.ok(world.time > 0);
});

test('sixteen players start in separated safe locations and late joiners cannot enter the active round', () => {
    const world = new RoomWorld();
    for (let i = 0; i < 16; i++) world.addPlayer('p' + i);
    world.start('p0');
    const players = [...world.players.values()];
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        assert.equal(world.pointOnLand(p.pose.x, p.pose.y, world.boatRadius + 40), false);
        assert.ok(p.pose.x >= 600 && p.pose.x <= 5400 && p.pose.y >= 680 && p.pose.y <= 3320);
        for (const shark of world.sharks) assert.ok(Math.hypot(p.pose.x - shark.x, p.pose.y - shark.y) >= 220);
        for (let j = i + 1; j < players.length; j++) {
            assert.ok(Math.hypot(p.pose.x - players[j].pose.x, p.pose.y - players[j].pose.y) >= 500);
        }
    }
    const host = world.hostId;
    assert.equal(world.action(host, { action: 'respawn' }), false);
    assert.equal(world.hostId, host);
    world.removePlayer('p15');
    const late = world.addPlayer('late');
    assert.equal(late.spectator, true);
    assert.equal(late.gameOver, true);
});

test('the next connected player becomes host when the host leaves the lobby', () => {
    const world = new RoomWorld();
    world.addPlayer('host'); world.addPlayer('next'); world.addPlayer('third');
    world.removePlayer('host');
    assert.equal(world.phase, 'waiting');
    assert.equal(world.hostId, 'next');
    assert.equal(world.start('host'), false);
    assert.equal(world.start('next'), true);
});

test('one room owns immutable island geometry and current world data for late joiners', () => {
    const world = new RoomWorld();
    const terrain = JSON.stringify(world.layout.map(({ coconuts, ...island }) => island));
    world.addPlayer('host');
    world.sharks[0].health = 1;
    world.pirateShip.hits = 9;
    world.floatingGuns.pop();
    const late = world.addPlayer('late');
    const snapshot = world.snapshot();
    assert.equal(snapshot.sharks[0].health, 1);
    assert.equal(snapshot.pirateShip.hits, 9);
    assert.equal(snapshot.guns.length, 5);
    assert.equal(late.health, 100);
    assert.equal(JSON.stringify(world.islands.map(({ coconuts, ...island }) => island)), terrain);
    assert.equal(snapshot.sharks[0].routeIslands, undefined, 'Navigation caches are not sent over the network');
});

test('chest loot is server-owned and only one player can claim its firecracker', () => {
    const world = new RoomWorld();
    const a = world.addPlayer('a'), b = world.addPlayer('b');
    world.start('a');
    const index = world.islands.findIndex(island => island.chests.length > 0);
    const island = world.islands[index], chest = island.chests[0];
    for (const p of [a, b]) {
        p.onFoot = true; p.walkIsland = island;
        Object.assign(p.pose, { x: island.x + chest.x, y: island.y + chest.y });
    }
    assert.equal(world.action('a', { action: 'open_chest' }), true);
    assert.equal(chest.opened, true);
    assert.equal(world.action('b', { action: 'open_chest' }), false);
    assert.equal(a.inventory.every(item => item === null), true);
    assert.equal(b.inventory.every(item => item === null), true);
    assert.equal(chest.items.length, 0);
    assert.equal(world.loot.length, 1);
    assert.equal(world.snapshot().loot[0].durability, 5);
    for (const p of [a, b]) Object.assign(p.pose, { x: world.loot[0].x, y: world.loot[0].y });
    world.time += 0.2;
    world.action('a', { action: 'interact' });
    world.action('b', { action: 'interact' });
    assert.equal(a.inventory.filter(item => item?.type === 'firecracker').length, 1);
    assert.equal(b.inventory.filter(item => item?.type === 'firecracker').length, 0);
    assert.equal(world.loot.length, 0);
    world.addPlayer('late');
    assert.equal(world.snapshot().chests[index][0].opened, true);
    assert.equal(world.layout[index].chests[0].opened, false, 'Immutable layout keeps the original chest position');
});

test('shared firecracker shots consume five ammo and their bouncing damage and effects come from the server', () => {
    const { world, a } = fixture();
    world.start('a');
    Object.assign(a.pose, { x: 3000, y: 2000, angle: Math.PI / 2 });
    const shark = world.sharks[0];
    world.sharks = [shark]; Object.assign(shark, { x: 3100, y: 2000, health: 3, state: 'chase' });
    a.inventory[0] = { id: 'firecracker-shared', type: 'firecracker', name: 'Firecracker', durability: 5 };
    world.action('a', { action: 'fire', slot: 0, angle: 0 });
    assert.equal(a.inventory[0].durability, 4);
    assert.equal(world.projectiles[0].type, 'firecracker');
    assert.equal(world.projectiles[0].shooter, 'a');
    world.updateProjectiles(1.5);
    assert.equal(shark.health, 1);
    assert.equal(world.snapshot().fireworkBursts.length, 3);
    for (let i = 0; i < 4; i++) { world.time += 0.21; world.action('a', { action: 'fire', slot: 0, angle: 0 }); }
    assert.equal(a.inventory[0], null);
});

test('sharks choose the nearest living rider and switch when that rider dies', () => {
    const { world, a, b } = fixture();
    const shark = world.sharks[0];
    Object.assign(shark, { x: 3000, y: 2000, state: 'chase' });
    Object.assign(a.pose, { x: 3300, y: 2000 });
    Object.assign(b.pose, { x: 3200, y: 2000 });
    world.stepWorld(1 / 60);
    assert.equal(shark.targetId, 'b');
    assert.ok(shark.x > 3000);
    b.gameOver = true;
    world.stepWorld(1 / 60);
    assert.equal(shark.targetId, 'a');
});

test('a shared shark bite damages only its victim and death does not freeze the room', () => {
    const { world, a, b } = fixture();
    const shark = world.sharks[0]; world.sharks = [shark];
    Object.assign(shark, { x: 3000, y: 2000, state: 'leap', timer: 0.2, leapX: 1, leapY: 0, hasBitten: false });
    Object.assign(b.pose, { x: 3400, y: 2000 });
    a.health = 25;
    world.stepWorld(1 / 60);
    assert.equal(a.health, 0);
    assert.equal(a.gameOver, true);
    assert.equal(a.cause, 'Shark Attack');
    assert.equal(b.health, 100);
    const time = world.time;
    world.stepWorld(1 / 60);
    assert.ok(world.time > time);
    assert.equal(shark.targetId, 'b');
});

test('simultaneous pickup attempts grant one gun to exactly one player', () => {
    const { world, a, b } = fixture();
    world.floatingGuns = [{ id: 'shared-gun', name: 'Spear gun', x: 3000, y: 2000, durability: 12 }];
    world.action('a', { action: 'interact', slot: 0 });
    world.action('b', { action: 'interact', slot: 0 });
    assert.equal(a.inventory[0].id, 'shared-gun');
    assert.ok(b.inventory.every(item => item === null));
    assert.equal(world.floatingGuns.length, 0);
    assert.equal(world.personal('a').inventory[0].durability, 12);
});

test('coconuts disappear for everyone, and eating heals only the owner once', () => {
    const { world, a, b } = fixture();
    const island = { x: 3000, y: 2000, radius: 170, points: [[-120, -120], [120, -120], [120, 120], [-120, 120]],
        palms: [], coconuts: [{ id: 'coconut-test', x: 0, y: 0 }] };
    world.islands = [island];
    for (const p of [a, b]) {
        p.onFoot = true; p.walkIsland = island;
        p.parkedBoat = { x: 2800, y: 2000, angle: 0 }; p.health = 70;
    }
    world.action('a', { action: 'interact' });
    world.action('b', { action: 'interact' });
    assert.equal(a.inventory[0].type, 'coconut');
    assert.ok(b.inventory.every(item => !item));
    assert.equal(world.snapshot().coconuts[0].length, 0);
    world.time += 0.2;
    world.action('a', { action: 'interact' });
    assert.equal(a.health, 82);
    assert.equal(b.health, 70);
    assert.equal(a.inventory[0], null);
});

test('the server validates guns, resolves hits once, and respawns the same shark after ten seconds', () => {
    const { world, a, b } = fixture();
    Object.assign(b.pose, { x: 3500, y: 2500 });
    const shark = world.sharks[0]; world.sharks = [shark];
    Object.assign(shark, { x: 3100, y: 2000, state: 'chase' });
    world.action('a', { action: 'fire', slot: 0, angle: 0 });
    assert.equal(world.projectiles.length, 0, 'A client cannot shoot without a gun');
    a.inventory[0] = { id: 'gun-test', name: 'Spear gun', durability: 12 };
    for (let i = 0; i < 3; i++) {
        world.action('a', { action: 'fire', slot: 0, angle: 0 });
        world.updateProjectiles(0.1);
        world.time += 0.21;
    }
    assert.equal(shark.state, 'dead');
    assert.equal(shark.health, 0);
    assert.equal(a.inventory[0].durability, 9);
    world.time = shark.respawnAt - 0.02;
    world.stepWorld(0.01);
    assert.equal(shark.state, 'dead');
    world.stepWorld(0.01);
    assert.equal(world.sharks.length, 1);
    assert.equal(world.sharks[0], shark);
    assert.equal(shark.health, 3);
    assert.equal(shark.state, 'patrol');
});

test('a broken gun creates one shared replacement and cannot fire again', () => {
    const { world, a } = fixture();
    a.inventory[0] = { id: 'last-shot', name: 'Spear gun', durability: 1 };
    world.action('a', { action: 'fire', slot: 0, angle: 0 });
    assert.equal(a.inventory[0], null);
    assert.equal(world.projectiles.length, 1);
    assert.equal(world.floatingGuns.length, 1);
    world.time += 1;
    world.action('a', { action: 'fire', slot: 0, angle: 0 });
    assert.equal(world.projectiles.length, 1);
    assert.equal(world.floatingGuns.length, 1);
});

test('respawn requests cannot revive an eliminated player or reset the room', () => {
    const { world, a, b } = fixture();
    a.gameOver = true; a.health = 0; b.health = 50;
    const before = JSON.stringify(world.snapshot());
    assert.equal(world.action('a', { action: 'respawn' }), false);
    assert.equal(a.health, 0);
    assert.equal(a.gameOver, true);
    assert.equal(b.health, 50);
    assert.equal(JSON.stringify(world.snapshot()), before);
});

test('only one player can pilot the captured ship, with shared movement and cannon fire', () => {
    const { world, a, b } = fixture();
    world.sharks = [];
    Object.assign(world.pirateShip, { x: 3000, y: 2000, disarmed: true, hits: 16 });
    world.action('a', { action: 'interact' });
    world.action('b', { action: 'interact' });
    assert.equal(world.pilotId, 'a');
    assert.equal(a.onPirateShip, true);
    assert.equal(b.onPirateShip, false);
    world.updatePlayer('a', a.pose, a.poseRevision, a.selectedSlot, { x: 1, y: 0 });
    world.stepWorld(0.1);
    assert.ok(world.pirateShip.x > 3000);
    world.action('a', { action: 'fire', slot: a.selectedSlot, angle: 0.5 });
    assert.equal(world.cannonballs.length, 1);
    assert.equal(world.cannonballs[0].owner, 'player');
    assert.ok(Math.abs(Math.atan2(world.cannonballs[0].vy, world.cannonballs[0].vx) - 0.5) < 1e-10);
    assert.equal(world.snapshot().pilotId, 'a');
    world.removePlayer('a');
    assert.equal(world.pilotId, null);
    assert.equal(world.pirateShip.disarmed, true);
});

test('pirate attacks target the nearest player and server cannonballs apply damage once', () => {
    const { world, a, b } = fixture();
    world.sharks = []; world.steerPirateShip = () => {};
    Object.assign(world.pirateShip, { x: 2800, y: 2000, fireTimer: 2.99 });
    Object.assign(b.pose, { x: 3500, y: 2000 });
    world.stepWorld(0.02);
    assert.equal(world.pirateShip.targetId, 'a');
    assert.equal(world.cannonballs.length, 1);
    const ball = world.cannonballs[0];
    assert.ok(ball.vx > 0);
    world.advanceCannonballs(2);
    assert.equal(a.health, 25);
    assert.equal(b.health, 100);
    assert.equal(world.cannonballs.length, 0);
    world.advanceCannonballs(2);
    assert.equal(a.health, 25);
});

test('stale pre-start position messages cannot undo the server spawn correction', () => {
    const world = new RoomWorld();
    const a = world.addPlayer('a'); world.addPlayer('b');
    world.start('a');
    const x = a.pose.x;
    world.updatePlayer('a', { ...a.pose, x: 3400 }, 0, 0);
    assert.equal(a.pose.x, x);
    world.updatePlayer('a', { ...a.pose, x: x + 5 }, a.poseRevision, 0);
    assert.equal(a.pose.x, x + 5);
});

test('pirate movement cannot cut across a shoreline chord between multiple route waypoints', () => {
    const original = Math.random;
    let seed = 7;
    Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    try {
        const world = new RoomWorld(), ship = world.pirateShip;
        for (let i = 0; i < 800; i++) {
            const x = ship.x, y = ship.y;
            world.steerPirateShip(0.25);
            assert.equal(world.waterSegmentClear(x, y, ship.x, ship.y, ship.clearance), true);
            assert.equal(world.piratePoseClear(ship.x, ship.y, ship.angle), true);
        }
    } finally { Math.random = original; }
});
