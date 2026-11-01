#!/usr/bin/env node
/**
 * Fill the APK's web bundle from the Ember site: the phone app (site/app) and the
 * libraries its object frames load (site/vendor). Copied, never forked — the APK and
 * ember.deepanswerlabs.com/app/ are the same app. See docs/specs/phone.md.
 *
 *   node sync.mjs && npx cap sync android
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const site = join(here, '..', 'site')
const www = join(here, 'www')
rmSync(www, { recursive: true, force: true })
mkdirSync(www, { recursive: true })
cpSync(join(site, 'app'), join(www, 'app'), { recursive: true, filter: (p) => !/[\/]app[\/]dev([\/]|$)/.test(p) })
cpSync(join(site, 'vendor'), join(www, 'vendor'), { recursive: true })
// The app itself is the start page. Capacitor answers any path that is not a file (like
// /app/) with index.html, so a redirect to /app/ would loop forever on a black screen.
cpSync(join(site, 'app', 'index.html'), join(www, 'index.html'))
console.log('  site/app + site/vendor -> www')
