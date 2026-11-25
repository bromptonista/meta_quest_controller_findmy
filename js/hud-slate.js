/**
 * 2D Canvas -> WebGL Texture Spatial HUD Slate with interactive UV button hitboxes.
 *
 * Why a WebGL 3D Slate instead of relying solely on WebXR `dom-overlay`?
 * Meta Quest Browser on Horizon OS frequently ignores `dom-overlay` in head-mounted
 * `immersive-ar` and rejects/ignores it in `immersive-vr`, leaving HTML overlays invisible
 * inside the headset. Rendering a stereo-accurate 3D Spatial Slate in world space
 * guarantees crisp telemetry + hand-pinch / controller-laser controls on EVERY Quest!
 */

export const SLATE_CANVAS_W = 1024;
export const SLATE_CANVAS_H = 680;
export const SLATE_WORLD_W = 0.64; // meters
export const SLATE_WORLD_H = 0.425; // meters

export const HUD_BUTTONS = [
  { id: 'target-left', label: 'Ping Left', x: 44, y: 502, w: 296, h: 68 },
  { id: 'target-right', label: 'Ping Right', x: 364, y: 502, w: 296, h: 68 },
  { id: 'target-both', label: 'Ping Both', x: 684, y: 502, w: 296, h: 68 },
  { id: 'cycle-pattern', label: 'Pattern', x: 44, y: 586, w: 350, h: 64 },
  { id: 'toggle-sonar', label: '3D Sonar', x: 414, y: 586, w: 330, h: 64 },
  { id: 'exit-xr', label: 'Exit XR', x: 764, y: 586, w: 216, h: 64 }
];

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Given normalized UV coordinates [0..1, 0..1] on the slate, return matching button or null.
 */
export function hitTestHudButton(u, v) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const px = u * SLATE_CANVAS_W;
  const py = v * SLATE_CANVAS_H;
  for (const btn of HUD_BUTTONS) {
    if (px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h) {
      return btn;
    }
  }
  return null;
}

export class SpatialHudCanvas {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SLATE_CANVAS_W;
    this.canvas.height = SLATE_CANVAS_H;
    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * Render current locator state onto the 2D canvas.
   */
  render(state) {
    const ctx = this.ctx;
    const W = SLATE_CANVAS_W;
    const H = SLATE_CANVAS_H;

    ctx.clearRect(0, 0, W, H);

    // Outer frosted dark tactical slate
    roundRectPath(ctx, 8, 8, W - 16, H - 16, 34);
    ctx.fillStyle = 'rgba(10, 15, 24, 0.90)';
    ctx.fill();

    // Dynamic border glow based on state
    let borderColor = 'rgba(71, 85, 105, 0.85)';
    if (state.anyVisualLock) {
      borderColor = '#22c55e';
    } else if (state.targetConnected) {
      borderColor = '#f59e0b';
    }
    ctx.lineWidth = state.anyVisualLock || state.targetConnected ? 5 : 3;
    ctx.strokeStyle = borderColor;
    ctx.stroke();

    // Header bar
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 30px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('QUEST CONTROLLER LOCATOR', 44, 62);

    // Live Buzz indicator pill (top right)
    const pillW = 256;
    const pillH = 44;
    const pillX = W - 44 - pillW;
    const pillY = 30;
    roundRectPath(ctx, pillX, pillY, pillW, pillH, 22);
    if (state.targetConnected && state.isBuzzingNow) {
      ctx.fillStyle = 'rgba(34, 197, 94, 0.25)';
      ctx.fill();
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(pillX + 26, pillY + 22, 9, 0, Math.PI * 2);
    ctx.fillStyle = state.targetConnected && state.isBuzzingNow
      ? '#4ade80'
      : state.targetConnected
        ? '#facc15'
        : '#64748b';
    ctx.fill();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 20px system-ui, -apple-system, sans-serif';
    ctx.fillText(
      state.targetConnected
        ? (state.isBuzzingNow ? 'HAPTIC BLAST ON' : 'LISTENING GAP')
        : 'WAITING WAKEUP',
      pillX + 46,
      pillY + 29
    );

    // Subtitle / Wayfinder headline
    ctx.font = '600 22px system-ui, -apple-system, sans-serif';
    if (state.primaryWayfinder) {
      const wf = state.primaryWayfinder;
      ctx.fillStyle = state.anyVisualLock ? '#4ade80' : '#38bdf8';
      const lockType = state.anyVisualLock ? 'LIVE 6DoF LOCK' : 'LAST SIGHTING PIN';
      ctx.fillText(
        `${lockType}  ·  ${wf.distanceMeters.toFixed(2)} m  ·  ${wf.directionHint}`,
        44,
        102
      );
    } else if (state.targetConnected) {
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(
        'CONNECTED (OUT OF CAMERA VIEW) — Follow physical buzz or tap cushions!',
        44,
        102
      );
    } else {
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(
        'Controller asleep: Walk heavily, tap couch cushions, or sleep/wake headset.',
        44,
        102
      );
    }

    // Two Controller Telemetry Cards
    this.drawHandCard(ctx, 44, 126, 454, 214, 'LEFT CONTROLLER', 'left', state.hands.left, state.targetHand);
    this.drawHandCard(ctx, 526, 126, 454, 214, 'RIGHT CONTROLLER', 'right', state.hands.right, state.targetHand);

    // IMU Cushion-Tap Seismometer Panel ("Hot/Cold" Motion Detector)
    const seisY = 358;
    roundRectPath(ctx, 44, seisY, W - 88, 122, 18);
    ctx.fillStyle = state.bumpAlertActive
      ? 'rgba(234, 179, 8, 0.20)'
      : 'rgba(15, 23, 42, 0.85)';
    ctx.fill();
    ctx.lineWidth = state.bumpAlertActive ? 2.5 : 1.5;
    ctx.strokeStyle = state.bumpAlertActive ? '#facc15' : 'rgba(51, 65, 85, 0.85)';
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 21px system-ui, -apple-system, sans-serif';
    ctx.fillText('IMU CUSHION-TAP SEISMOMETER (HOT / COLD MOTION)', 68, seisY + 36);

    if (state.touchAlertText) {
      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'right';
      ctx.font = '700 21px system-ui, -apple-system, sans-serif';
      ctx.fillText(`TOUCH: ${state.touchAlertText}`, W - 68, seisY + 36);
      ctx.textAlign = 'left';
    } else if (state.bumpAlertActive) {
      ctx.fillStyle = '#fde047';
      ctx.textAlign = 'right';
      ctx.font = '800 22px system-ui, -apple-system, sans-serif';
      ctx.fillText('HOT! BUMP DETECTED!', W - 68, seisY + 36);
      ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'right';
      ctx.font = '500 19px system-ui, -apple-system, sans-serif';
      ctx.fillText(`${state.maxSeismoDeg.toFixed(1)}° tilt`, W - 68, seisY + 36);
      ctx.textAlign = 'left';
    }

    // Progress bar track
    const barX = 68;
    const barY = seisY + 56;
    const barW = W - 136;
    const barH = 24;
    roundRectPath(ctx, barX, barY, barW, barH, 12);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.95)';
    ctx.fill();

    const fillW = Math.max(0, Math.min(1, state.seismoLevel)) * barW;
    if (fillW > 4) {
      roundRectPath(ctx, barX, barY, Math.max(20, fillW), barH, 12);
      const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      grad.addColorStop(0, '#22c55e');
      grad.addColorStop(0.5, '#eab308');
      grad.addColorStop(1, '#ef4444');
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 18px system-ui, -apple-system, sans-serif';
    ctx.fillText(
      'Works even buried out of camera sight: pat cushions/blankets and watch for a spike.',
      68,
      seisY + 106
    );

    // Interactive Buttons (Pinch / Controller Trigger / Simulator Click)
    for (const btn of HUD_BUTTONS) {
      const isHovered = state.hoveredButtonId === btn.id;
      let isActive = false;
      let label = btn.label;

      if (btn.id === 'target-left') isActive = state.targetHand === 'left';
      if (btn.id === 'target-right') isActive = state.targetHand === 'right';
      if (btn.id === 'target-both') isActive = state.targetHand === 'both';
      if (btn.id === 'cycle-pattern') {
        label = `Mode: ${state.patternShortLabel}`;
      }
      if (btn.id === 'toggle-sonar') {
        isActive = state.sonarEnabled;
        label = `3D Sonar: ${state.sonarEnabled ? 'ON' : 'OFF'}`;
      }

      const isExit = btn.id === 'exit-xr';

      roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, 16);
      if (isExit) {
        ctx.fillStyle = isHovered ? '#ef4444' : 'rgba(185, 28, 28, 0.85)';
      } else if (isActive) {
        ctx.fillStyle = isHovered ? '#3b82f6' : '#2563eb';
      } else {
        ctx.fillStyle = isHovered ? 'rgba(51, 65, 85, 0.95)' : 'rgba(30, 41, 59, 0.92)';
      }
      ctx.fill();

      ctx.lineWidth = isHovered ? 3.5 : 2;
      ctx.strokeStyle = isHovered
        ? '#f8fafc'
        : isActive
          ? '#60a5fa'
          : isExit
            ? '#f87171'
            : 'rgba(71, 85, 105, 0.85)';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 23px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 8);
      ctx.textAlign = 'left';
    }

    // Draw subtle cursor dot if ray intersects the slate
    if (state.cursorUV) {
      const cx = state.cursorUV[0] * W;
      const cy = state.cursorUV[1] * H;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }

  drawHandCard(ctx, x, y, w, h, title, handKey, info, targetHand) {
    const isTargeted = targetHand === 'both' || targetHand === handKey;
    roundRectPath(ctx, x, y, w, h, 18);
    ctx.fillStyle = isTargeted ? 'rgba(23, 37, 64, 0.78)' : 'rgba(15, 23, 42, 0.75)';
    ctx.fill();

    ctx.lineWidth = isTargeted ? 2.5 : 1.5;
    ctx.strokeStyle = info.visualLock
      ? '#22c55e'
      : info.connected
        ? '#f59e0b'
        : isTargeted
          ? '#3b82f6'
          : 'rgba(51, 65, 85, 0.7)';
    ctx.stroke();

    // Title + TARGET badge
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 22px system-ui, -apple-system, sans-serif';
    ctx.fillText(title, x + 22, y + 38);

    if (isTargeted) {
      roundRectPath(ctx, x + w - 118, y + 15, 96, 30, 15);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.35)';
      ctx.fill();
      ctx.fillStyle = '#93c5fd';
      ctx.font = '700 16px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('TARGET', x + w - 70, y + 36);
      ctx.textAlign = 'left';
    }

    // Status headline
    let statusText = 'NOT DETECTED (ASLEEP)';
    let statusColor = '#f87171';
    let detailLine1 = 'No RF link. Move cushions or reboot HMD.';
    let detailLine2 = '';

    if (info.visualLock) {
      statusText = 'VISUAL 6DoF LOCK!';
      statusColor = '#4ade80';
      detailLine1 = info.wayfinder
        ? `Distance: ${info.wayfinder.distanceMeters.toFixed(2)} m (${info.wayfinder.directionHint})`
        : 'In headset camera view!';
      detailLine2 = `Actuators firing: ${info.actuatorCount || 1}x motor`;
    } else if (info.connected) {
      statusText = 'CONNECTED · BUZZING';
      statusColor = '#fbbf24';
      if (info.lastSeenAgeSec !== null && info.wayfinder) {
        detailLine1 = `Last seen ${info.lastSeenAgeSec}s ago · ${info.wayfinder.distanceMeters.toFixed(2)} m`;
        detailLine2 = `Direction: ${info.wayfinder.directionHint}`;
      } else {
        detailLine1 = '3DoF IMU Link active — cameras occluded';
        detailLine2 = 'Listen for chirp or pat cushions for IMU spike';
      }
    } else if (info.lastSeenAgeSec !== null && info.wayfinder) {
      statusText = 'DISCONNECTED (PINNED)';
      statusColor = '#38bdf8';
      detailLine1 = `Last seen ${info.lastSeenAgeSec}s ago · ${info.wayfinder.distanceMeters.toFixed(2)} m`;
      detailLine2 = `Pinned at: ${info.wayfinder.directionHint}`;
    }

    ctx.fillStyle = statusColor;
    ctx.font = '800 25px system-ui, -apple-system, sans-serif';
    ctx.fillText(statusText, x + 22, y + 84);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 19px system-ui, -apple-system, sans-serif';
    ctx.fillText(detailLine1, x + 22, y + 124);

    if (detailLine2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '500 18px system-ui, -apple-system, sans-serif';
      ctx.fillText(detailLine2, x + 22, y + 156);
    }

    if (info.touchDetail) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = '700 18px system-ui, -apple-system, sans-serif';
      ctx.fillText(`Input active: ${info.touchDetail}`, x + 22, y + 190);
    } else if (info.connected) {
      ctx.fillStyle = '#64748b';
      ctx.font = '500 17px system-ui, -apple-system, sans-serif';
      ctx.fillText(`IMU Δ: ${info.seismoDeg.toFixed(1)}°`, x + 22, y + 190);
    }
  }
}
