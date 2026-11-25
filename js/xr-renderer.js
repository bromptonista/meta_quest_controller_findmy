/**
 * Zero-dependency WebGL 3D Renderer for Meta Quest Passthrough (immersive-ar),
 * immersive-vr fallback, and the Desktop Interactive 3D Simulator.
 *
 * Renders:
 * 1. 3D Floor-to-Ceiling Light Pillar + Expanding Radar Rings + Wireframe Cage at controller pose
 * 2. Head-locked 3D Off-Screen Wayfinder Arrow & Compass Ring pointing toward off-FOV targets
 * 3. Smooth lazy-following 3D Spatial HUD Slate (textured from SpatialHudCanvas)
 * 4. Hand-tracking pinch / controller 3D aiming laser ray
 * 5. Subtle wireframe room reference grid ( ONLY in simulator / VR fallback; 100% transparent in AR! )
 */

import {
  composeTRS,
  getMatrixForward,
  getMatrixPosition,
  multiplyMat4
} from './math.js';
import { SLATE_WORLD_H, SLATE_WORLD_W } from './hud-slate.js';

export class SpatialSceneRenderer {
  constructor(canvas = null) {
    this.canvas = canvas || document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', {
      xrCompatible: true,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false
    });

    this.lineProg = null;
    this.texProg = null;
    this.beaconBuf = null;
    this.beaconVertCount = 0;
    this.ringBuf = null;
    this.ringVertCount = 0;
    this.arrowBuf = null;
    this.arrowVertCount = 0;
    this.gridBuf = null;
    this.gridVertCount = 0;
    this.rayBuf = null;
    this.quadBuf = null;
    this.hudTexture = null;

    // Lazy-follow state for the 3D Spatial HUD Slate in world space
    this.slatePos = null;
    this.slateYaw = 0;

    if (this.gl) {
      this.initResources();
    }
  }

  initResources() {
    const gl = this.gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(s));
      }
      return s;
    };

    const link = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      return p;
    };

    // 1. Colored 3D Line / Geometry Shader
    this.lineProg = link(
      `
      attribute vec3 aPos;
      uniform mat4 uProj;
      uniform mat4 uView;
      uniform mat4 uModel;
      void main() {
        gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
      }
      `,
      `
      precision mediump float;
      uniform vec4 uColor;
      void main() {
        gl_FragColor = uColor;
      }
      `
    );

    // 2. Textured Quad Shader for 3D Spatial HUD Slate
    this.texProg = link(
      `
      attribute vec3 aPos;
      attribute vec2 aUV;
      varying vec2 vUV;
      uniform mat4 uProj;
      uniform mat4 uView;
      uniform mat4 uModel;
      void main() {
        vUV = aUV;
        gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
      }
      `,
      `
      precision mediump float;
      varying vec2 vUV;
      uniform sampler2D uTex;
      void main() {
        gl_FragColor = texture2D(uTex, vUV);
      }
      `
    );

    // Build 3D Controller Beacon Cage + 1.8m Vertical Light Pillar
    const s = 0.085;
    const hTop = 1.65;
    const cage = [
      // Wireframe controller cube
      -s, -s, -s,  s, -s, -s,   s, -s, -s,  s, -s,  s,
       s, -s,  s, -s, -s,  s,  -s, -s,  s, -s, -s, -s,
      -s,  s, -s,  s,  s, -s,   s,  s, -s,  s,  s,  s,
       s,  s,  s, -s,  s,  s,  -s,  s,  s, -s,  s, -s,
      -s, -s, -s, -s,  s, -s,   s, -s, -s,  s,  s, -s,
       s, -s,  s,  s,  s,  s,  -s, -s,  s, -s,  s,  s,
      // Inner diamond crosshairs
      -0.26, 0, 0,  0.26, 0, 0,
       0, 0, -0.26, 0, 0, 0.26,
      // Tall vertical light pillar (4 vertical beams converging slightly)
       0, -0.15, 0,  0, hTop, 0,
      -0.03, 0, -0.03,  0, hTop * 0.85, 0,
       0.03, 0, -0.03,  0, hTop * 0.85, 0,
       0, 0,  0.04,     0, hTop * 0.85, 0,
      // Downward pointer chevron above controller
      -0.11, 0.36, 0,  0, 0.20, 0,
       0.11, 0.36, 0,  0, 0.20, 0,
       0, 0.36, -0.11, 0, 0.20, 0,
       0, 0.36,  0.11, 0, 0.20, 0
    ];
    this.beaconVertCount = cage.length / 3;
    this.beaconBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.beaconBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cage), gl.STATIC_DRAW);

    // Build Unit Circle in XZ plane (for expanding horizontal sonar rings & HUD compass)
    const segs = 40;
    const ringVerts = [];
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      ringVerts.push(Math.cos(a0), 0, Math.sin(a0));
      ringVerts.push(Math.cos(a1), 0, Math.sin(a1));
    }
    this.ringVertCount = ringVerts.length / 3;
    this.ringBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ringVerts), gl.STATIC_DRAW);

    // Build 3D Wayfinder Chevron Arrow in XY plane pointing +X (rotated by ringAngleRad)
    const arrowVerts = [
      // Bold double-chevron pointing toward +X
      0.045,  0.0,   0.0,   -0.020,  0.034, 0.0,
      0.045,  0.0,   0.0,   -0.020, -0.034, 0.0,
     -0.020,  0.034, 0.0,   -0.006,  0.0,   0.0,
     -0.020, -0.034, 0.0,   -0.006,  0.0,   0.0,
      0.022,  0.0,   0.0,   -0.036,  0.026, 0.0,
      0.022,  0.0,   0.0,   -0.036, -0.026, 0.0,
      // Tail stem
     -0.052,  0.0,   0.0,    0.038,  0.0,   0.0
    ];
    this.arrowVertCount = arrowVerts.length / 3;
    this.arrowBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arrowVerts), gl.STATIC_DRAW);

    // Build Subtle Simulator / VR Floor Grid (y = 0, -4m..+4m)
    const gridVerts = [];
    for (let i = -4; i <= 4; i++) {
      gridVerts.push(i, 0, -4, i, 0, 4);
      gridVerts.push(-4, 0, i, 4, 0, i);
    }
    // Simulated couch / coffee table outline in simulator mode so user has spatial landmarks!
    const couch = [
      // Sofa at z = -2.1, x = -1.1..1.1, y = 0..0.48
      -1.1, 0, -2.4,  1.1, 0, -2.4,   1.1, 0, -2.4,  1.1, 0, -1.7,
       1.1, 0, -1.7, -1.1, 0, -1.7,  -1.1, 0, -1.7, -1.1, 0, -2.4,
      -1.1, 0.45, -2.4,  1.1, 0.45, -2.4,  1.1, 0.45, -2.4,  1.1, 0.45, -1.7,
       1.1, 0.45, -1.7, -1.1, 0.45, -1.7, -1.1, 0.45, -1.7, -1.1, 0.45, -2.4,
      -1.1, 0, -2.4, -1.1, 0.45, -2.4,   1.1, 0, -2.4,  1.1, 0.45, -2.4,
       1.1, 0, -1.7,  1.1, 0.45, -1.7,  -1.1, 0, -1.7, -1.1, 0.45, -1.7,
      // Sofa backrest
      -1.1, 0.45, -2.4, -1.1, 0.85, -2.4,  1.1, 0.45, -2.4,  1.1, 0.85, -2.4,
      -1.1, 0.85, -2.4,  1.1, 0.85, -2.4
    ];
    const allGrid = [...gridVerts, ...couch];
    this.gridVertCount = allGrid.length / 3;
    this.gridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(allGrid), gl.STATIC_DRAW);

    // Dynamic 2-vertex ray buffer
    this.rayBuf = gl.createBuffer();

    // Textured HUD Quad Buffer (pos XYZ + UV)
    const hw = SLATE_WORLD_W * 0.5;
    const hh = SLATE_WORLD_H * 0.5;
    const quadData = new Float32Array([
      -hw, -hh, 0,  0, 1,
       hw, -hh, 0,  1, 1,
      -hw,  hh, 0,  0, 0,
       hw, -hh, 0,  1, 1,
       hw,  hh, 0,  1, 0,
      -hw,  hh, 0,  0, 0
    ]);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);

    // HUD Canvas Texture
    this.hudTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.hudTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  resetSlateAnchor() {
    this.slatePos = null;
  }

  /**
   * Smoothly position the 3D Spatial HUD Slate comfortably in front of & slightly below eye level.
   * Holds steady when looking at buttons to pinch/click, and glides along as you walk around rooms!
   */
  updateSlateWorldMatrix(viewerMatrix, dtSec = 0.016) {
    const headPos = getMatrixPosition(viewerMatrix) || [0, 1.5, 0];
    const fwd = getMatrixForward(viewerMatrix);
    const horizLen = Math.hypot(fwd[0], fwd[2]) || 1;
    const hx = fwd[0] / horizLen;
    const hz = fwd[2] / horizLen;
    //Yaw facing back toward the user (+Z of slate points toward user!)
    const targetYaw = Math.atan2(-hx, -hz);

    const desiredPos = [
      headPos[0] + hx * 1.16,
      Math.max(0.55, headPos[1] - 0.25),
      headPos[2] + hz * 1.16
    ];

    if (!this.slatePos) {
      this.slatePos = desiredPos;
      this.slateYaw = targetYaw;
    } else {
      const distDrift = Math.hypot(
        desiredPos[0] - this.slatePos[0],
        desiredPos[1] - this.slatePos[1],
        desiredPos[2] - this.slatePos[2]
      );
      let yawDiff = targetYaw - this.slateYaw;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;

      // Deadzone while aiming at the slate, smooth catch-up when turning or walking!
      if (distDrift > 0.42 || Math.abs(yawDiff) > 0.58) {
        const alpha = Math.min(1, dtSec * 4.2);
        this.slatePos[0] += (desiredPos[0] - this.slatePos[0]) * alpha;
        this.slatePos[1] += (desiredPos[1] - this.slatePos[1]) * alpha;
        this.slatePos[2] += (desiredPos[2] - this.slatePos[2]) * alpha;
        this.slateYaw += yawDiff * alpha;
      }
    }

    // Tilt top edge slightly away (-13 deg around local X) so face looks up at user's eyes
    return composeTRS(this.slatePos, this.slateYaw, -0.22, 0);
  }

  uploadHudCanvas(canvasEl) {
    const gl = this.gl;
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this.hudTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasEl);
  }

  /**
   * Render a complete stereo or mono frame across `views`.
   * Each view: { viewport: {x,y,width,height}, projectionMatrix, viewMatrix }
   */
  renderViews({
    timeMs,
    framebuffer = null,
    clearOpaque = false,
    drawRoomGrid = false,
    viewerMatrix,
    slateWorldMatrix,
    beacons = [],
    wayfinder = null,
    activeRays = [],
    views = []
  }) {
    const gl = this.gl;
    if (!gl) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    if (clearOpaque) {
      gl.clearColor(0.035, 0.055, 0.095, 1.0);
    } else {
      gl.clearColor(0, 0, 0, 0); // Keep Passthrough cameras 100% transparent!
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.012);
    const ringPhase = (timeMs % 1300) / 1300;

    for (const view of views) {
      const vp = view.viewport;
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      // --- Pass 1: Line Geometry (Grid, Beacons, Radar Rings, Wayfinder, Laser Rays) ---
      gl.useProgram(this.lineProg);
      const aPos = gl.getAttribLocation(this.lineProg, 'aPos');
      const uProj = gl.getUniformLocation(this.lineProg, 'uProj');
      const uView = gl.getUniformLocation(this.lineProg, 'uView');
      const uModel = gl.getUniformLocation(this.lineProg, 'uModel');
      const uColor = gl.getUniformLocation(this.lineProg, 'uColor');

      gl.enableVertexAttribArray(aPos);
      gl.uniformMatrix4fv(uProj, false, view.projectionMatrix);
      gl.uniformMatrix4fv(uView, false, view.viewMatrix);

      if (drawRoomGrid) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uModel, false, composeTRS([0, 0, 0]));
        gl.uniform4f(uColor, 0.22, 0.32, 0.48, 0.35);
        gl.drawArrays(gl.LINES, 0, this.gridVertCount);
      }

      // Draw 3D Beacons + Expanding Horizontal Sonar Rings at each sighted controller
      for (const b of beacons) {
        const [bx, by, bz] = b.position;
        const beaconModel = composeTRS([bx, by, bz], timeMs * 0.0012, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.beaconBuf);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uModel, false, beaconModel);

        if (b.isLive) {
          gl.uniform4f(uColor, 0.15, 1.0, 0.42, 0.6 + 0.4 * pulse);
        } else {
          gl.uniform4f(uColor, 0.22, 0.78, 1.0, 0.5 + 0.35 * pulse);
        }
        gl.drawArrays(gl.LINES, 0, this.beaconVertCount);

        // Expanding horizontal ripple ring
        const rScale = 0.12 + ringPhase * 0.55;
        const ringAlpha = (1.0 - ringPhase) * (b.isLive ? 0.85 : 0.6);
        const ringModel = composeTRS([bx, by - 0.06, bz], 0, 0, 0, [rScale, 1, rScale]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uModel, false, ringModel);
        if (b.isLive) {
          gl.uniform4f(uColor, 0.25, 1.0, 0.5, ringAlpha);
        } else {
          gl.uniform4f(uColor, 0.22, 0.78, 1.0, ringAlpha);
        }
        gl.drawArrays(gl.LINES, 0, this.ringVertCount);
      }

      // Draw Head-Locked 3D Off-Screen Wayfinder Arrow when target is outside central gaze
      if (wayfinder && !wayfinder.isOnScreen && viewerMatrix) {
        const ringDist = -0.82;
        const ringRadius = 0.145;

        // Subtle head-centered reticle ring (rotate XZ circle by 90 deg pitch so it lies in XY)
        const reticleLocal = composeTRS([0, 0.02, ringDist], 0, Math.PI * 0.5, 0, [ringRadius, 1, ringRadius]);
        const reticleWorld = multiplyMat4(viewerMatrix, reticleLocal);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uModel, false, reticleWorld);
        gl.uniform4f(uColor, 0.38, 0.65, 0.98, 0.28);
        gl.drawArrays(gl.LINES, 0, this.ringVertCount);

        // Orbiting directional chevron arrow pointing straight toward controller!
        const [ux, uy] = wayfinder.ringDir2D;
        const bounce = 0.008 * Math.sin(timeMs * 0.016);
        const arrowLocal = composeTRS(
          [ux * (ringRadius + bounce), 0.02 + uy * (ringRadius + bounce), ringDist],
          0,
          0,
          wayfinder.ringAngleRad
        );
        const arrowWorld = multiplyMat4(viewerMatrix, arrowLocal);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuf);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uModel, false, arrowWorld);
        gl.uniform4f(uColor, 0.18, 1.0, 0.48, 0.95);
        gl.drawArrays(gl.LINES, 0, this.arrowVertCount);
      }

      // Draw 3D Aiming Laser Rays (for hand pinch or working controller aiming at HUD)
      for (const ray of activeRays) {
        const verts = new Float32Array([
          ray.start[0], ray.start[1], ray.start[2],
          ray.end[0], ray.end[1], ray.end[2]
        ]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.rayBuf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uModel, false, composeTRS([0, 0, 0]));
        gl.uniform4f(uColor, 0.22, 0.78, 1.0, ray.hitHud ? 0.9 : 0.35);
        gl.drawArrays(gl.LINES, 0, 2);
      }

      // --- Pass 2: Textured 3D Spatial HUD Slate ---
      if (slateWorldMatrix) {
        gl.useProgram(this.texProg);
        const aTexPos = gl.getAttribLocation(this.texProg, 'aPos');
        const aTexUV = gl.getAttribLocation(this.texProg, 'aUV');
        const uTexProj = gl.getUniformLocation(this.texProg, 'uProj');
        const uTexView = gl.getUniformLocation(this.texProg, 'uView');
        const uTexModel = gl.getUniformLocation(this.texProg, 'uModel');
        const uTexSampler = gl.getUniformLocation(this.texProg, 'uTex');

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        gl.enableVertexAttribArray(aTexPos);
        gl.enableVertexAttribArray(aTexUV);
        gl.vertexAttribPointer(aTexPos, 3, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(aTexUV, 2, gl.FLOAT, false, 20, 12);

        gl.uniformMatrix4fv(uTexProj, false, view.projectionMatrix);
        gl.uniformMatrix4fv(uTexView, false, view.viewMatrix);
        gl.uniformMatrix4fv(uTexModel, false, slateWorldMatrix);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.hudTexture);
        gl.uniform1i(uTexSampler, 0);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disableVertexAttribArray(aTexUV);
      }
    }
  }
}
