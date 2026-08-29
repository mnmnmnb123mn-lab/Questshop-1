# Deploy Questshop on inwcloud with SQLite

Questshop runs one Node.js 22.22 process with one persistent database.

Required environment values:

```text
SQLITE_PATH=/data/questshop.db
QUESTSHOP_SECRET_KEY=<one permanent secret, at least 32 characters>
GIT_SHA=<exact 40-character source SHA>
DISCORD_BOT_TOKEN=<secret>
DISCORD_CLIENT_ID=<application id>
DISCORD_GUILD_ID=<guild id>
OWNER_ID=<owner id>
STATUS_TOKEN=<secret>
```

Mount `/data` as persistent storage, keep the deployment at one instance, and
run the existing command:

```bash
npm ci --omit=dev && npm run deploy && npm start
```

`deploy` verifies configuration, creates an online pre-migration SQLite backup,
applies the atomic schema migration, verifies integrity and registers commands.
It does not prove Discord or TrueMoney behaviour. Do not enable financial gates
until the exact `GIT_SHA` completes the PRELAUNCH UAT.
