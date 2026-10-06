#!/usr/bin/env node
/**
 * The panel MCP server.
 *
 * Claude Code spawns this; Ember never does. That indirection is the point: the CLI
 * runs in a pty as itself, and the only thing Ember gives it is an environment. This
 * process inherits `EMBER_BRIDGE_URL`, `EMBER_BRIDGE_TOKEN` and `EMBER_TAB_ID` down
 * the chain — pty to shell to claude to here — so it knows which tab's panel to draw
 * on without anyone passing an argument.
 *
 * Hand-rolled JSON-RPC rather than the MCP SDK, because a dependency here would have
 * to be installed and resolvable from wherever the CLI happens to be running. This
 * file has to work when dropped next to a packaged app with no node_modules at all.
 */

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID

/**
 * How a panel talks back, described once and pasted into the two tool descriptions
 * that can use it. Buttons are the difference between a panel you read and a panel you
 * work from, and a model that does not know the syntax will not invent it.
 */
const INTERACTIVE = [
  'The panel is two-way. Anything you put on it can be pressed, and pressing it types into this ',
  'terminal as if the user had typed it themselves — so offer the next step as a button instead of ',
  'describing it. In markdown: `[Run the tests](ember:run the tests)` sends that text and submits it; ',
  '`[npm run build](ember-type:npm run build)` puts it in the prompt and leaves Enter to the user, ',
  'which is the right choice for anything destructive. In an html panel, put `data-ember-send="..."` on ',
  'any element (add `data-ember-submit="0"` for the fill-only variant). ',
  'The user can also point at any element on the panel — a table row, a node in a diagram, a paragraph — ',
  'and ask about it; that arrives here as a message quoting what they picked.',
].join('')

/**
 * What an html panel has to be, said once and pasted wherever html is mentioned.
 *
 * The panel is a transparent webview over the theme's surface, dark or light. A fragment — a bare `<div>`
 * with no document, no colours — is wrapped by Ember and styled like a markdown panel,
 * so it is never blank any more; but a model that knows the shape sends the shape, and
 * a real page with its own colours is what the format is for. The most frequent way the
 * panel has "shown nothing" was exactly this: partial markup, or a page whose body
 * never named a text colour, drawn black on black.
 */
const HTML_CONTRACT = [
  'An html panel is a complete document: start with `<!doctype html>`, then `<html>`, a `<head>` with a ',
  '`<style>`, and a `<body>` — never a bare fragment like `<div>…</div>`, and never wrapped in a ``` fence. ',
  'The panel follows the user\'s theme — dark or light — and is transparent behind your page, so never ',
  'hard-code pale text on nothing. Colour the page with the CSS variables Ember defines, which flip with ',
  'the theme: var(--ember-ink) body text, var(--ember-strong) headings, var(--ember-muted) secondary text, ',
  'var(--ember-accent) links and highlights, var(--ember-line) borders, var(--ember-surface) card fills ',
  '(html[data-ember-tone] is "light" or "dark" if you need to branch). A card with its own solid background ',
  'is fine: choose text that reads on that card. Inline all CSS and JS; nothing external is fetched. Keep it ',
  'self-contained and under a few hundred lines. If you send a fragment anyway, Ember wraps it in a page ',
  'of its own so it still shows, but it will look like a markdown panel rather than your design.',
].join('')

/**
 * What the CLI is told about the panel before it does anything.
 *
 * Carried here rather than pushed in with `--append-system-prompt`: the shim would
 * have to quote all of this through PowerShell, and a server describing itself is the
 * mechanism that already exists for it.
 *
 * It is written as a working habit rather than as a feature list, because that is the
 * thing being asked for. A tool description answers "what does this do"; only the
 * instructions can answer "when, without being asked".
 */
const INSTRUCTIONS = [
  'This session is running inside an Ember tab. To the right of the terminal is a visualisation panel ',
  'you can draw on, and the user has asked for it to be used on your own initiative — they do not want ',
  'to have to say "show me" every time.\n\n',

  'Treat the panel as half of your answer. The terminal is where you talk; the panel is where the thing ',
  'you are talking about stays on screen while you talk about it. Before a substantial reply, ask ',
  'yourself what the user would have to hold in their head to follow it, and put that on the panel with ',
  'show_panel. In practice that means, without being asked:\n',
  '- Changing architecture or structure: the before and the after, as diagrams, with what moved marked.\n',
  '- Explaining a system: the flow, sequence, state machine or file tree — not a paragraph describing one.\n',
  '- Weighing options: a comparison table, then ask_panel to let them choose.\n',
  '- Planning work of more than a couple of steps: the plan, updated in place as it proceeds.\n',
  '- Designing anything visual: a real mockup as an html panel, not a description of one — and an html ',
  'panel is a whole document, `<!doctype html>` through `</html>`, with its own colours, never a fragment.\n',
  '- Reporting measurements, coverage, timings, counts: a chart.\n',
  '- Anything long they will want to keep looking at while you carry on: the listing or the document.\n\n',

  'Each push replaces what is on the panel, so push again as the work moves on and the panel tracks ',
  'it. Never ask whether to show something, and never describe what you ',
  'have just put on the panel — they are looking at it. One or two sentences in the terminal pointing at ',
  'what matters in it is right; a written-out version of the same content is not.\n\n',

  'The panel answers back. Put the next step on it as a button and pressing it types into this terminal ',
  'as the user: `[Run the tests](ember:run the tests)` in markdown sends and submits, ',
  '`[npm run build](ember-type:npm run build)` fills the prompt and leaves Enter to them, and ',
  '`data-ember-send="..."` does the same on any element of an html panel. Use ask_panel for questions ',
  'with discrete answers instead of asking in prose. The user can also point at any element on the ',
  'panel and ask about it, which arrives as a message quoting what they picked — so make the panel out ',
  'of things worth pointing at: real rows, named nodes, separate steps.\n\n',

  'Use open_url instead of telling them to open a browser — a dev server you just started, a PR, docs ',
  'you are quoting. Use clear_panel when what is up is finished with.\n\n',

  'The terminal cannot draw images, so the user does not see the screenshots you take or the pictures ',
  'you read unless they reach the panel. In Claude Code most of them get there by themselves — an image ',
  'you Read and a screenshot an MCP tool returns are added to the panel\'s Images — but when an image is ',
  'the point (a before/after, a render you produced, the screenshot that shows the bug), put it up with ',
  'show_image, and name the image files in the terminal rather than describing them.\n\n',

  `The user also keeps notes in Ember: plain .md files in ${process.env.EMBER_NOTES_DIR || 'their Documents\\\\Ember Notes folder'}, `,
  'shown in a Notes tab. There is a command for them on PATH — `notes list`, `notes read <note>`, ',
  '`notes new <text>`, `notes append <note> <text>`, `notes write <note>` (stdin), `notes open <note>`; ',
  '`notes --help` has the rest. When they mention their notes ("what did I note about X", "add this to my ',
  'notes", "make a note"), use it rather than asking where they are. They are ordinary files, so reading or ',
  'grepping the folder directly is fine too.\n\n',

  'One of those notes is the todo list. `todo add "…"` adds an item, `todo done <words>` ticks one, ',
  '`todo list` prints the open ones. Keep it fed without being asked: when the user says they need to ',
  'do something later, or a turn of yours ends with something only they can do — a decision, a manual ',
  'step, a thing to check tomorrow — add it, once, phrased as an action they can tick off.',
].join('')

const TOOLS = [
  {
    name: 'show_panel',
    // The habit — when to push, unprompted — lives in the server instructions above and is
    // not repeated here; this describes the tool. Every word here is in context on every
    // turn of every session, so it is kept to what changes how the tool is called.
    description:
      "Show something on the user's visualisation panel, the pane beside this terminal. It opens on the " +
      'first push and costs nothing when unused. If what you are about to say has a shape — a diagram, a ' +
      'table, a plan, a mockup, a chart, a long listing — draw it here and narrate it in the terminal. ' +
      'Each push replaces what is on the panel, so update it as the work moves on. Do not ' +
      'ask permission and do not describe the panel afterwards; push it and carry on. ' +
      INTERACTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading for the panel.' },
        format: {
          type: 'string',
          enum: ['markdown', 'mermaid', 'code', 'html'],
          description:
            'markdown for prose, tables, lists and action buttons; mermaid for diagrams (flowchart, ' +
            'sequence, state, ER, gantt, class); code for a single listing; html for a complete ' +
            'self-contained page when you want charts, mockups, layout or interaction. Markdown may ' +
            'contain ```mermaid fences too, which is usually the best default: a diagram with a ' +
            'sentence above it and buttons below it. ' +
            HTML_CONTRACT,
        },
        content: {
          type: 'string',
          description:
            'The panel body, in the chosen format. For html: the whole document, from `<!doctype html>` ' +
            'to `</html>`, as raw text — not a fragment, not inside a ``` fence.',
        },
        language: { type: 'string', description: 'Language hint when format is "code".' },
        replace: {
          type: 'boolean',
          description:
            'Accepted for compatibility; the panel shows one thing, and every push replaces what was ' +
            'there. Omit it.',
        },
      },
      required: ['title', 'format', 'content'],
    },
  },
  {
    name: 'ask_panel',
    description:
      'Ask the user a question as a card on the panel, with the answers as buttons. Pressing one types ' +
      'it into this terminal and submits it, so the answer comes back as their next message. ' +
      'Use this instead of asking in prose whenever the question has discrete answers — which design, ' +
      'which of these files, is this right, shall I go ahead — and especially when the options are worth ' +
      'seeing next to each other. There is a free-text box under the buttons by default, so it never ' +
      'traps them in your list. Ask, then stop and wait for the answer; do not also repeat the question ' +
      'in the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading for the card.' },
        question: {
          type: 'string',
          description: 'The question, in markdown. A sentence or two; put the detail in the options.',
        },
        options: {
          type: 'array',
          description: 'The answers, as buttons. Omit for a pure free-text prompt.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'What the button reads.' },
              value: {
                type: 'string',
                description: 'What gets sent when it is pressed. Defaults to the label.',
              },
              hint: { type: 'string', description: 'A line of smaller text under the label.' },
              submit: {
                type: 'boolean',
                description: 'False to fill the prompt without pressing Enter. Default true.',
              },
            },
            required: ['label'],
          },
        },
        freeText: {
          type: 'boolean',
          description: 'False to remove the free-text box. Default true — leave it unless the answer is truly closed.',
        },
      },
      required: ['title', 'question'],
    },
  },
  {
    name: 'open_url',
    description:
      "Open a web page in the user's panel, as a real browser with back, forward and an address bar. Use " +
      'this instead of telling them to go and look at something: a dev server you just started, docs you ' +
      'are quoting, a dashboard, a PR. It saves them leaving the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An http or https URL.' },
        title: { type: 'string', description: 'Short heading for the panel.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'show_image',
    description:
      'Show one or more image files on the panel — screenshots, renders, charts saved as images, before/after ' +
      'pairs. The terminal cannot display images, so this is how the user sees one. Give absolute paths to ' +
      'png, jpg, gif, webp or bmp files; the first is shown large and the rest as thumbnails, and the panel ' +
      'keeps every image of the session so they can go back to earlier ones.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to the image files, the one to show first first.' },
        caption: { type: 'string', description: 'Short line under the image: what it shows.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'clear_panel',
    description: 'Empty the panel and collapse it. Use when what is on screen is finished with.',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** The same test Ember's renderer applies before deciding whether to wrap the page. */
function isHtmlDocument(content) {
  const text = String(content ?? '')
  // A fenced page is unfenced by Ember, but it is still not what was asked for.
  if (/^\s*```/.test(text)) return false
  return /^\s*(<!doctype\b|<html\b)/i.test(text)
}

async function post(path, body) {
  const res = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
    body: JSON.stringify({ ...body, tabId: TAB }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`bridge said ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return res.json()
}

async function announce() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  if (!BRIDGE || !TOKEN || !TAB || !sessionId) return
  try {
    await post('/session', { sessionId, cwd })
  } catch {
    // Narration falls back to guessing which transcript is ours. Not worth a noise on
    // stderr, which Claude Code surfaces as an MCP server failure.
  }
}

async function call(name, args) {
  if (!BRIDGE || !TOKEN || !TAB) {
    throw new Error('No Ember panel is attached to this shell — this session is not running inside an Ember v2 tab.')
  }
  switch (name) {
    case 'show_panel': {
      await post('/panel', {
        title: args.title,
        format: args.format ?? 'markdown',
        content: args.content,
        language: args.language,
        replace: args.replace === true,
      })
      const shown = `The panel is now showing "${args.title}". The user can see it — do not describe it to them.`
      // A fragment still shows — Ember wraps it — but it shows as Ember's page, not the
      // model's. Say so on the result, where it is read, rather than only in the schema.
      if (args.format === 'html' && !isHtmlDocument(args.content)) {
        return (
          `${shown} Note: the content was an HTML fragment, not a document, so Ember wrapped it in a page ` +
          'of its own with the panel\'s default styles. Next time send the whole page — `<!doctype html>`, ' +
          '`<html>`, `<head>` with a `<style>`, `<body>` — with explicit colours, and not inside a ``` fence.'
        )
      }
      return shown
    }
    case 'ask_panel': {
      await post('/panel', {
        title: args.title,
        format: 'ask',
        content: args.question ?? args.content ?? '',
        options: Array.isArray(args.options) ? args.options : [],
        freeText: args.freeText !== false,
        // A question supersedes whatever was on the panel. Two live questions on one
        // surface is a way to get neither answered.
        replace: true,
      })
      return (
        `The question is on the panel and the user can answer it by pressing a button. ` +
        `Their answer will arrive as their next message — stop here and wait for it.`
      )
    }
    case 'open_url': {
      if (!/^https?:\/\//i.test(String(args.url ?? ''))) throw new Error('url must be http or https')
      await post('/panel', {
        title: args.title ?? args.url,
        format: 'url',
        content: args.url,
        replace: true,
      })
      return `The panel is now browsing ${args.url}.`
    }
    case 'show_image': {
      const paths = (Array.isArray(args.paths) ? args.paths : [args.path ?? args.paths]).filter(Boolean).map(String)
      if (!paths.length) throw new Error('paths is required: absolute paths to image files')
      const res = await post('/image', { paths, caption: args.caption, source: 'shown' })
      return `${res.count === 1 ? 'The image is' : `${res.count} images are`} on the panel. The user can see ${res.count === 1 ? 'it' : 'them'} — do not describe ${res.count === 1 ? 'it' : 'them'}.`
    }
    case 'clear_panel': {
      await post('/panel/clear', {})
      return 'The panel is empty and collapsed.'
    }
    default:
      throw new Error(`unknown tool "${name}"`)
  }
}

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function reply(id, result) {
  if (id === undefined || id === null) return
  write({ jsonrpc: '2.0', id, result })
}

/**
 * Tool failures are results with `isError`, not JSON-RPC errors. A protocol error is
 * for "I could not process this message"; a tool that could not do its job is
 * something the model should read and react to, and only the first form reaches it.
 */
function fail(id, message) {
  if (id === undefined || id === null) return
  write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } })
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return reply(id, {
        // Echoing the client's version keeps this working as the spec moves; nothing
        // here depends on any version-specific behaviour.
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ember-panel', version: '1.0.0' },
        // Carried here rather than pushed in with --append-system-prompt: the shim
        // would have to quote this through PowerShell, and a server describing itself
        // is the mechanism that already exists for it.
        instructions: INSTRUCTIONS,
      })
    case 'notifications/initialized':
      // Tell Ember which Claude session is running in this tab.
      //
      // This process is the only place the two facts meet: `EMBER_TAB_ID` came down the
      // chain from the pty, and `CLAUDE_CODE_SESSION_ID` was put here by Claude Code
      // itself. The transcript is named after the session id, so this one message is
      // what lets narration read the right file instead of guessing at the newest one.
      void announce()
      return
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call':
      try {
        const text = await call(params?.name, params?.arguments ?? {})
        return reply(id, { content: [{ type: 'text', text }] })
      } catch (err) {
        return fail(id, `Panel unavailable: ${err.message}`)
      }
    default:
      if (id !== undefined && id !== null) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method "${method}"` } })
      }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  // Messages are newline-delimited; a chunk boundary can land anywhere, so only whole
  // lines are ever parsed and the remainder is carried forward.
  let cut = buffer.indexOf('\n')
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line) {
      try {
        void handle(JSON.parse(line))
      } catch {
        /* A line we cannot parse is not a line we can answer. */
      }
    }
    cut = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
