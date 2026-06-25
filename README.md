# swarm

> A large-count particle / lightweight-fluid engine for visual effects — **smoke, snow, falling petals and water/splash, from one tiny pure core.**

Drives *thousands* of particles cheaply and **deterministically** out of flat,
typed-array-friendly `pos`/`vel` buffers. Two regimes share one substrate: cheap
**granular drift** (gravity + drag + curl-ish wind = smoke / snow / petals) and —
at M2 — **SPH-lite** (uniform-grid neighbours → density → pressure → viscosity =
water / splash). It is **pure**: no three.js / canvas / DOM imports, no
dependencies. The host just reads `field.positions` (a flat `[x,y, x,y, …]` view)
and `field.count` and draws them however it likes. Seeded PRNG + sin-based wind
(no `Math.random`) make it **deterministic**, so replays/tests reproduce exactly
and it runs **headless** in Node.

```js
import { Field } from 'swarm';

const field = new Field({ gravity: [0, -2], drag: 0.2, windAmp: 1.5, seed: 42 });

// snow: gentle gravity, high drag, a little wind drift
field.emit(800, { pos: [0, 5], spread: 4, vel: [0, -0.5], velJitter: 0.5, life: 6, lifeJitter: 2 });

// each frame (fixed dt → deterministic):
field.step(1 / 60);

// hand the flat buffer to your renderer:
for (let k = 0; k < field.count; k++) {
  draw(field.positions[k * 2], field.positions[k * 2 + 1]);
}
```

## API

- `new Field({ gravity, drag, windAmp, bounds, seed, capacity })` → a sim domain.
- `field.emit(n, { pos, spread, vel, velJitter, life, lifeJitter })` — seeded, deterministic spawn with per-particle jitter and lifetime.
- `field.step(dt)` — one fixed step: forces (gravity / drag / curl-ish wind) → integrate → age & cull.
- `field.positions` / `field.velocities` — flat `[x0,y0, x1,y1, …]` views of the **live** particles; `field.count` is the live count.
- `mulberry32(seed)` — the seeded PRNG, exported so hosts can share the stream.

See [DESIGN.md](./DESIGN.md) for the architecture, the two regimes, and the M1–M4 plan.

## Use via CDN (no build step)

```html
<script type="importmap">
{ "imports": { "swarm": "https://cdn.jsdelivr.net/gh/opaopa6969/swarm@v0.1.0/index.js" } }
</script>
```

## Test

```sh
node test.mjs     # or: npm test
```

Headless proof: emit raises the count, particles fall under gravity, everything
stays finite under gravity + drag + wind, lifetimes cull correctly, and the field
is **deterministic** (same seed → byte-identical positions, different seed →
different field).

## Status

**M1** — particle buffers + integrate + basic forces (gravity / drag / curl-ish
wind = smoke / snow / petal drift), seeded-deterministic emit + lifetime cull.
Roadmap: **M2** SPH-lite (uniform grid → pressure + viscosity = water/splash) ·
**M3** collision vs plane/box (bounce + settle) · **M4** host wiring (upgrade
[netmahg](https://github.com/opaopa6969/netmahg)'s seasonal ambient particles +
win-burst & splash effects). Sibling engines:
[motion-engine](https://github.com/opaopa6969/motion-engine) ·
[xpbd-body](https://github.com/opaopa6969/xpbd-body).

## License

MIT
