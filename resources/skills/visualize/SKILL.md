---
name: visualize
description: Put something on Ember's visualisation panel — a diagram, a table, a plan, a mockup, a chart, a document. Use when the user says /visualize, "show me", "draw it", "put it on the panel", "as a diagram", or presses Visualize in Ember — and on your own initiative, without being asked, whenever what you are about to explain has a shape (an architecture, a flow, a comparison, a plan, numbers, a layout) and a picture beside the terminal would carry it better than prose.
---

<!-- installed by Ember; edit freely, Ember will not overwrite a file that has lost this line -->

# Visualize

Draw the thing on the panel with `show_panel`, then say one or two sentences in the
terminal about what matters in it. Do not write out in prose what the panel shows.

This is yours to decide as much as the user's. Before any substantial reply, ask what
they would have to hold in their head to follow it; if that is a structure, a sequence,
a comparison, a plan or a set of numbers, draw it first and talk second. Invoked with no
subject (`/visualize` alone, or the Visualize button), the subject is whatever is being
discussed right now: the last thing you explained, the change you are making, the
question on the table.

If `show_panel` is not available, this session is not in an Ember tab: say so in a line
and put the same content in the terminal as markdown or a mermaid block instead.

## Pick the format

- **Structure, flow, sequence, state, dependencies** → `mermaid`. Flowcharts for how
  parts connect; `sequenceDiagram` for who calls whom over time; `stateDiagram-v2` for
  lifecycles; `erDiagram` for data; `gantt` for a schedule. Keep node labels short and
  name the real things — files, services, functions — so the user can point at them.
- **Comparisons, options, inventories, results** → `markdown` with a table, then
  `ask_panel` if a choice follows.
- **A plan of several steps** → `markdown` checklist, pushed again with the ticks
  updated as steps complete.
- **UI, a layout, anything with a look** → `html`: a real, self-contained mockup with
  inline CSS, not a description of one.
- **Numbers over time or across categories** → `html` with an inline chart (an SVG you
  draw, or a tiny script); never a table pretending to be a chart.
- **One listing to keep open while you keep talking** → `code`, with `language`.

## What an html panel is

A whole page, as raw text, every time:

```
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  body { margin: 0; padding: 18px; color: #D9D2EA; font: 13.5px/1.6 ui-monospace, monospace; }
  …your styles…
</style></head>
<body>
  …your markup…
</body></html>
```

Not a fragment (`<div>…</div>` on its own), and not inside a ``` fence — the panel then
shows the backticks. The webview is transparent over Ember's dark panel, so a page that
never names a text colour draws black on black and looks empty: either keep the
background transparent and use light text, or paint your own background and pick text to
match. Everything inline; nothing external is fetched. Ember will wrap a fragment in a
page of its own so it still shows, but it will look like a markdown panel, not yours.

## Keep it readable

The panel is dark. Leave node colours to Ember's theme; if a diagram needs its own
colours (before/after, the changed nodes), set `fill` and `color` together in the same
`style` or `classDef`, never a fill alone. Ember re-inks labels after render by the
luminance of the shape under them, so a stray light fill still reads, but a chosen
pair always looks better than a rescued one.

## Make it answer back

Put the next step on the panel as a button: `[Run the tests](ember:run the tests)` sends
and submits; `[npm run build](ember-type:npm run build)` fills the prompt and leaves Enter
to the user — the right choice for anything destructive. In html, `data-ember-send="…"`
on any element, `data-ember-submit="0"` for the fill-only variant.

## Before and after

For a change to structure, draw both: the before and the after as two diagrams, or one
diagram with the changed nodes marked. That is the single most useful picture in a
refactor and the one people cannot hold in their head from prose.

## One panel

Each push replaces what is on the panel. Push again as the work moves on — a plan
updated in place, the after beside the before — rather than describing the change.
