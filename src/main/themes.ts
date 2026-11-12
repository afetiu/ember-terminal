import type { ThemeConfig } from '../shared/types.js'
import type { Look } from '../shared/looks.js'

/**
 * The terminal palette of each look. The chrome's own surfaces live in the stylesheets
 * (styles/basalt.css for the structure and Basalt's stone, styles/looks.css for the
 * rest); these are the sixteen ANSI colours, the ground and the caret the shell draws in.
 *
 * In every look the warm ANSI slots lean toward that look's accent, so a warning reads
 * as part of the same material. config.ts pins the palette of the chosen look whatever a
 * config file says: the look is a choice, its colours are not.
 */

/** Basalt: matte volcanic stone. Greys are stone, the one accent is lava. */
export const BASALT: ThemeConfig = {
  name: 'Basalt',
  background: '#1D1E20',
  foreground: '#ECEBE8',
  cursor: '#FF7A3D',
  cursorAccent: '#1D1E20',
  selectionBackground: '#4D3426',
  black: '#2F3033',
  red: '#EE6A4E',
  green: '#A3BF8E',
  yellow: '#FFA45C',
  blue: '#8EA8C3',
  magenta: '#C49AB2',
  cyan: '#8DBDB8',
  white: '#B9B8B4',
  brightBlack: '#8D8C88',
  brightRed: '#FF8A6C',
  brightGreen: '#BDD4AA',
  brightYellow: '#FFBE86',
  brightBlue: '#AEC3D8',
  brightMagenta: '#D9B6CA',
  brightCyan: '#AED4D0',
  brightWhite: '#F7F6F3',
}

/** Smoke: dark glass over soft colour. Near-black ground, white ink, an ember accent. */
export const SMOKE: ThemeConfig = {
  name: 'Smoke',
  background: '#0C0D10',
  foreground: '#F4F4F5',
  cursor: '#FF8A4C',
  cursorAccent: '#0C0D10',
  selectionBackground: '#4A3020',
  black: '#2A2C31',
  red: '#FF7A6B',
  green: '#7FD9A8',
  yellow: '#FFC56B',
  blue: '#7FB2FF',
  magenta: '#D69AE8',
  cyan: '#6FD3DE',
  white: '#C8C9CE',
  brightBlack: '#8A8C93',
  brightRed: '#FFA296',
  brightGreen: '#B9F3D6',
  brightYellow: '#FFD999',
  brightBlue: '#A9CBFF',
  brightMagenta: '#E7BDF2',
  brightCyan: '#A2E6EE',
  brightWhite: '#FFFFFF',
}

/** Lacquer: deep red-black gloss. Cream ink, gold for the caret and the fine lines. */
export const LACQUER: ThemeConfig = {
  name: 'Lacquer',
  background: '#170D0F',
  foreground: '#F5EBDE',
  cursor: '#DCB76C',
  cursorAccent: '#170D0F',
  selectionBackground: '#4A2A1E',
  black: '#2D1C1F',
  red: '#F0563C',
  green: '#A9C08A',
  yellow: '#DCB76C',
  blue: '#8FA6C9',
  magenta: '#C98BA8',
  cyan: '#8CBDB2',
  white: '#CDBCAE',
  brightBlack: '#A08C80',
  brightRed: '#FF7A61',
  brightGreen: '#C6D9AA',
  brightYellow: '#F4D58F',
  brightBlue: '#B2C4E0',
  brightMagenta: '#E0B0C6',
  brightCyan: '#B0D6CD',
  brightWhite: '#FFF6EA',
}

/** Patina: aged green metal. Pale mint ink, copper for the caret and whatever is hot. */
export const PATINA: ThemeConfig = {
  name: 'Patina',
  background: '#13211E',
  foreground: '#E7EFE9',
  cursor: '#E8915C',
  cursorAccent: '#13211E',
  selectionBackground: '#4A3324',
  black: '#1A2C28',
  red: '#E8785C',
  green: '#86D6BF',
  yellow: '#F3A877',
  blue: '#8DB4D6',
  magenta: '#C99BB8',
  cyan: '#7FCFD0',
  white: '#B3C5BC',
  brightBlack: '#86A096',
  brightRed: '#FF9A80',
  brightGreen: '#AEE8D6',
  brightYellow: '#FFC79E',
  brightBlue: '#B0CEE8',
  brightMagenta: '#DFBDD2',
  brightCyan: '#A8E2E2',
  brightWhite: '#F4FAF6',
}

/** Hearth: a room lit by a low fire. Warm cream ink, the caret is a live coal. */
export const HEARTH: ThemeConfig = {
  name: 'Hearth',
  background: '#1B1512',
  foreground: '#F4E9DD',
  cursor: '#FF9A52',
  cursorAccent: '#1B1512',
  selectionBackground: '#553018',
  black: '#2A201A',
  red: '#FF7A5A',
  green: '#B5CE94',
  yellow: '#FFB27A',
  blue: '#9DB4CC',
  magenta: '#D3A0B4',
  cyan: '#93C4B8',
  white: '#D8CABD',
  brightBlack: '#A89788',
  brightRed: '#FFA088',
  brightGreen: '#CFE3B4',
  brightYellow: '#FFD08A',
  brightBlue: '#BCCEE0',
  brightMagenta: '#E6BECE',
  brightCyan: '#B6DCD2',
  brightWhite: '#FFF3E6',
}

/** Lamp: a lava lamp in a plum room. Orange and pink wax, mint for what went well. */
export const LAMP: ThemeConfig = {
  name: 'Lamp',
  background: '#1B0D24',
  foreground: '#FFF5EC',
  cursor: '#FF9A4D',
  cursorAccent: '#1B0D24',
  selectionBackground: '#5C2A4C',
  black: '#33203C',
  red: '#FF6F8F',
  green: '#8EE8C2',
  yellow: '#FFAD3D',
  blue: '#9DB6FF',
  magenta: '#FF8AC0',
  cyan: '#84DCE0',
  white: '#E6D3E2',
  brightBlack: '#B49FB8',
  brightRed: '#FF9AB4',
  brightGreen: '#B6F5D8',
  brightYellow: '#FFD98A',
  brightBlue: '#BFCFFF',
  brightMagenta: '#FFB3D6',
  brightCyan: '#B0ECEE',
  brightWhite: '#FFFFFF',
}

/** Snowfall: a plum night with snow on it. The caret is the lit window. */
export const SNOWFALL: ThemeConfig = {
  name: 'Snowfall',
  background: '#19152B',
  foreground: '#F7F2EC',
  cursor: '#FFB868',
  cursorAccent: '#19152B',
  selectionBackground: '#473A63',
  black: '#2E2745',
  red: '#FF8F8F',
  green: '#A6E0B8',
  yellow: '#FFB868',
  blue: '#A9B8FF',
  magenta: '#D6A8F0',
  cyan: '#9FD6E8',
  white: '#D5CCE2',
  brightBlack: '#A297B2',
  brightRed: '#FFB3A6',
  brightGreen: '#C6EED2',
  brightYellow: '#FFD49A',
  brightBlue: '#C6D0FF',
  brightMagenta: '#E6C6F7',
  brightCyan: '#C2E8F2',
  brightWhite: '#FFFFFF',
}

/** Tide: dark sand and sea water. Seafoam for the caret, coral for what is wrong. */
export const TIDE: ThemeConfig = {
  name: 'Tide',
  background: '#1B1611',
  foreground: '#F6EFE4',
  cursor: '#8FE6D4',
  cursorAccent: '#1B1611',
  selectionBackground: '#2F4A46',
  black: '#322A21',
  red: '#FF9478',
  green: '#9BE2B4',
  yellow: '#F2C98A',
  blue: '#8FBFE6',
  magenta: '#E3A6C0',
  cyan: '#8FE6D4',
  white: '#D8CEBE',
  brightBlack: '#AEA595',
  brightRed: '#FFB5A0',
  brightGreen: '#BFF0CF',
  brightYellow: '#FFE0AE',
  brightBlue: '#B5D6F2',
  brightMagenta: '#F0C4D6',
  brightCyan: '#C8FFF2',
  brightWhite: '#FFFAF0',
}

/** Terrarium: deep green under glass. Leaf green for the caret, mushroom orange for warnings. */
export const TERRARIUM: ThemeConfig = {
  name: 'Terrarium',
  background: '#0D1B14',
  foreground: '#F0F6EA',
  cursor: '#9BE38A',
  cursorAccent: '#0D1B14',
  selectionBackground: '#2B4A35',
  black: '#1F3528',
  red: '#FF9F8A',
  green: '#9BE38A',
  yellow: '#FFB35C',
  blue: '#8FC4E8',
  magenta: '#E0A8D0',
  cyan: '#8ADFC4',
  white: '#CFE0CB',
  brightBlack: '#A3B5A2',
  brightRed: '#FFBDAE',
  brightGreen: '#C2F2B6',
  brightYellow: '#FFD08F',
  brightBlue: '#B8DAF2',
  brightMagenta: '#EEC6E2',
  brightCyan: '#B6F0DC',
  brightWhite: '#FBFFF6',
}

export const THEMES: Record<Look, ThemeConfig> = {
  basalt: BASALT,
  smoke: SMOKE,
  lacquer: LACQUER,
  patina: PATINA,
  hearth: HEARTH,
  lamp: LAMP,
  snowfall: SNOWFALL,
  tide: TIDE,
  terrarium: TERRARIUM,
}
