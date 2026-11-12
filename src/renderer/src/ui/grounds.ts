/**
 * The living grounds that are a small scene: Snowfall's cabin in the pines, Tide's beach
 * seen from above, Terrarium's ferns under glass. Each is markup for `.ember-ground-live`
 * (styles/looks.css gives it its place and its movement). What is drawn here stands still;
 * what moves is a layer of its own, and only its transform or opacity changes.
 */

const n = (v: number): string => v.toFixed(1).replace(/\.0$/, '')

// ---------------------------------------------------------------- Snowfall

/** A pine: four stacked tiers on a trunk, its foot at (x, y). */
function pine(x: number, y: number, h: number, fill: string): string {
  const w = h * 0.42
  let s = `<rect x="${x - 2}" y="${n(y - h * 0.12)}" width="4" height="${n(h * 0.12)}" fill="${fill}"/>`
  for (let i = 0; i < 4; i++) {
    const top = y - h + h * 0.2 * i
    const bot = top + h * 0.36
    const hw = (w / 2) * (0.5 + i * 0.17)
    s += `<path d="M${x} ${n(top)}L${n(x + hw)} ${n(bot)}H${n(x - hw)}Z" fill="${fill}"/>`
  }
  return s
}

export function snowfallGround(): string {
  const far = '#231d3a'
  const near = '#18132a'
  const pines: [number, number, number, string][] = [
    [300, 742, 120, far],
    [372, 748, 150, far],
    [520, 744, 110, far],
    [690, 750, 160, far],
    [860, 746, 125, far],
    [1010, 750, 150, far],
    [1120, 744, 105, far],
    [22, 724, 190, near],
    [196, 728, 230, near],
    [258, 756, 150, near],
    [1196, 760, 250, near],
    [1262, 770, 190, near],
    [444, 780, 120, near],
    [948, 786, 130, near],
  ]
  // left %, size px, fall seconds, delay, sway, opacity
  const flakes: [number, number, number, number, string, number][] = [
    [2.2, 5, 26, -3, 'a', 0.5],
    [17.3, 5, 29, -9, 'a', 0.5],
    [24.2, 5, 34, -21, 'b', 0.4],
    [35.3, 8, 27, -6, 'a', 0.45],
    [44.9, 4, 31, -14, 'b', 0.4],
    [53.8, 6, 36, -27, 'a', 0.4],
    [62.8, 9, 28, -11, 'b', 0.45],
    [72.7, 5, 33, -1, 'a', 0.4],
    [81.4, 7, 30, -19, 'b', 0.45],
    [89.8, 4, 35, -8, 'a', 0.5],
    [96.6, 8, 27, -23, 'b', 0.65],
  ]
  const cabin =
    '<g transform="translate(66 604)"><rect x="72" y="4" width="11" height="24" fill="#120e20"/>' +
    '<path d="M70 3q7-5 15 0v4H70z" fill="#f4f0fa"/><path d="M16 46h88v48H16z" fill="#120e20"/>' +
    '<path d="M6 48L60 12l54 36z" fill="#1a1530"/>' +
    '<path d="M4 49L60 9l56 40c-6 3-10 1-14-2L60 19 18 47c-4 3-9 5-14 2z" fill="#f4f0fa"/>' +
    '<rect x="30" y="58" width="24" height="22" rx="2" fill="#ffb868"/>' +
    '<path d="M42 58v22M30 69h24" stroke="#120e20" stroke-width="2"/>' +
    '<rect x="70" y="60" width="18" height="34" rx="2" fill="#2a2140"/><circle cx="84" cy="78" r="1.5" fill="#ffb868"/>' +
    '<path d="M0 96c20-8 40-6 60-4s40 0 62 4v6H0z" fill="#3d335a"/></g>'
  return (
    '<i class="eg-moon"></i>' +
    '<div class="eg-scene"><svg viewBox="0 500 1280 300" preserveAspectRatio="none">' +
    '<path d="M0 700C130 664 240 690 380 668s250-34 400-8 260 20 500-14v154H0z" fill="#1d1832"/>' +
    pines.map((p) => pine(...p)).join('') +
    '<path d="M0 742c80-22 170-26 262-10s190 30 330 16 250-26 380-12 200 8 308-14v78H0z" fill="#332a4e"/>' +
    '<path d="M0 770c120-18 240-10 400 2s340 6 520-6 240 0 360 8v26H0z" fill="#3d335a"/>' +
    cabin +
    '</svg><i class="eg-window"></i><i class="eg-smoke"></i><i class="eg-smoke is-b"></i></div>' +
    flakes
      .map(
        ([x, px, t, d, sway, o]) =>
          `<i class="eg-flake is-${sway}" style="left:${x}%;width:${px}px;height:${px}px;opacity:${o};` +
          `animation-duration:${t}s;animation-delay:${d}s"></i>`,
      )
      .join('')
  )
}

// ---------------------------------------------------------------- Tide

/** The top edge of a sheet of water 1700 wide: a soft wave. */
const edge = (a: number, b: number): string =>
  `M0 ${40 + a}C120 ${10 + b} 230 ${64 - a} 380 ${38 + b}S640 ${8 + a} 800 ${40 - b}s280 ${30 + a} 430 ${-2 + b}S1560 ${52 - a} 1700 ${30 + b}`

function sheet(k: string, a: number, b: number, fill: string, stroke: string, sw: number): string {
  return (
    `<svg class="eg-tide is-${k}" viewBox="0 0 1700 520" preserveAspectRatio="none"><path d="${edge(a, b)}V520H0z" fill="${fill}"/>` +
    (stroke
      ? `<path d="${edge(a, b)}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
      : '') +
    '</svg>'
  )
}

function starfish(cx: number, cy: number, r: number, fill: string): string {
  let d = ''
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2
    const rr = i % 2 ? r * 0.46 : r
    d += `${i ? 'L' : 'M'}${n(cx + Math.cos(a) * rr)} ${n(cy + Math.sin(a) * rr)}`
  }
  return `<path d="${d}z" fill="${fill}" stroke="${fill}" stroke-width="5" stroke-linejoin="round"/>`
}

export function tideGround(): string {
  // left %, top %, seconds, delay: light on the wet sand and on the water
  const glints: [number, number, number, number][] = [
    [5.5, 92.7, 5, -1],
    [14.2, 95.5, 6.5, -3],
    [96.9, 91.2, 5.5, -2],
    [50, 96.2, 7, -4.5],
    [38, 22, 9, -2],
    [71, 34, 11, -6],
    [57, 12, 13, -9],
    [86, 47, 10, -4],
  ]
  return (
    '<svg class="eg-sand" viewBox="0 0 1280 800" preserveAspectRatio="none">' +
    '<g fill="none" stroke="rgba(240,225,200,0.045)" stroke-width="1.5" vector-effect="non-scaling-stroke">' +
    '<path d="M-20 318C200 290 420 336 660 310s420-30 660 6"/><path d="M-20 392C220 368 430 410 680 386s400-22 640 10"/>' +
    '<path d="M-20 462C180 440 440 480 700 458s380-18 620 12"/></g>' +
    '<path d="M-20 540C200 512 430 560 690 532s390-24 630 14v260H-20z" fill="rgba(10,8,6,0.3)"/></svg>' +
    '<i class="eg-moonlight"></i>' +
    '<svg class="eg-shore" viewBox="0 300 260 190">' +
    `<g>${starfish(162, 372, 15, '#e07e5e')}<circle cx="162" cy="372" r="2.2" fill="#f3b79f"/></g>` +
    '<g transform="rotate(-18 68 452)"><path d="M68 462c-3 0-5-2-5-4-6-2-11-8-11-15 0-9 7-15 16-15s16 6 16 15c0 7-5 13-11 15 0 2-2 4-5 4z" fill="#e9dcc4"/>' +
    '<path d="M68 457v-26M65 457l-7-22M71 457l7-22M63 456l-10-14M73 456l10-14" stroke="#b7a688" stroke-width="1.2" stroke-linecap="round"/></g>' +
    '<ellipse cx="118" cy="322" rx="5" ry="3.5" fill="#4a3f33"/><ellipse cx="196" cy="468" rx="3.5" ry="2.5" fill="#51463a"/>' +
    '<ellipse cx="44" cy="366" rx="3" ry="2.2" fill="#3f362c"/></svg>' +
    '<i class="eg-pebble"></i>' +
    sheet('a', 0, 0, 'rgba(120,214,198,0.1)', 'rgba(226,250,244,0.62)', 2.5) +
    sheet('b', 12, -8, 'rgba(22,104,108,0.62)', 'rgba(170,236,224,0.3)', 1.5) +
    sheet('c', -8, 10, 'rgba(9,58,68,0.92)', '', 0) +
    glints
      .map(
        ([x, y, t, d], i) =>
          `<i class="eg-glint${i > 3 ? ' is-sand' : ''}" style="left:${x}%;top:${y}%;animation-duration:${t}s;animation-delay:${d}s"></i>`,
      )
      .join('')
  )
}

// ---------------------------------------------------------------- Terrarium

/** A fern frond rooted at the bottom middle of a box 150 wide: a curved stem, leaflets down both sides. */
function frond(h: number, lean: number, c1: string, c2: string): string {
  const x0 = 75
  const y0 = h
  const cx = x0 + lean * 0.15
  const cy = y0 - h * 0.6
  const x1 = x0 + lean
  const y1 = 6
  const at = (t: number): [number, number, number] => {
    const u = 1 - t
    return [
      u * u * x0 + 2 * u * t * cx + t * t * x1,
      u * u * y0 + 2 * u * t * cy + t * t * y1,
      Math.atan2(2 * u * (cy - y0) + 2 * t * (y1 - cy), 2 * u * (cx - x0) + 2 * t * (x1 - cx)),
    ]
  }
  let s = ''
  const count = 15
  for (let i = 1; i <= count; i++) {
    const t = 0.16 + (0.84 * i) / (count + 0.6)
    const [x, y, a] = at(t)
    const len = h * 0.17 * Math.sin(Math.PI * (0.14 + 0.86 * (1 - t))) + 3
    for (const side of [-1, 1]) {
      const deg = ((a + side * 1.05) * 180) / Math.PI
      s +=
        `<ellipse cx="${n(len / 2)}" cy="0" rx="${n(len / 2)}" ry="${n(len * 0.15 + 0.8)}" fill="${side < 0 ? c1 : c2}" ` +
        `transform="translate(${n(x)} ${n(y)}) rotate(${n(deg)})"/>`
    }
  }
  const [ex, ey] = at(1)
  return `<path d="M${x0} ${y0}Q${n(cx)} ${n(cy)} ${n(ex)} ${n(ey)}" stroke="${c2}" stroke-width="2" fill="none" stroke-linecap="round"/>${s}`
}

function mushroom(x: number, y: number, s: number): string {
  return (
    `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-2" y="-9" width="4" height="10" rx="2" fill="#f1e3cc"/>` +
    '<path d="M-9-8a9 8 0 0 1 18 0z" fill="#ffb35c"/><circle cx="-3.5" cy="-11.5" r="1.2" fill="#ffe6c2"/>' +
    '<circle cx="3" cy="-10" r="1" fill="#ffe6c2"/></g>'
  )
}

export function terrariumGround(): string {
  // place, px from the bottom, height, lean, the two greens, sway, seconds, delay
  const ferns: [string, number, number, number, string, string, string, number, number][] = [
    ['left:-15px', 122, 236, -44, '#2f7a4d', '#25633f', 'a', 9, -2],
    ['left:47px', 118, 316, 20, '#479a63', '#357f50', 'b', 11, -6],
    ['left:107px', 124, 196, 46, '#2f7a4d', '#215a39', 'a', 8, -4],
    ['right:-27px', 0, 330, -40, '#2f7449', '#255c3a', 'b', 12, -1],
  ]
  // side, px in, top %, size
  const drops: [string, number, number, number][] = [
    ['left', 24, 42.2, 7],
    ['left', 210, 50.2, 5],
    ['left', 40, 70, 4],
    ['left', 222, 37.5, 4],
    ['right', 12, 31.2, 6],
  ]
  // left px, px from the bottom, seconds, delay
  const motes: [number, number, number, number][] = [
    [150, 200, 13, -2],
    [84, 200, 17, -9],
    [196, 240, 15, -5],
  ]
  return (
    '<i class="eg-shaft"></i><i class="eg-glass"></i>' +
    '<svg class="eg-glass-r" viewBox="1200 510 80 270"><path d="M1274 520c4 110-10 190-60 250" fill="none" stroke="rgba(230,255,235,0.08)" stroke-width="3" stroke-linecap="round"/></svg>' +
    ferns
      .map(
        ([side, bottom, h, lean, c1, c2, sway, t, d]) =>
          `<svg class="eg-fern is-${sway}" width="150" height="${h}" viewBox="0 0 150 ${h}" ` +
          `style="${side};bottom:${bottom}px;animation-duration:${t}s;animation-delay:${d}s">${frond(h, lean, c1, c2)}</svg>`,
      )
      .join('') +
    '<svg class="eg-moss" width="480" height="150" viewBox="-10 650 480 150">' +
    '<path d="M-10 668c40-12 96-14 150-10s96 6 150 30 110 50 170 72v40H-10z" fill="#0f2218"/>' +
    '<path d="M-10 750c50-16 110-18 160-8s110 18 190 36v32H-10z" fill="#132a1c"/>' +
    mushroom(204, 670, 1.5) +
    mushroom(226, 675, 1) +
    mushroom(24, 661, 1.1) +
    '</svg><svg class="eg-moss is-r" width="150" height="60" viewBox="1130 740 150 60"><path d="M1130 800c20-40 70-58 150-52v52z" fill="#0f2218"/></svg>' +
    '<i class="eg-shroomglow"></i>' +
    drops.map(([side, x, y, px]) => `<i class="eg-drop" style="${side}:${x}px;top:${y}%;width:${px}px;height:${Math.round(px * 1.25)}px"></i>`).join('') +
    '<i class="eg-drop is-running" style="left:206px;top:53.7%;width:6px;height:8px"></i>' +
    motes.map(([x, bottom, t, d]) => `<i class="eg-mote" style="left:${x}px;bottom:${bottom}px;animation-duration:${t}s;animation-delay:${d}s"></i>`).join('')
  )
}
