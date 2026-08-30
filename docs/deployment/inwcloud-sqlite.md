# Deploy Questshop on inwcloud with SQLite

Questshop runs one Node.js 22.22 process with one persistent database.

Required environment values:

```text
SQLITE_PATH=/data/questshop.db
QUESTSHOP_SECRET_KEY=<one permanent secret, at least 32 characters>
VOUCHER_HMAC_ACTIVE_VERSION=v1
CREDENTIAL_ENCRYPTION_ACTIVE_VERSION=v1
CREDENTIAL_ENCRYPTION_ALLOWED_VERSIONS=v1
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

Before choosing the candidate SHA, run under Node `22.22.x`:

```bash
npm run check && npm run check:imports && npm run lint && npm test
npm run test:coverage && npm run load:test
npm audit --audit-level=high
git diff --check
docker build --build-arg GIT_SHA="$GIT_SHA" -t questshop:local .
```

The Docker evidence is valid only after a successful build and a check that
`/app/.source-sha` equals the exact candidate SHA. If a workstation has no
Docker daemon, record `NOT_RUN_LOCAL: DOCKER_DAEMON_UNAVAILABLE`; do not edit
the Dockerfile on that fact alone. GitHub Actions performs the build without
pushing or deploying an image.
