const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomWorld } = require('../server/room-world.cjs');

function fixture() {
    const world = new RoomWorld();
    const a = world.addPlayer('alpha'), b = world.addPlayer('bravo'), c = world.addPlayer('charlie');
    world.start(a.id);
    world.islands = []; world.sharks = []; world.floatingGuns = [];
    Object.assign(world.pirateShip, { x: 500, y: 500 });
    Object.assign(a.pose, { x: 3000, y: 2000, vx: 0, vy: 0 });
    Object.assign(b.pose, { x: 3100, y: 2000, vx: 0, vy: 0 });
    Object.assign(c.pose, { x: 3500, y: 2500, vx: 0, vy: 0 });
    return { world, a, b, c };
}
const spear = shooter => ({ x: 3043, y: 2000, vx: 1100, vy: 0, life: 1.2, shooter });

test('spear shots deal 25 health, are consumed on impact, and permanently eliminate after four hits', () => {
    const { world, a, b } = fixture();
    for (let i = 1; i <= 4; i++) {
        world.projectiles.push(spear(a.id)); world.updateProjectiles(0.1);
        assert.equal(b.health, 100 - i * 25);
        assert.equal(a.health, 100);
        assert.equal(world.projectiles.length, 0);
    }
    assert.equal(b.gameOver, true);
    assert.match(b.cause, /Spear hit/);
    assert.equal(world.action(b.id, { action: 'respawn' }), false);
    assert.equal(world.action(b.id, { action: 'fire', angle: 0 }), false);
    world.updatePlayer(b.id, { ...b.pose, x: 3300, dead: false }, b.poseRevision, 0);
    assert.equal(b.pose.x, 3100);
    assert.equal(b.gameOver, true);
});

test('a swept spear hits the nearest player or enemy once, without shooting through either', () => {
    const { world, a, b, c } = fixture();
    Object.assign(c.pose, { x: 3200, y: 2000 });
    world.projectiles.push(spear(a.id)); world.updateProjectiles(0.3);
    assert.equal(b.health, 75); assert.equal(c.health, 100);
    const shark = world.createSharks()[0];
    Object.assign(shark, { x: 3060, y: 2000, health: 3 }); world.sharks = [shark];
    world.projectiles.push(spear(a.id)); world.updateProjectiles(0.3);
    assert.equal(shark.health, 2); assert.equal(b.health, 75);
});

test('cannonballs deal 75 damage and skip their shooter', () => {
    const { world, a, b, c } = fixture();
    for (let i = 0; i < 2; i++) {
        world.cannonballs.push({ x: 3000, y: 2000, vx: 320, vy: 0, life: 30, owner: 'player', shooter: a.id });
        world.advanceCannonballs(1);
    }
    assert.equal(a.health, 100); assert.equal(b.health, 0); assert.equal(b.gameOver, true);
    assert.equal(c.health, 100); assert.equal(world.cannonballs.length, 0);
});

test('pirate-ship drivers can be hit and eliminated by player weapons', () => {
    const { world, a, b } = fixture();
    Object.assign(world.pirateShip, { x: b.pose.x, y: b.pose.y, disarmed: true, hits: 16 });
    b.onPirateShip = true; world.pilotId = b.id;
    b.parkedBoat = { x: 3100, y: 2100, angle: 0 };
    world.projectiles.push(spear(a.id)); world.updateProjectiles(0.1);
    assert.equal(b.health, 75); assert.equal(world.pilotId, b.id);
    world.cannonballs.push({ x: 3043, y: 2000, vx: 320, vy: 0, life: 30, owner: 'player', shooter: a.id });
    world.advanceCannonballs(0.5);
    assert.equal(b.health, 0); assert.equal(b.gameOver, true); assert.equal(world.pilotId, null);
});

test('firecrackers can hit a driver but damage each player only once across their bounces', () => {
    const { world, a, b } = fixture();
    Object.assign(world.pirateShip, { x: b.pose.x, y: b.pose.y, disarmed: true });
    b.onPirateShip = true; world.pilotId = b.id;
    const shot = { x: b.pose.x, y: b.pose.y, shooter: a.id, hitTargets: [] };
    world.firecrackerImpact(shot); world.firecrackerImpact(shot); world.firecrackerImpact(shot);
    assert.equal(b.health, 75); assert.equal(a.health, 100);
    assert.equal(shot.hitTargets.filter(id => id === 'player-' + b.id).length, 1);
});

test('firecrackers trigger on swept player contact rather than passing through a rider', () => {
    const { world, a, b } = fixture();
    world.projectiles.push({ ...spear(a.id), type: 'firecracker', vx: 650, life: 1.5,
        impacts: 0, hopRemaining: 0.42, hitTargets: [] });
    world.updateProjectiles(0.2);
    assert.equal(b.health, 75);
    assert.ok(world.fireworkBursts.length > 0);
});

test('the last surviving player wins once, and the finished world stops advancing', () => {
    const { world, a, b, c } = fixture();
    world.damagePlayer(b, 100, 'Spear hit', a.id);
    world.checkWinner(); assert.equal(world.phase, 'running');
    world.damagePlayer(c, 100, 'Spear hit', a.id);
    world.checkWinner();
    assert.equal(world.phase, 'finished'); assert.equal(world.result.winnerId, a.id);
    assert.equal(world.result.winnerLabel, 'Rider alph');
    const time = world.time, result = { ...world.result };
    world.stepWorld(10); world.checkWinner();
    assert.equal(world.time, time); assert.deepEqual(world.result, result);
    assert.equal(world.action(a.id, { action: 'fire', angle: 0 }), false);
});

test('disconnecting counts as elimination and does not let an eliminated player rejoin alive', () => {
    const { world, a, b, c } = fixture();
    world.removePlayer(b.id);
    assert.equal(world.phase, 'running');
    const reconnect = world.addPlayer('bravo-reconnect');
    assert.equal(reconnect.spectator, true); assert.equal(reconnect.gameOver, true);
    Object.assign(reconnect.pose, { x: 3070, y: 2000 });
    world.projectiles.push(spear(a.id)); world.updateProjectiles(0.1);
    assert.equal(reconnect.health, 0, 'Spectators cannot absorb live projectiles');
    world.removePlayer(c.id);
    assert.equal(world.result.winnerId, a.id);
});

test('two players are required and only the host can start a clean new round in the same room', () => {
    const solo = new RoomWorld(); solo.addPlayer('solo'); assert.equal(solo.start('solo'), false);
    const { world, a, b, c } = fixture();
    const geometry = JSON.stringify(world.layout);
    world.damagePlayer(b, 100, 'Hit', a.id); world.damagePlayer(c, 100, 'Hit', a.id); world.checkWinner();
    const late = world.addPlayer('late'); assert.equal(late.spectator, true);
    const generation = b.generation;
    assert.equal(world.nextRound(b.id), false);
    assert.equal(world.nextRound(a.id), true);
    assert.equal(world.roundNumber, 2); assert.equal(world.phase, 'running'); assert.equal(world.result, null);
    assert.equal(world.time, 0); assert.equal(world.projectiles.length, 0); assert.equal(world.cannonballs.length, 0);
    for (const player of world.players.values()) {
        assert.equal(player.health, 100); assert.equal(player.gameOver, false); assert.equal(player.spectator, false);
        assert.ok(player.inventory.every(item => item === null));
    }
    assert.equal(world.players.get(b.id).generation, generation + 1);
    assert.equal(world.participants.has(late.id), true);
    assert.equal(JSON.stringify(world.layout), geometry);
});

test('simultaneous last-player deaths produce a draw rather than a false winner', () => {
    const { world, a, b, c } = fixture();
    c.gameOver = true; c.health = 0; a.health = b.health = 25;
    world.projectiles.push(spear(a.id), { x: 3057, y: 2000, vx: -1100, vy: 0, life: 1.2, shooter: b.id });
    world.updateProjectiles(0.1); world.checkWinner();
    assert.equal(world.phase, 'finished'); assert.equal(world.result.winnerId, null);
});

test('an eliminated host can start the next round after another player wins', () => {
    const { world, a, b, c } = fixture();
    world.damagePlayer(a, 100, 'Hit', b.id); world.damagePlayer(c, 100, 'Hit', b.id); world.checkWinner();
    assert.equal(world.result.winnerId, b.id);
    assert.equal(world.action(a.id, { action: 'next_round' }), true);
    assert.equal(world.players.get(a.id).gameOver, false);
    assert.equal(world.phase, 'running');
});

test('deaths from the world also count toward the last-player winner', () => {
    const { world, a, b, c } = fixture();
    c.gameOver = true; c.health = 0;
    world.time = 180; b.health = 1; b.pose.x = 0;
    world.stepWorld(0.5);
    assert.equal(b.gameOver, true); assert.equal(b.cause, 'Outside Safe Area');
    assert.equal(world.phase, 'finished'); assert.equal(world.result.winnerId, a.id);
});
