// @ts-expect-error - plain ES shared verbatim with the phone bundle; see the file header
import { AccountLink } from '../../../../resources/relay/protocol.js'
import type { Account, PanelPush, RemoteDevice } from '@shared/types'

/**
 * The phone, as another front end on the same orchestrator.
 *
 * The panel and the call already share one conversation; this adds whatever devices are on
 * the account to that list rather than adding another agent. Everything arriving here is
 * handled by the code that already handles the panel's composer and the call's tool
 * requests — a message off the wire is a typed message, a tool request off the wire is a
 * tool request. That is the whole design, and it is why this file is small.
 *
 * WHY THE PHONE HOLDS THE CALL. When the user is driving, the microphone that matters is the
 * phone's, so the phone runs its own WebRTC session straight to OpenAI. Audio therefore
 * never crosses the relay — only tool calls and their results do, which are small and
 * latency-tolerant. A weak cell signal degrades dispatching, not the conversation, and if
 * the link drops in a tunnel the call carries on regardless.
 *
 * The desk mints the ephemeral secret and sends it over, so the real OpenAI key never goes
 * near a device that can be left in a taxi.
 */

export interface RemoteHooks {
  /** A message typed on a phone. Resolves with the answer and the tools it used. */
  onText: (text: string) => Promise<{ text: string; did: string[] }>
  /** A tool a phone's voice called. Always resolves — see `runVoiceTool`. */
  onTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** Something said on a phone's call, to fold into the shared conversation. */
  onSpoken: (who: 'user' | 'voice', text: string) => void
  /** A button pressed on a panel document shown on a phone. */
  onPanelAct: (text: string, submit: boolean) => void
  /** The conversation so far, for briefing a call as it connects. */
  recap: () => string
  /** Anything worth repainting: link state, which devices are here. */
  onChange: () => void
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
  readonly stats = { texts: 0, tools: 0, lines: 0, secrets: 0, notes: 0, panels: 0, acts: 0, lastTool: '', errors: [] as string[] }

  constructor(private readonly hooks: RemoteHooks) {}

  /** Phones currently connected to the account — who a note should be sent to. */
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
      onMessage: (m: Record<string, unknown>, from: string) => void this.receive(m, from),
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

  stop(): void {
    this.link?.stop()
    this.link = null
    this.devices = []
    this.state = 'off'
  }

  private async receive(m: Record<string, unknown>, from: string): Promise<void> {
    const kind = String(m['t'] ?? '')
    const reply = (body: Record<string, unknown>) => this.link?.send(from, { ...body, id: m['id'] })

    try {
      switch (kind) {
        // A phone has just picked this laptop and wants to know what it has walked into.
        case 'hello':
          this.stats.notes++
          await this.link?.send(from, { t: 'ready', recap: this.hooks.recap() })
          break

        // A message typed on the phone. Handled by the same method the panel's composer
        // calls, so both land in one history and one thread.
        case 'say': {
          this.stats.texts++
          const answer = await this.hooks.onText(String(m['text'] ?? ''))
          await reply({ t: 'reply', text: answer.text, did: answer.did })
          break
        }

        // A tool the phone's voice called. The result is a sentence either way: the model
        // is holding the floor waiting for this string.
        case 'tool': {
          this.stats.tools++
          this.stats.lastTool = String(m['name'] ?? '')
          const out = await this.hooks.onTool(
            String(m['name'] ?? ''),
            (m['args'] as Record<string, unknown>) ?? {}
          )
          await reply({ t: 'toolResult', text: out })
          break
        }

        // Someone tapped a button on a panel shown on the phone. It lands in the same
        // place the desk's own panel acts do — the session the panel belongs to.
        case 'act':
          this.stats.acts++
          this.hooks.onPanelAct(String(m['text'] ?? ''), m['submit'] !== false)
          break

        // A line of the phone's call, so this laptop's thread has it too. This is what
        // makes a conversation had in the car continue at the desk.
        case 'line':
          this.stats.lines++
          this.hooks.onSpoken(m['who'] === 'user' ? 'user' : 'voice', String(m['text'] ?? ''))
          break

        // A session secret for the phone's call. Minted here, valid for minutes, and the
        // only credential that ever leaves this machine.
        case 'secret': {
          this.stats.secrets++
          const auth = await window.ember.voice.secret(String(m['voice'] ?? ''), String(m['model'] ?? ''))
          await reply({ t: 'secret', auth })
          break
        }
      }
    } catch (err) {
      const why = `${kind}: ${(err as Error).message}`
      this.stats.errors.push(why)
      console.warn(`[ember] remote ${why}`)
      // The phone is waiting on a reply for the request kinds that carry an id. Leaving it
      // waiting is worse than telling it the truth — a call with a tool that never returns
      // goes silent with nothing to recover from.
      if (m['id'] !== undefined) {
        const message = (err as Error).message
        await reply(
          kind === 'tool'
            ? { t: 'toolResult', text: `That did not work: ${message}` }
            : kind === 'secret'
              ? { t: 'secret', auth: { ok: false, error: message } }
              : { t: 'reply', text: `That did not work: ${message}`, did: [] }
        )
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
      html = await window.ember.panel.render(push)
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

  /**
   * Tell the phones a dispatched session has finished.
   *
   * The point of handing work out while driving is being told when it lands, so this is
   * the other half of `send_work`. Sent to every phone on the account rather than a
   * remembered one — which phone is in his hand is not something this machine can know.
   * Each decides whether to say it aloud; that judgement needs to know whether anyone is
   * mid-sentence, which only the phone can see.
   */
  async note(text: string): Promise<void> {
    if (!this.link) return
    for (const phone of this.phones) {
      this.stats.notes++
      await this.link.send(phone.id, { t: 'note', text })
    }
  }
}
