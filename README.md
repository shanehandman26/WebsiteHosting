# Ocean Rush

A top-down ocean game built with HTML, CSS, and Canvas. `/` offers Singleplayer
and Multiplayer; `/game.html` opens singleplayer. A visible rider pilots a jet ski:

- **W** moves up, **A** moves left, **S** moves down, **D** moves right.
- Combine directions to move diagonally at the same maximum speed.
- Hold **Q** to boost. Combine with WASD to steer; Q alone propels the jet ski
  along its current heading. The top-right bar displays the remaining boost.
- Release the keys to drift to a stop. The jet ski turns toward its movement.
- Touch controls support the same four directions and a hold-to-boost button.
- **Reset rider** returns to the ocean center, refills boost, and clears the wake.

The ocean is 6000 × 4000 world pixels, about 30 times the original screen-sized
area. A following camera shows a 1200 × 660 view, clamps at the world edges,
and keeps the rider visible. World-anchored waves, a fading wake, and decorative
navigation buoys show movement through the map; buoys are not obstacles.
Speed remains displayed in MPH. The car, road, and jump
mechanics have been replaced.

### Boost behavior

The tank holds 100 units. Holding Q drains 25 units/second (four seconds from
full); releasing Q restores 15 units/second (about 6.7 seconds from empty).
Holding Q with an empty tank provides no boost and prevents refilling until
release. Boost raises the target speed from 280 to 560 pixels/second and the
acceleration response from 5 to 12. Boost now reaches 560 pixels/second (about
87 MPH), versus about 43 MPH normally. Pressing Q immediately applies a real
velocity kick to at least 392 pixels/second (about 61 MPH), rather than only
changing the eventual target speed. After release or depletion the speed eases
back to normal. Movement, drain, and recharge use elapsed simulation time,
so rates do not depend on the keyboard repeat speed or display refresh rate.
Only visible ocean details are drawn, rather than the whole expanded map.

### Sharks

The map is divided into a 5-column × 2-row grid: ten territories, each with one
permanently assigned shark. A shark patrols a five-point route in its own area.
Without fresh blood, direct pursuit starts only when it becomes visible.
Losing the rider cancels the attack and sends the shark swimming back to its
own home area, then back onto its patrol. There are still exactly ten sharks:
they can temporarily leave their territories during chases, then return;
they are not teleported or replaced by extra sharks.

After the rider stays nearly stationary for five seconds, the guard assigned
to that territory patrols toward their vicinity. It starts direct pursuit once
it enters the viewport (or senses blood). This keeps a cleared area from being
permanently safe for a waiting rider. Guards elsewhere continue patrolling or
returning home. Patrol and return movement use the same 30-MPH speed.
Sharks chase and leap horizontally at
**30 MPH**, converted using the same 14.4-pixels-per-meter scale as the rider
(193.12128 pixels/second). Normal and boosted jet ski speeds can outrun them.

Within 130 pixels, a shark pauses for a 0.35-second orange-ring warning, then
leaps for 0.65 seconds. Takeoff leads the rider's current velocity by up to
0.32 seconds. During the first 0.38 seconds, the shark can correct its heading
at up to 2.8 radians/second to follow direction changes; it then commits to
the final approach so late dodges and boosting still work. Its speed remains
30 MPH throughout the leap. An airborne shark grows/lifts
above its shadow, opens its jaws, and makes takeoff/landing splashes. Dodge or
boost away: only a nearby bite during the leap deals damage. Each bite removes
25 health, with 1.2 seconds of protection against overlapping attacks. Sharks
recover for 1.6 seconds before chasing again. Four bites end the run; Ride again
or Reset rider restores health, boost, the starting position, and all 10 sharks.
The health display is separate from the top-right MPH/boost display.

A damaging bite creates a soft red blood cloud at the bite's world position.
The cloud spreads and fades over 12 seconds. During that time sharks within
1400 pixels of the wounded rider can detect and pursue them even off screen.
This temporarily overrides the normal screen-only chase rule. A new damaging
bite creates a new cloud and refreshes the scent window; blocked bites during
the protection period do neither. Sharks outside the scent radius stop chasing
unless visible. Once all blood fades, screen-only detection returns. Reset
clears all clouds and scent. The pursuing-shark count has been removed; the
death panel shows “You were caught!” followed only by “Shark Attack” and the
restart button.

### Inventory

Six inventory slots sit on the ocean at the bottom center. Number keys 1–6
select slots. Three guns float on the map; approach within 80 pixels and press
E to pick one up. Move the pointer to aim and primary-click to fire. Each gun
starts with 12 durability, shown by a bar below its slot. Every successful shot
consumes one durability, including misses; cooldown-blocked clicks consume none.
The twelfth shot fires, then the gun breaks and its slot becomes empty.
Exactly one fresh 12-shot replacement appears elsewhere on the map for pickup.

Sharks have three health points, without visible health bars. Each bullet hit removes
one point, so three hits kill a shark. Bullets use swept collision detection,
hit only the nearest intersected shark, and are consumed on impact. Dead sharks
cannot chase or bite. After ten seconds of game time, the same shark respawns
in its assigned territory at full health; the shark population does not grow.
Reset restores all sharks and the original three guns and empties inventory.

Every shark hit, including a killing shot, leaves a fading blood cloud at the
shark's position. This attracts sharks within 1400 pixels of the hit as well
as the existing attraction around the rider, for the cloud's 12-second life.
Dead sharks do not bleed again from further hits. Every shot produces a short,
layered orange/yellow/white muzzle flame that shrinks and fades in 0.14 seconds.
The effect is independent of inventory, so it also appears on the final shot
when the broken gun disappears.

### Fullscreen

The bottom-right fullscreen button expands only the ocean and its overlays,
removing the surrounding navy page. Inventory, health, boost, and the exit
button stay visible. Click Exit or press Escape to return. The canvas view
adapts to the display's aspect ratio so the ocean fills it without letterboxing
or stretching the jet ski. Fullscreen touch controls are available on touch
devices. Where browser fullscreen is unavailable, the button fills the browser
window instead; Escape or the same button exits that mode as well.

While boosting, layered orange/yellow/white flames flicker behind the ski and
rotate with its heading. They stop on release or depletion. The boost bar sits
beside the MPH display in one top-right overlay on desktop and mobile. The CSS
and game script URLs include a version suffix to refresh older browser caches
after publishing. Deploy the updated files, then hard-refresh the page if the
new side-by-side overlay is not visible.

Preview with `firebase emulators:start --only hosting --project shanetuffproject`.
Publish with `firebase deploy --only hosting --project shanetuffproject`.

Microsoft Clarity remains on both pages. Google Analytics sends `game_start`
once on the first movement with `mode: jet_ski`. The game runs independently
of Firestore and does not write the earlier collectible scores.

## Previous collectible game: Firebase score storage

This section describes the earlier game. The current jet ski game does
not load this score-storage module.

The game uses Cloud Firestore in project `shanetuffproject`. Collecting items
saves your personal best score to `players/{uid}`. Anonymous Firebase Auth
remembers the player in this browser; clearing browser data or changing browsers
creates a different player. Each new game starts at zero; the best score persists.
There are six collectibles. If that changes, update the score limit in both
`public/scripts/firebase.js` and `firestore.rules`.

### Finish cloud setup

1. Sign in again: `npx -y firebase-tools@latest login --reauth`.
2. In the Firebase console for `shanetuffproject`, create the default Cloud
   Firestore database in **Standard edition**, if it does not exist. Choose your
   database location there. This code assumes the default Standard database;
   the database edition could not be checked from this environment.
3. Ensure a Web app is registered under Project settings → Your apps.
4. Deploy database rules and enable guest authentication:
   `npx -y firebase-tools@latest deploy --only firestore,auth --project shanetuffproject`.
5. Preview locally:
   `npx -y firebase-tools@latest emulators:start --only hosting --project shanetuffproject`.
   Open the URL printed by the CLI. This preview uses the **live** database and
   Authentication service. A plain static server or `file://` will not supply
   the `/__/firebase/init.json` endpoint used to load the Web app configuration.
6. Publish the updated game when ready:
   `npx -y firebase-tools@latest deploy --only hosting --project shanetuffproject`.

Collect an item and wait for “Score saved to Firebase.” Verify the document in
Firestore → Data → players, then reload and check that Your best is restored.
If the status says Firebase is unavailable, check the browser console for the
error (including whether anonymous sign-in is enabled and rules are deployed).

The prototype rules restrict access to each player's own document, validate
the score range and server timestamp, reject extra fields, and forbid decreases
and deletion. Review and verify these rules before broadly sharing the app.
Scores are client supplied; these rules do not prove that a player earned them.

## Usage tracking with Google Analytics

The game includes Google Analytics for Firebase (GA4), independent of Firestore
and anonymous sign-in. Analytics automatically measures page visits and
engagement. The jet ski game sends `game_start` on the first movement;
the earlier `collect_item`, `level_end`, and `luck_button_click` events are no
longer emitted.

1. Open Firebase console → Project settings → Integrations → Google Analytics
   and enable or link a Google Analytics property for `shanetuffproject`.
2. Under Project settings → Your apps, select the game's Web app and ensure its
   config includes a `measurementId` beginning with `G-`. If linking an existing
   property, ensure this Web app is linked to its web data stream.
3. Deploy the updated Hosting files using the command above. Firebase Hosting
   supplies the Analytics measurement ID through `/__/firebase/init.json`.
4. Open the game with `?analytics_debug=1`, move, collect items, and check
   Analytics → DebugView in the Firebase console (ride rather than collect
   items in the current prototype). Normal visits appear in
   Google Analytics Realtime; standard reports take longer to populate.
5. For reports grouped by collectible score, register `score` as an event-scoped
   custom metric in GA4 Admin → Custom definitions. Raw parameters can be
   inspected in DebugView without registering a metric.

No names, emails, or Firebase Authentication IDs are included in these events.
Analytics uses its own browser identifier, so visitor counts represent browsers,
not verified people. Advertising signals and personalization are disabled.
Missing Analytics configuration or blocked Analytics must not stop gameplay or
score saving. No consent UI is included; configure collection and consent to
match your audience before publishing.

## Microsoft Clarity heatmaps, click maps, and scroll maps

Both `public/index.html` and `public/game.html` include the official Clarity
loader in their `<head>`, using project ID `zcpjnlldtq`. The loader creates an
asynchronous script from `https://www.clarity.ms/tag/zcpjnlldtq`. Clarity
collects page interactions and builds the maps in its dashboard. Click maps
and scroll maps are types of heatmaps; they do not need extra scripts, Google
Analytics events, or Firestore writes. Keep only one loader on each page.

### Publish and test

1. From this project's directory, publish the current HTML:
   `firebase deploy --only hosting --project shanetuffproject`.
2. Visit `https://shanetuffproject.web.app/` and
   `https://shanetuffproject.web.app/game.html`. Click around and scroll down
   and back up. If the page fits on screen, make the browser window shorter
   to test scrolling.
3. In browser developer tools, open Network before reloading, filter for
   `clarity`, and look for the tag script and successful Clarity `/collect`
   requests. Blocked requests can indicate browser tracking protection or
   an extension. Local script checks cannot confirm live data delivery.
4. Open the matching project at `https://clarity.microsoft.com/`, select
   Heatmaps, and choose the tested page URL and a date range including today.
   Select Click to see where visitors clicked, Scroll to see how far visitors
   reached, or Area to compare clicks within a selected page region.
5. Close your game tabs when finished. If the recording is still live, wait
   for the session to end after 30 minutes of inactivity and refresh Clarity.
   Viewing heatmaps within a live recording is not supported.

Clarity heatmaps are aggregated page interactions, not a continuous cursor
movement density map. Session recordings can show cursor movement, but Clarity
cannot render the game's canvas contents. Scroll maps measure page scroll
depth, not the player moving around the canvas.

Official documentation:
- Setup: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup
- Heatmaps: https://learn.microsoft.com/en-us/clarity/heatmaps-overview
- Session timing: https://learn.microsoft.com/en-us/clarity/session-recordings/recordings-overview


## Real-time multiplayer relay

Choose **Multiplayer** on the home screen, then **Host Room** or **Join Room**.
Hosting requests a unique four-letter code from the relay. The code appears in
the bottom-left corner of the ocean, including in fullscreen. Friends choose
**Join Room** and enter that code; letter case does not matter. Unknown or full
rooms show an error instead of creating a new room. Rooms hold up to 16 riders.
After joining, the game URL also contains the code and can be shared directly.
An empty hosted room remains available for 60 seconds to allow reconnecting.
Singleplayer does not open a relay connection.

Shared rooms require the updated public files, `server/relay.cjs`, and
`server/room-world.cjs`.
Restart the relay after updating the server; publishing Firebase Hosting alone
does not update the room service. Older unnamed-room clients remain supported
by the relay, but the new host/join flow uses four-letter codes exclusively.

Each room now owns **one server-controlled world**. The server creates island
polygons once, and every device receives those exact polygons for drawing,
shorelines, walking, and collisions. Sharks, pirate position and attacks, blood,
projectiles, enemy health, kills, and shark respawns are shared. A late joiner
receives the current world, including defeated enemies and collected pickups.
The simulation continues if the host leaves and another player remains.

Sharks target the nearest living rider who is not protected aboard the pirate
ship. Normal detection uses a fixed 900-pixel radius; fresh blood extends it to
1400 pixels. Pirate attacks target the nearest living player within 1200 pixels.
These room-wide distances replace viewport-dependent detection in multiplayer,
so a different screen size cannot change enemy behavior. Singleplayer keeps its
existing rules. Sharks still respawn after ten seconds; sixteen spear hits
disarm the pirate ship, which can then have **one pilot at a time**. Captured
ship movement and cannon fire are shared. Player weapons do not damage players.

Guns and coconuts are shared pickups: the server grants an item to only one
player, removes it for everyone, checks inventory and firing cooldowns, and
resolves damage once. Broken guns create one shared replacement. Coconut
healing affects only the player who eats it. Guns carried when leaving or
respawning return to the pickup pool; carried coconuts are lost.

**Ride again** and **Reset rider** respawn only that player, clear their
inventory, and restore health/boost with three seconds of shark protection.
They do not regenerate islands or reset enemies, other players, or the shared
safe-area clock. The room pauses while empty and expires after 60 seconds.
Reconnecting enters the existing world as a fresh rider; persistent player
identities and server-restart recovery are not implemented. Fish and wake are
cosmetic local effects.

The browser connects directly to `wss://shaneh.api.codehw.net/multiplayer` from
either the server-hosted game or Firebase Hosting. The public endpoint is in
`public/scripts/relay-config.js`. This service accepts only the game's small JSON
messages; it does not forward arbitrary web traffic. Caddy handles HTTPS,
WebSocket upgrades, and CORS; Node serves HTTP on `process.env.PORT`.

Local steering and island collisions run immediately. Player movement sends
at 30 Hz with TCP_NODELAY and compression disabled. The server simulates enemies
and combat at 60 Hz and sends world snapshots at 20 Hz. Browsers interpolate
enemy and projectile positions with a 75 ms buffer; other riders use a 50 ms
buffer and at most 100 ms prediction. Server damage and pickup confirmations
arrive over the network. Snapshots do not overwrite ordinary local steering;
server-issued position revisions handle boarding, respawn, and corrections.
Buffered stale movement is dropped, slow receivers reconnect, dead connections receive heartbeat checks,
and clients retry with backoff. The status shows measured browser-to-relay
**round-trip** time, not one-way latency or player-to-player delay. Physical
distance and network quality still affect latency. World data is held only in server memory.

### Run and maintain the server

The server's teacher-owned `~/README.md` is authoritative. Every SSH/SCP command
must select the assigned student environment:

```sh
ssh -o SetEnv=STUDENT=shaneh theiss@45.79.67.199
cd ~/projects/ocean-rush
npm ci --omit=dev --ignore-scripts
svc start ocean-rush "node server/relay.cjs"
svc status ocean-rush
svc logs ocean-rush
# After uploading updates:
svc restart ocean-rush
```

Use only the assigned `$PORT` (the service reads it from the environment), keep
all project files under `~/projects/ocean-rush`, and manage the service with
`svc`. Do not change shared proxy configuration or other students' services.
The service hosts this game's public files too, so Firebase deployment is not
required to play at the student URL. To update the existing Firebase copy,
use the Hosting deploy command above after testing.

Install dependencies with `npm ci` and run `npm test`. Local tests use temporary
loopback ports on your computer; do not run these tests on the shared server.
For a local game preview, set `PORT` to an available local port and run
`npm start`; multiplayer still uses the public relay unless you edit the public
relay config. Check `/health` for service readiness. Keep `.env*`, dependencies,
and credentials out of Git, and commit/push your source to your own GitHub repo.

Implementation references: [ws server, compression, and heartbeat documentation](https://github.com/websockets/ws)
and [Caddy WebSocket reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
