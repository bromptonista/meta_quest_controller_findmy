/**
 * Pure 3D spatial math, quaternion IMU seismometer, and ray-quad hit testing
 * for Quest Controller Find My (zero external dependencies, Node & browser compatible).
 */

export const DEG_PER_RAD = 180 / Math.PI;
export const RAD_PER_DEG = Math.PI / 180;

/**
 * Extract world-space position [x, y, z] from a column-major 4x4 matrix.
 */
export function getMatrixPosition(m) {
  if (!m || m.length < 15) return null;
  return [m[12], m[13], m[14]];
}

/**
 * Extract world-space forward unit vector (-Z axis) from a column-major 4x4 matrix.
 */
export function getMatrixForward(m) {
  if (!m || m.length < 11) return [0, 0, -1];
  const fx = -m[8];
  const fy = -m[9];
  const fz = -m[10];
  const len = Math.hypot(fx, fy, fz) || 1;
  return [fx / len, fy / len, fz / len];
}

/**
 * Transform a 3D point [x, y, z] by a column-major 4x4 matrix.
 */
export function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

/**
 * Transform a 3D direction vector [x, y, z] (w=0) by a column-major 4x4 matrix.
 */
export function transformDirection(m, d) {
  const [x, y, z] = d;
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z
  ];
}

/**
 * Multiply two column-major 4x4 matrices: out = a * b.
 */
export function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4 + 0];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * Create a column-major translation + XYZ scale matrix, or pose matrix from position + yaw/pitch/roll.
 */
export function composeTRS(pos, yawRad = 0, pitchRad = 0, rollRad = 0, scale = [1, 1, 1]) {
  const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
  const cr = Math.cos(rollRad), sr = Math.sin(rollRad);

  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  const r00 = cy * cr + sy * sp * sr;
  const r10 = cp * sr;
  const r20 = -sy * cr + cy * sp * sr;

  const r01 = -cy * sr + sy * sp * cr;
  const r11 = cp * cr;
  const r21 = sy * sr + cy * sp * cr;

  const r02 = sy * cp;
  const r12 = -sp;
  const r22 = cy * cp;

  const [sx, syS, sz] = scale;
  return new Float32Array([
    r00 * sx, r10 * sx, r20 * sx, 0,
    r01 * syS, r11 * syS, r21 * syS, 0,
    r02 * sz, r12 * sz, r22 * sz, 0,
    pos[0], pos[1], pos[2], 1
  ]);
}

/**
 * Invert a rigid-body (or uniform-unscaled) 4x4 column-major transform matrix.
 */
export function invertRigidMat4(m) {
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r01 = m[4], r11 = m[5], r21 = m[6];
  const r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];

  // Transpose rotation
  const i00 = r00, i10 = r01, i20 = r02;
  const i01 = r10, i11 = r11, i21 = r12;
  const i02 = r20, i12 = r21, i22 = r22;

  const itx = -(i00 * tx + i01 * ty + i02 * tz);
  const ity = -(i10 * tx + i11 * ty + i12 * tz);
  const itz = -(i20 * tx + i21 * ty + i22 * tz);

  return new Float32Array([
    i00, i10, i20, 0,
    i01, i11, i21, 0,
    i02, i12, i22, 0,
    itx, ity, itz, 1
  ]);
}

/**
 * Create a symmetric perspective projection matrix (for desktop 3D simulator).
 */
export function perspectiveMat4(fovYRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}

/**
 * Compute wayfinder guidance from viewer inverse matrix (world -> head) and target world position.
 * In WebXR head space: +X is right, +Y is up, -Z is forward.
 */
export function computeWayfinder(worldToHeadMatrix, targetWorldPos) {
  if (!worldToHeadMatrix || !targetWorldPos) return null;

  const [hx, hy, hz] = transformPoint(worldToHeadMatrix, targetWorldPos);
  const distanceMeters = Math.hypot(hx, hy, hz);
  if (distanceMeters < 1e-4) {
    return {
      headLocal: [hx, hy, hz],
      distanceMeters: 0,
      horizontalMeters: 0,
      verticalMeters: 0,
      offAxisDeg: 0,
      isOnScreen: true,
      isBehind: false,
      ringDir2D: [1, 0],
      ringAngleRad: 0,
      directionHint: 'RIGHT HERE'
    };
  }

  const cosTheta = Math.max(-1, Math.min(1, -hz / distanceMeters));
  const offAxisDeg = Math.acos(cosTheta) * DEG_PER_RAD;
  const isBehind = hz > 0;
  const isOnScreen = !isBehind && offAxisDeg <= 16;

  const len2D = Math.hypot(hx, hy);
  let ux = 1;
  let uy = 0;
  if (len2D > 1e-4) {
    ux = hx / len2D;
    uy = hy / len2D;
  }

  const ringAngleRad = Math.atan2(uy, ux);
  const horizontalMeters = Math.hypot(hx, hz);

  let directionHint = 'AHEAD';
  if (isOnScreen) {
    directionHint = distanceMeters < 0.65 ? 'WITHIN REACH' : 'STRAIGHT AHEAD';
  } else if (isBehind && Math.abs(hx) < 0.35) {
    directionHint = 'BEHIND YOU';
  } else if (Math.abs(hx) >= Math.abs(hy) * 0.85) {
    directionHint = hx > 0
      ? (isBehind ? 'TURN FAR RIGHT' : 'LOOK RIGHT')
      : (isBehind ? 'TURN FAR LEFT' : 'LOOK LEFT');
  } else {
    directionHint = hy > 0 ? 'LOOK UP' : 'LOOK DOWN';
  }

  return {
    headLocal: [hx, hy, hz],
    distanceMeters,
    horizontalMeters,
    verticalMeters: hy,
    offAxisDeg,
    isOnScreen,
    isBehind,
    ringDir2D: [ux, uy],
    ringAngleRad,
    directionHint
  };
}

/**
 * Compute angular difference in degrees between two unit quaternions {x, y, z, w}.
 */
export function quaternionAngleDeg(q1, q2) {
  if (!q1 || !q2) return 0;
  const dot = Math.abs(
    q1.x * q2.x +
    q1.y * q2.y +
    q1.z * q2.z +
    q1.w * q2.w
  );
  const clamped = Math.min(1, Math.max(0, dot));
  return 2 * Math.acos(clamped) * DEG_PER_RAD;
}

/**
 * IMU "Hot/Cold" Cushion-Tap Seismometer.
 * Measures net orientation shift over a ~160ms sliding window so symmetric
 * high-frequency haptic motor buzz (~200Hz) cancels out while physical cushion
 * taps, floor footsteps, or blanket tugs (>1.1 deg tilt) register cleanly.
 */
export class ImuSeismometer {
  constructor({ windowMs = 160, bumpThresholdDeg = 1.15, holdDecayMs = 1400 } = {}) {
    this.windowMs = windowMs;
    this.bumpThresholdDeg = bumpThresholdDeg;
    this.holdDecayMs = holdDecayMs;
    this.samples = [];
    this.lastBumpTime = -Infinity;
    this.peakDeltaDeg = 0;
  }

  reset() {
    this.samples.length = 0;
    this.lastBumpTime = -Infinity;
    this.peakDeltaDeg = 0;
  }

  /**
   * Feed a new quaternion sample at timeMs.
   * @param {number} timeMs
   * @param {{x:number,y:number,z:number,w:number}|null} quat
   * @param {boolean} isPulsingNow - slightly raises threshold while motor is actively firing
   */
  update(timeMs, quat, isPulsingNow = false) {
    if (!quat) {
      return { deltaDeg: 0, level: 0, bumpedNow: false, recentlyBumped: false };
    }

    const qCopy = { x: quat.x, y: quat.y, z: quat.z, w: quat.w };
    this.samples.push({ timeMs, q: qCopy });

    // Prune samples older than 2.5x window
    const minTime = timeMs - this.windowMs * 2.5;
    while (this.samples.length > 2 && this.samples[0].timeMs < minTime) {
      this.samples.shift();
    }

    // Find sample closest to (timeMs - windowMs)
    const targetTime = timeMs - this.windowMs;
    let ref = this.samples[0];
    for (let i = 0; i < this.samples.length - 1; i++) {
      if (this.samples[i].timeMs <= targetTime) {
        ref = this.samples[i];
      } else {
        break;
      }
    }

    const elapsed = timeMs - ref.timeMs;
    if (elapsed < 40) {
      return { deltaDeg: 0, level: 0, bumpedNow: false, recentlyBumped: false };
    }

    const deltaDeg = quaternionAngleDeg(ref.q, qCopy);
    const effectiveThreshold = isPulsingNow
      ? this.bumpThresholdDeg * 1.55
      : this.bumpThresholdDeg;

    let bumpedNow = false;
    if (deltaDeg >= effectiveThreshold) {
      if (timeMs - this.lastBumpTime > 260) {
        bumpedNow = true;
      }
      this.lastBumpTime = timeMs;
      this.peakDeltaDeg = Math.max(this.peakDeltaDeg * 0.85, deltaDeg);
    } else {
      this.peakDeltaDeg *= 0.92;
    }

    const ageSinceBump = timeMs - this.lastBumpTime;
    const recentlyBumped = ageSinceBump >= 0 && ageSinceBump <= this.holdDecayMs;
    const rawLevel = Math.min(1, deltaDeg / 8.0);
    const decayLevel = recentlyBumped
      ? Math.max(0, 1 - ageSinceBump / this.holdDecayMs) * Math.min(1, this.peakDeltaDeg / 6.0)
      : 0;

    return {
      deltaDeg,
      level: Math.max(rawLevel, decayLevel),
      bumpedNow,
      recentlyBumped
    };
  }
}

/**
 * Intersect a world-space ray (origin + unit direction) with a 3D quad centered at
 * `quadWorldMatrix` spanning [-width/2..width/2] in X and [-height/2..height/2] in Y at local Z=0,
 * facing local +Z toward the viewer.
 * Returns { distance, worldPoint, u, v } where u in [0..1] (left->right), v in [0..1] (top->bottom),
 * or null if missed.
 */
export function intersectRayQuad(rayOriginWorld, rayDirWorld, quadWorldMatrix, width, height, maxDist = 4.5) {
  if (!rayOriginWorld || !rayDirWorld || !quadWorldMatrix) return null;
  const invQuad = invertRigidMat4(quadWorldMatrix);
  const localOrigin = transformPoint(invQuad, rayOriginWorld);
  const localDir = transformDirection(invQuad, rayDirWorld);

  // Ray should approach front face (+Z -> 0), so localDir[2] < 0
  if (localDir[2] > -1e-4) return null;

  const t = -localOrigin[2] / localDir[2];
  if (t < 0.04 || t > maxDist) return null;

  const lx = localOrigin[0] + t * localDir[0];
  const ly = localOrigin[1] + t * localDir[1];

  const halfW = width * 0.5;
  const halfH = height * 0.5;
  if (Math.abs(lx) > halfW || Math.abs(ly) > halfH) return null;

  const u = (lx + halfW) / width;
  const v = (halfH - ly) / height;

  const worldPoint = [
    rayOriginWorld[0] + t * rayDirWorld[0],
    rayOriginWorld[1] + t * rayDirWorld[1],
    rayOriginWorld[2] + t * rayDirWorld[2]
  ];

  return { distance: t, worldPoint, u, v };
}
