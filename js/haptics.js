/**
 * Multi-Actuator Haptic Pattern Scheduler for Meta Quest Touch / Touch Pro / Touch Plus.
 *
 * Why patterns matter on Quest 3 Touch Plus:
 * - Touch Plus uses a linear TruTouch voice-coil actuator (VCM) driven by a 3.2W amp.
 * - Sharp staccato bursts ("Resonant Chirp") create repeated mechanical attack/release
 *   clicks against wood, plastic, or couch frames that carry much farther than a flat hum,
 *   prevent firmware thermal throttling, and leave clean quiet windows so you can listen
 *   with your ears and let the IMU Cushion-Tap Seismometer detect subtle motion!
 */

export const HAPTIC_PATTERNS = {
  chirp: {
    id: 'chirp',
    name: 'Resonant Chirp',
    shortLabel: 'CHIRP',
    description: 'Rapid 4x TruTouch strike bursts + listening gap. Loudest through couch cushions & prevents thermal throttling.',
    periodMs: 1000,
    pulses: [
      { offsetMs: 0, durationMs: 48, intensity: 1.0 },
      { offsetMs: 82, durationMs: 48, intensity: 1.0 },
      { offsetMs: 164, durationMs: 48, intensity: 1.0 },
      { offsetMs: 246, durationMs: 56, intensity: 1.0 }
    ]
  },
  sos: {
    id: 'sos',
    name: 'SOS Morse',
    shortLabel: 'SOS',
    description: 'Unmistakable ··· ——— ··· cadence that stands out clearly against AC, fan, or fridge hum.',
    periodMs: 2600,
    pulses: [
      // S (...)
      { offsetMs: 0, durationMs: 70, intensity: 1.0 },
      { offsetMs: 135, durationMs: 70, intensity: 1.0 },
      { offsetMs: 270, durationMs: 70, intensity: 1.0 },
      // O (---)
      { offsetMs: 500, durationMs: 200, intensity: 1.0 },
      { offsetMs: 780, durationMs: 200, intensity: 1.0 },
      { offsetMs: 1060, durationMs: 200, intensity: 1.0 },
      // S (...)
      { offsetMs: 1420, durationMs: 70, intensity: 1.0 },
      { offsetMs: 1555, durationMs: 70, intensity: 1.0 },
      { offsetMs: 1690, durationMs: 70, intensity: 1.0 }
    ]
  },
  heartbeat: {
    id: 'heartbeat',
    name: 'Sonar Heartbeat',
    shortLabel: 'PULSE',
    description: 'Low-duty double-thump cadence with wide silent gaps for directional ear triangulation.',
    periodMs: 960,
    pulses: [
      { offsetMs: 0, durationMs: 85, intensity: 1.0 },
      { offsetMs: 155, durationMs: 165, intensity: 1.0 }
    ]
  },
  overdrive: {
    id: 'overdrive',
    name: 'Max Overdrive',
    shortLabel: 'MAX',
    description: 'Continuous max-amplitude buzz (with auto thermal breather every 8s) for hard desks & floors.',
    periodMs: 200,
    pulses: [
      { offsetMs: 0, durationMs: 230, intensity: 1.0 }
    ],
    thermalCooldownEveryMs: 8000,
    thermalCooldownDurationMs: 380
  }
};

export const PATTERN_ORDER = ['chirp', 'sos', 'heartbeat', 'overdrive'];

export function nextPatternId(currentId) {
  const idx = PATTERN_ORDER.indexOf(currentId);
  return PATTERN_ORDER[(idx + 1) % PATTERN_ORDER.length];
}

/**
 * Trigger EVERY available haptic actuator on a WebXR Gamepad.
 * - Quest 2 / Quest 3 / 3S: hapticActuators[0] (main body LRA / TruTouch VCM)
 * - Quest Pro / Touch Pro: hapticActuators[0] (body), [1] (trigger), [2] (thumbstick)
 * - Fallback: gamepad.vibrationActuator ('dual-rumble') for Link / desktop runtimes.
 */
export function triggerGamepadPulse(gamepad, intensity = 1.0, durationMs = 60) {
  if (!gamepad) return 0;
  let firedCount = 0;

  try {
    if (Array.isArray(gamepad.hapticActuators) && gamepad.hapticActuators.length > 0) {
      for (const actuator of gamepad.hapticActuators) {
        if (actuator && typeof actuator.pulse === 'function') {
          const res = actuator.pulse(intensity, durationMs);
          if (res && typeof res.catch === 'function') res.catch(() => {});
          firedCount++;
        }
      }
    } else if (gamepad.hapticActuators && gamepad.hapticActuators.length > 0) {
      for (let i = 0; i < gamepad.hapticActuators.length; i++) {
        const actuator = gamepad.hapticActuators[i];
        if (actuator && typeof actuator.pulse === 'function') {
          const res = actuator.pulse(intensity, durationMs);
          if (res && typeof res.catch === 'function') res.catch(() => {});
          firedCount++;
        }
      }
    }

    if (
      firedCount === 0 &&
      gamepad.vibrationActuator &&
      typeof gamepad.vibrationActuator.playEffect === 'function'
    ) {
      const res = gamepad.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: durationMs,
        strongMagnitude: intensity,
        weakMagnitude: intensity
      });
      if (res && typeof res.catch === 'function') res.catch(() => {});
      firedCount++;
    }
  } catch (_) {
    // Ignore transient WebXR gamepad errors
  }

  return firedCount;
}

/**
 * Inspect a WebXR Gamepad for capacitive touch or button/stick deflection
 * (e.g., if a couch cushion or searching hand presses against the hidden controller).
 */
export function detectGamepadTouchOrInput(gamepad) {
  if (!gamepad) return { touched: false, pressed: false, detail: null };

  const buttonNames = ['Trigger', 'Grip', 'Thumbstick', 'X/A Button', 'Y/B Button', 'Thumbrest'];
  if (gamepad.buttons) {
    for (let i = 0; i < gamepad.buttons.length; i++) {
      const b = gamepad.buttons[i];
      if (!b) continue;
      if (b.pressed || b.value > 0.12) {
        return { touched: true, pressed: true, detail: buttonNames[i] || `Button ${i}` };
      }
      if (b.touched) {
        return { touched: true, pressed: false, detail: buttonNames[i] || `Sensor ${i}` };
      }
    }
  }

  if (gamepad.axes) {
    for (let i = 0; i < gamepad.axes.length; i++) {
      if (Math.abs(gamepad.axes[i]) > 0.28) {
        return { touched: true, pressed: true, detail: 'Thumbstick' };
      }
    }
  }

  return { touched: false, pressed: false, detail: null };
}

/**
 * Stateful frame-accurate scheduler that determines when pulses fire for a pattern.
 */
export class HapticPatternScheduler {
  constructor(patternId = 'chirp') {
    this.patternId = HAPTIC_PATTERNS[patternId] ? patternId : 'chirp';
    this.cycleIndex = -1;
    this.firedInCycle = new Set();
    this.activeUntilTime = 0;
  }

  setPattern(patternId) {
    if (HAPTIC_PATTERNS[patternId] && patternId !== this.patternId) {
      this.patternId = patternId;
      this.cycleIndex = -1;
      this.firedInCycle.clear();
      this.activeUntilTime = 0;
    }
  }

  getPattern() {
    return HAPTIC_PATTERNS[this.patternId] || HAPTIC_PATTERNS.chirp;
  }

  /**
   * Evaluate at `timeMs` whether a new pulse should be dispatched on this frame,
   * and whether the actuator is currently vibrating.
   * Returns { pulseToFire: {durationMs, intensity} | null, isBuzzingNow: boolean }.
   */
  step(timeMs) {
    const pat = this.getPattern();

    // Optional periodic breather to prevent VCM thermal throttling in Overdrive mode
    if (pat.thermalCooldownEveryMs) {
      const modThermal = timeMs % pat.thermalCooldownEveryMs;
      if (modThermal > pat.thermalCooldownEveryMs - (pat.thermalCooldownDurationMs || 350)) {
        return { pulseToFire: null, isBuzzingNow: false };
      }
    }

    const cycleIdx = Math.floor(timeMs / pat.periodMs);
    const offsetInCycle = timeMs - cycleIdx * pat.periodMs;

    if (cycleIdx !== this.cycleIndex) {
      this.cycleIndex = cycleIdx;
      this.firedInCycle.clear();
    }

    let pulseToFire = null;
    for (let i = 0; i < pat.pulses.length; i++) {
      const p = pat.pulses[i];
      if (!this.firedInCycle.has(i) && offsetInCycle >= p.offsetMs && offsetInCycle < p.offsetMs + p.durationMs) {
        this.firedInCycle.add(i);
        pulseToFire = p;
        this.activeUntilTime = Math.max(this.activeUntilTime, timeMs + p.durationMs);
        break;
      }
    }

    const isBuzzingNow = timeMs < this.activeUntilTime;
    return { pulseToFire, isBuzzingNow };
  }
}
