✨ What it does

Shows your local webcam feed inside Garry’s Mod.

Runs a tiny Node.js server you host yourself.

Can be embedded in a DHTML panel or rendered onto a 3D2D surface using GLua.

Privacy-first: your camera never touches third-party services unless you expose the server.


⚙️ Requirements

Garry’s Mod (client)

Node.js 18+ (recommended)

A modern webcam

(Optional) HTTPS certificate for camera permissions on some systems

Chromium/CEF usually requires a secure context for getUserMedia. localhost is generally treated as secure; for LAN use HTTPS.


🚀 Quick Start

1. Clone and install

```
git clone https://github.com/Sylvana3018/webcam_in_gmod.git
cd webcam_in_gmod
npm install
```

2. Configure (optional) — create .env

```
# .env
PORT=3000          # change if you like
HOST=127.0.0.1     # 0.0.0.0 to allow LAN
ORIGIN=*           # lock this down to your client if needed
```

3. Run the server

```
# If package.json defines a start script:
npm start

# Otherwise:
node server.js
```

You should see the server listening (e.g. http://127.0.0.1:3000).

🔒 Security & Privacy

Local-first: keep HOST=127.0.0.1 for single-PC use. Use 0.0.0.0 only when you need LAN access.

Restrict origins: set ORIGIN to your exact URL if you add CORS.

HTTPS strongly recommended when accessing from devices other than localhost.

```
Quick self-signed HTTPS (optional)
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=localhost"
```

Then (if your server.js supports it) run with HTTPS env flags, or adapt server.js to use Node’s https.createServer with those certs.

🧪 Troubleshooting

Black/empty video → ensure camera permission is granted. Use HTTPS if not on localhost.

CEF prompt not visible → reload the DHTML, or temporarily open the page in an external browser to approve permissions first.

Nothing loads → verify the Node server is running and the URL/port matches your .env.

LAN clients can’t see it → set HOST=0.0.0.0, open the firewall for the port, and browse to http://PC_IP:PORT from GMod.

Performance → keep panel dimensions reasonable (e.g., 640×360–1280×720).

🗺️ Roadmap ideas

Toggleable audio capture (mic) with mute button

UI overlay: FPS/readout, camera switcher, quality slider

Server auth for exposed instances (simple token/Bearer)

Multi-client rooms with per-player visibility

OBS/NDI passthrough mode for streamers

🤝 Contributing

PRs and issues are welcome. Please avoid renaming existing functions/hooks in GLua examples unless it’s part of a clearly scoped change. Keep code style consistent and add comments for anything non-obvious.

