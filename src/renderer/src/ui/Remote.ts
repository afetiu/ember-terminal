// @ts-expect-error - plain ES shared verbatim with the phone bundle; see the file header
import { AccountLink } from '../../../../resources/relay/protocol.js'
import type { Account, PanelPush, RemoteDevice } from '@shared/types'
import { phoneActs } from '../phone/PhoneHost'

/**
 * This machine's link to the Ember account: the sealed channel the phone reaches the desk
 * over. What the phone does with the tabs is PhoneHost's; this only carries messages and
 * mirrors the active tab's panel.
 */

export interface RemoteHooks {
  /** A button pressed on a panel document shown on a phone, for the tab that document is from. */
  onPanelAct: (tabId: string, text: string, submit: boolean) => void
  /** Anything worth repainting: link state, which devices are here. */
  onChange: () => void
  /** Ember on the phone (docs/specs/phone.md): true when the message was its. */
  onPhone?: (m: Record<string, unknown>, from: string) => boolean
}

export type LinkState = 'off' | 'connecting' | 'online' | 'offline'

export class Remote {
  private link: InstanceType<typeof AccountLink> | null = null

  state: LinkState = 'off'
  joined = false
  account: Account | null = null
  /** Everyone on the account, this machine included. */
  devices: RemoteDevice[] = []

  /** Counters, for the probe. Nothing in the app reads these. */
  readonly stats = { panels: 0, acts: 0, errors: [] as string[] }

  constructor(private readonly hooks: RemoteHooks) {}

  /** Phones currently connected to the account — who a panel should be sent to. */
  get phones(): RemoteDevice[] {
    return this.devices.filter((d) => d.kind === 'phone' && d.online && !d.self)
  }

  /**
   * Join the account, if this machine belongs to one.
   *
   * Started once at boot and then left alone: the socket stays up around the clock so a
   * phone can reach a laptop that has been sitting untouched for hours, and so the relay
   * dyno never idles out from under it.
   */
  async start(account: Account | null): Promise<void> {
    this.stop()
    this.account = account
    if (!account) {
      this.joined = false
      this.state = 'off'
      this.hooks.onChange()
      return
    }

    this.joined = true
    this.link = new AccountLink({
      relay: account.relay,
      key: account.key,
      deviceId: account.deviceId,
      kind: 'desk',
      name: account.deviceName,
      onMessage: (m: Record<string, unknown>, from: string) => this.receive(m, from),
      onRoster: (devices: RemoteDevice[]) => {
        this.devices = devices
        this.hooks.onChange()
      },
      onStatus: (s: LinkState) => {
        this.state = s
        this.hooks.onChange()
      },
    })
    await this.link.start()
  }

  /** One sealed message to one device on the account. */
  sendTo(to: string, msg: Record<string, unknown>): void {
    void this.link?.send(to, msg)
  }

  stop(): void {
    this.link?.stop()
    this.link = null
    this.devices = []
    this.state = 'off'
  }

  private receive(m: Record<string, unknown>, from: string): void {
    if (this.hooks.onPhone?.(m, from)) return
    // Someone tapped a button on a panel shown on the phone. It lands in the same place
    // the desk's own panel acts do — the session the panel belongs to, which the secret the
    // panel was sent with says. Without one it is not an act this desk asked for.
    if (m['t'] === 'act') {
      const tabId = phoneActs.tabFor(m['act'])
      if (!tabId) return
      this.stats.acts++
      try {
        this.hooks.onPanelAct(tabId, String(m['text'] ?? ''), m['submit'] !== false)
      } catch (err) {
        const why = `act: ${(err as Error).message}`
        this.stats.errors.push(why)
        console.warn(`[ember] remote ${why}`)
      }
    }
  }

  /**
   * Show a panel document on the phones.
   *
   * Rendered by main so it is the same document the desk shows, then carried whole rather
   * than as source — the phone has no renderer of its own and should never grow one.
   *
   * Size-capped because the relay refuses anything over half a megabyte, and a panel that
   * silently fails to arrive is worse than one that says why. A diagram or a table is a
   * few kilobytes; only a pasted-in page gets near this.
   */
  async panel(push: PanelPush): Promise<void> {
    if (!this.link || !this.phones.length) return
    let html: string
    try {
      // Rendered with an empty slot for the act secret; this desk fills it in (see PhoneHost).
      // A non-empty `act` is what tells main the document may talk back at all, and a file
      // shown from disk may not (bridge.ts, pushForFile).
      html = phoneActs.fill(await window.ember.panel.render(push.file ? push : { ...push, act: 'phone' }), push.tabId)
    } catch (err) {
      this.stats.errors.push(`panel: ${(err as Error).message}`)
      return
    }
    const body =
      html.length > 400_000
        ? { t: 'panel', title: push.title, tooBig: html.length }
        : { t: 'panel', title: push.title, html, format: push.format, id: push.id }
    this.stats.panels++
    for (const phone of this.phones) await this.link.send(phone.id, body)
  }

  /** Take the panel down on the phones, when the desk's is cleared. */
  async clearPanel(): Promise<void> {
    if (!this.link) return
    for (const phone of this.phones) await this.link.send(phone.id, { t: 'panelClear' })
  }
}
