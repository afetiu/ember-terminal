/**
 * Where a todo item came from, as a small mark: Slack, GitHub, Jira, Gmail, Outlook, or a
 * plain link. Decided from the URL's host, so the skill that adds items only has to end
 * the line with a link and the list shows the right badge without being told.
 */
export type Source = 'slack' | 'github' | 'jira' | 'gmail' | 'outlook' | 'link'

const GITHUB =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'

const JIRA =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#2684FF" d="M16 3 29 16 16 29 3 16z"/><path fill="#fff" opacity=".92" d="M16 9.5 22.5 16 16 22.5 9.5 16z"/></svg>'

const SLACK =
  '<svg viewBox="0 0 122.8 122.8" aria-hidden="true">' +
  '<path fill="#e01e5a" d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zM32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"/>' +
  '<path fill="#36c5f0" d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zM45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"/>' +
  '<path fill="#2eb67d" d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zM90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"/>' +
  '<path fill="#ecb22e" d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zM77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"/>' +
  '</svg>'

/** An envelope, drawn rather than a font glyph so it renders the same in every face. */
const MAIL =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm0 1.6V12h12V4.6L8 8.9 2 4.6zM2.7 4 8 7.8 13.3 4H2.7z"/></svg>'

const LINK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1 1 1 1-1a1.6 1.6 0 0 1 2.2 2.2l-2 2a1.6 1.6 0 0 1-2.2 0l-1 1zm3-3a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1-1-1-1 1a1.6 1.6 0 0 1-2.2-2.2l2-2a1.6 1.6 0 0 1 2.2 0l1-1z"/></svg>'

export function sourceOf(url: string): Source {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'link'
  }
  if (host.endsWith('slack.com')) return 'slack'
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host.endsWith('atlassian.net') || host.endsWith('jira.com') || /\/browse\/[A-Z][A-Z0-9]+-\d+/.test(url)) return 'jira'
  if (host === 'mail.google.com') return 'gmail'
  if (host.includes('outlook.') || host.endsWith('office.com') || host.endsWith('office365.com') || host.endsWith('live.com')) return 'outlook'
  return 'link'
}

const NAMES: Record<Source, string> = { slack: 'Slack', github: 'GitHub', jira: 'Jira', gmail: 'Gmail', outlook: 'Outlook', link: 'the source' }
const MARKS: Record<Source, string> = { slack: SLACK, github: GITHUB, jira: JIRA, gmail: MAIL, outlook: MAIL, link: LINK }

/** A small button carrying the mark; pressing it opens the source. */
export function sourceButton(url: string, onOpen: (url: string) => void): HTMLButtonElement {
  const kind = sourceOf(url)
  const b = document.createElement('button')
  b.className = `ember-src is-${kind}`
  b.innerHTML = MARKS[kind]
  b.title = `Open in ${NAMES[kind]}`
  b.tabIndex = -1
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onOpen(url)
  })
  return b
}
