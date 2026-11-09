import type { ThemeConfig } from '../shared/types.js'

/**
 * Ember's one look: Basalt, matte volcanic stone. Opaque stone surfaces (styles/basalt.css),
 * Archivo for the interface, DM Mono for the terminal. Greys are stone, one accent is lava;
 * the ANSI warm slots lean toward the lava so a warning reads as part of the same rock.
 *
 * There is no theme picker: config.ts pins this palette whatever a config file says.
 */
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
