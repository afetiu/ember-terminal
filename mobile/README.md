# Ember on the phone

A front end onto whichever of your computers is running Ember — not a second Ember. The
sessions stay on that computer with their real context. The phone shows the current turn,
the objects the agent made (diagrams, tables, pages, images) and a box to write to the
session. Spec: `docs/specs/phone.md`.

```
  phone ──wss──► relay (Cloudflare Worker, relay/) ◄──wss── Ember on a computer
                 routes by SHA-256(key), reads nothing
```

Every message is sealed with the account key; the relay sees device ids, online state, sizes
and timing, never content or names. The computer's side is
`src/renderer/src/phone/PhoneHost.ts`.

## Your computers, not a pairing

Every computer holds the same **account key**. The phone joins the account once and from
then on sees a live list of whichever are running, and picks one. Adding a computer later is
a one-time step on that computer and changes nothing on the phone.

In Ember: `Ctrl+K` -> **Connect your phone** (or **Connect your phone — your devices** once
it is on an account). The QR is a code to *join*; the same code works for every device you
own. Treat it like a house key: anyone who photographs it can reach everything on the
account, and rotating the key means visiting every computer.

## What is in the APK

The APK and https://ember.deepanswerlabs.com/app/ are the same app. `sync.mjs` copies
`site/app` and `site/vendor` into `www/`; nothing is forked. A change to the phone app is a
change to `site/app`, followed by a rebuild here.

## Building

Needs **JDK 21** (Capacitor 7 rejects 17) and the Android SDK.

```bash
node sync.mjs                 # copy site/app + site/vendor into www/
npx cap sync android
cd android && ./gradlew.bat assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

Bump `versionCode` and `versionName` in `android/app/build.gradle` for every APK handed out,
or Android refuses to install it over the previous one.

### Signing

`keystore/` holds the release keystore and `signing.json` (its password), and is gitignored.
The signature's job here is not provenance — this is sideloaded — but letting one install
upgrade the previous one. **Lose the keystore and the next APK will refuse to install over
the last one**; the only way out is uninstalling, which takes the account membership with
it. A missing keystore falls back to debug signing so a clean checkout still builds — but
that APK will not install over a release-signed one.

## Testing

Run from the Ember repo root:

```bash
node scripts/probe-phone.mjs    # this bundle, in Chrome, against a real desk
```

It matters because the bundle it loads is the one inside the APK. A syntax error in
`app.js` survives every other test and shows up as a blank screen on the phone, which is
the one place it cannot be debugged.
