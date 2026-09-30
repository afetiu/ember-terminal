# Code signing policy

**Ember's releases are not code signed yet.** Windows SmartScreen may warn the first time
you run the installer: choose "More info", then "Run anyway". Ember installs for your user
only and never asks for admin rights.

## How to check a download

Every Windows release on this repository's
[Releases](https://github.com/afetiu/ember-terminal/releases) page, and linked from
https://ember.deepanswerlabs.com, is built from this repository's source by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)). Nothing built on a
personal machine is published. Each release carries `SHA256SUMS.txt`; compare it with

```powershell
Get-FileHash .\Ember-Setup-win-x64.exe -Algorithm SHA256
```

The release workflow is ready to sign through a code-signing service once one is in place;
this page will say so when releases are signed.

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
