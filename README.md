# Lab 5 Starter: reservation-service

`reservation-service` is a TypeScript module for booking rooms. Callers register rooms,
create and cancel bookings, price them, query free slots, and pull occupancy and revenue
reports. It ships with about 750 lines under `src/`, a green test suite, and CI.

Same domain as Lab 3, different codebase.

The lab is mostly reading and writing. You make ONE small fix, and it has to keep the
suite green without editing any test.

**Read the code, then fill in `SMELLS.md`.**

## Build and test

```
npm install
npm test
npm run typecheck
```

Everything is green before you touch anything. If it is not, see `SETUP.md`.

## Continuous integration

CI is configured (`.github/workflows/ci.yml`). Every push runs `npm ci`, `npm run typecheck`,
and `npm test`, once you enable workflows on your fork from the Actions tab.

## Where things are

- Source: `src/`
  - `reservationManager.ts`, `reportGenerator.ts`, `availability.ts`, `validation.ts`, `types.ts`
  - `src/notifications/`, `src/storage/`, `src/cache/`
- Tests: `tests/`
- Your writeup: `SMELLS.md`
- Setup: `SETUP.md`

See the Lab 5 handout on the course page for the three milestones you show a TA.

## AI tools used

- Tool: Claude Code (Anthropic's CLI coding agent)
- Model: Claude Opus 5.5 (`claude-opus-5-5`)
