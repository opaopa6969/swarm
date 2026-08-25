// Type definitions for swarm — a large-count particle / lightweight-fluid engine.
// Mirrors the runtime API in index.js. MIT.
//
// Two regimes share one substrate:
//   - granular/drift (M1, done): gravity + drag + curl-ish wind + optional
//     flutter/vortex. Smoke / snow / petals.
//   - SPH-lite (M2, planned): uniform-grid neighbours → density → pressure →
//     viscosity. Water / splash.

/** Seeded 32-bit PRNG (mulberry32). Same seed → same stream. */
export function mulberry32(seed: number): () => number;

/** 2D screen-plane swirl. */
export interface Vortex2D {
  /** Swirl center in the 2D plane. */
  center: [number, number];
  /** Tangential swirl strength. */
  strength: number;
  /** Optional inward pull (0 = pure swirl). */
  inward?: number;
}

/** 3D XZ-plane tornado around a vertical axis. Uses the optional depth axis. */
export interface Vortex3D {
  /** Marks this as the 3D tornado variant. */
  axis: "y";
  /** Swirl center in the 2D plane (x corresponds to screen x). */
  center: [number, number];
  /** Swirl center along the depth axis (defaults to 0). */
  centerZ?: number;
  /** Tangential swirl strength. */
  strength: number;
  /** Optional inward pull (0 = pure swirl). */
  inward?: number;
  /** Optional vertical velocity component added per step. */
  updraft?: number;
}

export type Vortex = Vortex2D | Vortex3D | null;

/** Reserved for the M3 collision milestone; currently has no effect. */
export type Bounds = [number, number, number, number] | null;

export interface FieldOptions {
  /** m/s^2; small |g| for smoke/snow, large for splash. Default [0, -9.8]. */
  gravity?: [number, number];
  /** Velocity damping per second (air resistance). Default 0.1. */
  drag?: number;
  /** Curl-ish wind strength (0 = still air). Default 0. */
  windAmp?: number;
  /** World-units per wind wavelength. Default 1. */
  windScale?: number;
  /** Per-particle lateral sway amplitude (petals/leaves). Default 0. */
  flutter?: number;
  /** Sway oscillations per second. Default 1.2. */
  flutterFreq?: number;
  /** Optional 2D swirl or 3D tornado. Default null. */
  vortex?: Vortex;
  /** Reserved for M3 collision/cull; currently unused. Default null. */
  bounds?: Bounds;
  /** Deterministic emit + replay seed. Default 1. */
  seed?: number;
  /** Max particles (buffers are pre-sized, never grow mid-step). Default 8192. */
  capacity?: number;
}

export interface EmitOptions {
  /** Spawn origin. Default [0, 0]. */
  pos?: [number, number];
  /** Position scatter radius. Default 0. */
  spread?: number;
  /** Initial velocity. Default [0, 0]. */
  vel?: [number, number];
  /** Velocity jitter magnitude. Default 0. */
  velJitter?: number;
  /** Lifetime in seconds. Default 2. */
  life?: number;
  /** Lifetime jitter magnitude. Default 0. */
  lifeJitter?: number;
  /** Depth-axis spawn origin. Default 0. */
  z?: number;
  /** Depth-axis position scatter. Default 0. */
  zSpread?: number;
  /** Depth-axis initial velocity. Default 0. */
  zVel?: number;
  /** Depth-axis velocity jitter. Default 0. */
  zVelJitter?: number;
}

export class Field {
  constructor(options?: FieldOptions);

  /** Gravity [gx, gy]. */
  gravity: [number, number];
  /** Velocity damping per second. */
  drag: number;
  /** Curl-ish wind strength. */
  windAmp: number;
  /** World-units per wind wavelength. */
  windScale: number;
  /** Per-particle lateral sway amplitude. */
  flutter: number;
  /** Sway oscillations per second. */
  flutterFreq: number;
  /** Optional 2D swirl or 3D tornado. */
  vortex: Vortex;
  /** Reserved for M3 collision/cull; currently unused. */
  bounds: Bounds;
  /** Max particles (buffers are pre-sized, never grow mid-step). */
  capacity: number;
  /** Live particle count. */
  count: number;

  /** Flat [x0,y0, x1,y1, ...] live positions (length = count * 2). */
  readonly positions: Float64Array;
  /** Flat [vx0,vy0, ...] live velocities (length = count * 2). */
  readonly velocities: Float64Array;
  /** Live particle ages in seconds (length = count). */
  readonly ages: Float64Array;
  /** Live particle lifetimes remaining in seconds (length = count). */
  readonly lives: Float64Array;
  /** Live particle depth-axis positions (length = count). */
  readonly depths: Float64Array;

  /**
   * Spawn n particles from pos with seeded jitter. Spawn stops at capacity;
   * the actual number spawned is min(n, capacity - count). Returns this for
   * chaining (note: the return value is the field, not the spawn count — read
   * `field.count` before/after to detect any capacity truncation).
   */
  emit(n: number, options?: EmitOptions): this;

  /** Advance the whole field by dt: forces → integrate → age/cull. Returns this. */
  step(dt: number): this;

  /** Per-particle visual rotation (radians) at index k. */
  angle(k: number): number;

  /** Depth-axis position at index k (>0 toward viewer, <0 behind). */
  z(k: number): number;
}
