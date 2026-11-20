const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ islands = false, room = '', search, storage = new Map() } = {}) {
    const buttons = {};
    const listeners = {};
    let drawDepth = 0;
    const drawCalls = [];
    const context = new Proxy({}, {
        get(target, key) {
            if (key in target) return target[key];
            if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
            return (...args) => {
                drawCalls.push({ method: key, args, fillStyle: target.fillStyle });
                if (key === 'save') drawDepth++;
                if (key === 'restore') drawDepth--;
                for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), key);
            };
        }
    });
    const classList = () => {
        const values = new Set();
        return { toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); }, contains: name => values.has(name) };
    };
    const elements = {
        gameCanvas: {
            width: 1200, height: 660, getContext: () => context,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 330 }),
            addEventListener: (event, callback) => { buttons['canvas:' + event] = callback; }
        },
        minimapCanvas: { width: 240, height: 160, getContext: () => context },
        oceanScreen: { classList: classList(), getBoundingClientRect: () => ({ width: 1200, height: 660 }) },
        speed: {}, boostBar: {}, boostAmount: {}, boostStatus: {},
        healthBar: {}, healthAmount: {}, gameOver: { hidden: true }, deathCause: {},
        survivalHud: { hidden: true }, survivalTime: {}, bestSurvival: {}, gameOverTime: {},
        inventoryCount: {}, pickupPrompt: { hidden: true }
    };
    for (let i = 1; i <= 6; i++) {
        elements['inventorySlot' + i] = { classList: classList(), setAttribute(name, value) { this[name] = value; } };
        elements['inventoryItem' + i] = {};
        elements['inventoryDurability' + i] = { hidden: true, value: 0, setAttribute(name, value) { this[name] = value; } };
    }
    for (const id of ['resetButton', 'restartButton', 'fullscreenButton', 'moveUp', 'moveLeft', 'moveDown', 'moveRight', 'boostButton',
        'fullscreen-moveUp', 'fullscreen-moveLeft', 'fullscreen-moveDown', 'fullscreen-moveRight', 'fullscreen-boostButton']) {
        elements[id] = {
            addEventListener: (event, callback) => { buttons[id + ':' + event] = callback; },
            setAttribute(name, value) { this[name] = value; },
            setPointerCapture() {}
        };
    }
    const document = {
        fullscreenElement: null, body: { classList: classList() },
        createElement: () => ({ width: 0, height: 0, getContext: () => context }),
        hidden: false, getElementById: id => elements[id],
        addEventListener: (event, callback) => { listeners[event] = callback; }
    };
    const window = {
        location: { search: search ?? (room ? '?room=' + room : '') },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        addEventListener: (event, callback) => { listeners[event] = callback; }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/scripts/game.js'), 'utf8'), {
        document, window, console, URLSearchParams, requestAnimationFrame() {}
    }, { importModuleDynamically: async () => { throw new Error('Offline analytics test'); } });
    const game = document.myGame;
    // Keep obstacle-free fixtures for focused existing mechanics; island tests opt in.
    if (!islands) {
        game.islands = [];
        game.createIslands = () => [];
    }
    return {
        game, elements, buttons, listeners, document, window,
        drawDepth: () => drawDepth, drawCalls,
        advance(seconds) { for (let i = 0; i < Math.round(seconds * 120); i++) game.step(1 / 120); },
        shark(x = 3100, y = 2000) {
            const shark = { ...game.createSharks()[0], x, y };
            game.sharks = [shark];
            return shark;
        },
        key(key, pressed = true) {
            game.handleKey({ key, target: { tagName: 'BODY' }, preventDefault() {} }, pressed);
        }
    };
}

test('singleplayer survival timer counts while alive, resets each round, and preserves the best time', () => {
    const storage = new Map();
    const fixture = setup({ storage });
    const { game, elements } = fixture;
    game.sharks = []; game.updatePirateShip = () => {};
    assert.equal(elements.survivalHud.hidden, false);
    assert.equal(elements.survivalTime.textContent, '00:00');
    fixture.advance(1.5);
    assert.equal(elements.survivalTime.textContent, '00:01');
    assert.equal(elements.bestSurvival.textContent, '00:01');
    assert.equal(storage.get('ocean-rush-best-survival'), '1');
    game.reset();
    assert.equal(elements.survivalTime.textContent, '00:00');
    assert.equal(elements.bestSurvival.textContent, '00:01');
    assert.equal(game.survivalSeconds, 0);
});

test('survival timer stops at death from either sharks or cannonballs', () => {
    for (const cause of ['shark', 'cannon']) {
        const fixture = setup();
        const { game, elements } = fixture;
        game.sharks = []; game.updatePirateShip = () => {};
        fixture.advance(5.25);
        if (cause === 'shark') { game.health = 25; game.takeBite(); }
        else {
            game.health = 75;
            game.cannonballs = [{ x: game.rider.x, y: game.rider.y, vx: 0, vy: 0, life: 1 }];
            game.updateCannonballs(0.01);
        }
        assert.equal(game.gameOver, true);
        const elapsed = game.survivalSeconds;
        fixture.advance(2);
        assert.equal(game.survivalSeconds, elapsed);
        assert.equal(elements.survivalTime.textContent, '00:05');
        assert.equal(elements.bestSurvival.textContent, '00:05');
        assert.equal(elements.gameOverTime.textContent, 'Survived 00:05');
        game.reset();
        assert.equal(elements.gameOverTime.textContent, '');
    }
});

test('survival best persists across reloads, formats minutes, and cannot be replaced by a shorter run', () => {
    const storage = new Map();
    const first = setup({ storage });
    first.game.sharks = []; first.game.updatePirateShip = () => {};
    first.game.step(65);
    assert.equal(first.elements.survivalTime.textContent, '01:05');
    assert.equal(first.elements.bestSurvival.textContent, '01:05');
    const next = setup({ storage });
    next.game.sharks = []; next.game.updatePirateShip = () => {};
    assert.equal(next.elements.survivalTime.textContent, '00:00');
    assert.equal(next.elements.bestSurvival.textContent, '01:05');
    next.advance(2);
    assert.equal(next.elements.bestSurvival.textContent, '01:05');
    assert.equal(storage.get('ocean-rush-best-survival'), '65');
});

test('hosting uses multiplayer mode before the server assigns its room code', () => {
    const { game, elements } = setup({ search: '?action=host' });
    assert.equal(game.isSingleplayer, false);
    assert.equal(elements.survivalHud.hidden, true);
});

test('multiplayer hides the timer and does not change the singleplayer survival record', () => {
    const storage = new Map([['ocean-rush-best-survival', '12']]);
    const { game, elements } = setup({ room: 'crew', storage });
    game.sharks = []; game.updatePirateShip = () => {};
    game.step(20);
    assert.equal(elements.survivalHud.hidden, true);
    assert.equal(game.survivalSeconds, 20);
    assert.equal(storage.get('ocean-rush-best-survival'), '12');
});

test('invalid or blocked browser storage cannot break survival timing', () => {
    for (const saved of ['not-a-number', '-10', 'Infinity']) {
        const fixture = setup({ storage: new Map([['ocean-rush-best-survival', saved]]) });
        assert.equal(fixture.elements.bestSurvival.textContent, '00:00');
    }
    const fixture = setup({ storage: { get() { throw new Error('Blocked'); }, set() { throw new Error('Blocked'); } } });
    fixture.game.sharks = []; fixture.game.updatePirateShip = () => {};
    fixture.advance(1.5);
    assert.equal(fixture.elements.survivalTime.textContent, '00:01');
    assert.equal(fixture.elements.bestSurvival.textContent, '00:01');
    fixture.game.reset();
    assert.equal(fixture.elements.bestSurvival.textContent, '00:01');
});

test('caught messages include the final time in either mode without changing multiplayer high scores', () => {
    for (const room of ['', 'crew']) {
        const storage = new Map([['ocean-rush-best-survival', '12']]);
        const fixture = setup({ room, storage });
        const { game, elements } = fixture;
        game.sharks = []; game.updatePirateShip = () => {};
        game.step(65.25);
        game.health = 25; game.takeBite();
        assert.equal(elements.gameOverTime.textContent, 'Survived 01:05');
        assert.equal(elements.deathCause.textContent, 'Shark Attack');
        assert.equal(storage.get('ocean-rush-best-survival'), room ? '12' : '65');
        fixture.advance(2);
        assert.equal(elements.gameOverTime.textContent, 'Survived 01:05');
    }
});

test('minimap omits islands while scaling player, pirate ship, and camera view without changing gameplay state', () => {
    const fixture = setup();
    const { game, drawCalls } = fixture;
    game.islands = [{ x: 1000, y: 1000, radius: 150, points: [[-100, -100], [100, -100], [0, 100]] }];
    Object.assign(game.rider, { x: 5000, y: 3000 });
    Object.assign(game.pirateShip, { x: 4500, y: 2500 });
    game.updateCamera();
    const before = JSON.stringify({ rider: game.rider, ship: game.pirateShip, camera: game.camera });
    game.drawMinimap();
    assert.equal(drawCalls.some(call => call.method === 'moveTo' && call.args[0] === 36 && call.args[1] === 36), false);
    assert.equal(drawCalls.some(call => call.fillStyle === '#c887e8'), false);
    assert.ok(drawCalls.some(call => call.method === 'translate' && call.args[0] === 180 && call.args[1] === 100));
    assert.ok(drawCalls.some(call => call.method === 'translate' && call.args[0] === 200 && call.args[1] === 120));
    assert.ok(drawCalls.some(call => call.method === 'strokeRect' && call.args[2] === 48 && call.args[3] === 26.400000000000002));
    assert.equal(JSON.stringify({ rider: game.rider, ship: game.pirateShip, camera: game.camera }), before);
    assert.equal(fixture.drawDepth(), 0);
    drawCalls.length = 0;
    game.canvas.width = 2000;
    game.updateCamera(); game.drawMinimap();
    assert.ok(drawCalls.some(call => call.method === 'strokeRect' && call.args[2] === 80));
    assert.equal(game.minimapCanvas.width, 240);
    assert.equal(game.minimapCanvas.height, 160);
    assert.equal(fixture.drawDepth(), 0);
});

test('safe area shrinks to four by four standard screens over three minutes and never gets smaller', () => {
    const { game } = setup();
    let area = game.safeAreaBounds();
    assert.equal(area.x, 0); assert.equal(area.y, 0);
    assert.equal(area.width, 6000); assert.equal(area.height, 4000);
    game.survivalSeconds = 90; area = game.safeAreaBounds();
    assert.equal(area.width, 5400); assert.equal(area.height, 3320);
    assert.equal(area.x, 300); assert.equal(area.y, 340);
    game.survivalSeconds = 180; area = game.safeAreaBounds();
    assert.equal(area.width, 4800); assert.equal(area.height, 2640);
    assert.equal(area.x, 600); assert.equal(area.y, 680);
    game.survivalSeconds = 600; game.canvas.width = 2400;
    assert.equal(JSON.stringify(game.safeAreaBounds()), JSON.stringify(area));
    game.reset();
    assert.equal(game.safeAreaBounds().width, 6000);
    assert.equal(game.safeAreaBounds().height, 4000);
    assert.equal(game.zoneDamageCarry, 0);
});

test('outside-zone damage is two health per second, stops inside, and reports a lethal exposure', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    game.sharks = []; game.updatePirateShip = () => {};
    game.survivalSeconds = 180;
    Object.assign(game.rider, { x: 100, y: 100 });
    game.invulnerable = 100;
    fixture.advance(1); assert.equal(game.health, 98);
    fixture.advance(2); assert.equal(game.health, 94);
    Object.assign(game.rider, { x: 600, y: 680 });
    fixture.advance(0.5); assert.equal(game.health, 94, 'Safe boundary counts as inside');
    Object.assign(game.rider, { x: 100, y: 100 }); game.health = 3;
    fixture.advance(1.5);
    assert.equal(game.health, 0); assert.equal(game.gameOver, true);
    assert.equal(elements.deathCause.textContent, 'Outside Safe Area');
    assert.equal(elements.gameOverTime.textContent, 'Survived 03:05');
    const elapsed = game.survivalSeconds;
    fixture.advance(1);
    assert.equal(game.survivalSeconds, elapsed);
});

test('zone damage applies on islands and the pirate ship and resets partial damage on safe reentry', () => {
    for (const mode of ['onFoot', 'onPirateShip']) {
        const { game } = setup();
        game[mode] = true; game.survivalSeconds = 180;
        Object.assign(game.rider, { x: 100, y: 100 });
        game.updateSafeArea(1);
        assert.equal(game.health, 98);
    }
    const { game } = setup({ room: 'crew' });
    game.survivalSeconds = 180;
    Object.assign(game.rider, { x: 100, y: 100 });
    game.updateSafeArea(0.1);
    assert.equal(game.health, 100);
    Object.assign(game.rider, { x: 3000, y: 2000 });
    game.updateSafeArea(1);
    assert.equal(game.zoneDamageCarry, 0);
    Object.assign(game.rider, { x: 100, y: 100 });
    game.updateSafeArea(0.1); assert.equal(game.health, 100);
    game.updateSafeArea(0.4); assert.equal(game.health, 99);
});

test('minimap safe boundary shrinks at the same scale as the visible ocean boundary', () => {
    const fixture = setup();
    const { game, drawCalls } = fixture;
    game.drawMinimap();
    assert.ok(drawCalls.some(call => call.method === 'strokeRect' && call.args[2] === 240 && call.args[3] === 160));
    drawCalls.length = 0;
    game.survivalSeconds = 180;
    game.drawMinimap();
    assert.ok(drawCalls.some(call => call.method === 'strokeRect' &&
        Math.abs(call.args[0] - 24) < 1e-6 && Math.abs(call.args[1] - 27.2) < 1e-6 &&
        Math.abs(call.args[2] - 192) < 1e-6 && Math.abs(call.args[3] - 105.6) < 1e-6));
    game.drawSafeArea(game.ctx);
    assert.ok(drawCalls.some(call => call.method === 'strokeRect' && call.args[0] === 600 &&
        call.args[1] === 680 && call.args[2] === 4800 && call.args[3] === 2640));
    assert.ok(drawCalls.some(call => call.method === 'fillRect' && call.fillStyle === 'rgba(238, 48, 101, 0.22)' && call.args[3] > 0));
    assert.equal(fixture.drawDepth(), 0);
});

test('ten sharks spawn in map, one in view, all safely away from rider', () => {
    const { game } = setup();
    assert.equal(game.sharks.length, 10);
    assert.equal(game.sharks.filter(shark => game.isOnScreen(shark)).length, 1);
    for (const shark of game.sharks) {
        assert.ok(shark.x >= game.margin && shark.x <= game.world.width - game.margin);
        assert.ok(shark.y >= game.margin && shark.y <= game.world.height - game.margin);
        assert.ok(Math.hypot(shark.x - game.rider.x, shark.y - game.rider.y) > 400);
    }
});

test('visible chase travels at exactly 30 MPH using rider scale', () => {
    const fixture = setup();
    const shark = fixture.shark(3500);
    fixture.game.updateSharks(0.5);
    const mph = (3500 - shark.x) / 0.5 / fixture.game.pixelsPerMeter * 3600 / 1609.344;
    assert.ok(Math.abs(mph - 30) < 1e-9);
    assert.equal(shark.state, 'chase');
});

test('unalerted sharks patrol; lost sharks return home and reentry activates chase', () => {
    const fixture = setup();
    const shark = fixture.shark(1000);
    fixture.advance(1);
    assert.equal(shark.state, 'patrol');
    assert.notEqual(shark.x, 1000);
    shark.x = 3200;
    fixture.game.updateSharks(1 / 120);
    assert.equal(shark.state, 'chase');
    Object.assign(shark, { state: 'leap', timer: 0.2, x: fixture.game.camera.x - 56 });
    const x = shark.x;
    fixture.game.updateSharks(1 / 120);
    assert.equal(shark.state, 'return');
    assert.ok(shark.x < x);
    assert.equal(fixture.game.health, 100);
    shark.x = 3300;
    fixture.game.updateSharks(1 / 120);
    assert.equal(shark.state, 'chase');
});

test('attack warns before leaping and deals one bite, then recovers', () => {
    const fixture = setup();
    const shark = fixture.shark();
    fixture.game.updateSharks(1 / 120);
    assert.equal(shark.state, 'windup');
    fixture.advance(0.25);
    assert.equal(shark.state, 'windup');
    assert.equal(fixture.game.health, 100);
    fixture.advance(0.15);
    assert.equal(shark.state, 'leap');
    fixture.advance(0.5);
    assert.equal(fixture.game.health, 75);
    assert.equal(shark.hasBitten, true);
    fixture.advance(0.2);
    assert.equal(shark.state, 'recover');
    assert.equal(fixture.game.health, 75);
    assert.ok(shark.cooldown > 0);
});

test('steerable leaps can still be dodged', () => {
    const fixture = setup();
    const shark = fixture.shark();
    fixture.advance(0.4);
    assert.equal(shark.state, 'leap');
    fixture.game.rider.y += 250;
    fixture.game.updateCamera();
    fixture.advance(0.8);
    assert.equal(fixture.game.health, 100);
    assert.equal(shark.hasBitten, false);
});

test('boost outruns a shark and losing it offscreen stops pursuit', () => {
    const fixture = setup();
    const shark = fixture.shark(2650);
    fixture.key('d');
    fixture.key('q');
    fixture.advance(2);
    assert.ok(Number(fixture.elements.speed.textContent) > 80);
    assert.equal(fixture.game.isOnScreen(shark), false);
    assert.equal(shark.state, 'return');
    const x = shark.x;
    fixture.advance(0.5);
    assert.ok(shark.x < x);
    assert.equal(fixture.game.health, 100);
});

test('bite protection, game over, controls lock, and restart restore the run', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    game.takeBite();
    game.takeBite();
    assert.equal(game.health, 75);
    for (let i = 0; i < 3; i++) {
        game.invulnerable = 0;
        game.takeBite();
    }
    assert.equal(game.health, 0);
    assert.equal(game.gameOver, true);
    assert.equal(elements.gameOver.hidden, false);
    fixture.key('q');
    assert.equal(game.boosting, false);
    const x = game.rider.x;
    fixture.advance(1);
    assert.equal(game.rider.x, x);
    fixture.buttons['restartButton:click']();
    assert.equal(game.health, 100);
    assert.equal(game.boost, 100);
    assert.equal(game.sharks.length, 10);
    assert.equal(game.gameOver, false);
    assert.equal(elements.gameOver.hidden, true);
});

test('shark states render with finite coordinates and balanced canvas transforms', () => {
    const fixture = setup();
    const shark = fixture.shark();
    for (const state of ['patrol', 'chase', 'windup', 'leap', 'recover', 'return']) {
        Object.assign(shark, { state, timer: 0.3, splashAge: 0.2 });
        fixture.game.draw();
        assert.equal(fixture.drawDepth(), 0);
    }
    for (const file of ['game.html']) {
        const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
        for (const id of Object.keys(fixture.elements)) assert.ok(html.includes('id="' + id + '"'), id);
        assert.equal((html.match(/clarity\.ms\/tag\//g) || []).length, 1);
        assert.ok(html.includes('game.js?v=room-codes-34'));
        assert.ok(!html.includes('sharkStatus'));
        assert.ok(html.includes('<h2>You were caught!</h2><p id="deathCause">Shark Attack</p>'));
    }
});

test('only damaging bites leave blood at the bite location', () => {
    const fixture = setup();
    const { game } = fixture;
    game.takeBite();
    assert.equal(game.blood.length, 1);
    assert.equal(game.blood[0].x, 3000);
    assert.equal(game.blood[0].y, 2000);
    assert.equal(game.blood[0].life, 12);
    game.takeBite();
    assert.equal(game.blood.length, 1);
    game.rider.x += 100;
    game.updateCamera();
    assert.equal(game.blood[0].x, 3000);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
    game.invulnerable = 0;
    game.takeBite();
    assert.equal(game.blood.length, 2);
    assert.equal(game.blood[1].x, 3100);
});

test('blood attracts offscreen sharks inside 1400 pixels, but not farther sharks', () => {
    const fixture = setup();
    const shark = fixture.shark(3900);
    assert.equal(fixture.game.isOnScreen(shark), false);
    assert.equal(fixture.game.canPursue(shark), false);
    fixture.game.takeBite();
    assert.equal(fixture.game.canPursue(shark), true);
    fixture.game.updateSharks(0.1);
    assert.equal(shark.state, 'chase');
    assert.ok(shark.x < 3900);
    shark.x = fixture.game.rider.x + 1400;
    assert.equal(fixture.game.canPursue(shark), true);
    shark.x += 1;
    assert.equal(fixture.game.canPursue(shark), false);
    fixture.game.updateSharks(0.1);
    assert.equal(shark.state, 'return');
});

test('expired blood removes scent and offscreen pursuit; reset clears new blood', () => {
    const fixture = setup();
    const shark = fixture.shark(3900);
    fixture.game.takeBite();
    fixture.game.blood[0].life = 0.1;
    fixture.advance(0.05);
    assert.equal(shark.state, 'chase');
    fixture.advance(0.1);
    assert.equal(fixture.game.blood.length, 0);
    assert.equal(shark.state, 'return');
    const distanceHome = Math.hypot(shark.x - shark.homeX, shark.y - shark.homeY);
    fixture.advance(1);
    assert.ok(Math.hypot(shark.x - shark.homeX, shark.y - shark.homeY) < distanceHome);
    fixture.game.invulnerable = 0;
    fixture.game.takeBite();
    fixture.game.reset();
    assert.equal(fixture.game.blood.length, 0);
    assert.equal(fixture.game.canPursue({ x: 3900, y: 2000 }), false);
});

test('lost sharks return to distinct territories and resume patrol instead of settling', () => {
    const fixture = setup();
    const first = { ...fixture.game.createSharks()[0], x: 2000, y: 1800, state: 'chase' };
    const second = { ...fixture.game.createSharks()[1], x: 2000, y: 1805, state: 'chase' };
    fixture.game.sharks = [first, second];
    fixture.game.updateSharks(1 / 120);
    for (const shark of [first, second]) {
        assert.equal(shark.state, 'return');
        assert.ok(shark.homeX >= shark.territory.x && shark.homeX <= shark.territory.x + shark.territory.width);
        assert.ok(shark.homeY >= shark.territory.y && shark.homeY <= shark.territory.y + shark.territory.height);
    }
    fixture.advance(15);
    assert.ok(Math.hypot(first.x - second.x, first.y - second.y) > 300);
    assert.equal(first.state, 'patrol');
    assert.equal(second.state, 'patrol');
    for (const shark of [first, second]) {
        assert.ok(shark.x >= shark.territory.x && shark.x <= shark.territory.x + shark.territory.width);
        assert.ok(shark.y >= shark.territory.y && shark.y <= shark.territory.y + shark.territory.height);
    }
    assert.equal(fixture.game.health, 100);
});

test('leap takeoff predicts rider movement and early steering follows direction changes', () => {
    const fixture = setup();
    const shark = fixture.shark();
    fixture.game.rider.vy = 150;
    fixture.game.updateSharks(0.01);
    fixture.game.updateSharks(0.35);
    assert.equal(shark.state, 'leap');
    assert.ok(shark.leapY > 0, 'Aim ahead of a rider moving down');

    Object.assign(shark, { x: 3100, y: 2000, state: 'leap', timer: 0.05, leapX: -1, leapY: 0 });
    fixture.game.rider.y = 1980;
    fixture.game.rider.vy = -100;
    const beforeX = shark.x;
    const beforeY = shark.y;
    fixture.game.updateSharks(0.1);
    assert.ok(shark.leapY < 0, 'Correct toward the rider turning up');
    assert.ok(Math.abs(Math.hypot(shark.leapX, shark.leapY) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(shark.x - beforeX, shark.y - beforeY) / 0.1 - fixture.game.sharkSpeed) < 1e-9);
    assert.ok(Math.abs(Math.atan2(shark.leapY, shark.leapX) + Math.PI) <= 0.280001);

    shark.timer = 0.4;
    const lockedX = shark.leapX;
    const lockedY = shark.leapY;
    fixture.game.rider.vy = 200;
    fixture.game.updateSharks(0.05);
    assert.equal(shark.leapX, lockedX);
    assert.equal(shark.leapY, lockedY);
});

test('one permanent guard covers each of the ten territories and patrol stays in bounds', () => {
    const { game } = setup();
    const areas = new Set();
    for (const shark of game.sharks) {
        const area = shark.territory;
        areas.add(area.x + ':' + area.y);
        assert.equal(area.width, 1200);
        assert.equal(area.height, 2000);
        const start = { x: shark.x, y: shark.y };
        for (let i = 0; i < 1000; i++) {
            game.patrolShark(shark, 0.1);
            assert.ok(shark.x >= area.x && shark.x <= area.x + area.width);
            assert.ok(shark.y >= area.y && shark.y <= area.y + area.height);
        }
        assert.ok(Math.hypot(start.x - shark.x, start.y - shark.y) > 10);
    }
    assert.equal(areas.size, 10);
    game.reset();
    assert.equal(new Set(game.sharks.map(shark => shark.territory.x + ':' + shark.territory.y)).size, 10);
});

test('waiting after escape draws the assigned guard in every territory without teleporting', () => {
    for (let id = 0; id < 10; id++) {
        const fixture = setup();
        // Isolate guard navigation from the new independent pirate threat.
        fixture.game.updatePirateShip = () => {};
        const guard = fixture.game.sharks[id];
        fixture.game.sharks = [guard];
        fixture.game.rider.x = guard.territory.x + 100;
        fixture.game.rider.y = guard.territory.y + 100;
        fixture.game.updateCamera();
        // Simulate the area's guard having been drawn to the opposite end of the map.
        guard.x = fixture.game.rider.x < 3000 ? 5800 : 200;
        guard.y = fixture.game.rider.y < 2000 ? 3800 : 200;
        guard.state = 'chase';
        let found = false;
        for (let i = 0; i < 50 * 120; i++) {
            const x = guard.x;
            const y = guard.y;
            fixture.advance(1 / 120);
            assert.ok(Math.hypot(guard.x - x, guard.y - y) <= fixture.game.sharkSpeed / 120 + 1e-8);
            if (['chase', 'windup', 'leap'].includes(guard.state) && fixture.game.isOnScreen(guard)) {
                found = true;
                break;
            }
        }
        assert.equal(found, true, 'Guard should find a waiting rider in territory ' + id);
        assert.equal(fixture.game.sharks.length, 1);
    }
});

test('inventory starts with six empty selectable slots on both pages', () => {
    const { game } = setup();
    assert.equal(game.inventory.length, 6);
    assert.ok(game.inventory.every(item => item === null));
    game.reset();
    assert.ok(game.inventory.every(item => item === null));
    for (const file of ['game.html']) {
        const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
        const inventory = html.match(/<section class="inventory"[\s\S]*?<\/section>/)[0];
        assert.equal((inventory.match(/role="option"/g) || []).length, 6);
        assert.ok(inventory.includes('0 / 6'));
        assert.ok(!/<button/.test(inventory));
        assert.equal((inventory.match(/src="assets\/spear.svg"/g) || []).length, 6);
        assert.ok(html.indexOf(inventory) > html.indexOf('</canvas>'));
        assert.ok(html.indexOf(inventory) < html.indexOf('id="gameOver"'));
    }
});

test('number keys select their matching slots and respect typing fields', () => {
    const fixture = setup();
    for (let i = 1; i <= 6; i++) {
        fixture.key(String(i));
        assert.equal(fixture.game.selectedSlot, i - 1);
        assert.equal(fixture.elements['inventorySlot' + i]['aria-selected'], 'true');
        assert.ok(fixture.elements['inventorySlot' + i].classList.contains('selected'));
    }
    fixture.game.handleKey({ key: '1', target: { tagName: 'INPUT' }, preventDefault() { throw new Error('Typing intercepted'); } }, true);
    assert.equal(fixture.game.selectedSlot, 5);
    fixture.key('7');
    assert.equal(fixture.game.selectedSlot, 5);
});

test('six floating guns require E and range, then occupy inventory without duplicate pickups', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    assert.equal(game.floatingGuns.length, 6);
    assert.equal(new Set(game.floatingGuns.map(gun => gun.id)).size, 6);
    fixture.key('e');
    assert.ok(game.inventory.every(item => item === null));
    fixture.key('e', false);
    for (let i = 0; i < 6; i++) {
        const gun = game.floatingGuns[0];
        game.rider.x = gun.x;
        game.rider.y = gun.y;
        game.updateCamera();
        game.updatePickupPrompt();
        assert.equal(elements.pickupPrompt.hidden, false);
        fixture.key('E');
        assert.equal(game.inventory[i].id, gun.id);
        assert.equal(game.selectedSlot, i);
        assert.equal(game.floatingGuns.length, 5 - i);
        fixture.key('E');
        assert.equal(game.inventory.filter(Boolean).length, i + 1);
        fixture.key('E', false);
    }
    assert.equal(elements.inventoryCount.textContent, '6 / 6');
    assert.equal(elements.pickupPrompt.hidden, true);
});

test('full inventory and game over prevent collecting a gun', () => {
    const { game } = setup();
    const gun = game.floatingGuns[0];
    game.rider.x = gun.x; game.rider.y = gun.y;
    game.inventory.fill({ id: 'test', name: 'Gun' });
    game.pickUpGun();
    assert.equal(game.floatingGuns.length, 6);
    game.inventory.fill(null);
    game.gameOver = true;
    game.pickUpGun();
    assert.equal(game.floatingGuns.length, 6);
});

test('trackpad pointer aims in world coordinates and primary presses fire selected guns', () => {
    const fixture = setup();
    const { game } = fixture;
    const gun = game.floatingGuns[0];
    Object.assign(game.rider, { x: gun.x, y: gun.y });
    game.updateCamera(); game.pickUpGun();
    const point = { clientX: 450, clientY: 165, button: 0, preventDefault() {} };
    fixture.buttons['canvas:pointermove'](point);
    assert.ok(Math.abs(game.aimAngle()) < 1e-10);
    fixture.buttons['canvas:pointerdown'](point);
    assert.equal(game.projectiles.length, 1);
    assert.equal(game.projectiles[0].vx, 1100);
    assert.ok(Math.abs(game.projectiles[0].vy) < 1e-10);
    const x = game.projectiles[0].x;
    game.updateProjectiles(0.1);
    assert.equal(game.projectiles[0].x, x + 110);
    fixture.key('2');
    game.time += 1;
    fixture.buttons['canvas:pointerdown'](point);
    assert.equal(game.projectiles.length, 1, 'Empty selected slot must not shoot');
    fixture.key('1');
    fixture.buttons['canvas:pointerdown']({ ...point, button: 2 });
    assert.equal(game.projectiles.length, 1, 'Secondary press must not shoot');
    fixture.buttons['canvas:pointerdown'](point);
    assert.equal(game.projectiles.length, 2);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
    game.updateProjectiles(2);
    assert.equal(game.projectiles.length, 0);
});

test('aim remains correct with a different fullscreen canvas aspect and reset restores guns', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    game.inventory[0] = { name: 'Gun', id: 'test', durability: 12 };
    elements.gameCanvas.width = 800;
    game.updateCamera();
    fixture.buttons['canvas:pointermove']({ clientX: 450, clientY: 165 });
    assert.ok(Math.abs(game.aimAngle()) < 1e-10);
    fixture.buttons['canvas:pointermove']({ clientX: 300, clientY: 30 });
    assert.ok(Math.abs(game.aimAngle() + Math.PI / 2) < 1e-10);
    assert.equal(game.fireGun(), true);
    assert.equal(game.fireGun(), false, 'Cooldown prevents duplicate shots from one press');
    game.gameOver = true; game.time += 1;
    assert.equal(game.fireGun(), false);
    game.reset();
    assert.equal(game.floatingGuns.length, 6);
    assert.equal(game.projectiles.length, 0);
    assert.equal(game.selectedSlot, 0);
    assert.ok(game.inventory.every(item => item === null));
});

test('fullscreen enters and exits on the ocean, resizes without stretching, and restores normal view', async () => {
    const fixture = setup();
    const { game, elements, document } = fixture;
    const screen = elements.oceanScreen;
    screen.getBoundingClientRect = () => ({ width: 1920, height: 1080 });
    screen.requestFullscreen = async () => { document.fullscreenElement = screen; };
    document.exitFullscreen = async () => { document.fullscreenElement = null; };
    fixture.key('d');
    await fixture.buttons['fullscreenButton:click']();
    assert.equal(document.fullscreenElement, screen);
    assert.equal(elements.gameCanvas.width, 1173);
    assert.equal(elements.gameCanvas.height, 660);
    assert.equal(elements.fullscreenButton['aria-pressed'], 'true');
    assert.ok(document.body.classList.contains('ocean-fullscreen'));
    assert.equal(game.keys.size, 0);
    screen.getBoundingClientRect = () => ({ width: 900, height: 1200 });
    fixture.listeners.resize();
    assert.equal(elements.gameCanvas.width, 495);
    assert.ok(game.camera.x >= 0 && game.camera.y >= 0);
    await game.toggleFullscreen();
    assert.equal(document.fullscreenElement, null);
    assert.equal(elements.gameCanvas.width, 1200);
    assert.equal(elements.fullscreenButton['aria-pressed'], 'false');
    assert.ok(!document.body.classList.contains('ocean-fullscreen'));
});

test('native Escape restores layout; unsupported or rejected fullscreen falls back and Escape exits', async () => {
    const fixture = setup();
    const { game, elements, document } = fixture;
    document.fullscreenElement = elements.oceanScreen;
    fixture.listeners.fullscreenchange();
    document.fullscreenElement = null;
    fixture.listeners.fullscreenchange();
    assert.equal(game.isFullscreen(), false);
    await game.toggleFullscreen();
    assert.equal(game.fullscreenFallback, true);
    assert.ok(elements.oceanScreen.classList.contains('fullscreen-fallback'));
    fixture.key('Escape');
    assert.equal(game.isFullscreen(), false);
    assert.ok(!elements.oceanScreen.classList.contains('fullscreen-fallback'));
    elements.oceanScreen.requestFullscreen = async () => { throw new Error('Unavailable'); };
    await game.toggleFullscreen();
    assert.equal(game.fullscreenFallback, true);
    await game.toggleFullscreen();
    assert.equal(game.fullscreenFallback, false);
});

test('fullscreen touch controls can move and boost, and cancel cleanly', () => {
    const fixture = setup();
    fixture.buttons['fullscreen-moveRight:pointerdown']({ preventDefault() {}, pointerId: 1 });
    fixture.buttons['fullscreen-boostButton:pointerdown']({ preventDefault() {}, pointerId: 2 });
    assert.ok(fixture.game.rider.vx > 390);
    fixture.buttons['fullscreen-moveRight:pointercancel']();
    fixture.buttons['fullscreen-boostButton:pointercancel']();
    assert.equal(fixture.game.touchDirections.size, 0);
});

test('three bullet hits kill a shark; two hits leave it alive', () => {
    const fixture = setup();
    const shark = fixture.shark();
    for (let i = 1; i <= 3; i++) {
        fixture.game.projectiles.push({ x: 3000, y: 2000, vx: 1100, vy: 0, life: 1.2 });
        fixture.game.updateProjectiles(0.2);
        assert.equal(shark.health, 3 - i);
        assert.equal(fixture.game.projectiles.length, 0);
        if (i < 3) assert.notEqual(shark.state, 'dead');
    }
    assert.equal(shark.state, 'dead');
    assert.equal(fixture.game.canPursue(shark), false);
    fixture.game.updateSharks(0.2);
    assert.equal(fixture.game.health, 100);
    fixture.game.damageShark(shark);
    assert.equal(shark.health, 0);
});

test('fast bullets hit the first intersected shark only, while misses do not damage', () => {
    const fixture = setup();
    const near = fixture.shark(3150);
    const far = { ...fixture.game.createSharks()[1], x: 3300, y: 2000 };
    fixture.game.sharks = [far, near];
    fixture.game.projectiles.push({ x: 3000, y: 2000, vx: 1100, vy: 0, life: 1.2 });
    fixture.game.updateProjectiles(0.5);
    assert.equal(near.health, 2);
    assert.equal(far.health, 3);
    fixture.game.projectiles.push({ x: 3000, y: 2100, vx: 1100, vy: 0, life: 1.2 });
    fixture.game.updateProjectiles(0.5);
    assert.equal(near.health, 2);
    assert.equal(far.health, 3);
});

test('a dead shark respawns exactly ten seconds later at home with full health', () => {
    const fixture = setup();
    const shark = fixture.shark();
    fixture.game.time = 7;
    for (let i = 0; i < 3; i++) fixture.game.damageShark(shark);
    assert.equal(shark.respawnAt, 17);
    fixture.game.time = 16.999;
    fixture.game.updateSharks(0.1);
    assert.equal(shark.state, 'dead');
    fixture.game.time = 17;
    fixture.game.updateSharks(0.001);
    assert.equal(shark.state, 'patrol');
    assert.equal(shark.health, 3);
    assert.equal(shark.x, shark.homeX);
    assert.equal(shark.y, shark.homeY);
    assert.ok(shark.x >= shark.territory.x && shark.x <= shark.territory.x + shark.territory.width);
    assert.equal(fixture.game.sharks.length, 1);
});

test('a gun fires exactly twelve shots then breaks and creates one fresh world pickup', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    Object.assign(game.rider, { x: game.floatingGuns[0].x, y: game.floatingGuns[0].y });
    game.pickUpGun();
    const gun = game.inventory[0];
    assert.equal(gun.durability, 12);
    assert.equal(elements.inventoryDurability1.value, 12);
    assert.equal(elements.inventoryDurability1.hidden, false);
    for (let i = 0; i < 12; i++) {
        assert.equal(game.fireGun(), true);
        assert.equal(gun.durability, 11 - i);
        if (i < 11) assert.equal(elements.inventoryDurability1.value, 11 - i);
        game.time += 0.21;
    }
    assert.equal(game.projectiles.length, 12, 'The final shot must still fire');
    assert.equal(game.inventory[0], null);
    assert.equal(elements.inventoryDurability1.value, 0);
    assert.equal(elements.inventoryDurability1.hidden, true);
    assert.equal(game.floatingGuns.length, 6);
    const replacement = game.floatingGuns.find(item => item.id === 'gun-7');
    assert.equal(replacement.durability, 12);
    assert.ok(replacement.x > 0 && replacement.x < game.world.width);
    assert.ok(replacement.y > 0 && replacement.y < game.world.height);
    assert.equal(game.fireGun(), false);
    assert.equal(game.floatingGuns.length, 6, 'A broken slot must not repeatedly spawn guns');
    Object.assign(game.rider, { x: replacement.x, y: replacement.y });
    game.pickUpGun();
    assert.equal(game.inventory[0].id, 'gun-7');
    assert.equal(game.inventory[0].durability, 12);
    assert.equal(game.fireGun(), true);
});

test('failed fire attempts and changing slots do not consume durability', () => {
    const fixture = setup();
    const { game } = fixture;
    Object.assign(game.rider, { x: game.floatingGuns[0].x, y: game.floatingGuns[0].y });
    game.pickUpGun();
    const gun = game.inventory[0];
    assert.equal(game.fireGun(), true);
    assert.equal(game.fireGun(), false);
    assert.equal(gun.durability, 11);
    fixture.key('2');
    assert.equal(game.fireGun(), false);
    assert.equal(gun.durability, 11);
    game.gameOver = true;
    fixture.key('1');
    assert.equal(game.fireGun(), false);
    assert.equal(gun.durability, 11);
});

test('reset clears pending respawns and restores gun/shark health state', () => {
    const { game } = setup();
    const shark = game.sharks[0];
    for (let i = 0; i < 3; i++) game.damageShark(shark);
    game.nextGunId = 9;
    game.reset();
    assert.equal(game.nextGunId, 7);
    assert.equal(game.sharks.length, 10);
    assert.ok(game.sharks.every(item => item.health === 3 && item.state !== 'dead' && item.respawnAt === 0));
    assert.ok(game.floatingGuns.every(item => item.durability === 12));
});

test('shot-shark blood attracts offscreen sharks near the hit, even far from the rider', () => {
    const fixture = setup();
    const victim = fixture.shark(4000);
    const watcher = { ...fixture.game.createSharks()[1], x: 5000, y: 2000 };
    fixture.game.sharks = [victim, watcher];
    assert.equal(fixture.game.canPursue(watcher), false);
    fixture.game.projectiles.push({ x: 3800, y: 2000, vx: 1100, vy: 0, life: 1.2 });
    fixture.game.updateProjectiles(0.3);
    assert.equal(fixture.game.blood.length, 1);
    assert.equal(fixture.game.blood[0].x, 4000);
    assert.equal(fixture.game.blood[0].y, 2000);
    assert.equal(fixture.game.blood[0].source, 'shark');
    assert.equal(fixture.game.canPursue(watcher), true);
    fixture.game.updateSharks(0.1);
    assert.equal(watcher.state, 'chase');
    assert.ok(watcher.x < 5000);
    fixture.game.blood[0].life = 0;
    assert.equal(fixture.game.canPursue(watcher), false);
});

test('each damaging shark hit leaves blood, including killing hit, but misses and dead hits do not', () => {
    const fixture = setup();
    const shark = fixture.shark();
    fixture.game.projectiles.push({ x: 3000, y: 2200, vx: 1100, vy: 0, life: 1.2 });
    fixture.game.updateProjectiles(0.2);
    assert.equal(fixture.game.blood.length, 0);
    for (let i = 1; i <= 3; i++) {
        fixture.game.damageShark(shark);
        assert.equal(fixture.game.blood.length, i);
    }
    assert.equal(shark.state, 'dead');
    fixture.game.damageShark(shark);
    assert.equal(fixture.game.blood.length, 3);
});

test('final shot draws a layered muzzle flame after gun disappears, then fades away', () => {
    const fixture = setup();
    const { game, drawCalls } = fixture;
    game.inventory[0] = { id: 'test', name: 'Gun', durability: 1 };
    assert.equal(game.fireGun(), true);
    assert.equal(game.inventory[0], null);
    game.draw();
    for (const color of ['#ff6b25', '#ffc64a', '#fff6cd']) {
        assert.ok(drawCalls.some(call => call.method === 'fill' && call.fillStyle === color));
    }
    drawCalls.length = 0;
    game.time += 0.2;
    game.draw();
    assert.ok(!drawCalls.some(call => call.method === 'fill' && call.fillStyle === '#ff6b25'));
    assert.equal(fixture.drawDepth(), 0);
});

test('sharks retain hidden health but no health bar is drawn', () => {
    const fixture = setup();
    const shark = fixture.shark();
    fixture.game.drawShark(shark);
    assert.ok(!fixture.drawCalls.some(call => call.method === 'fillRect'));
    assert.equal(shark.health, 3);
    for (const file of ['game.html']) {
        const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
        assert.equal((html.match(/class="gun-durability" max="12"/g) || []).length, 6);
    }
});

test('fish swim within the map, render safely, and do not alter gameplay state', () => {
    const fixture = setup();
    const { game } = fixture;
    assert.equal(game.fish.length, 60);
    const fish = game.fish[0];
    const start = { x: fish.x, y: fish.y };
    const sharks = JSON.stringify(game.sharks);
    game.updateFish(1);
    assert.ok(Math.hypot(fish.x - start.x, fish.y - start.y) > 20);
    assert.equal(JSON.stringify(game.sharks), sharks);
    assert.equal(game.health, 100);
    assert.equal(game.floatingGuns.length, 6);
    Object.assign(fish, { x: 5999, y: 3999, angle: Math.PI / 4 });
    game.updateFish(1);
    for (const swimmer of game.fish) {
        assert.ok(swimmer.x >= 0 && swimmer.x < game.world.width);
        assert.ok(swimmer.y >= 0 && swimmer.y < game.world.height);
    }
    game.drawFish();
    assert.equal(fixture.drawDepth(), 0);
    game.reset();
    assert.equal(game.fish.length, 60);
    assert.equal(game.floatingGuns.length, 6);
});

test('spear guns and fish get fresh positions on each round while counts and stats stay the same', () => {
    const { game } = setup();
    let previousGuns = game.floatingGuns.map(item => [item.x, item.y]);
    let previousFish = game.fish.map(item => [item.x, item.y]);
    for (let round = 0; round < 10; round++) {
        game.reset();
        const guns = game.floatingGuns.map(item => [item.x, item.y]);
        const fish = game.fish.map(item => [item.x, item.y]);
        assert.notDeepEqual(guns, previousGuns);
        assert.notDeepEqual(fish, previousFish);
        assert.equal(guns.length, 6);
        assert.equal(fish.length, 60);
        for (const item of game.floatingGuns) {
            assert.equal(item.name, 'Spear gun');
            assert.equal(item.durability, 12);
            assert.ok(item.x >= 120 && item.x <= 5880);
            assert.ok(item.y >= 120 && item.y <= 3880);
        }
        for (const swimmer of game.fish) {
            assert.ok(swimmer.x >= 60 && swimmer.x <= 5940);
            assert.ok(swimmer.y >= 60 && swimmer.y <= 3940);
        }
        assert.ok(game.isOnScreen(game.floatingGuns[0]));
        assert.equal(game.sharks.length, 10);
        assert.equal(game.boost, 100);
        previousGuns = guns;
        previousFish = fish;
    }
});

test('random replacement spear guns keep unique IDs and inventory uses the new name', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    Object.assign(game.rider, { x: game.floatingGuns[0].x, y: game.floatingGuns[0].y });
    game.pickUpGun();
    assert.equal(game.inventory[0].name, 'Spear gun');
    assert.equal(elements.inventoryItem1.hidden, false);
    const oldPositions = game.floatingGuns.map(item => [item.x, item.y]);
    game.spawnReplacementGun();
    game.spawnReplacementGun();
    const first = game.floatingGuns.at(-2);
    const second = game.floatingGuns.at(-1);
    assert.equal(first.name, 'Spear gun');
    assert.equal(second.name, 'Spear gun');
    assert.notEqual(first.id, second.id);
    assert.notDeepEqual([first.x, first.y], [second.x, second.y]);
    assert.ok(!oldPositions.some(([x, y]) => first.x === x && first.y === y));
    game.fireGun();
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
});

test('larger night lighting reveals nearby and forward sharks while distant sharks leave ripples', () => {
    const fixture = setup();
    const { game } = fixture;
    const side = { ...game.createSharks()[0], x: 3400, y: 2000 };
    const ahead = { ...game.createSharks()[1], x: 3000, y: 1700 };
    const behind = { ...game.createSharks()[2], x: 3000, y: 2350 };
    const dead = { ...game.createSharks()[3], x: 3100, y: 2000, state: 'dead' };
    const offscreen = { ...game.createSharks()[4], x: 1000, y: 1000 };
    game.sharks = [side, ahead, behind, dead, offscreen];
    const bodies = [];
    const ripples = [];
    const drawBody = game.drawShark.bind(game);
    const drawRipples = game.drawHiddenSharkRipples.bind(game);
    game.drawShark = shark => { bodies.push(shark.id); drawBody(shark); };
    game.drawHiddenSharkRipples = shark => { ripples.push(shark.id); drawRipples(shark); };
    game.draw();
    assert.deepEqual(bodies, [ahead.id]);
    assert.deepEqual(ripples, [side.id, behind.id]);
    assert.ok(fixture.drawCalls.some(call => call.method === 'clip'));
    assert.equal(game.nightCanvas.width, 1200);
    assert.equal(fixture.drawDepth(), 0);
    behind.state = 'leap'; behind.timer = 0.3;
    bodies.length = 0; ripples.length = 0;
    game.draw();
    assert.deepEqual(bodies, [ahead.id]);
    assert.deepEqual(ripples, [side.id, behind.id]);
});

test('night circle is larger than before and the headlight follows the boat', () => {
    const { game } = setup();
    assert.equal(game.nearLightRadius, 300);
    assert.equal(game.isPointLit(3280, 2000), true);
    assert.equal(game.isPointLit(3000, 2280), true);
    assert.equal(game.isPointLit(3400, 2000), false);
    assert.equal(game.isPointLit(3000, 1500), true);
    assert.equal(game.isPointLit(3000, 1250), false);
    game.rider.angle = Math.PI / 2;
    assert.equal(game.isPointLit(3500, 2000), true);
    assert.equal(game.isPointLit(3000, 1500), false);
});

test('synthwave art paints the full viewport with a neon jet ski but no sun', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    elements.gameCanvas.width = 1600;
    game.rider.x = 5900; game.rider.y = 3900;
    game.updateCamera();
    game.draw();
    assert.ok(fixture.drawCalls.some(call => call.method === 'fillRect' && call.args[2] === 1600 && call.args[3] === 660));
    assert.ok(fixture.drawCalls.some(call => call.method === 'fill' && call.fillStyle === '#e63bbe'));
    assert.ok(!fixture.drawCalls.some(call => call.method === 'fillRect' && call.fillStyle === '#ff748e'));
    const source = fs.readFileSync(path.join(__dirname, '../public/scripts/game.js'), 'utf8');
    assert.ok(!source.includes('sunX'));
    assert.equal(fixture.drawDepth(), 0);
});

test('island layouts randomize each round, stay separated, and leave safe spawn/pickups', () => {
    const { game } = setup({ islands: true });
    let previous = game.islands.map(island => [island.x, island.y]);
    for (let round = 0; round < 5; round++) {
        game.reset();
        assert.equal(game.islands.length, 14);
        assert.notDeepEqual(game.islands.map(island => [island.x, island.y]), previous);
        for (const island of game.islands) {
            assert.ok(island.x - island.radius >= 0 && island.x + island.radius <= 6000);
            assert.ok(island.y - island.radius >= 0 && island.y + island.radius <= 4000);
            assert.ok(Math.hypot(island.x - 3000, island.y - 2000) >= island.radius + 600);
            for (const other of game.islands) {
                if (other !== island) assert.ok(Math.hypot(island.x - other.x, island.y - other.y) >= island.radius + other.radius + 180);
            }
        }
        for (const gun of game.floatingGuns) assert.equal(game.pointOnLand(gun.x, gun.y, 25), false);
        for (const fish of game.fish) assert.equal(game.pointOnLand(fish.x, fish.y, 25), false);
        game.spawnReplacementGun();
        const replacement = game.floatingGuns.at(-1);
        assert.equal(game.pointOnLand(replacement.x, replacement.y, 25), false);
        previous = game.islands.map(island => [island.x, island.y]);
    }
});

test('island impact stops the rider; only two seconds of backing away releases them', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    game.sharks = [];
    game.islands = [{ x: 3200, y: 2000, radius: 100, palms: [] }];
    fixture.key('d');
    fixture.advance(0.6);
    assert.ok(game.islandCollision);
    assert.equal(game.rider.vx, 0);
    assert.equal(game.pointOnLand(game.rider.x, game.rider.y, game.boatRadius), false);
    fixture.key('d', false);
    fixture.advance(3);
    assert.equal(game.islandCollision.reversed, 0, 'Waiting must not release the rider');
    fixture.key('d');
    fixture.advance(0.5);
    assert.equal(game.islandCollision.reversed, 0, 'Moving farther into land must not count');
    fixture.key('d', false);
    fixture.key('a');
    fixture.advance(1);
    assert.ok(Math.abs(game.islandCollision.reversed - 1) < 1e-8);
    fixture.key('a', false);
    fixture.advance(0.5);
    assert.ok(Math.abs(game.islandCollision.reversed - 1) < 1e-8);
    fixture.key('a');
    fixture.advance(0.9);
    assert.ok(game.islandCollision);
    fixture.advance(0.1);
    assert.equal(game.islandCollision, null);
    const x = game.rider.x;
    fixture.advance(0.5);
    assert.ok(game.rider.x < x);
});

test('boost cannot bypass a collision; touch reversing and reset work', () => {
    const fixture = setup();
    const { game } = fixture;
    game.sharks = [];
    game.islands = [{ x: 3200, y: 2000, radius: 100, palms: [] }];
    fixture.key('d'); fixture.key('q');
    fixture.advance(0.4);
    assert.ok(game.islandCollision);
    assert.equal(game.boosting, false);
    fixture.key('q', false); fixture.key('d', false);
    fixture.key('q');
    assert.equal(game.rider.vx, 0);
    assert.equal(game.boosting, false);
    fixture.key('q', false);
    fixture.buttons['moveLeft:pointerdown']({ preventDefault() {}, pointerId: 1 });
    fixture.advance(2);
    assert.equal(game.islandCollision, null);
    fixture.buttons['moveLeft:pointercancel']();
    game.islandCollision = { nx: -1, ny: 0, reversed: 1 };
    game.reset();
    assert.equal(game.islandCollision, null);
    assert.equal(game.rider.x, 3000);
});

test('islands render and fish avoid swimming onto land', () => {
    const fixture = setup({ islands: true });
    const { game } = fixture;
    const island = game.islands[0];
    game.rider.x = island.x - 200;
    game.rider.y = island.y;
    game.updateCamera();
    const fish = game.fish[0];
    Object.assign(fish, { x: island.x - island.radius - 20, y: island.y, angle: 0, speed: 44 });
    game.updateFish(1);
    assert.equal(game.pointOnLand(fish.x, fish.y, 12), false);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
});

test('sand islands vary in outline and size, with bare and palm/coconut islands', () => {
    const fixture = setup({ islands: true });
    const { game } = fixture;
    assert.ok(game.islands.some(island => island.palms.length === 0));
    assert.ok(game.islands.some(island => island.palms.length > 0 && island.coconuts.length > 0));
    assert.ok(new Set(game.islands.map(island => Math.round(island.radius))).size > 5);
    const proportions = new Set();
    for (const island of game.islands) {
        assert.equal(island.points.length, 28);
        const width = Math.max(...island.points.map(point => point[0])) - Math.min(...island.points.map(point => point[0]));
        const height = Math.max(...island.points.map(point => point[1])) - Math.min(...island.points.map(point => point[1]));
        proportions.add((width / height).toFixed(2));
        for (const coconut of island.coconuts) {
            assert.equal(game.pointOnLand(island.x + coconut.x, island.y + coconut.y), true);
        }
    }
    assert.ok(proportions.size > 5);
    const first = game.islands[0];
    game.rider.x = first.x; game.rider.y = first.y; game.updateCamera();
    game.drawIslands();
    assert.ok(fixture.drawCalls.some(call => call.method === 'fill' && call.fillStyle === '#d28cee'));
    assert.ok(!fixture.drawCalls.some(call => call.fillStyle === '#426f4d'));
    assert.equal(fixture.drawDepth(), 0);
});

test('shoreline collisions follow island polygons, and no impact prompt/countdown remains', () => {
    const fixture = setup();
    const { game } = fixture;
    game.islands = [{ x: 3200, y: 2000, radius: 170,
        points: [[-160, -50], [160, -50], [160, 50], [-160, 50]], palms: [], coconuts: [] }];
    assert.equal(game.pointOnLand(3200, 2100, 32), false, 'Water inside the bounding circle must remain passable');
    assert.equal(game.pointOnLand(3200, 2060, 32), true, 'Boat radius must contact the actual shoreline');
    game.rider.x = 3200; game.rider.y = 2060;
    game.checkIslandCollision();
    assert.ok(game.islandCollision);
    assert.equal(game.pointOnLand(game.rider.x, game.rider.y, 32), false);
    assert.ok(game.islandCollision.ny > 0.99);
    for (const file of ['game.html']) {
        const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
        assert.ok(!html.includes('islandPrompt'));
    }
    const source = fs.readFileSync(path.join(__dirname, '../public/scripts/game.js'), 'utf8');
    assert.ok(!source.includes('updateIslandPrompt'));
});

test('inventory uses a real spear image only while a slot contains an item', () => {
    const fixture = setup();
    const { game, elements } = fixture;
    assert.equal(elements.inventoryItem1.hidden, true);
    Object.assign(game.rider, { x: game.floatingGuns[0].x, y: game.floatingGuns[0].y });
    game.pickUpGun();
    assert.equal(elements.inventoryItem1.hidden, false);
    assert.equal(elements.inventoryItem2.hidden, true);
    for (let i = 0; i < 12; i++) {
        assert.equal(game.fireGun(), true);
        game.time += 0.21;
    }
    assert.equal(elements.inventoryItem1.hidden, true);
    for (const file of ['game.html']) {
        const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
        assert.equal((html.match(/<img id="inventoryItem[1-6]" src="assets\/spear.svg" alt="Spear" hidden>/g) || []).length, 6);
    }
    const icon = fs.readFileSync(path.join(__dirname, '../public/assets/spear.svg'), 'utf8');
    assert.ok(icon.includes('viewBox="0 0 64 64"'));
    assert.ok(icon.includes('<path'));
});

test('sharks route around an island during pursuit without ever crossing the shore', () => {
    const fixture = setup();
    const { game } = fixture;
    game.islands = [{ x: 3200, y: 2000, radius: 130, palms: [] }];
    const shark = fixture.shark(2800);
    game.rider.x = 3600; game.rider.y = 2000; game.updateCamera();
    game.blood = [{ x: 3600, y: 2000, life: 100 }];
    let detoured = false;
    for (let i = 0; i < 12 * 120; i++) {
        game.time += 1 / 120;
        game.updateSharks(1 / 120);
        assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
        if (Math.abs(shark.y - 2000) > 190) detoured = true;
        if (Math.hypot(shark.x - game.rider.x, shark.y - game.rider.y) < 130) break;
    }
    assert.ok(detoured, 'Should take a real detour instead of stopping at the island');
    assert.ok(Math.hypot(shark.x - 3600, shark.y - 2000) < 130);
});

test('returning sharks navigate around land to reach their home territory', () => {
    const fixture = setup();
    const { game } = fixture;
    game.islands = [{ x: 900, y: 1000, radius: 140, palms: [] }];
    const shark = fixture.shark(1200, 1000);
    shark.state = 'return';
    game.rider.x = 5000; game.rider.y = 3500; game.updateCamera();
    let reached = false;
    for (let i = 0; i < 12 * 120; i++) {
        game.time += 1 / 120;
        game.updateSharks(1 / 120);
        assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
        if (Math.hypot(shark.x - shark.homeX, shark.y - shark.homeY) < 5) { reached = true; break; }
    }
    assert.ok(reached);
});

test('leaping sharks cannot jump through an island', () => {
    const fixture = setup();
    const { game } = fixture;
    game.islands = [{ x: 3100, y: 2000, radius: 40, palms: [] }];
    const shark = fixture.shark(2980, 2000);
    Object.assign(shark, { state: 'leap', timer: 0, leapX: 1, leapY: 0 });
    game.rider.x = 3220; game.updateCamera();
    for (let i = 0; i < 90; i++) {
        game.time += 1 / 120;
        game.updateSharks(1 / 120);
        assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
    }
    assert.equal(game.health, 100);
});

test('water-route segment checks prevent tunneling and preserve open water', () => {
    const { game } = setup();
    game.islands = [{ x: 3200, y: 2000, radius: 100, palms: [] }];
    assert.equal(game.waterSegmentClear(2800, 2000, 3600, 2000), false);
    assert.equal(game.waterSegmentClear(2800, 1800, 3600, 1800), true);
    const target = game.waterTarget(3200, 2000);
    assert.equal(game.pointOnLand(target.x, target.y, game.sharkClearance), false);
});

test('narrow map-edge channels do not push a shark back onto land', () => {
    const fixture = setup();
    const { game } = fixture;
    game.islands = [{ x: 200, y: 2000, radius: 110, palms: [] }];
    const goal = game.waterTarget(60, 2000);
    assert.ok(goal.x >= game.margin && goal.y >= game.margin);
    assert.equal(game.pointOnLand(goal.x, goal.y, game.sharkClearance), false);
    const shark = fixture.shark(400, 2000);
    for (let i = 0; i < 600; i++) {
        game.time += 1 / 120;
        game.moveShark(shark, 60, 2000, game.sharkSpeed / 120);
        assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
        assert.ok(shark.x >= game.margin);
    }
});

test('all ten sharks stay clear of land while patrolling a generated map', () => {
    const { game } = setup({ islands: true });
    game.invulnerable = Infinity;
    for (let i = 0; i < 200; i++) {
        game.time += 0.1;
        game.updateSharks(0.1);
        for (const shark of game.sharks) {
            assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false, 'Shark ' + shark.id + ' crossed a shoreline');
        }
    }
    assert.equal(game.sharks.length, 10);
});

function shoreSetup() {
    const fixture = setup();
    const { game } = fixture;
    game.islands = [{ x: 3200, y: 2000, radius: 100, palms: [], coconuts: [] }];
    game.sharks = [];
    game.floatingGuns = [];
    Object.assign(game.rider, { x: 3050, y: 2000, vx: 0, vy: 0, angle: Math.PI / 2 });
    game.updateCamera(); game.updatePickupPrompt();
    return fixture;
}

function coconutSetup() {
    const fixture = shoreSetup();
    fixture.game.islands[0].coconuts = [{ id: 'coconut-test-1', x: -40, y: 0 }];
    return fixture;
}

test('E collects nearby island coconuts into separate inventory slots without duplicate pickups', () => {
    const fixture = coconutSetup();
    const { game, elements } = fixture;
    const island = game.islands[0];
    island.coconuts.push({ id: 'coconut-test-2', x: -40, y: 1 });
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onFoot, true);
    assert.equal(elements.pickupPrompt.textContent, 'E · PICK UP COCONUT');
    fixture.key('e');
    assert.equal(game.onFoot, true, 'Nearby coconut takes priority over reboarding');
    assert.equal(game.inventory[0].name, 'Coconut');
    assert.equal(game.inventory[0].type, 'coconut');
    assert.equal(island.coconuts.length, 1);
    assert.equal(elements.inventoryItem1.src, 'assets/coconut.svg');
    assert.equal(elements.inventoryItem1.alt, 'Coconut');
    assert.equal(elements.inventoryDurability1.hidden, true);
    fixture.key('e');
    assert.equal(island.coconuts.length, 1, 'Holding E cannot repeat a pickup');
    fixture.key('e', false); fixture.key('2'); fixture.key('e');
    assert.equal(island.coconuts.length, 0);
    assert.equal(game.inventory.filter(item => item?.type === 'coconut').length, 2);
    assert.equal(new Set(game.inventory.filter(Boolean).map(item => item.id)).size, 2);
    assert.equal(elements.inventoryCount.textContent, '2 / 6');
});

test('coconut pickups require being on foot on the island, within range, and alive', () => {
    const fixture = coconutSetup();
    const { game } = fixture;
    Object.assign(game.rider, { x: 3160, y: 2000 });
    assert.equal(game.pickUpCoconut(), false, 'A jet ski cannot collect coconuts');
    game.walkIsland = game.islands[0]; game.onFoot = true;
    game.rider.x = 3260;
    assert.equal(game.pickUpCoconut(), false, 'Distant coconuts cannot be collected');
    game.rider.x = 3160; game.gameOver = true;
    assert.equal(game.pickUpCoconut(), false);
    game.gameOver = false; game.rider.x = 3050;
    assert.equal(game.pickUpCoconut(), false, 'On-foot state outside the island is insufficient');
    assert.equal(game.islands[0].coconuts.length, 1);
    assert.equal(game.inventory.every(item => item === null), true);
});

test('full inventory leaves coconuts on the island and still allows returning to the jet ski', () => {
    const fixture = coconutSetup();
    const { game, elements } = fixture;
    fixture.key('e'); fixture.key('e', false);
    game.inventory = Array.from({ length: 6 }, (_, i) => ({ id: 'full-' + i, name: 'Spear gun', durability: 12 }));
    const items = game.inventory.slice();
    game.rider.x = 3200;
    game.updatePickupPrompt();
    assert.equal(elements.pickupPrompt.textContent, 'INVENTORY FULL');
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.islands[0].coconuts.length, 1);
    assert.equal(game.onFoot, true);
    game.rider.x = 3124;
    game.updatePickupPrompt();
    assert.equal(elements.pickupPrompt.textContent, 'E · BOARD JET SKI');
    fixture.key('e');
    assert.equal(game.onFoot, false);
    assert.equal(game.islands[0].coconuts.length, 1);
    for (let i = 0; i < 6; i++) assert.equal(game.inventory[i], items[i]);
});

test('selecting a coconut neither fires nor draws a spear gun and the collected coconut stays gone', () => {
    const fixture = coconutSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false); fixture.key('e');
    let drawnGuns = 0;
    game.drawGun = () => { drawnGuns++; };
    game.aim.active = true;
    game.draw();
    assert.equal(drawnGuns, 0);
    assert.equal(fixture.drawDepth(), 0);
    assert.equal(game.fireGun(), false);
    assert.equal(game.projectiles.length, 0);
    assert.equal(game.islands[0].coconuts.length, 0);
    assert.equal(game.inventory[0].type, 'coconut');
    assert.ok(fs.readFileSync(path.join(__dirname, '../public/assets/coconut.svg'), 'utf8').includes('<svg'));
});

test('E eats the selected coconut once, restores twelve health, and frees its inventory slot', () => {
    const fixture = coconutSetup();
    const { game, elements } = fixture;
    fixture.key('e'); fixture.key('e', false); fixture.key('e'); fixture.key('e', false);
    game.health = 60;
    assert.equal(elements.pickupPrompt.textContent, 'E · EAT COCONUT');
    fixture.key('e');
    assert.equal(game.health, 72);
    assert.equal(elements.healthBar.value, 72);
    assert.equal(game.inventory[0], null);
    assert.equal(elements.inventoryItem1.hidden, true);
    assert.equal(elements.inventoryCount.textContent, '0 / 6');
    assert.equal(game.onFoot, true, 'Eating takes priority over reboarding');
    assert.equal(game.islands[0].coconuts.length, 0);
    fixture.key('e');
    assert.equal(game.health, 72, 'Holding E cannot repeatedly heal');
});

test('coconut healing caps at full health and cannot revive a game-over player', () => {
    const { game } = setup();
    game.inventory[0] = { id: 'heal', type: 'coconut', name: 'Coconut' };
    game.health = 95;
    assert.equal(game.eatCoconut(), true);
    assert.equal(game.health, 100);
    assert.equal(game.inventory[0], null);
    game.inventory[0] = { id: 'revive', type: 'coconut', name: 'Coconut' };
    game.health = 0; game.gameOver = true;
    assert.equal(game.eatCoconut(), false);
    assert.equal(game.health, 0);
    assert.equal(game.inventory[0].id, 'revive');
});

test('eating uses the selected slot and works on the jet ski and captured ship', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    game.inventory[1] = { id: 'snack-one', type: 'coconut', name: 'Coconut' };
    game.health = 50;
    fixture.key('2'); fixture.key('e'); fixture.key('e', false);
    assert.equal(game.health, 62);
    assert.equal(game.onPirateShip, false, 'Eating takes priority over boarding the nearby ship');
    assert.equal(game.inventory[1], null);
    fixture.key('1'); fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onPirateShip, true);
    game.inventory[1] = { id: 'snack-two', type: 'coconut', name: 'Coconut' };
    fixture.key('2'); fixture.key('e');
    assert.equal(game.health, 74);
    assert.equal(game.onPirateShip, true, 'Eating takes priority over leaving the ship');
    assert.equal(game.inventory[1], null);
    assert.equal(game.inventory[0].type, 'cannon');
});

test('generated coconut items are on land with unique IDs and are restored on a new round', () => {
    const { game } = setup({ islands: true });
    const checkDistribution = () => {
        assert.equal(game.islands.length, 14);
        const populated = game.islands.filter(island => island.coconuts.length > 0);
        assert.equal(populated.length, 7);
        for (const island of populated) {
            assert.equal(island.coconuts.length, 2);
            for (const item of island.coconuts) {
                assert.equal(game.canWalkAt(island.x + item.x, island.y + item.y, island), true);
            }
        }
    };
    checkDistribution();
    const coconuts = game.islands.flatMap(island => island.coconuts);
    assert.ok(coconuts.length > 0);
    assert.equal(new Set(coconuts.map(item => item.id)).size, coconuts.length);
    const island = game.islands.find(item => item.coconuts.length);
    game.onFoot = true; game.walkIsland = island;
    Object.assign(game.rider, { x: island.x, y: island.y });
    const coconut = game.nearbyCoconut();
    assert.ok(coconut);
    assert.equal(game.pickUpCoconut(), true);
    assert.equal(island.coconuts.includes(coconut), false);
    game.reset();
    checkDistribution();
    assert.equal(game.inventory.every(item => item === null), true);
    assert.equal(game.islands.includes(island), false);
    assert.ok(game.islands.some(item => item.coconuts.length > 0));
});

function captureSetup() {
    const fixture = setup();
    const { game } = fixture;
    game.sharks = []; game.floatingGuns = [];
    Object.assign(game.pirateShip, { x: 3200, y: 2000, angle: 0 });
    Object.assign(game.rider, { x: 3200, y: 2100, vx: 0, vy: 0 });
    for (let i = 0; i < 16; i++) game.damagePirateShip();
    game.updateCamera(); game.updatePickupPrompt();
    return fixture;
}

test('sixteen actual spear hits disarm the pirate; misses do not count and fifteen are insufficient', () => {
    const fixture = setup();
    const { game } = fixture;
    game.sharks = [];
    Object.assign(game.pirateShip, { x: 3200, y: 2000, angle: 0 });
    Object.assign(game.rider, { x: 2800, y: 2000, angle: Math.PI / 2 });
    game.inventory[0] = { id: 'one', name: 'Spear gun', durability: 12 };
    game.inventory[1] = { id: 'two', name: 'Spear gun', durability: 12 };
    game.projectiles = [{ x: 2800, y: 2150, vx: 1100, vy: 0, life: 1.2 }];
    game.updateProjectiles(0.6);
    assert.equal(game.pirateShip.hits, 0);
    game.projectiles = [];
    for (let hit = 1; hit <= 16; hit++) {
        if (hit === 13) fixture.key('2');
        assert.equal(game.fireGun(), true);
        game.updateProjectiles(0.5);
        assert.equal(game.pirateShip.hits, hit);
        assert.equal(game.pirateShip.disarmed, hit === 16);
        assert.equal(game.projectiles.length, 0);
        game.time += 0.21;
    }
    const x = game.pirateShip.x, y = game.pirateShip.y;
    game.updatePirateShip(20);
    assert.equal(game.pirateShip.x, x); assert.equal(game.pirateShip.y, y);
    assert.equal(game.cannonballs.length, 0);
    game.damagePirateShip();
    assert.equal(game.pirateShip.hits, 16);
});

test('a spear hits whichever target comes first, including a rotated pirate hull', () => {
    const fixture = setup();
    const { game } = fixture;
    Object.assign(game.pirateShip, { x: 3200, y: 2000, angle: Math.PI / 2 });
    const shark = fixture.shark(2900, 2000);
    const shoot = () => {
        game.projectiles = [{ x: 2700, y: 2000, vx: 1100, vy: 0, life: 1.2 }];
        game.updateProjectiles(0.8);
    };
    shoot();
    assert.equal(shark.health, 2);
    assert.equal(game.pirateShip.hits, 0);
    shark.x = 3500;
    shoot();
    assert.equal(game.pirateShip.hits, 1);
    assert.equal(shark.health, 2);
});

test('boarding requires a disarmed ship and proximity; the cannon occupies a selectable slot', () => {
    const fixture = captureSetup();
    const { game, elements } = fixture;
    game.pirateShip.disarmed = false;
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onPirateShip, false);
    game.pirateShip.disarmed = true;
    game.rider.x = 2000;
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onPirateShip, false);
    game.rider.x = 3200;
    game.updatePickupPrompt();
    assert.equal(elements.pickupPrompt.textContent, 'E · BOARD PIRATE SHIP');
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onPirateShip, true);
    assert.equal(game.inventory[game.selectedSlot].type, 'cannon');
    assert.equal(elements.inventoryItem1.src, 'assets/cannon.svg');
    assert.equal(elements.inventoryDurability1.hidden, true);
    assert.equal(elements.pickupPrompt.textContent, 'E · RETURN TO JET SKI');
    fixture.key('2'); assert.equal(game.fireGun(), false);
    fixture.key('1'); assert.equal(game.fireGun(), true);
    assert.equal(game.cannonballs[0].owner, 'player');
});

test('captured cannon uses pointer aim and primary click, with exactly a three-second cooldown', () => {
    const fixture = captureSetup();
    const { game, buttons } = fixture;
    fixture.key('e'); fixture.key('e', false);
    const click = () => buttons['canvas:pointerdown']({ button: 0, clientX: 500, clientY: 165, preventDefault() {} });
    click();
    assert.equal(game.cannonballs.length, 1);
    const ball = game.cannonballs[0], cannon = game.pirateCannonPose();
    assert.equal(ball.x, cannon.muzzleX); assert.equal(ball.y, cannon.muzzleY);
    const targetX = game.camera.x + 1000, targetY = game.camera.y + 330;
    assert.ok(Math.abs(ball.vx * (targetY - ball.y) - ball.vy * (targetX - ball.x)) < 1e-6);
    assert.ok(Math.abs(Math.hypot(ball.vx, ball.vy) - 320) < 1e-6);
    game.time = 2.99; click(); assert.equal(game.cannonballs.length, 1);
    game.time = 3; click(); assert.equal(game.cannonballs.length, 2);
    game.time = 6; click(); assert.equal(game.cannonballs.length, 3);
    assert.equal(game.inventory[game.selectedSlot].type, 'cannon');
    fixture.key('e'); fixture.key('e', false);
    fixture.key('e'); fixture.key('e', false);
    click(); assert.equal(game.cannonballs.length, 3, 'Reboarding cannot bypass the cannon cooldown');
    game.time = 9;
    click(); assert.equal(game.cannonballs.length, 4);
    fixture.key('e');
    assert.equal(game.firePlayerCannon(), false);
});

test('player cannonballs kill the first shark hit and cannot hurt the player or their own ship', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    fixture.key('e');
    game.aim = { active: true, u: 1, v: 0.5 };
    const shark = fixture.shark(3600, 2000);
    const second = { ...shark, id: 99, x: 3800 };
    game.sharks.push(second);
    assert.equal(game.fireGun(), true);
    game.updateCannonballs(3);
    assert.equal(shark.state, 'dead');
    assert.equal(second.health, 3);
    assert.equal(game.health, 100);
    assert.equal(game.pirateShip.hits, 16);
    assert.equal(game.cannonballs.length, 0);
    assert.equal(game.blood.length, 1);
    assert.equal(shark.respawnAt, game.time + 10);
});

test('sharks cannot pursue or bite the player aboard, and protection ends after leaving', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    const shark = fixture.shark(game.rider.x, game.rider.y);
    Object.assign(shark, { state: 'leap', timer: 0.1, leapX: 1, leapY: 0 });
    assert.equal(game.canPursue(shark), false);
    game.takeBite();
    fixture.advance(0.5);
    assert.equal(game.health, 100);
    assert.equal(game.blood.length, 0);
    fixture.key('e');
    game.takeBite();
    assert.equal(game.health, 75);
});

test('full inventory is preserved across boarding, firing other guns, and returning to the jet ski', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    game.inventory = Array.from({ length: 6 }, (_, i) => ({ id: 'kept-' + i, name: 'Spear gun', durability: 12 }));
    const saved = game.inventory.slice();
    fixture.key('3');
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.inventory[2].type, 'cannon');
    fixture.key('1');
    assert.equal(game.fireGun(), true);
    assert.equal(saved[0].durability, 11);
    fixture.key('e');
    assert.equal(game.onPirateShip, false);
    assert.equal(game.parkedBoat, null);
    assert.equal(game.stowedCannonSlot, null);
    for (let i = 0; i < 6; i++) assert.equal(game.inventory[i], saved[i]);
    assert.equal(game.selectedSlot, 2);
    assert.equal(game.boardReadyAt, game.time + 2);
    assert.equal(fixture.elements.inventoryItem3.src, 'assets/spear.svg');
});

test('captured ship uses WASD, blocks island collisions and boost, renders, and resets capture state', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    game.islands = [{ x: 3600, y: 2000, radius: 100, palms: [], coconuts: [] }];
    fixture.key('d'); fixture.key('q');
    fixture.advance(2);
    assert.ok(game.pirateShip.x > 3200);
    assert.ok(game.pirateShip.x <= 3313);
    assert.equal(game.pointOnLand(game.pirateShip.x, game.pirateShip.y, game.pirateShip.clearance), false);
    assert.equal(game.rider.x, game.pirateShip.x);
    assert.equal(game.rider.y, game.pirateShip.y);
    assert.ok(Math.abs(Math.hypot(game.parkedBoat.x - game.rider.x, game.parkedBoat.y - game.rider.y) - 100) < 1e-6);
    assert.equal(game.boost, 100);
    assert.equal(game.boosting, false);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
    game.reset();
    assert.equal(game.onPirateShip, false);
    assert.equal(game.stowedCannonSlot, null);
    assert.equal(game.pirateShip.hits, 0);
    assert.equal(game.pirateShip.disarmed, false);
    assert.equal(game.inventory.every(item => item === null), true);
});

test('captured ship keeps sailing after releasing controls and remembers the latest direction', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    fixture.advance(0.5);
    assert.equal(game.pirateShip.x, 3200, 'Boarding waits for the first steering input');
    fixture.key('d'); fixture.advance(0.5); fixture.key('d', false);
    const x = game.pirateShip.x, y = game.pirateShip.y;
    fixture.advance(1);
    assert.ok(Math.abs(game.pirateShip.x - x - 95) < 1e-6);
    assert.equal(game.pirateShip.y, y);
    fixture.key('w'); fixture.key('a'); fixture.advance(0.5);
    fixture.key('w', false); fixture.key('a', false);
    const fromX = game.pirateShip.x, fromY = game.pirateShip.y;
    fixture.advance(1);
    assert.ok(game.pirateShip.x < fromX && game.pirateShip.y < fromY);
    assert.ok(Math.abs(Math.hypot(game.pirateShip.x - fromX, game.pirateShip.y - fromY) - 95) < 1e-6);
    assert.equal(game.rider.x, game.pirateShip.x);
    assert.equal(game.rider.y, game.pirateShip.y);
});

test('automatic sailing still stops at islands without putting the hull on land', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    game.islands = [{ x: 3800, y: 2000, radius: 100, palms: [], coconuts: [] }];
    fixture.key('d'); fixture.advance(0.1); fixture.key('d', false);
    for (let i = 0; i < 80; i++) { fixture.advance(0.1); assertPirateHullInWater(game); }
    assert.ok(game.pirateShip.x > 3400 && game.pirateShip.x < 3514);
    const x = game.pirateShip.x;
    fixture.advance(1);
    assert.equal(game.pirateShip.x, x);
    fixture.key('a'); fixture.advance(1); fixture.key('a', false);
    const backedUpX = game.pirateShip.x;
    fixture.advance(1);
    assert.ok(game.pirateShip.x < backedUpX);
});

test('leaving and resetting clear automatic sailing so the next boarding starts stationary', () => {
    const fixture = captureSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    fixture.key('d'); fixture.advance(0.2); fixture.key('d', false);
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.pirateShip.cruiseDirection, null);
    const x = game.pirateShip.x, y = game.pirateShip.y;
    fixture.advance(0.5);
    assert.equal(game.pirateShip.x, x); assert.equal(game.pirateShip.y, y);
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onPirateShip, true);
    fixture.advance(0.5);
    assert.equal(game.pirateShip.x, x); assert.equal(game.pirateShip.y, y);
    fixture.key('d'); fixture.advance(0.1);
    game.reset();
    assert.equal(game.pirateShip.cruiseDirection, null);
});

test('pirate spawns fully offscreen in open water on initial load and resets with wider views', () => {
    const { game } = setup({ islands: true });
    const check = () => {
        const ship = game.pirateShip;
        assert.equal(game.pirateOnScreen(), false);
        assert.ok(ship.x + 220 < game.camera.x || ship.x - 220 > game.camera.x + game.canvas.width ||
            ship.y + 220 < game.camera.y || ship.y - 220 > game.camera.y + game.canvas.height);
        assert.equal(game.piratePoseClear(ship.x, ship.y, ship.angle), true);
        assertPirateHullInWater(game);
    };
    check();
    for (const width of [1200, 2200, 3600]) {
        game.canvas.width = width;
        game.rider.x = 5700; game.rider.y = 3600;
        game.updateCamera(); // Leave a stale camera from a previous run.
        game.reset();
        check();
    }
});

test('pirate spawn falls back to other offscreen water when new islands block nearby spawn positions', () => {
    const { game } = setup();
    const blocked = [{ x: 3000, y: 1290 }, { x: 2020, y: 2000 },
        { x: 3000, y: 2710 }, { x: 3980, y: 2000 }];
    game.createIslands = () => blocked.map(p => ({ ...p, radius: 230, palms: [], coconuts: [] }));
    game.reset();
    assert.equal(game.pirateOnScreen(), false);
    assert.equal(game.piratePoseClear(game.pirateShip.x, game.pirateShip.y, game.pirateShip.angle), true);
    assertPirateHullInWater(game);
    assert.ok(blocked.every(p => p.x !== game.pirateShip.x || p.y !== game.pirateShip.y));
});

test('pirate tours all twelve map areas including the interior', () => {
    const { game } = setup();
    const areas = new Set();
    for (let i = 0; i < 700; i++) {
        game.time += 1;
        game.updatePirateShip(1);
        const ship = game.pirateShip;
        assert.ok(ship.x >= ship.clearance && ship.x <= game.world.width - ship.clearance);
        assert.ok(ship.y >= ship.clearance && ship.y <= game.world.height - ship.clearance);
        areas.add(Math.floor(ship.x / 1500) + ':' + Math.floor(ship.y / (4000 / 3)));
    }
    assert.equal(areas.size, 12);
    assert.ok(game.pirateShip.roamIndex >= 12);
});

test('pirate routes its full hull around an island blocking its destination', () => {
    const { game } = setup();
    game.islands = [{ x: 3000, y: 2000, radius: 260 }];
    const ship = game.pirateShip;
    Object.assign(ship, { x: 2200, y: 2000, angle: 0 });
    const goal = { x: 3800, y: 2000 };
    assert.equal(game.waterSegmentClear(ship.x, ship.y, goal.x, goal.y, ship.clearance), false);
    ship.route = game.waterRoute(ship, goal, ship.clearance, true);
    ship.routeIslands = game.islands;
    assert.ok(ship.route.length > 1);
    let detoured = false;
    for (let i = 0; i < 1000 && Math.hypot(ship.x - goal.x, ship.y - goal.y) > 1; i++) {
        const x = ship.x, y = ship.y;
        game.steerPirateShip(0.1);
        assert.equal(game.waterSegmentClear(x, y, ship.x, ship.y, ship.clearance), true);
        assert.equal(game.piratePoseClear(ship.x, ship.y, ship.angle), true);
        if (Math.abs(ship.y - 2000) > 300) detoured = true;
    }
    assert.equal(detoured, true);
    assert.ok(Math.hypot(ship.x - goal.x, ship.y - goal.y) <= 1);
    game.waterRoute({ x: 2200, y: 2000 }, goal);
    assert.equal(game.navigation.padding, game.sharkClearance);
    assert.equal(game.pirateNavigation.padding, ship.clearance);
});

test('pirate stays clear of generated islands and replans when an unsafe route is blocked', () => {
    const { game } = setup({ islands: true });
    const ship = game.pirateShip;
    for (let i = 0; i < 1800; i++) {
        const x = ship.x, y = ship.y;
        game.steerPirateShip(0.25);
        assert.equal(game.waterSegmentClear(x, y, ship.x, ship.y, ship.clearance), true);
        assert.equal(game.piratePoseClear(ship.x, ship.y, ship.angle), true);
    }
    assert.ok(ship.roamIndex >= 12);
    game.islands = [{ x: 3000, y: 2000, radius: 260 }];
    Object.assign(ship, { x: 2200, y: 2000, route: [{ x: 3800, y: 2000 }], routeIslands: game.islands });
    game.steerPirateShip(10);
    assert.equal(ship.x, 2200);
    const oldIndex = ship.roamIndex;
    for (let i = 0; i < 300; i++) {
        game.steerPirateShip(0.1);
        assert.equal(game.piratePoseClear(ship.x, ship.y, ship.angle), true);
    }
    assert.ok(ship.roamIndex > oldIndex);
});

function assertPirateHullInWater(game) {
    const ship = game.pirateShip;
    const hull = [[-94, -24], [51, -32], [100, 0], [51, 32], [-94, 24]].map(([x, y]) => ({
        x: ship.x + x * ship.scaleX * Math.cos(ship.angle) - y * ship.scaleY * Math.sin(ship.angle),
        y: ship.y + x * ship.scaleX * Math.sin(ship.angle) + y * ship.scaleY * Math.cos(ship.angle)
    }));
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        assert.equal(game.waterSegmentClear(a.x, a.y, b.x, b.y, 0), true, 'Rendered hull crossed an island');
    }
}

function channelSetup(gap = 200) {
    const fixture = captureSetup();
    const { game } = fixture;
    game.islands = [
        { x: 3200, y: 2000 - 200 - gap / 2, radius: 200, palms: [], coconuts: [] },
        { x: 3200, y: 2000 + 200 + gap / 2, radius: 200, palms: [], coconuts: [] }
    ];
    Object.assign(game.pirateShip, { x: 2600, y: 2000, angle: 0 });
    Object.assign(game.rider, { x: 2600, y: 2100 });
    return fixture;
}

test('captured pirate can drive through a 200-pixel channel while its bow, stern, and jet ski stay in water', () => {
    const fixture = channelSetup();
    const { game } = fixture;
    assert.equal(game.pointOnLand(3200, 2000, 190), true, 'Old circular clearance blocked this channel');
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onPirateShip, true);
    fixture.key('d');
    for (let i = 0; i < 140; i++) {
        fixture.advance(0.1);
        assertPirateHullInWater(game);
        assert.equal(game.pointOnLand(game.parkedBoat.x, game.parkedBoat.y, game.boatRadius), false);
    }
    assert.ok(game.pirateShip.x > 3800);
    fixture.key('d', false);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
});

test('autonomous pirate routing uses channels that fit the hull instead of taking a circle-sized detour', () => {
    const { game } = channelSetup();
    const ship = game.pirateShip;
    ship.disarmed = false;
    const goal = { x: 3800, y: 2000 };
    ship.route = game.waterRoute(ship, goal, ship.clearance, true);
    ship.routeIslands = game.islands;
    assert.ok(ship.route.some(p => Math.abs(p.x - 3200) < 50 && Math.abs(p.y - 2000) < 75));
    for (let i = 0; i < 150 && Math.hypot(ship.x - goal.x, ship.y - goal.y) > 1; i++) {
        game.steerPirateShip(0.1);
        assertPirateHullInWater(game);
    }
    assert.ok(Math.hypot(ship.x - goal.x, ship.y - goal.y) <= 1);
});

test('turning cannot sweep the stern onto an island, and the captured pirate can reverse out of a tight gap', () => {
    const fixture = channelSetup(120);
    const { game } = fixture;
    Object.assign(game.pirateShip, { x: 3200 });
    Object.assign(game.rider, { x: 3200, y: 2100 });
    fixture.key('e'); fixture.key('e', false);
    fixture.key('w');
    for (let i = 0; i < 20; i++) { fixture.advance(0.1); assertPirateHullInWater(game); }
    fixture.key('w', false); fixture.key('a');
    for (let i = 0; i < 60; i++) { fixture.advance(0.1); assertPirateHullInWater(game); }
    assert.ok(game.pirateShip.x < 2800, 'Ship should be able to back out instead of becoming stuck');
});

test('channels narrower than the visible hull still block the pirate ship', () => {
    const fixture = channelSetup(70);
    const { game } = fixture;
    assert.equal(game.pirateRouteClear(2600, 2000, 3800, 2000), false);
    fixture.key('e'); fixture.key('e', false); fixture.key('d');
    for (let i = 0; i < 160; i++) { fixture.advance(0.1); assertPirateHullInWater(game); }
    assert.ok(game.pirateShip.x < 3200);
});

test('pirate fires only after three visible seconds, repeats every three, and aims at the rider', () => {
    const { game } = setup();
    Object.assign(game.pirateShip, { x: 3000, y: 1600 });
    game.steerPirateShip = () => {}; // Keep visibility fixed while checking the firing clock.
    game.camera.x = 2700; game.camera.y = 1400;
    Object.assign(game.rider, { x: 3300, y: 250 });
    game.updatePirateShip(2.99);
    assert.equal(game.cannonballs.length, 0);
    game.updatePirateShip(0.01);
    assert.equal(game.cannonballs.length, 1);
    const ball = game.cannonballs[0];
    const muzzle = game.pirateCannonPose();
    assert.equal(ball.x, muzzle.muzzleX);
    assert.equal(ball.y, muzzle.muzzleY);
    const dx = game.rider.x - ball.x, dy = game.rider.y - ball.y;
    assert.ok(Math.abs(ball.vx * dy - ball.vy * dx) < 1e-6);
    assert.ok(Math.abs(Math.hypot(ball.vx, ball.vy) - 320) < 1e-6);
    game.updatePirateShip(2.99);
    assert.equal(game.cannonballs.length, 1);
    game.updatePirateShip(0.01);
    assert.equal(game.cannonballs.length, 2);
    game.camera.y = 3000;
    game.updatePirateShip(20);
    assert.equal(game.cannonballs.length, 2);
    assert.equal(game.pirateShip.fireTimer, 0);
    game.camera.x = game.pirateShip.x - 600; game.camera.y = game.pirateShip.y - 330;
    game.updatePirateShip(0.1);
    assert.equal(game.cannonballs.length, 2, 'Reappearing does not cause an immediate shot');
});

test('cannonballs sweep for hits, deal exactly 75 health, and disappear after one hit', () => {
    const { game, elements } = setup();
    game.invulnerable = 1;
    const hit = () => {
        game.cannonballs.push({ x: game.rider.x - 150, y: game.rider.y, vx: 320, vy: 0, life: 30 });
        game.updateCannonballs(1);
    };
    hit();
    assert.equal(game.health, 25);
    assert.equal(game.cannonballs.length, 0);
    assert.equal(game.gameOver, false);
    game.updateCannonballs(1);
    assert.equal(game.health, 25);
    hit();
    assert.equal(game.health, 0);
    assert.equal(game.gameOver, true);
    assert.equal(elements.gameOver.hidden, false);
    assert.equal(elements.deathCause.textContent, 'Cannonball Attack');
});

test('cannonballs can be dodged, expire, and damage the rider on an island', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    fixture.key('e');
    game.cannonballs.push({ x: game.rider.x - 100, y: game.rider.y, vx: 320, vy: 0, life: 30 });
    game.rider.y += 60;
    game.updateCannonballs(0.7);
    assert.equal(game.health, 100);
    game.updateCannonballs(30);
    assert.equal(game.cannonballs.length, 0);
    game.cannonballs.push({ x: game.rider.x - 100, y: game.rider.y, vx: 320, vy: 0, life: 30 });
    game.updateCannonballs(0.5);
    assert.equal(game.health, 25);
});

test('pirate ship and cannonballs render safely, reset completely, and freeze on game over', () => {
    const fixture = setup();
    const { game } = fixture;
    Object.assign(game.pirateShip, { x: 3000, y: 1600 });
    game.steerPirateShip = () => {};
    game.camera.x = 2700; game.camera.y = 1400;
    game.updatePirateShip(3);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
    assert.ok(fixture.drawCalls.some(call => call.method === 'arc' && call.args[2] === 9));
    game.gameOver = true;
    const ship = JSON.stringify(game.pirateShip), balls = JSON.stringify(game.cannonballs);
    game.step(1);
    game.updatePirateShip(1);
    game.updateCannonballs(1);
    assert.equal(JSON.stringify(game.pirateShip), ship);
    assert.equal(JSON.stringify(game.cannonballs), balls);
    game.reset();
    assert.equal(game.cannonballs.length, 0);
    assert.equal(game.pirateOnScreen(), false);
    assert.equal(game.piratePoseClear(game.pirateShip.x, game.pirateShip.y, game.pirateShip.angle), true);
    assert.equal(game.pirateShip.fireTimer, 0);
    assert.equal(game.health, 100);
});

test('larger pirate ship shows its gunner and a muzzle blast only when firing', () => {
    const fixture = setup();
    const { game, drawCalls } = fixture;
    Object.assign(game.pirateShip, { x: 3000, y: 1600 });
    game.steerPirateShip = () => {};
    game.camera.x = 2700; game.camera.y = 1400;
    game.drawPirateShip();
    assert.ok(drawCalls.some(call => call.method === 'scale' && call.args[0] > 1 && call.args[1] > 1));
    assert.ok(drawCalls.some(call => call.method === 'arc' && call.fillStyle === '#f2bd8d'));
    assert.equal(drawCalls.some(call => call.fillStyle === '#ff863c'), false);
    drawCalls.length = 0;
    game.updatePirateShip(3);
    game.drawPirateShip();
    assert.ok(drawCalls.some(call => call.fillStyle === '#ff863c'));
    assert.ok(drawCalls.some(call => call.fillStyle === '#ffe998'));
    assert.equal(fixture.drawDepth(), 0);
    drawCalls.length = 0;
    game.time += 0.7;
    game.drawPirateShip();
    assert.equal(drawCalls.some(call => call.fillStyle === '#ff863c'), false);
    assert.equal(drawCalls.some(call => String(call.fillStyle).startsWith('rgba(192, 187, 211,')), false);
    assert.ok(drawCalls.some(call => call.method === 'arc' && call.fillStyle === '#f2bd8d'));
    assert.equal(fixture.drawDepth(), 0);
});

test('reboarding blocks movement and boost for two full seconds each time', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    for (let visit = 0; visit < 2; visit++) {
        fixture.key('e'); fixture.key('e', false);
        fixture.key('e'); fixture.key('e', false);
        const x = game.rider.x;
        fixture.key('a'); fixture.key('q');
        assert.equal(game.boosting, false);
        fixture.advance(1.99);
        assert.equal(game.rider.x, x);
        assert.equal(game.boost, 100);
        fixture.advance(0.01);
        assert.equal(game.rider.x, x);
        fixture.advance(0.1);
        assert.ok(game.rider.x < x);
        assert.equal(game.boosting, true);
        fixture.key('a', false); fixture.key('q', false);
        Object.assign(game.rider, { x: 3050, y: 2000, vx: 0, vy: 0 });
        game.boost = 100;
    }
    game.reset();
    assert.equal(game.boardReadyAt, 0);
});

test('exactly 15 percent of the random range permits a land attack', () => {
    const { game } = setup();
    assert.equal(game.rollLandAttack(() => 0.149999), true);
    assert.equal(game.rollLandAttack(() => 0.15), false);
    assert.equal(Array.from({ length: 100 }, (_, i) => game.rollLandAttack(() => i / 100)).filter(Boolean).length, 15);
});

test('eligible jumps can bite a player on land and return to their water launch point', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    game.rollLandAttack = () => true;
    const shark = fixture.shark(3030, 2000);
    fixture.advance(0.9);
    assert.equal(game.health, 75);
    assert.equal(shark.hasBitten, true);
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
    fixture.advance(0.6);
    assert.equal(shark.state, 'recover');
    assert.equal(shark.x, 3030);
    assert.equal(shark.y, 2000);
    assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
});

test('ordinary jumps cannot hurt a player on land or cross the shoreline', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    fixture.key('e');
    game.rollLandAttack = () => false;
    const shark = fixture.shark(3030, 2000);
    for (let i = 0; i < 180; i++) {
        game.step(1 / 120);
        assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
    }
    assert.equal(game.health, 100);
});

test('a land jump completes its return even if the player leaves detection range', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    fixture.key('e');
    game.rollLandAttack = () => true;
    const shark = fixture.shark(3030, 2000);
    fixture.advance(0.65);
    assert.equal(shark.shoreLeap, true);
    game.rider.x = 5000; game.rider.y = 3500;
    game.updateCamera();
    for (let i = 0; i < 90; i++) game.updateSharks(1 / 120);
    assert.equal(game.pointOnLand(shark.x, shark.y, game.sharkClearance), false);
    assert.equal(shark.shoreLeap, false);
});

test('E disembarks onto land, leaves an empty boat, and boards again nearby', () => {
    const fixture = shoreSetup();
    const { game, elements } = fixture;
    assert.equal(elements.pickupPrompt.textContent, 'E · GET ON ISLAND');
    fixture.key('e');
    assert.equal(game.onFoot, true);
    assert.equal(game.canWalkAt(game.rider.x, game.rider.y), true);
    assert.equal(game.parkedBoat.x, 3050);
    assert.equal(game.parkedBoat.y, 2000);
    assert.equal(game.islandCollision, null);
    assert.equal(elements.pickupPrompt.textContent, 'E · BOARD JET SKI');
    game.draw();
    assert.equal(fixture.drawDepth(), 0);
    fixture.key('e', false);
    fixture.key('e');
    assert.equal(game.onFoot, false);
    assert.equal(game.rider.x, 3050);
    assert.equal(game.rider.y, 2000);
    assert.equal(game.parkedBoat, null);
});

test('walking stays on the island, leaves the boat stationary, and creates no wake or boost', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    const boat = JSON.stringify(game.parkedBoat);
    const origin = game.lightOrigin();
    fixture.key('d'); fixture.advance(0.7); fixture.key('d', false);
    assert.ok(game.rider.x > 3170);
    fixture.key('w');
    fixture.advance(3);
    fixture.key('w', false);
    assert.equal(game.canWalkAt(game.rider.x, game.rider.y), true);
    assert.equal(JSON.stringify(game.parkedBoat), boat);
    assert.deepEqual(game.lightOrigin(), origin, 'Headlight remains attached to the parked boat');
    assert.equal(game.wake.length, 0);
    fixture.key('q');
    assert.equal(game.boosting, false);
    assert.equal(Number(fixture.elements.speed.textContent), 0);
    const x = game.rider.x; const y = game.rider.y;
    fixture.advance(0.2);
    assert.equal(game.rider.x, x); assert.equal(game.rider.y, y);
});

test('boarding requires being near the boat; open ocean cannot be disembarked onto', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    fixture.key('e'); fixture.key('e', false);
    game.rider.x = 3260;
    assert.equal(game.canBoardBoat(), false);
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onFoot, true);
    game.rider.x = 3124; game.rider.y = 2000;
    fixture.key('e'); fixture.key('e', false);
    assert.equal(game.onFoot, false);
    game.rider.x = 2500;
    fixture.key('e');
    assert.equal(game.onFoot, false);
    assert.equal(game.parkedBoat, null);
});

test('nearby spear-gun pickup still takes priority over disembarking, and reset clears walking state', () => {
    const fixture = shoreSetup();
    const { game } = fixture;
    game.floatingGuns = [{ id: 'test', name: 'Spear gun', x: 3050, y: 2000, durability: 12 }];
    fixture.key('e');
    assert.equal(game.onFoot, false);
    assert.equal(game.inventory[0].id, 'test');
    fixture.key('e', false); fixture.key('e');
    assert.equal(game.onFoot, true);
    game.reset();
    assert.equal(game.onFoot, false);
    assert.equal(game.parkedBoat, null);
    assert.equal(game.walkIsland, null);
    assert.equal(game.rider.x, 3000);
});
