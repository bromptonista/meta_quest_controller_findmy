import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ImuSeismometer,
  composeTRS,
  computeWayfinder,
  intersectRayQuad,
  invertRigidMat4,
  quaternionAngleDeg
} from '../js/math.js';
import {
  HAPTIC_PATTERNS,
  HapticPatternScheduler,
  detectGamepadTouchOrInput,
  nextPatternId,
  triggerGamepadPulse
} from '../js/haptics.js';
import {
  SLATE_WORLD_H,
  SLATE_WORLD_W,
  hitTestHudButton
} from '../js/hud-slate.js';
import { generateQrMatrix, renderQrSvg } from '../js/qr.js';

test('computeWayfinder identifies ahead, left, right, behind, and distance accurately', () => {
  const viewerMat = composeTRS([0, 1.5, 0], 0, 0, 0);
  const worldToHead = invertRigidMat4(viewerMat);

  // 2m straight ahead (-Z)
  const ahead = computeWayfinder(worldToHead, [0, 1.5, -2.0]);
  assert.ok(Math.abs(ahead.distanceMeters - 2.0) < 1e-4);
  assert.equal(ahead.isOnScreen, true);
  assert.equal(ahead.isBehind, false);
  assert.equal(ahead.directionHint, 'STRAIGHT AHEAD');

  // Off to the right (+X)
  const right = computeWayfinder(worldToHead, [2.0, 1.5, -0.5]);
  assert.equal(right.isOnScreen, false);
  assert.ok(right.ringDir2D[0] > 0.9);
  assert.equal(right.directionHint, 'LOOK RIGHT');

  // Directly behind (+Z)
  const behind = computeWayfinder(worldToHead, [0, 1.5, 1.8]);
  assert.equal(behind.isBehind, true);
  assert.equal(behind.isOnScreen, false);
  assert.equal(behind.directionHint, 'BEHIND YOU');
});

test('ImuSeismometer rejects tiny motor micro-vibration and spikes on cushion-tap tilt', () => {
  const seismo = new ImuSeismometer({ windowMs: 160, bumpThresholdDeg: 1.15 });

  // Stationary / tiny 0.2 deg motor buzz over 300ms -> never triggers bump
  for (let t = 0; t <= 300; t += 16) {
    const tiny = (0.15 * Math.PI) / 180 * (t % 32 === 0 ? 1 : -1);
    const q = { x: Math.sin(tiny / 2), y: 0, z: 0, w: Math.cos(tiny / 2) };
    const res = seismo.update(t, q, true);
    assert.equal(res.bumpedNow, false);
  }

  // Sudden 4.5 deg cushion tap at t = 340ms -> triggers bump!
  const tapRad = (4.5 * Math.PI) / 180;
  const tapQuat = { x: Math.sin(tapRad / 2), y: 0, z: 0, w: Math.cos(tapRad / 2) };
  const hit = seismo.update(340, tapQuat, false);
  assert.equal(hit.bumpedNow, true);
  assert.equal(hit.recentlyBumped, true);
  assert.ok(hit.deltaDeg > 4.0);
  assert.ok(hit.level > 0.4);
});

test('quaternionAngleDeg handles double-cover sign equivalence (q and -q)', () => {
  const q1 = { x: 0, y: 0, z: 0, w: 1 };
  const q2 = { x: -0, y: -0, z: -0, w: -1 };
  assert.ok(quaternionAngleDeg(q1, q2) < 1e-6);
});

test('intersectRayQuad and hitTestHudButton locate 3D Spatial HUD buttons accurately', () => {
  const slateMat = composeTRS([0, 1.25, -1.2], 0, 0, 0);
  // Ray aimed straight at center of slate (u = 0.5, v = 0.5)
  const centerHit = intersectRayQuad([0, 1.25, 0], [0, 0, -1], slateMat, SLATE_WORLD_W, SLATE_WORLD_H);
  assert.ok(centerHit);
  assert.ok(Math.abs(centerHit.u - 0.5) < 1e-4);
  assert.ok(Math.abs(centerHit.v - 0.5) < 1e-4);
  assert.ok(Math.abs(centerHit.distance - 1.2) < 1e-4);

  // Check UV mapping on Ping Right button (centered horizontally around u=0.5, y=536/680 ≈ 0.788)
  const btn = hitTestHudButton(0.5, 536 / 680);
  assert.ok(btn);
  assert.equal(btn.id, 'target-right');
});

test('HapticPatternScheduler fires chirp pulses and respects overdrive thermal breather', () => {
  const sched = new HapticPatternScheduler('chirp');
  const first = sched.step(5);
  assert.ok(first.pulseToFire);
  assert.equal(first.isBuzzingNow, true);

  // Same pulse slot should not double-fire 10ms later
  const duplicate = sched.step(15);
  assert.equal(duplicate.pulseToFire, null);
  assert.equal(duplicate.isBuzzingNow, true);

  // Quiet listening window at t = 600ms
  const quiet = sched.step(600);
  assert.equal(quiet.pulseToFire, null);
  assert.equal(quiet.isBuzzingNow, false);

  // Cycle through all patterns
  let p = 'chirp';
  const seen = new Set([p]);
  for (let i = 0; i < 4; i++) {
    p = nextPatternId(p);
    seen.add(p);
  }
  assert.equal(seen.size, Object.keys(HAPTIC_PATTERNS).length);

  // Overdrive thermal breather at end of 8000ms window
  sched.setPattern('overdrive');
  const cooldown = sched.step(7900);
  assert.equal(cooldown.pulseToFire, null);
  assert.equal(cooldown.isBuzzingNow, false);
});

test('triggerGamepadPulse drives all multi-actuator motors and vibrationActuator fallback', () => {
  let calls = 0;
  const multiGamepad = {
    hapticActuators: [
      { pulse: () => { calls++; return Promise.resolve(); } },
      { pulse: () => { calls++; return Promise.resolve(); } },
      { pulse: () => { calls++; return Promise.resolve(); } }
    ]
  };
  assert.equal(triggerGamepadPulse(multiGamepad, 1.0, 50), 3);
  assert.equal(calls, 3);

  let fallbackCalls = 0;
  const fallbackGamepad = {
    hapticActuators: [],
    vibrationActuator: {
      playEffect: () => { fallbackCalls++; return Promise.resolve(); }
    }
  };
  assert.equal(triggerGamepadPulse(fallbackGamepad, 1.0, 50), 1);
  assert.equal(fallbackCalls, 1);

  const touchRes = detectGamepadTouchOrInput({
    buttons: [{ pressed: false, touched: true, value: 0 }],
    axes: [0, 0]
  });
  assert.equal(touchRes.touched, true);
  assert.equal(touchRes.detail, 'Trigger');
});

test('QR generator builds valid ISO 18004 matrix and SVG for GitHub Pages URL', () => {
  const url = 'https://bromptonista.github.io/meta_quest_controller_findmy/';
  const matrix = generateQrMatrix(url);
  assert.ok(matrix);
  assert.equal(matrix.length, 33); // Version 4 (33x33)
  const svg = renderQrSvg(url, 160);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('<path d="M'));
});
