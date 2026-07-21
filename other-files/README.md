# other-files/ - landed history

This directory is the archive of June's completed improvement rounds and findings.
It is **history**, not the current plan.

## Where the current plan lives

The authoritative, still-in-progress round doc is the **highest-numbered
`improvement-N.md` at the repo root** (alongside `bugs1.md`, `PLAN.md`,
`README.md`). Everything in this directory is landed history.

## What's here

- `improvement-1.md` .. `improvement-6.md` (+ their `.html` renders) - the first
  six improvement rounds, all landed.
- `findings/` - per-round findings notes (`findings-N.md`), migrated here from the
  directory root.

## Rules of thumb

- **Reading for what to do next?** Open the highest-numbered `improvement-N.md` at
  the repo root, not anything in here.
- **Reading for why something was done?** The round docs here are the record; each
  round's `## Phase` items carry inline `DONE` notes with the deviations.
- Trust `git log` over any status header in `PLAN.md` or `README.md` (both are
  stale by design - see the note in `PLAN.md`).
