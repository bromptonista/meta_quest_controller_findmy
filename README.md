# Meta Quest Controller Find My

**Live WebXR App (HTTPS):** **https://bromptonista.github.io/meta_quest_controller_findmy/**

Meta Quest 3, 3S, Pro, and Quest 2 Touch controllers don't have built-in speakers, Ultra-Wideband (UWB), or a native "Find My" button in Horizon OS. Worse, once paired, their proprietary 2.4 GHz radio doesn't advertise open BLE packets for phone sniffers.

**Quest Controller Find My** turns the built-in **Meta Quest Browser** into a zero-install **Passthrough AR Controller Locator**—operable entirely with **bare-hand tracking** (or your remaining controller) and zero APK sideloading.

---

## Key Capabilities & Refinements

- **Resonant TruTouch Acoustic Waveforms (`js/haptics.js`):**
  Touch Plus controllers use a 3.2 W linear voice-coil actuator (TruTouch VCM) rather than an eccentric spinning weight. Instead of a flat continuous buzz that quickly hits firmware thermal throttling and blends into household hum, you can choose between:
  - **Resonant Chirp (Default):** Rapid 4× staccato 100% strikes + a 700 ms listening window—maximizing sharp mechanical clicks against wood, plastic, or sofa frames while avoiding thermal throttling.
  - **SOS Morse (`··· ——— ···`):** Unmistakable cadence that stands out against AC, fans, or fridge noise.
  - **Sonar Heartbeat:** Double-thump pulse with wide quiet windows to turn your head and triangulate by ear.
  - **Max Overdrive:** Continuous 100% output (with an automatic 8-second thermal breather) for hard desks and floors.
- **Multi-Actuator Drive:** Simultaneously fires *every* actuator exposed on `gamepad.hapticActuators` (main body VCM + Touch Pro trigger and thumbstick LRA motors) with automatic `vibrationActuator` fallback.
- **True Stereo 3D Spatial HUD Slate (`js/hud-slate.js`, `js/xr-renderer.js`):**
  Meta Quest Browser frequently ignores 2D HTML `dom-overlay` elements in head-mounted sessions. All telemetry and controls (`Left` / `Right` / `Both`, waveform mode, `3D Sonar`, `Exit`) render on a crisp, lazy-following **3D WebGL Spatial Slate** that you can click using **hand-tracking pinch** or your other controller's laser.
- **Off-Screen 3D Wayfinder Arrow & Last-Sighting Room Pin (`js/math.js`):**
  If Quest's wide-FOV tracking cameras catch even a **single-frame glimpse** of a controller sticking out of laundry or cushions, a **2-meter neon light pillar** and distance readout (`m`) stay pinned to those exact room coordinates—guided by a head-space **3D directional compass chevron** whenever you're looking elsewhere.
- **IMU "Hot / Cold" Cushion-Tap Seismometer:**
  Even when a controller is buried completely out of camera sight (`pose.emulatedPosition === true`), its 3DoF IMU orientation still streams over RF. A 160 ms sliding-window quaternion filter rejects high-frequency motor buzz and flashes **HOT! BUMP DETECTED!** (with a pitch-scaled Geiger pop) the instant you pat the right couch cushion or blanket.
- **Capacitive Touch Alert:** Immediately alerts you if a cushion or searching hand brushes any capacitive sensor (trigger, thumbstick, face buttons, thumbrest) on the missing controller.
- **Smart Quiet-Listen Audio + Optional 3D HRTF Sonar (`js/audio.js`):**
  Plays a rising 3-note wakeup fanfare *once* when a sleeping controller connects—then keeps headset speakers silent between bursts so they never mask the physical buzz. Optional **3D Spatial Sonar** places HRTF audio pings at the controller's pinned 3D room coordinates.
- **Interactive 3D Desktop / Mobile Simulator:**
  Preview the entire 3D Passthrough HUD, wayfinder arrow, light pillar, and IMU cushion-tap seismometer in any desktop or mobile browser without putting on a headset.
- **Offline-Ready PWA (`sw.js`):** Once opened in Meta Quest Browser, a Service Worker caches all static modules so it launches even in a Wi-Fi dead zone.

---

## Quick Start on Meta Quest 3 / 3S / Pro / 2

### Method 1: Instant HTTPS via GitHub Pages (Recommended)
1. Put on your Quest headset (hand tracking works automatically when controllers are down).
2. Open **Meta Quest Browser** and visit:
   `https://bromptonista.github.io/meta_quest_controller_findmy/`
3. Bookmark the page, pinch **Enter Passthrough & Ping**, and sweep each room.

### Beat the Hardware "Deep Sleep" Wall First
After several minutes completely still, Quest controllers enter deep sleep and shut off their radio until nudged:
- **Reboot / Sleep-Wake Cycle:** Tap the Quest headset power button to sleep for ~15 seconds, then wake it back up to trigger a wireless reconnect sweep.
- **Jostle the Room:** Walk heavily across floorboards and tap couch cushions, blankets, or desk piles as you walk through each room to wake the controller's sensitive 6-axis IMU. The instant it wakes, your headset will chime and start hammering the haptic motor.

---

## Serving Locally

WebXR requires a secure context (`https://` or `http://localhost`). Plain `http://192.168.x.x` LAN URLs disable `navigator.xr` in Chromium/Quest Browser. Use the included `serve.py` helper:

### Option A: Local HTTP + ADB Port Forwarding (Zero SSL Warning)
```bash
# Terminal 1: Start local server on port 8000 (auto-sets adb reverse & opens Quest Browser if plugged in)
python3 serve.py --adb
```
Or manually:
```bash
python3 serve.py --port 8000
adb reverse tcp:8000 tcp:8000
# Open http://localhost:8000/ in Meta Quest Browser
```

### Option B: Untethered Local Wi-Fi HTTPS
```bash
python3 serve.py --https
# Serves https://<YOUR-LAN-IP>:8443/ using an auto-generated self-signed certificate
```

---

## Project Structure & Testing

Zero external runtime or npm dependencies—pure ES modules, WebXR, WebGL, and Web Audio:

```text
├── index.html            # Pre-flight mission control + 3D simulator modal
├── quest-pinger.html     # Redirect alias for legacy bookmarks
├── styles.css            # High-contrast Quest & desktop responsive UI
├── serve.py              # Local HTTP / self-signed HTTPS / ADB launcher CLI
├── sw.js                 # Offline PWA Service Worker
├── js/
│   ├── app.js            # WebXR session loop, state fusion & 3D simulator
│   ├── math.js           # 3D wayfinder, ray-quad hit test & IMU seismometer
│   ├── haptics.js        # Multi-actuator TruTouch chirp/SOS/heartbeat scheduler
│   ├── audio.js          # Wakeup chimes & 3D HRTF PannerNode sonar
│   ├── hud-slate.js      # Dynamic 2D canvas -> 3D WebGL Spatial HUD texture
│   ├── xr-renderer.js    # Stereo WebGL beacons, compass chevron & laser rays
│   └── qr.js             # Zero-dependency ISO/IEC 18004 SVG QR encoder
└── tests/
    └── locator.test.js   # Node built-in test suite
```

Run automated tests:
```bash
npm test
```

### Agent / Maintainer Notes
- Completion notifications via `~/.codex/task_complete.py` use the `Zarvox` macOS voice (`say -v Zarvox`).
