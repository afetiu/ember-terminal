import QRCode from 'qrcode'
import type { Account, RemoteDevice } from '@shared/types'

/**
 * The account sheet: what this machine is called, who else is on, and how to add a device.
 *
 * The QR is a code to *join*, not to pair. That distinction is the whole rework: the same
 * code works for the phone, for a work laptop, for anything the user owns, and it does not
 * expire when the next device uses it. Scanning it once is what puts a machine on the list
 * everything else can already see.
 *
 * A QR rather than something to type because the payload is a 256-bit key — about sixty
 * characters of base64 that nobody transcribes correctly, and a shorter one would be a
 * weaker key. The screen is the channel: offline, in the room, and the key never travels
 * over the relay it exists to defend against.
 */
export class PairSheet {
  readonly el: HTMLElement
  private readonly body: HTMLElement
  private open = false

  constructor(
    private readonly hooks: {
      /** Start an account, with this machine as its first device. */
      onCreate: () => Promise<Account>
      /** Add this machine to an account that already exists. */
      onJoin: (relay: string, key: string) => Promise<Account | null>
      /** Rename this machine as it appears on the other devices. */
      onRename: (name: string) => Promise<void>
      /** Take this machine off the account. */
      onLeave: () => Promise<void>
      onRead: () => Promise<Account | null>
      status: () => { joined: boolean; linked: boolean; devices: RemoteDevice[] }
    }
  ) {
    this.el = document.createElement('div')
    this.el.className = 'ember-pair'
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.hide()
    })

    const card = document.createElement('div')
    card.className = 'ember-pair-card'

    const head = document.createElement('header')
    head.className = 'ember-pair-head'
    head.innerHTML = '<span>Your devices</span>'

    const close = document.createElement('button')
    close.className = 'ember-pair-x'
    close.textContent = '✕'
    close.addEventListener('click', () => this.hide())
    head.appendChild(close)

    this.body = document.createElement('div')
    this.body.className = 'ember-pair-body'

    card.append(head, this.body)
    this.el.appendChild(card)

    document.addEventListener('keydown', (e) => {
      if (this.open && e.key === 'Escape') {
        e.preventDefault()
        this.hide()
      }
    })
  }

  get isOpen(): boolean {
    return this.open
  }

  async show(): Promise<void> {
    this.open = true
    this.el.classList.add('is-open')
    await this.render()
  }

  hide(): void {
    this.open = false
    this.el.classList.remove('is-open')
  }

  async toggle(): Promise<void> {
    if (this.open) this.hide()
    else await this.show()
  }

  /**
   * Repaint the live parts only.
   *
   * The roster changes whenever a device connects, and redrawing the whole sheet would
   * rebuild the QR canvas underneath the camera being pointed at it.
   */
  tick(): void {
    if (!this.open) return
    const list = this.body.querySelector<HTMLElement>('.ember-pair-devices')
    if (list) this.paintDevices(list)
    const dot = this.body.querySelector<HTMLElement>('.ember-pair-status')
    if (dot) this.paintStatus(dot)
  }

  private paintStatus(el: HTMLElement): void {
    const s = this.hooks.status()
    el.className = 'ember-pair-status'
    if (!s.joined) {
      el.classList.add('is-none')
      el.textContent = 'Not on an account'
    } else if (s.linked) {
      el.classList.add('is-on')
      el.textContent = 'This machine is online'
    } else {
      el.classList.add('is-off')
      el.textContent = 'Relay unreachable — check this machine’s connection'
    }
  }

  private paintDevices(el: HTMLElement): void {
    const { devices } = this.hooks.status()
    el.textContent = ''
    // Sorted so this machine leads and anything offline sinks: the list is read to answer
    // "can I reach it right now", not to enumerate history.
    const sorted = [...devices].sort(
      (a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
    )
    if (!sorted.length) {
      const none = document.createElement('div')
      none.className = 'ember-pair-note'
      none.textContent = 'No other devices yet.'
      el.appendChild(none)
      return
    }
    for (const d of sorted) {
      const row = document.createElement('div')
      row.className = `ember-pair-device${d.online ? ' is-online' : ''}`
      const dot = document.createElement('span')
      dot.className = 'ember-pair-dot'
      const name = document.createElement('span')
      name.className = 'ember-pair-devname'
      name.textContent = d.name + (d.self ? ' (this one)' : '')
      const kind = document.createElement('span')
      kind.className = 'ember-pair-devkind'
      kind.textContent = d.kind === 'phone' ? 'phone' : 'laptop'
      row.append(dot, name, kind)
      el.appendChild(row)
    }
  }

  private async render(): Promise<void> {
    this.body.textContent = ''
    const account = await this.hooks.onRead()

    const status = document.createElement('div')
    this.paintStatus(status)
    this.body.appendChild(status)

    if (!account) {
      const blurb = document.createElement('p')
      blurb.className = 'ember-pair-note'
      blurb.textContent =
        'Put your machines on one account and your phone can reach whichever is running — no pairing, one code for all of them.'

      const start = document.createElement('button')
      start.className = 'ember-pair-go'
      start.textContent = 'Start an account'
      start.addEventListener('click', () => {
        void this.hooks.onCreate().then(() => this.render())
      })

      const join = document.createElement('details')
      join.className = 'ember-pair-join'
      join.innerHTML = '<summary>This machine joins an existing one</summary>'
      const field = document.createElement('textarea')
      field.rows = 3
      field.placeholder = 'ember://join?...'
      field.spellcheck = false
      const go = document.createElement('button')
      go.className = 'ember-pair-minor'
      go.textContent = 'Join'
      const err = document.createElement('div')
      err.className = 'ember-pair-warn'
      go.addEventListener('click', () => {
        void this.hooks.onJoin('', field.value).then((a) => {
          if (a) void this.render()
          else err.textContent = 'That is not an Ember account code.'
        })
      })
      join.append(field, go, err)

      this.body.append(blurb, start, join)
      return
    }

    // Rendered here rather than handed to a QR service: this string is the account key,
    // and a service would be a third party learning the one secret kept off the wire.
    const canvas = document.createElement('canvas')
    canvas.className = 'ember-pair-qr'
    await QRCode.toCanvas(canvas, `ember://join?relay=${encodeURIComponent(account.relay)}&key=${account.key}`, {
      width: 240,
      margin: 1,
      // High contrast on white: a phone camera reading a dark, translucent terminal window
      // needs the code itself to be the bright thing on screen.
      color: { dark: '#0b0b12', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })

    const hint = document.createElement('p')
    hint.className = 'ember-pair-note'
    hint.textContent = 'Scan this on your phone, or on another laptop, to add it. The same code works for all of them.'

    const devices = document.createElement('div')
    devices.className = 'ember-pair-devices'
    this.paintDevices(devices)

    // Renaming matters more than it looks: the list on the phone is unusable if every
    // entry is a Windows hostname.
    const nameRow = document.createElement('div')
    nameRow.className = 'ember-pair-namerow'
    const nameInput = document.createElement('input')
    nameInput.className = 'ember-pair-name'
    nameInput.value = account.deviceName
    nameInput.maxLength = 60
    nameInput.setAttribute('aria-label', 'What this machine is called')
    const save = () => {
      void this.hooks.onRename(nameInput.value).then(() => this.tick())
    }
    nameInput.addEventListener('blur', save)
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        nameInput.blur()
      }
    })
    nameRow.appendChild(nameInput)

    const warn = document.createElement('p')
    warn.className = 'ember-pair-warn'
    warn.textContent =
      'Anyone who photographs this code can reach every machine on the account. Changing it means visiting each of them.'

    const row = document.createElement('div')
    row.className = 'ember-pair-row'
    const leave = document.createElement('button')
    leave.className = 'ember-pair-minor is-danger'
    leave.textContent = 'Remove this machine'
    leave.title = 'It disappears from the list on your other devices'
    leave.addEventListener('click', () => {
      void this.hooks.onLeave().then(() => this.render())
    })
    row.appendChild(leave)

    this.body.append(canvas, hint, nameRow, devices, warn, row)
  }
}
