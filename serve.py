#!/usr/bin/env python3
"""
Local HTTP / HTTPS & ADB server for Meta Quest Controller Find My.

Usage:
  python3 serve.py                  # HTTP on http://localhost:8000 (ideal for desktop or `adb reverse`)
  python3 serve.py --https          # Untethered LAN HTTPS on https://<LAN-IP>:8443 (auto self-signed cert)
  python3 serve.py --adb            # HTTP + auto `adb reverse` + auto-open in Meta Quest Browser
"""

import argparse
import functools
import http.server
import os
import shutil
import socket
import ssl
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
CERT_DIR = ROOT_DIR / ".certs"


class QuestRequestHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def detect_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def ensure_self_signed_cert() -> tuple[Path, Path]:
    CERT_DIR.mkdir(exist_ok=True)
    cert_file = CERT_DIR / "cert.pem"
    key_file = CERT_DIR / "key.pem"
    if cert_file.exists() and key_file.exists():
        return cert_file, key_file

    lan_ip = detect_lan_ip()
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key_file),
            "-out",
            str(cert_file),
            "-days",
            "30",
            "-nodes",
            "-subj",
            f"/CN={lan_ip}",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return cert_file, key_file


def setup_adb(port: int) -> None:
    adb = shutil.which("adb")
    if not adb:
        print("  [!] `adb` not found on PATH; skipping automatic Quest port forwarding.")
        return
    res = subprocess.run([adb, "reverse", f"tcp:{port}", f"tcp:{port}"], capture_output=True, text=True)
    if res.returncode == 0:
        url = f"http://localhost:{port}/"
        print(f"  [+] ADB port reverse active: Quest {url} -> host :{port}")
        subprocess.run(
            [
                adb,
                "shell",
                "am",
                "start",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                url,
                "com.oculus.browser",
            ],
            capture_output=True,
        )
        print("  [+] Sent intent to open Meta Quest Browser on connected headset.")
    else:
        print(f"  [!] ADB reverse skipped ({res.stderr.strip() or 'no Quest connected'}).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Quest Controller Find My locally.")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=None, help="Port (default: 8000 for HTTP, 8443 for HTTPS)")
    parser.add_argument("--https", action="store_true", help="Serve over HTTPS with an ephemeral self-signed cert")
    parser.add_argument("--adb", action="store_true", help="Configure `adb reverse` and launch on connected Quest")
    args = parser.parse_args()

    port = args.port or (8443 if args.https else 8000)
    lan_ip = detect_lan_ip()

    handler = functools.partial(QuestRequestHandler, directory=str(ROOT_DIR))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    httpd = http.server.ThreadingHTTPServer((args.host, port), handler)

    scheme = "https" if args.https else "http"
    if args.https:
        cert_file, key_file = ensure_self_signed_cert()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    print("\n=== Meta Quest Controller Find My — Local Server ===")
    print(f"  Local URL   : {scheme}://localhost:{port}/")
    if args.https:
        print(f"  Quest Wi-Fi : https://{lan_ip}:{port}/  (accept self-signed cert once in Quest Browser)")
    else:
        print(f"  ADB Quest   : adb reverse tcp:{port} tcp:{port}  -> open http://localhost:{port}/")

    if args.adb and not args.https:
        setup_adb(port)

    print("  Press Ctrl+C to stop.\n", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
        httpd.server_close()


if __name__ == "__main__":
    main()
