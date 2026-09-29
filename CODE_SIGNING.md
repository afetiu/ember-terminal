# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What is signed

Every Windows release of Ember published on this repository's
[Releases](https://github.com/afetiu/ember-terminal/releases) page and linked from
https://ember.deepanswerlabs.com:

- `Ember.exe`, inside the installer and the portable `.zip` / `.tar.gz`
- `Ember-Setup-win-x64.exe`, the installer

Binaries are built from this repository's source by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) and submitted to
SignPath from that build; nothing built on a personal machine is signed. The artifact
configurations are in [`.signpath/`](.signpath). Third-party binaries that ship with the
app (Electron's runtime, ConPTY) are left as their authors published them.

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [@afetiu](https://github.com/afetiu) |
| Approvers | [@afetiu](https://github.com/afetiu) |

Changes from anyone outside this list arrive as pull requests and are reviewed by a
committer before merge. Every signing request is approved by hand.

## Privacy policy

This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it.

Ember has no telemetry and no account. It talks to the network only through features you
turn on or use: the agent CLI you run in it (which talks to its own provider, as it would
in any terminal), the plan-usage readout for Claude Code (off by default; Settings ›
Agent), the architecture map's change checks for the repos and URLs you add to a map, and
the experimental phone link (Settings › Labs, off by default).
