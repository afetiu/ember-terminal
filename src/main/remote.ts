import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'

/**
 * This machine's membership of the user's Ember account.
 *
 * An account rather than a pairing, which is the whole point of this file existing in
 * this shape. Pairing tied two devices together, so a second laptop meant a second code
 * and the phone had to be told about it. One account key on every machine means the phone
 * joins once, sees a roster — personal laptop, work laptop, whichever are running — and
 * picks one.
 *
 * Kept out of `config.json` because it is a credential, not a preference: this key is what
 * makes the relay unable to read anything, so it belongs with secrets rather than with
 * font sizes — a config file gets copied between machines and pasted into issues.
 *
 * It does reach the renderer, unlike the OpenAI key, and that is unavoidable: the link
 * runs there because that is where the orchestrator and its tools live. The boundary this
 * key defends is the one across the internet, not the one inside the app.
 */

const ACCOUNT_PATH = join(CONFIG_DIR, 'account.json')

/** Where devices meet. Overridable for anyone running their own. */
const DEFAULT_RELAY = 'https://ember-relay-15d6f9a3939b.herokuapp.com'

export interface Account {
  relay: string
  /** The account secret. Shared by every device the user owns, and never sent to the relay. */
  key: string
  /** Stable per install, so this machine keeps its identity across restarts. */
  deviceId: string
  /** What the phone shows in the list. Defaults to the machine name. */
  deviceName: string
  at: string
}

/**
 * Random ids and keys.
 *
 * `protocol.js` has its own versions for the browser, on WebCrypto. These use node:crypto
 * rather than importing that file into the main bundle — the shared module is written for
 * a browser, and the only thing duplicated is "N random bytes, base64url", which has no
 * shape to drift out of agreement about.
 */
function freshKey(): string {
  return randomBytes(32).toString('base64url')
}

function freshDeviceId(): string {
  return randomBytes(8).toString('base64url')
}

/** A readable default, so a new laptop is recognisable in the list without being named. */
function defaultName(): string {
  const host = hostname().trim()
  return host ? host.replace(/[-_]+/g, ' ') : 'This computer'
}

export function readAccount(): Account | null {
  try {
    if (!existsSync(ACCOUNT_PATH)) return null
    const a = JSON.parse(readFileSync(ACCOUNT_PATH, 'utf8')) as Partial<Account>
    if (!a.key) return null
    // A device id is generated on first read rather than required, so an account file
    // copied from another machine still works — and gets its own identity rather than
    // fighting the machine it was copied from for the same slot on the relay.
    const account: Account = {
      relay: a.relay || DEFAULT_RELAY,
      key: a.key,
      deviceId: a.deviceId || freshDeviceId(),
      deviceName: a.deviceName || defaultName(),
      at: a.at ?? new Date().toISOString(),
    }
    if (!a.deviceId || !a.deviceName) saveAccount(account)
    return account
  } catch (err) {
    console.error(`[ember] could not read ${ACCOUNT_PATH}: ${(err as Error).message}`)
    return null
  }
}

export function saveAccount(a: Account | null): void {
  try {
    writeFileSync(ACCOUNT_PATH, JSON.stringify(a ?? {}, null, 2), 'utf8')
  } catch (err) {
    console.error(`[ember] could not write ${ACCOUNT_PATH}: ${(err as Error).message}`)
  }
}

/** Start an account. This machine becomes its first device. */
export function createAccount(): Account {
  const account: Account = {
    relay: DEFAULT_RELAY,
    key: freshKey(),
    deviceId: freshDeviceId(),
    deviceName: defaultName(),
    at: new Date().toISOString(),
  }
  saveAccount(account)
  return account
}

/**
 * Add this machine to an account that already exists, from its code.
 *
 * A fresh device id every time, deliberately: two machines sharing one would take turns
 * evicting each other from the relay, and the symptom — a laptop that keeps going offline
 * whenever the other is used — gives no hint of the cause.
 */
export function joinAccount(relay: string, key: string): Account {
  const account: Account = {
    relay: relay || DEFAULT_RELAY,
    key,
    deviceId: freshDeviceId(),
    deviceName: defaultName(),
    at: new Date().toISOString(),
  }
  saveAccount(account)
  return account
}

/** Rename this machine, as it appears in the list on the phone. */
export function renameDevice(name: string): Account | null {
  const account = readAccount()
  if (!account) return null
  const next = { ...account, deviceName: name.trim().slice(0, 60) || defaultName() }
  saveAccount(next)
  return next
}

export { DEFAULT_RELAY, ACCOUNT_PATH }
