# Ember on the phone — Loom, mobile-first

Status: building (2026-10-31). Replaces the voice phone app of Aug 2026.

## What it is

Your Loom tabs, on your phone: the current turn (your words, Claude's words, the live
action line), the objects Claude made (diagrams, pages, tables, views, PDFs, images), the
plan card, subagent pills — laid out for a phone — and a box to write to the session.
Not a second Ember: everything runs on the computer; the phone shows and sends.

## Connecting (what a user does)

1. In Ember: Ctrl+K → **Connect your phone**. A QR code appears.
2. Point the phone camera at it. It opens `https://ember.deepanswerlabs.com/app/#join=<code>`.
3. The page keeps the account key (localStorage) and can be added to the home screen.

No accounts, no Tailscale, nothing to install on the computer.

The QR encodes `https://ember.deepanswerlabs.com/app/#k=<key>&r=<relay>` — the key is in the
fragment, so it never reaches any server, not even the page host. `r` is omitted when it is
the default relay.

## Transport

```
 phone (PWA) ──wss──► relay (Cloudflare Worker + Durable Object) ◄──wss── Ember (desk)
                      routes by SHA-256(key), reads nothing
```

- Wire protocol: `resources/relay/protocol.js` (AccountLink), unchanged. Every payload is
  sealed with AES-GCM under the account key. The relay sees device ids, kinds, online
  state, sizes and timing — never content or names.
- Relay: `relay/` in this repo, a Worker + one Durable Object per account. Same endpoints
  as the old Heroku relay (`GET /link?account&device&kind` → WebSocket; `GET /health`).
  Frames ≤ 512 KB (sealed); larger payloads are chunked by the sender.
- Later (not v1): a WebRTC data channel negotiated over the relay, for speed. The protocol
  below is transport-agnostic so it can move without change.

## Messages (inside the seal)

Every message is a JSON object with `t`. Requests carry `id`; replies echo it.

Phone → desk

| t | fields | does |
|---|---|---|
| `hello` | `v: 1` | desk answers `tabs` |
| `watch` | `tab` | desk answers `snap` for that tab, then streams `ev` for it until another `watch` |
| `send` | `tab, text` | types `text` into the session and presses Enter |
| `key` | `tab, key` | one key into the session: `esc` `enter` `up` `down` `tab` `shift-tab` `1`..`9` `y` `n` |
| `get` | `id, path` | fetch `path` from the desk's local bridge (only `/doc/`, `/media/`) |
| `act` | `tab, text, submit` | an answer from an `ask` object's buttons (typed into the session) |

Desk → phone

| t | fields |
|---|---|
| `tabs` | `tabs: [{ id, title, cwd, working, loom, active }]`, `desk: { name }` — also pushed whenever tabs change |
| `snap` | `tab, events: Ev[]` — everything digested so far for the tab (capped to the last 400) |
| `ev` | `tab, events: Ev[]` — new events, in order |
| `got` | `id, seq, last, status, type, b64` — a `get` answer, chunked (≤ 256 KB of base64 per frame) |
| `err` | `id, error` |

### Ev — the digested transcript

The desk turns raw transcript lines and canvas events into a small stream. The phone never
parses Claude Code's transcript format.

```ts
type Ev =
  | { k: 'you', id, text, at }                       // a message from the user — starts a turn
  | { k: 'say', id, text, at, end: boolean }          // Claude's words (markdown); end = the turn finished
  | { k: 'act', id, label, at }                       // a tool call, as one short line: "Read LoomView.ts"
  | { k: 'obj', id, title, format, path, at }         // an object on the canvas; path = '/doc/<id>' on the bridge
  | { k: 'link', id, title, url, at }                 // open_url
  | { k: 'media', id, title, items: [{ path, kind, name, caption? }], at }
  | { k: 'steps', id, title, steps: [{ text, status }], at }   // the plan; replaces earlier steps
  | { k: 'agent', id, agentId, label, state: 'run' | 'done', at } // a subagent
  | { k: 'note', id, text, at }                       // a one-line system note (compacted, interrupted…)
```

`id` is stable per event (transcript uuid + block index, or the push id), so a phone that
receives an event twice keeps one. An `obj` with a title seen before is an update of that
object, in place.

## The phone app (`site/app/`)

Static, no build step, mobile-first, installable (manifest + icon). Hosted on the Ember
site (Cloudflare Pages) at `/app/`.

- **Join**: reads `#k=` once, stores it, clears the fragment.
- **Desks**: the roster; picks the one online desk automatically.
- **Tabs**: a top switcher (Loom tabs first). Live dot when the tab is working.
- **The stage**: the current turn only — your words, Claude's words (markdown), the live
  action line (latest `act`), the plan card, agent pills, and the turn's objects as
  full-width cards. Swipe or the turn strip for earlier turns. Same rule as the desktop:
  objects belong to the turn they were made in.
- **Objects**: fetched with `get`, shown in `<iframe sandbox="allow-scripts" srcdoc>` with
  `<base href="https://ember.deepanswerlabs.com/">` so `/vendor/*` resolves to copies
  hosted with the app (mermaid, pdf.js…). Sandboxed without same-origin, so a page Claude
  wrote can never read the account key. Height from the doc's `emberDocHeight` message.
  Tap → full screen.
- **Composer**: bottom, thumb-reach. Send = `send`. A row of quick keys appears when the
  session is asking something (Esc, 1, 2, 3, Enter).
- **Look**: Ember Night (amber on warm black), Segoe-like system font for prose, glass cards.

## Security notes

- The key is the whole account. The QR is a house key; the app says so on the join screen.
- `get` is limited to `/doc/` and `/media/` on the desk; nothing else on the bridge is
  reachable from the phone.
- `send`/`key` type into a real session: the phone is as powerful as the keyboard. That is
  the feature, and why the key never leaves the user's devices.
