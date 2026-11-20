const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { clean } = require('../public/scripts/profile.js');
const { RoomWorld } = require('../server/room-world.cjs');

test('usernames are trimmed, normalized, bounded, and safe for plain display', () => {
    assert.equal(clean('  Wave   Rider_7-  '), 'Wave Rider_7-');
    assert.equal(clean('x'.repeat(200)), 'x'.repeat(16));
    assert.equal(clean('<script>alert(1)</script>'), 'scriptalert1scri');
    assert.equal(clean('\u202e🌊\n'), '');
    assert.equal(clean({ username: 'bad' }), '');
});

test('home saves names across navigation and restores them, with blocked-storage fallback', () => {
    const values = new Map();
    const storage = { getItem: key => values.get(key) || '', setItem: (key, value) => values.set(key, value) };
    const create = store => {
        const window = { localStorage: store };
        vm.runInNewContext(fs.readFileSync(require.resolve('../public/scripts/profile.js'), 'utf8'), { window });
        return window;
    };
    const window = create(storage);
    const input = { value: '', addEventListener(name, fn) { this[name] = fn; } };
    const forms = [{ addEventListener(name, fn) { this[name] = fn; } }, { addEventListener(name, fn) { this[name] = fn; } }];
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/scripts/home.js'), 'utf8'), {
        window, document: { getElementById: () => input, querySelectorAll: () => forms }
    });
    input.value = 'Wave ';
    input.input();
    assert.equal(input.value, 'Wave ', 'A space can be typed between words');
    input.value = 'Wave Rider'; input.input(); forms[1].submit();
    assert.equal(create(storage).OceanProfile.load(), 'Wave Rider');
    const blocked = create({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
    blocked.OceanProfile.save('Neon_7');
    assert.equal(blocked.OceanProfile.load(), 'Neon_7');
});

test('the server publishes a validated display name and preserves it in winner results and rematches', () => {
    const world = new RoomWorld();
    const a = world.addPlayer('alpha'), b = world.addPlayer('bravo');
    assert.equal(world.setUsername(a.id, '  Wave Rider  '), true);
    assert.equal(world.stateFor(a).username, 'Wave Rider');
    assert.equal(world.personal(a.id).username, 'Wave Rider');
    assert.equal(world.setUsername(a.id, 'Changed'), false, 'Identity stays fixed for a connection');
    world.start(a.id); world.damagePlayer(b, 100, 'Hit', a.id); world.checkWinner();
    assert.equal(world.result.winnerLabel, 'Wave Rider');
    world.nextRound(a.id);
    assert.equal(world.players.get(a.id).username, 'Wave Rider');
    assert.equal(world.players.get(a.id).profileSet, true);
});
