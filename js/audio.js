/**
 * Web Audio Synthesis & 3D HRTF Spatial Sonar Engine.
 *
 * Designed specifically for physical controller recovery:
 * - Plays a distinct rising fanfare ONCE when a sleeping controller wakes up & connects,
 *   then stays QUIET during normal buzzing so headset speakers never drown out the faint
 *   physical vibration coming from inside a couch or closet!
 * - Plays a crisp confirmation chime when cameras achieve a 6DoF Visual Lock.
 * - Optional 3D Spatial Sonar mode uses HRTF PannerNode positioned at the controller's
 *   exact (or last-seen) 3D room coordinates so you can hear its direction & proximity.
 */

export class LocatorAudio {
  constructor() {
    this.ctx = null;
    this.sonarEnabled = false; // Quiet-listen default so user hears physical buzz!
    this.alertsEnabled = true;
    this.lastSonarTime = 0;
  }

  async unlock() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      if (!this.ctx) {
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Celebratory rising 3-note chime when a missing controller wakes from deep sleep.
   */
  playWakeupFanfare() {
    if (!this.ctx || !this.alertsEnabled) return;
    try {
      const now = this.ctx.currentTime;
      const notes = [587.33, 880.0, 1174.66]; // D5 -> A5 -> D6
      notes.forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        const t0 = now + idx * 0.085;
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.001, t0);
        gain.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      });
    } catch (_) {}
  }

  /**
   * Bright harmonic lock tone when Quest tracking cameras spot the controller in 3D space.
   */
  playVisualLockChime() {
    if (!this.ctx || !this.alertsEnabled) return;
    try {
      const now = this.ctx.currentTime;
      const freqs = [1046.5, 1567.98]; // C6 -> G6
      freqs.forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        const t0 = now + idx * 0.07;
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.001, t0);
        gain.gain.linearRampToValueAtTime(0.2, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.27);
      });
    } catch (_) {}
  }

  /**
   * Short tactile "Geiger pop" when IMU Seismometer detects cushion-tap tilt!
   */
  playBumpTick(intensity = 0.6) {
    if (!this.ctx || !this.alertsEnabled) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      const pitch = 660 + Math.min(1, intensity) * 660;
      osc.frequency.setValueAtTime(pitch, now);
      osc.frequency.exponentialRampToValueAtTime(pitch * 1.35, now + 0.06);
      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch (_) {}
  }

  /**
   * Subtle UI click for 3D Spatial HUD pinch/trigger buttons.
   */
  playUiClick() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.035);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    } catch (_) {}
  }

  /**
   * Optional 3D HRTF Spatial Sonar Ping positioned in head-relative coordinates [hx, hy, hz].
   * Fires faster & higher-pitched as distance shrinks (< 0.4m -> rapid precision ping).
   */
  stepSpatialSonar(timeMs, headLocalPos, distanceMeters) {
    if (!this.ctx || !this.sonarEnabled || !headLocalPos) return;

    const clampedDist = Math.max(0.2, Math.min(4.0, distanceMeters || 2.0));
    const intervalMs = 240 + (clampedDist / 4.0) * 900;
    if (timeMs - this.lastSonarTime < intervalMs) return;
    this.lastSonarTime = timeMs;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const panner = this.ctx.createPanner();

      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 0.6;
      panner.maxDistance = 10;
      panner.rolloffFactor = 0.8;

      const [hx, hy, hz] = headLocalPos;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(hx, now);
        panner.positionY.setValueAtTime(hy, now);
        panner.positionZ.setValueAtTime(hz, now);
      } else {
        panner.setPosition(hx, hy, hz);
      }

      const baseFreq = 980 - (clampedDist / 4.0) * 380;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.18, now + 0.07);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.14, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);

      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.12);
    } catch (_) {}
  }
}
