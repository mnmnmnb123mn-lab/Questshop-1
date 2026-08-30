# UAT evidence template

- Git SHA: `<40-character SHA>`
- Node version: `22.22.x`
- SQLite path: `/data/questshop.db` (do not paste its contents)
- Date / Owner / environment:

| Check | Result | Safe evidence |
| --- | --- | --- |
| Startup and single-instance lock | | timestamp / masked log |
| Restart and redeploy persistence | | Wallet/Job IDs only |
| Backup and restore integrity | | backup filename / check result |
| Discord surfaces and media | | screenshot |
| Top-up success/duplicate/review/DM retry | | Top-up IDs only |
| Quest/Monitor/Order flow | | Order/Item IDs only |

Never record token, voucher URL, receiver phone, database contents or `QUESTSHOP_SECRET_KEY`.
