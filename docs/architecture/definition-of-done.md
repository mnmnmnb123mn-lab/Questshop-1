# Definition of done

Source work is complete only when Node 22.22.x runs `npm run check`, `npm run check:imports`, `npm run lint`, `npm test`,
coverage at least 70% for Lines/Branches/Functions/Statements, `npm run load:test`, dependency audit, diff check and a
Docker build using an exact 40-character `GIT_SHA`. Fresh SQLite migration/WAL/FULL/FK, append-only triggers, file
modes, backup/restore and single-instance lock must be covered by that evidence. The release label remains
**implemented-but-unverified** until a single Git SHA passes persistent `/data`, restart, redeploy, backup restore,
Discord desktop/mobile, TrueMoney, Quest Engine and Owner UAT.
