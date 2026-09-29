# Ember on the phone

A front end onto whichever of your machines is running Ember — not a second Ember. The
orchestrator, the conversation, and the crew of Claude sessions all stay on that machine
with their real context. This app types to it and talks to it.

```
  phone ──── WebRTC audio ─────────────────────────────► OpenAI Realtime
    │                                                          │
    │  tool calls + results (sealed, addressed)                 │ ask_claude,
    ▼                                                          ▼ send_work, …
  relay (Heroku) ──┬── Personal laptop  ── real Claude sessions
   routes by a     ├── Work laptop      ── real Claude sessions
   hash; reads     └── ...              the phone picks one
   nothing
```

The phone holds the call itself, so audio never crosses the relay. Only tool calls and
their results do — small, latency-tolerant JSON. A weak signal degrades dispatching rather
than the conversation, and losing the link in a tunnel does not drop the call.

## Your machines, not a pairing

Every machine holds the same **account key**. The phone joins the account once and from
then on sees a live list — personal laptop, work laptop, whichever are running — and picks
one. Adding a machine later is a one-time step on that machine and changes nothing on the
phone.

In Ember on a machine: `Ctrl+K` -> **Connect your phone** (or **Your devices...** once it
is on an account). The QR is a code to *join*, and the same code works for every device you
own; it does not expire when the next one uses it.

The relay routes by `SHA-256(key)`, so the key never reaches it, and device names are
sealed too. It sees how many devices exist and which are online — a real if small metadata
leak, and the price of it being able to route at all.

Rotating the key means visiting every machine, so treat the QR like a house key: anyone who
photographs it can reach everything on the account.

## Building

Needs **JDK 21** (Capacitor 7 rejects 17) and the Android SDK.

```bash
node sync.mjs                 # copy the shared files out of the desktop app
npx cap sync android
cd android && ./gradlew.bat assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

`sync.mjs` copies `protocol.js`, `rtc.js` and `realtime.html` from the Ember repo. They are
**not** forked. The turn-gating in `rtc.js` is the fix for the orchestrator answering the
same question three times; a second hand-written copy would be a second place for that to
come back. If sync stops running, the phone drifts silently — still connecting, still
talking, slowly disagreeing about the protocol.

### Signing

`keystore/` holds the release keystore and its password, and is gitignored. The signature's
job here is not provenance — this is sideloaded — but letting one install upgrade the
previous one. **Lose the keystore and the next APK will refuse to install over this one**;
the only way out is uninstalling, which takes the account membership with it. A missing keystore falls
back to debug signing so a clean checkout still builds.

## Known limitation: backgrounded calls

The app takes a **screen wake lock** for the length of a call, so the display does not sleep
mid-conversation in a car mount. That is a partial answer, not a complete one.

Android will still eventually throttle a backgrounded WebView. A call survives the screen
dimming; it does not survive the app being swiped away, and with the phone in a pocket for
a long stretch it may be suspended.

The complete answer is a **foreground service with `microphone` type**, plus a notification
channel and the Android 14+ permission. That is native Java which cannot be verified without
a physical device, and an untested service that crashes on call start would be worse than a
documented limit. It is the next thing to add, on a device.

Also not built yet: **push notifications**. When a dispatched session finishes while the app
is closed, the note lands in the thread and is waiting when you open it — nothing buzzes.

## Testing

Run from the Ember repo root:

```bash
node scripts/probe-remote.mjs   # the wire, with a stand-in phone against a real desk
node scripts/probe-phone.mjs    # this bundle, in Chrome, against a real desk
```

`probe-phone` matters because the bundle it loads is the one inside the APK. A syntax error
in `app.js` survives every other test and shows up as a blank screen on the phone, which is
the one place it cannot be debugged.

The call itself is deliberately out of scope for both: WebRTC to OpenAI needs a microphone
and a real conversation, and faking either proves nothing about the thing being faked.
