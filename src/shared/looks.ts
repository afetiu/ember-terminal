/**
 * Ember's looks. Each is a whole material, not a recolour: its own surfaces, its own two
 * typefaces and its own terminal palette (main/themes.ts). Basalt is the one a new install
 * starts in; the others are picked in Settings, from Ctrl+K, or with `ember theme <name>`.
 *
 * Shared by main (palette, terminal face, documents) and the renderer (stylesheet class,
 * interface face, the picker), so the list lives here and nowhere else.
 */
export const LOOKS = ['basalt', 'smoke', 'lacquer', 'patina', 'hearth', 'lamp', 'snowfall', 'tide', 'terrarium'] as const

export type Look = (typeof LOOKS)[number]

export interface LookInfo {
  id: Look
  name: string
  /** One plain line for the picker. */
  about: string
  /** The interface face: the first family is bundled (styles/fonts.css). */
  ui: string
  /** The terminal face, same rule. */
  mono: string
  /** What the picker's tile is painted with: ground, surface, ink, accent. */
  swatch: { ground: string; surface: string; ink: string; accent: string }
}

const UI_TAIL = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
const MONO_TAIL = "'Cascadia Code', Consolas, monospace"

export const LOOK_INFO: Record<Look, LookInfo> = {
  basalt: {
    id: 'basalt',
    name: 'Basalt',
    about: 'Matte stone, one lava accent',
    ui: `Archivo, ${UI_TAIL}`,
    mono: `'DM Mono', ${MONO_TAIL}`,
    swatch: { ground: '#1D1E20', surface: '#2A2B2E', ink: '#ECEBE8', accent: '#FF7A3D' },
  },
  smoke: {
    id: 'smoke',
    name: 'Smoke',
    about: 'Dark glass over soft colour',
    ui: `Geist, ${UI_TAIL}`,
    mono: `'Geist Mono', ${MONO_TAIL}`,
    swatch: { ground: '#0C0D10', surface: '#23262C', ink: '#F4F4F5', accent: '#FF8A4C' },
  },
  lacquer: {
    id: 'lacquer',
    name: 'Lacquer',
    about: 'Deep red gloss, gold lines',
    ui: `Outfit, ${UI_TAIL}`,
    mono: `'Red Hat Mono', ${MONO_TAIL}`,
    swatch: { ground: '#0E0809', surface: '#201215', ink: '#F5EBDE', accent: '#DCB76C' },
  },
  patina: {
    id: 'patina',
    name: 'Patina',
    about: 'Aged green metal, copper plates',
    ui: `'Bricolage Grotesque', ${UI_TAIL}`,
    mono: `'Martian Mono', ${MONO_TAIL}`,
    swatch: { ground: '#0C1614', surface: '#1A2C28', ink: '#E7EFE9', accent: '#E8915C' },
  },
  hearth: {
    id: 'hearth',
    name: 'Hearth',
    about: 'A low fire, embers drifting up',
    ui: `'Hanken Grotesk', ${UI_TAIL}`,
    mono: `'JetBrains Mono', ${MONO_TAIL}`,
    swatch: { ground: '#110D0B', surface: '#2A1A12', ink: '#F4E9DD', accent: '#FF9A52' },
  },
  lamp: {
    id: 'lamp',
    name: 'Lamp',
    about: 'A lava lamp, slow and round',
    ui: `Fredoka, ${UI_TAIL}`,
    mono: `'DM Mono', ${MONO_TAIL}`,
    swatch: { ground: '#1B0D24', surface: '#3A1B3E', ink: '#FFF5EC', accent: '#FF7A5E' },
  },
  snowfall: {
    id: 'snowfall',
    name: 'Snowfall',
    about: 'Snow on a cabin in the pines',
    ui: `Nunito, ${UI_TAIL}`,
    mono: `'Source Code Pro', ${MONO_TAIL}`,
    swatch: { ground: '#1B1730', surface: '#30284A', ink: '#F7F2EC', accent: '#FFB868' },
  },
  tide: {
    id: 'tide',
    name: 'Tide',
    about: 'A beach at night, the water coming in',
    ui: `Onest, ${UI_TAIL}`,
    mono: `'M PLUS 1 Code', ${MONO_TAIL}`,
    swatch: { ground: '#1F1913', surface: '#143F43', ink: '#F6EFE4', accent: '#8FE6D4' },
  },
  terrarium: {
    id: 'terrarium',
    name: 'Terrarium',
    about: 'Ferns under glass, mushrooms glowing',
    ui: `Gabarito, ${UI_TAIL}`,
    mono: `Inconsolata, ${MONO_TAIL}`,
    swatch: { ground: '#0E1E16', surface: '#1D3B2B', ink: '#F0F6EA', accent: '#9BE38A' },
  },
}

export function isLook(v: unknown): v is Look {
  return typeof v === 'string' && (LOOKS as readonly string[]).includes(v)
}

/** A look by any spelling a person might type; null when it is not one. */
export function findLook(v: string): Look | null {
  const k = v.trim().toLowerCase()
  return isLook(k) ? k : null
}

/** The first family of a font stack, unquoted: what `document.fonts.load` wants. */
export function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '')
}
