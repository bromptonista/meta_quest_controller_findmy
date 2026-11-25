/**
 * Main Application Controller for Meta Quest Controller Find My.
 * Coordinates:
 * - Pre-flight UI, Quest WebXR capability detection, QR & ADB helpers
 * - Real WebXR immersive-ar (Passthrough) / immersive-vr session loop
 * - Interactive 3D Desktop & Mobile Passthrough Simulator (sharing 100% of the WebGL/HUD/Math engine!)
 */

import {
  ImuSeismometer,
  composeTRS,
  computeWayfinder,
  getMatrixForward,
  getMatrixPosition,
  intersectRayQuad,
  invertRigidMat4,
  perspectiveMat4
} from './math.js';
import {
  HAPTIC_PATTERNS,
  HapticPatternScheduler,
  detectGamepadTouchOrInput,
  nextPatternId,
  triggerGamepadPulse
} from './haptics.js';
import { LocatorAudio } from './audio.js';
import {
  SLATE_WORLD_H,
  SLATE_WORLD_W,
  SpatialHudCanvas,
  hitTestHudButton
} from './hud-slate.js';
import { SpatialSceneRenderer } from './xr-renderer.js';
import { renderQrSvg } from './qr.js';

const CANONICAL_PAGES_URL = 'https://bromptonista.github.io/meta_quest_controller_findmy/';

class QuestControllerLocatorApp {
  constructor() {
    this.targetHand = 'left'; // 'left' | 'right' | 'both'
    this.patternId = 'chirp';
    this.scheduler = new HapticPatternScheduler(this.patternId);
    this.audio = new LocatorAudio();
    this.hudCanvas = new SpatialHudCanvas();

    // Per-hand tracking, last-known 6DoF room pin, and IMU seismometer state
    this.handMemory = {
      left: this.createHandMemory(),
      right: this.createHandMemory()
    };

    // WebXR runtime state
    this.xrSession = null;
    this.xrRefSpace = null;
    this.xrRenderer = null;
    this.xrMode = null;
    this.lastFrameTimeMs = 0;
    this.domOverlayActive = false;

    // Desktop / Mobile 3D Simulator state
    this.simActive = false;
    this.simRaf = 0;
    this.simRenderer = null;
    this.simYaw = -0.58; // Start turned slightly away so 3D Wayfinder Arrow immediately shines!
    this.simPitch = -0.08;
    this.simStage = 'imu'; // 'sleep' | 'imu' | 'visual' | 'pinned'
    this.simControllerWorldPos = [-0.52, 0.42, -2.05]; // Tucked on left side of sofa
    this.simQuat = { x: 0, y: 0, z: 0, w: 1 };
    this.simBumpImpulse = 0;
    this.simMouseUV = null;
    this.simHoveredBtn = null;
    this.simPointerRay = null;
    this.simSlateMatrix = null;

    this.initDom();
    this.probeEnvironment();
    this.registerServiceWorker();
  }

  createHandMemory() {
    return {
      wasConnected: false,
      wasVisualLock: false,
      lastKnownPos: null,
      lastSeenTimeMs: null,
      seismometer: new ImuSeismometer(),
      actuatorCount: 0
    };
  }

  resetTrackingMemory() {
    this.handMemory.left = this.createHandMemory();
    this.handMemory.right = this.createHandMemory();
  }

  initDom() {
    // Target hand selector pills on launcher
    document.querySelectorAll('[data-select-hand]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setTargetHand(btn.dataset.selectHand);
      });
    });

    // Pattern selector cards on launcher
    document.querySelectorAll('[data-select-pattern]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setPattern(btn.dataset.selectPattern);
      });
    });

    // Primary Launch WebXR button + Quick-launch Left/Right/Both buttons
    const launchBtn = document.getElementById('btnLaunchXR');
    if (launchBtn) {
      launchBtn.addEventListener('click', () => this.startXR(this.targetHand));
    }
    document.querySelectorAll('[data-quick-xr]').forEach((btn) => {
      btn.addEventListener('click', () => this.startXR(btn.dataset.quickXr));
    });

    // DOM Overlay fallback controls (if browser activates screen dom-overlay)
    const domHud = document.getElementById('domOverlayHud');
    if (domHud) {
      domHud.addEventListener('beforexrselect', (e) => e.preventDefault());
    }
    document.querySelectorAll('[data-hud-action]').forEach((btn) => {
      btn.addEventListener('click', () => this.executeHudAction(btn.dataset.hudAction));
    });

    // Simulator controls
    const openSimBtn = document.getElementById('btnOpenSimulator');
    if (openSimBtn) {
      openSimBtn.addEventListener('click', () => this.startSimulator());
    }
    const closeSimBtn = document.getElementById('btnCloseSimulator');
    if (closeSimBtn) {
      closeSimBtn.addEventListener('click', () => this.stopSimulator());
    }

    document.querySelectorAll('[data-sim-stage]').forEach((btn) => {
      btn.addEventListener('click', () => this.setSimulatorStage(btn.dataset.simStage));
    });

    const bumpBtn = document.getElementById('btnSimBump');
    if (bumpBtn) {
      bumpBtn.addEventListener('click', () => this.triggerSimulatorCushionTap());
    }

    // Copy URL & ADB Command buttons
    const copyUrlBtn = document.getElementById('btnCopyUrl');
    if (copyUrlBtn) {
      copyUrlBtn.addEventListener('click', () => this.copyTextWithFeedback(this.getShareableUrl(), copyUrlBtn));
    }
    const copyAdbBtn = document.getElementById('btnCopyAdb');
    if (copyAdbBtn) {
      copyAdbBtn.addEventListener('click', () => {
        const cmd = `adb shell am start -a android.intent.action.VIEW -d "${this.getShareableUrl()}" com.oculus.browser`;
        this.copyTextWithFeedback(cmd, copyAdbBtn);
      });
    }

    // Populate QR code & shareable URL
    const shareUrl = this.getShareableUrl();
    const urlCodeEl = document.getElementById('shareUrlDisplay');
    if (urlCodeEl) urlCodeEl.textContent = shareUrl;
    const adbCodeEl = document.getElementById('adbLaunchDisplay');
    if (adbCodeEl) {
      adbCodeEl.textContent = `adb shell am start -a android.intent.action.VIEW -d "${shareUrl}" com.oculus.browser`;
    }
    const qrBox = document.getElementById('qrContainer');
    if (qrBox) {
      qrBox.innerHTML = renderQrSvg(shareUrl, 148);
    }

    this.syncLauncherSelectionUI();
  }

  getShareableUrl() {
    const loc = window.location.href;
    if (loc.startsWith('https://')) return loc;
    return CANONICAL_PAGES_URL;
  }

  async copyTextWithFeedback(text, btnEl) {
    const orig = btnEl.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btnEl.textContent = 'Copied!';
    } catch (_) {
      btnEl.textContent = 'Select & Copy';
    }
    setTimeout(() => {
      btnEl.textContent = orig;
    }, 1600);
  }

  setTargetHand(hand) {
    if (!['left', 'right', 'both'].includes(hand)) return;
    this.targetHand = hand;
    this.syncLauncherSelectionUI();
  }

  setPattern(patternId) {
    if (!HAPTIC_PATTERNS[patternId]) return;
    this.patternId = patternId;
    this.scheduler.setPattern(patternId);
    this.syncLauncherSelectionUI();
  }

  syncLauncherSelectionUI() {
    document.querySelectorAll('[data-select-hand]').forEach((btn) => {
      const active = btn.dataset.selectHand === this.targetHand;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    document.querySelectorAll('[data-select-pattern]').forEach((btn) => {
      const active = btn.dataset.selectPattern === this.patternId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const launchLabel = document.getElementById('launchTargetLabel');
    if (launchLabel) {
      launchLabel.textContent =
        this.targetHand === 'both'
          ? 'Both Controllers'
          : `${this.targetHand[0].toUpperCase()}${this.targetHand.slice(1)} Controller`;
    }
  }

  async probeEnvironment() {
    const badge = document.getElementById('envStatusBadge');
    const detail = document.getElementById('envStatusDetail');
    if (!badge || !detail) return;

    const ua = navigator.userAgent || '';
    const isQuestUA = /Quest|OculusBrowser|Pacific|Miramar|Hollywood|Eureka|Panther/i.test(ua);

    if (!window.isSecureContext) {
      badge.textContent = 'Insecure Context (HTTP LAN)';
      badge.className = 'env-badge warn';
      detail.textContent =
        'WebXR requires HTTPS or http://localhost. Use the GitHub Pages HTTPS link, run ./serve.py --https, or forward via adb reverse tcp:8000 tcp:8000.';
      return;
    }

    if (!navigator.xr) {
      badge.textContent = 'Desktop / Mobile Browser · 3D Simulator Ready';
      badge.className = 'env-badge info';
      detail.textContent =
        'Open this page inside Meta Quest Browser to ping real controllers, or click "Try Interactive 3D Simulator" below to preview the Passthrough HUD & audio radar.';
      return;
    }

    try {
      const [arOk, vrOk] = await Promise.all([
        navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
        navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
      ]);

      if (arOk) {
        badge.textContent = isQuestUA
          ? 'Meta Quest Detected · Passthrough AR Ready'
          : 'WebXR Passthrough AR Ready';
        badge.className = 'env-badge ok';
        detail.textContent =
          'Hand tracking & one-controller input ready. Tap Launch below to enter Passthrough and fire TruTouch acoustic pulses.';
      } else if (vrOk) {
        badge.textContent = 'WebXR Immersive VR Ready';
        badge.className = 'env-badge ok';
        detail.textContent =
          'Immersive VR supported (Passthrough AR unavailable on this runtime). 3D Spatial HUD, beacons, and haptics are ready.';
      } else {
        badge.textContent = 'Browser Detected · No Headset Attached';
        badge.className = 'env-badge info';
        detail.textContent =
          'Scan the QR code or run the ADB command below to open directly inside your Meta Quest headset, or test in the 3D Simulator.';
      }
    } catch (_) {
      badge.textContent = 'Simulator Ready';
      badge.className = 'env-badge info';
    }
  }

  showError(msg) {
    const el = document.getElementById('launchError');
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  executeHudAction(actionId) {
    this.audio.playUiClick();
    switch (actionId) {
      case 'target-left':
        this.setTargetHand('left');
        break;
      case 'target-right':
        this.setTargetHand('right');
        break;
      case 'target-both':
        this.setTargetHand('both');
        break;
      case 'cycle-pattern':
        this.setPattern(nextPatternId(this.patternId));
        break;
      case 'toggle-sonar':
        this.audio.sonarEnabled = !this.audio.sonarEnabled;
        break;
      case 'exit-xr':
        if (this.xrSession) this.xrSession.end();
        if (this.simActive) this.stopSimulator();
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // REAL WEBXR SESSION (Meta Quest Browser Passthrough / VR)
  // =========================================================================

  async startXR(handOverride = null) {
    this.showError('');
    if (handOverride) this.setTargetHand(handOverride);
    await this.audio.unlock();

    if (!navigator.xr) {
      this.showError(
        'WebXR is not available in this browser. Open this HTTPS URL inside Meta Quest Browser on your headset — or launch the Interactive 3D Simulator below to preview on desktop/mobile!'
      );
      return;
    }

    if (!this.xrRenderer) {
      this.xrRenderer = new SpatialSceneRenderer();
    }
    if (!this.xrRenderer.gl) {
      this.showError('WebGL initialization failed.');
      return;
    }

    try {
      await this.xrRenderer.gl.makeXRCompatible();

      const arSupported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
      const vrSupported = arSupported
        ? true
        : await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);

      if (!arSupported && !vrSupported) {
        this.showError(
          'No active XR headset session available on this device. Open this URL in Meta Quest Browser on your Quest 3 / 3S / Pro / 2, or click "Try Interactive 3D Simulator"!'
        );
        return;
      }

      this.xrMode = arSupported ? 'immersive-ar' : 'immersive-vr';
      const domHud = document.getElementById('domOverlayHud');

      const sessionInit = {
        optionalFeatures: ['local-floor', 'hand-tracking']
      };
      // Only request dom-overlay in immersive-ar so immersive-vr never rejects it
      if (this.xrMode === 'immersive-ar' && domHud) {
        sessionInit.optionalFeatures.push('dom-overlay');
        sessionInit.domOverlay = { root: domHud };
      }

      const session = await navigator.xr.requestSession(this.xrMode, sessionInit);
      this.xrSession = session;
      this.resetTrackingMemory();
      this.xrRenderer.resetSlateAnchor();
      this.lastFrameTimeMs = 0;

      session.addEventListener('end', () => this.onXRSessionEnded());
      session.addEventListener('select', (ev) => this.onXRSelect(ev));

      const glLayer = new XRWebGLLayer(session, this.xrRenderer.gl);
      session.updateRenderState({ baseLayer: glLayer });

      try {
        this.xrRefSpace = await session.requestReferenceSpace('local-floor');
      } catch (_) {
        this.xrRefSpace = await session.requestReferenceSpace('local');
      }

      // Check whether browser actually activated screen DOM overlay (e.g. handheld phone AR)
      this.domOverlayActive = Boolean(session.domOverlayState && session.domOverlayState.type);
      if (domHud) {
        domHud.hidden = !this.domOverlayActive;
      }

      session.requestAnimationFrame((t, f) => this.onXRFrame(t, f));
    } catch (err) {
      this.showError(`Could not start WebXR session: ${err.message || err}`);
    }
  }

  onXRSessionEnded() {
    this.xrSession = null;
    this.xrRefSpace = null;
    const domHud = document.getElementById('domOverlayHud');
    if (domHud) domHud.hidden = true;
  }

  onXRSelect(event) {
    if (!this.xrRefSpace || !this.currentSlateMatrix) return;
    const raySpace = event.inputSource && event.inputSource.targetRaySpace;
    if (!raySpace) return;
    const rayPose = event.frame.getPose(raySpace, this.xrRefSpace);
    if (!rayPose) return;

    const origin = getMatrixPosition(rayPose.transform.matrix);
    const dir = getMatrixForward(rayPose.transform.matrix);
    const hit = intersectRayQuad(origin, dir, this.currentSlateMatrix, SLATE_WORLD_W, SLATE_WORLD_H);
    if (hit) {
      const btn = hitTestHudButton(hit.u, hit.v);
      if (btn) {
        this.executeHudAction(btn.id);
      }
    }
  }

  onXRFrame(timeMs, frame) {
    const session = frame.session;
    session.requestAnimationFrame((t, f) => this.onXRFrame(t, f));

    const dtSec = this.lastFrameTimeMs > 0 ? Math.min(0.1, (timeMs - this.lastFrameTimeMs) / 1000) : 0.016;
    this.lastFrameTimeMs = timeMs;

    const viewerPose = frame.getViewerPose(this.xrRefSpace);
    const viewerMatrix = viewerPose ? viewerPose.transform.matrix : null;
    const worldToHead = viewerPose ? viewerPose.transform.inverse.matrix : null;

    // Step haptic pattern scheduler
    const { pulseToFire, isBuzzingNow } = this.scheduler.step(timeMs);

    const frameHands = {
      left: { connected: false, visualLock: false, pos: null, quat: null, touchDetail: null },
      right: { connected: false, visualLock: false, pos: null, quat: null, touchDetail: null }
    };

    const candidateRays = [];

    for (const source of session.inputSources) {
      // Collect pointing rays from BOTH hand-tracking and controllers for 3D HUD interaction!
      if (source.targetRaySpace) {
        const rayPose = frame.getPose(source.targetRaySpace, this.xrRefSpace);
        if (rayPose) {
          candidateRays.push({
            origin: getMatrixPosition(rayPose.transform.matrix),
            dir: getMatrixForward(rayPose.transform.matrix)
          });
        }
      }

      // Skip bare hand-tracking sources when scanning for physical Touch controllers:
      // Bare hands expose `source.hand` (XRHand) or have 0 hapticActuators and profile 'generic-hand-select'.
      if (source.hand || !source.gamepad) continue;
      const h = source.handedness;
      if (h !== 'left' && h !== 'right') continue;

      frameHands[h].connected = true;

      const touchInfo = detectGamepadTouchOrInput(source.gamepad);
      if (touchInfo.touched) {
        frameHands[h].touchDetail = touchInfo.detail;
      }

      const space = source.gripSpace || source.targetRaySpace;
      if (space) {
        const pose = frame.getPose(space, this.xrRefSpace);
        if (pose) {
          frameHands[h].quat = pose.transform.orientation;
          if (!pose.emulatedPosition) {
            frameHands[h].visualLock = true;
            frameHands[h].pos = getMatrixPosition(pose.transform.matrix);
          }
        }
      }

      // Fire ALL haptic actuators on targeted controller(s)
      const isTargeted = this.targetHand === 'both' || this.targetHand === h;
      if (isTargeted && pulseToFire) {
        const count = triggerGamepadPulse(
          source.gamepad,
          pulseToFire.intensity,
          pulseToFire.durationMs
        );
        if (count > 0) this.handMemory[h].actuatorCount = count;
      } else if (source.gamepad.hapticActuators && source.gamepad.hapticActuators.length > 0) {
        this.handMemory[h].actuatorCount = source.gamepad.hapticActuators.length;
      }
    }

    const hudState = this.evaluateAndAudioStep(timeMs, frameHands, worldToHead, isBuzzingNow);

    if (!viewerPose) return;

    // Position 3D Spatial HUD Slate & check laser ray intersections
    const slateMatrix = this.xrRenderer.updateSlateWorldMatrix(viewerMatrix, dtSec);
    this.currentSlateMatrix = slateMatrix;

    const activeRays = [];
    let hoveredBtn = null;
    let cursorUV = null;

    for (const r of candidateRays) {
      const hit = intersectRayQuad(r.origin, r.dir, slateMatrix, SLATE_WORLD_W, SLATE_WORLD_H);
      const startPt = [
        r.origin[0] + r.dir[0] * 0.05,
        r.origin[1] + r.dir[1] * 0.05,
        r.origin[2] + r.dir[2] * 0.05
      ];
      if (hit) {
        activeRays.push({ start: startPt, end: hit.worldPoint, hitHud: true });
        cursorUV = [hit.u, hit.v];
        const btn = hitTestHudButton(hit.u, hit.v);
        if (btn) hoveredBtn = btn.id;
      }
    }

    hudState.hoveredButtonId = hoveredBtn;
    hudState.cursorUV = cursorUV;

    // Render 2D HUD canvas -> upload to WebGL texture
    this.hudCanvas.render(hudState);
    this.xrRenderer.uploadHudCanvas(this.hudCanvas.canvas);

    if (this.domOverlayActive) {
      this.syncDomOverlayHud(hudState);
    }

    const baseLayer = session.renderState.baseLayer;
    const views = viewerPose.views.map((v) => ({
      viewport: baseLayer.getViewport(v),
      projectionMatrix: v.projectionMatrix,
      viewMatrix: v.transform.inverse.matrix
    }));

    this.xrRenderer.renderViews({
      timeMs,
      framebuffer: baseLayer.framebuffer,
      clearOpaque: this.xrMode === 'immersive-vr',
      drawRoomGrid: this.xrMode === 'immersive-vr',
      viewerMatrix,
      slateWorldMatrix: this.domOverlayActive ? null : slateMatrix,
      beacons: hudState.beacons,
      wayfinder: hudState.primaryWayfinder,
      activeRays,
      views
    });
  }

  /**
   * Shared sensor fusion + audio cue evaluator used by BOTH real WebXR and the 3D Simulator!
   */
  evaluateAndAudioStep(timeMs, frameHands, worldToHead, isBuzzingNow) {
    const outHands = {};
    const beacons = [];
    let anyTargetConnected = false;
    let anyVisualLock = false;
    let primaryWayfinder = null;
    let maxSeismoDeg = 0;
    let seismoLevel = 0;
    let bumpAlertActive = false;
    let touchAlertText = null;

    for (const h of ['left', 'right']) {
      const fh = frameHands[h];
      const mem = this.handMemory[h];
      const isTarget = this.targetHand === 'both' || this.targetHand === h;

      // Update Last-Known 6DoF Room Pin whenever cameras see the controller
      if (fh.visualLock && fh.pos) {
        mem.lastKnownPos = [...fh.pos];
        mem.lastSeenTimeMs = timeMs;
      }

      // Trigger one-shot audio chimes on state transitions for targeted controller(s)
      if (isTarget) {
        if (fh.connected && !mem.wasConnected) {
          this.audio.playWakeupFanfare();
        }
        if (fh.visualLock && !mem.wasVisualLock) {
          this.audio.playVisualLockChime();
        }
      }
      mem.wasConnected = fh.connected;
      mem.wasVisualLock = fh.visualLock;

      // Step IMU Cushion-Tap Seismometer
      const seismo = mem.seismometer.update(timeMs, fh.quat, isBuzzingNow && isTarget);
      if (isTarget && fh.connected) {
        anyTargetConnected = true;
        maxSeismoDeg = Math.max(maxSeismoDeg, seismo.deltaDeg);
        seismoLevel = Math.max(seismoLevel, seismo.level);
        if (seismo.recentlyBumped && !fh.visualLock) {
          bumpAlertActive = true;
        }
        if (seismo.bumpedNow && !fh.visualLock) {
          this.audio.playBumpTick(seismo.level);
        }
        if (fh.touchDetail) {
          touchAlertText = `${h.toUpperCase()} ${fh.touchDetail}`;
        }
      }

      let wayfinder = null;
      if (mem.lastKnownPos && worldToHead) {
        wayfinder = computeWayfinder(worldToHead, mem.lastKnownPos);
      }

      if (isTarget && mem.lastKnownPos) {
        beacons.push({
          hand: h,
          position: mem.lastKnownPos,
          isLive: fh.visualLock
        });
        if (fh.visualLock) anyVisualLock = true;
        if (!primaryWayfinder || fh.visualLock) {
          primaryWayfinder = wayfinder;
        }
      }

      const lastSeenAgeSec =
        mem.lastSeenTimeMs !== null ? Math.max(0, Math.round((timeMs - mem.lastSeenTimeMs) / 1000)) : null;

      outHands[h] = {
        connected: fh.connected,
        visualLock: fh.visualLock,
        wayfinder,
        lastSeenAgeSec,
        seismoDeg: seismo.deltaDeg,
        touchDetail: fh.touchDetail,
        actuatorCount: mem.actuatorCount || 1
      };
    }

    // Optional 3D HRTF Spatial Sonar Ping
    if (primaryWayfinder) {
      this.audio.stepSpatialSonar(timeMs, primaryWayfinder.headLocal, primaryWayfinder.distanceMeters);
    }

    const pat = HAPTIC_PATTERNS[this.patternId] || HAPTIC_PATTERNS.chirp;

    return {
      targetHand: this.targetHand,
      patternShortLabel: pat.shortLabel,
      sonarEnabled: this.audio.sonarEnabled,
      targetConnected: anyTargetConnected,
      anyVisualLock,
      isBuzzingNow,
      primaryWayfinder,
      hands: outHands,
      beacons,
      maxSeismoDeg,
      seismoLevel,
      bumpAlertActive,
      touchAlertText,
      hoveredButtonId: null,
      cursorUV: null
    };
  }

  syncDomOverlayHud(state) {
    const statusEl = document.getElementById('domHudHeadline');
    if (statusEl) {
      if (state.primaryWayfinder) {
        statusEl.textContent = `${state.primaryWayfinder.distanceMeters.toFixed(2)}m · ${state.primaryWayfinder.directionHint}`;
      } else if (state.targetConnected) {
        statusEl.textContent = 'Connected & Buzzing — Listen or Tap Cushions';
      } else {
        statusEl.textContent = 'Searching — Walk Heavily or Reboot Headset to Wake';
      }
    }
  }

  // =========================================================================
  // INTERACTIVE 3D DESKTOP & MOBILE PASSTHROUGH SIMULATOR
  // =========================================================================

  async startSimulator() {
    await this.audio.unlock();
    const modal = document.getElementById('simulatorModal');
    const canvas = document.getElementById('simulatorCanvas');
    if (!modal || !canvas) return;

    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    if (!this.simRenderer) {
      this.simRenderer = new SpatialSceneRenderer(canvas);
      this.bindSimulatorInput(canvas);
    }

    this.resetTrackingMemory();
    this.simRenderer.resetSlateAnchor();
    this.simYaw = -0.58;
    this.simPitch = -0.06;
    this.simActive = true;
    this.setSimulatorStage('visual');

    const loop = (t) => {
      if (!this.simActive) return;
      this.onSimulatorFrame(t, canvas);
      this.simRaf = requestAnimationFrame(loop);
    };
    this.simRaf = requestAnimationFrame(loop);
  }

  stopSimulator() {
    this.simActive = false;
    if (this.simRaf) cancelAnimationFrame(this.simRaf);
    const modal = document.getElementById('simulatorModal');
    if (modal) modal.hidden = true;
    document.body.style.overflow = '';
  }

  setSimulatorStage(stage) {
    this.simStage = stage;
    document.querySelectorAll('[data-sim-stage]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.simStage === stage);
    });
  }

  triggerSimulatorCushionTap() {
    if (this.simStage === 'sleep') {
      // Just like real hardware: jostling a sleeping controller wakes its 6-axis IMU!
      this.setSimulatorStage('imu');
    }
    this.simBumpImpulse = 0.085; // ~9.5 deg quaternion kick
  }

  bindSimulatorInput(canvas) {
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;

    const updateMouseRay = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      this.simPointerNDC = [ndcX, ndcY];
    };

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      updateMouseRay(e.clientX, e.clientY);
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      updateMouseRay(e.clientX, e.clientY);
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.hypot(dx, dy) > 3) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.simYaw -= dx * 0.0055;
      this.simPitch = Math.max(-1.05, Math.min(0.95, this.simPitch - dy * 0.0055));
    });

    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      updateMouseRay(e.clientX, e.clientY);
      if (!moved && this.simHoveredBtn) {
        this.executeHudAction(this.simHoveredBtn);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (!this.simActive) return;
      if (e.key === 'Escape') this.stopSimulator();
      if (e.key === 'ArrowLeft' || e.key === 'a') this.simYaw += 0.08;
      if (e.key === 'ArrowRight' || e.key === 'd') this.simYaw -= 0.08;
      if (e.key === 'ArrowUp' || e.key === 'w') this.simPitch = Math.min(0.95, this.simPitch + 0.06);
      if (e.key === 'ArrowDown' || e.key === 's') this.simPitch = Math.max(-1.05, this.simPitch - 0.06);
    });
  }

  onSimulatorFrame(timeMs, canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dispW = Math.max(320, Math.floor(canvas.clientWidth * dpr));
    const dispH = Math.max(240, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== dispW || canvas.height !== dispH) {
      canvas.width = dispW;
      canvas.height = dispH;
    }

    const viewerMatrix = composeTRS([0, 1.52, 0.3], this.simYaw, this.simPitch, 0);
    const viewMatrix = invertRigidMat4(viewerMatrix);
    const aspect = dispW / dispH;
    const fovY = 64 * (Math.PI / 180);
    const projMatrix = perspectiveMat4(fovY, aspect, 0.05, 30.0);

    const { isBuzzingNow } = this.scheduler.step(timeMs);

    // Decay simulated cushion-tap quaternion tilt smoothly
    this.simBumpImpulse *= 0.88;
    const wobble = this.simBumpImpulse * Math.cos(timeMs * 0.032);
    const halfA = wobble * 0.5;
    this.simQuat = {
      x: Math.sin(halfA),
      y: 0,
      z: Math.sin(halfA * 0.6),
      w: Math.cos(halfA)
    };

    const primaryHand = this.targetHand === 'right' ? 'right' : 'left';
    const otherHand = primaryHand === 'left' ? 'right' : 'left';

    const connected = this.simStage !== 'sleep';
    const visualLock = this.simStage === 'visual';

    // If user chooses 'pinned' without having visited 'visual' yet, seed lastKnownPos once
    if (this.simStage === 'pinned' && !this.handMemory[primaryHand].lastKnownPos) {
      this.handMemory[primaryHand].lastKnownPos = [...this.simControllerWorldPos];
      this.handMemory[primaryHand].lastSeenTimeMs = timeMs - 4000;
    }

    const frameHands = {
      [primaryHand]: {
        connected,
        visualLock,
        pos: visualLock ? this.simControllerWorldPos : null,
        quat: connected ? this.simQuat : null,
        touchDetail: null
      },
      [otherHand]: {
        connected: true,
        visualLock: true,
        pos: [0.35, 1.12, -0.45],
        quat: { x: 0, y: 0, z: 0, w: 1 },
        touchDetail: null
      }
    };

    const hudState = this.evaluateAndAudioStep(timeMs, frameHands, viewMatrix, isBuzzingNow);

    const slateMatrix = this.simRenderer.updateSlateWorldMatrix(viewerMatrix, 0.016);
    this.simSlateMatrix = slateMatrix;

    // Unproject mouse pointer NDC into a 3D world ray to test interactive 3D HUD buttons!
    this.simHoveredBtn = null;
    if (this.simPointerNDC) {
      const [nx, ny] = this.simPointerNDC;
      const tanHalf = Math.tan(fovY * 0.5);
      const localDir = [nx * aspect * tanHalf, ny * tanHalf, -1];
      const len = Math.hypot(localDir[0], localDir[1], localDir[2]);
      const ld = [localDir[0] / len, localDir[1] / len, localDir[2] / len];
      const worldDir = [
        viewerMatrix[0] * ld[0] + viewerMatrix[4] * ld[1] + viewerMatrix[8] * ld[2],
        viewerMatrix[1] * ld[0] + viewerMatrix[5] * ld[1] + viewerMatrix[9] * ld[2],
        viewerMatrix[2] * ld[0] + viewerMatrix[6] * ld[1] + viewerMatrix[10] * ld[2]
      ];
      const origin = getMatrixPosition(viewerMatrix);
      const hit = intersectRayQuad(origin, worldDir, slateMatrix, SLATE_WORLD_W, SLATE_WORLD_H);
      if (hit) {
        hudState.cursorUV = [hit.u, hit.v];
        const btn = hitTestHudButton(hit.u, hit.v);
        if (btn) {
          hudState.hoveredButtonId = btn.id;
          this.simHoveredBtn = btn.id;
        }
      }
    }

    canvas.style.cursor = this.simHoveredBtn ? 'pointer' : 'grab';

    this.hudCanvas.render(hudState);
    this.simRenderer.uploadHudCanvas(this.hudCanvas.canvas);

    this.simRenderer.renderViews({
      timeMs,
      framebuffer: null,
      clearOpaque: true,
      drawRoomGrid: true,
      viewerMatrix,
      slateWorldMatrix: slateMatrix,
      beacons: hudState.beacons,
      wayfinder: hudState.primaryWayfinder,
      activeRays: [],
      views: [
        {
          viewport: { x: 0, y: 0, width: dispW, height: dispH },
          projectionMatrix: projMatrix,
          viewMatrix
        }
      ]
    });
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.questLocatorApp = new QuestControllerLocatorApp();
});
