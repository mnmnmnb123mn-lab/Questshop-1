# Emergency runbooks

Every incident follows:

```text
Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Review
```

| Incident | Immediate containment | Recovery authority |
|---|---|---|
| Ambiguous TrueMoney | preserve attempt/receiver/voucher evidence; no blind retry | Owner checks provider evidence, then Credit or Reject |
| Duplicate credit / ledger mismatch | stop affected intake through scoped incident control; never edit ledger | Owner uses compensating transaction after invariant audit |
| Database outage | mark Not Ready; stop dequeue/financial actions | restore connectivity, recover leases, verify ledger/checkpoints |
| Queue stuck / lease storm | stop affected dispatch; preserve jobs/leases | recover stale leases with fencing, verify, reopen scoped control |
| Financial DLQ | keep evidence/reservation; never discard | Owner replays with parent reference |
| Non-financial DLQ | preserve delivery evidence | Owner replay/discard with reason/audit |
| Quest schema/executor failure | pause affected Quest | pin compatible engine/contract, retest, reopen sale |
| Customer-discovered Quest | keep it private; preserve the discovery record | Admin chooses **ทดสอบก่อน** or audited **ส่งประกาศ** from `LOG_QUEST_OPERATIONS`; never identify the customer in `quest-new` |
| Monitor token invalid | quarantine account | Owner rotates credential and runs **เช็คระบบ Token** |
| Discord surface 403 | preserve authoritative pointer/outbox/incident | Owner fixes Discord permission manually |
| Discord outage / 429 | retain outbox; obey Retry-After | resume coalesced delivery after health recovery |
| Discord interaction timeout | preserve Support code and Git SHA | restart the current flow; never replay uncertain money action blindly |
| Quest Auto stale price | keep current anchor; do not create a second panel | verify active `TYPE` prices; allow Maintenance reconciliation or rerun `/quest-auto` |
| Quest Auto missing/old media | keep current anchor | verify source `quest-auto-demo.gif` and the remote attachment URL/size, then rerun `/quest-auto` or allow reconciliation |
| Quest Auto media integrity failure | do not bypass hash/size check | restore exact approved GIF in deployed source and redeploy |
| Quest Auto still shows standalone MP4/footer | keep current anchor | deploy current GIF-layout SHA, rerun `/quest-auto` or allow reconciliation |
| Aiven recovery | keep store closed; preserve ledger/incident evidence | Owner recovers through Aiven Console and reconciles before reopening |
| Secret compromise | contain affected integration | rotate provider/key version and verify scoped recovery |
| Deploy rollback | maintenance/drain as required | roll app only when schema compatible, otherwise forward-fix |
| Full voucher link exposure | Owner restricts channel and preserves audit | review viewers/access; no automated privacy guard exists |
| Worker crash during mutation | stop stale fencing owner | verify durable checkpoint/provider state before retry |
| Pre-launch closeout | keep store closed | compensate real financial tests; retain audit |
| Receiver rotation | retain old snapshot for pending work | new work uses active receiver version; a first install without a receiver remains backoffice-accessible but cannot accept vouchers |
| Customer leaves Guild with an active order | preserve Order, Wallet, reservation and Runner state; never cancel automatically | continue durable work; final DM is best-effort only and a failed DM is not a settlement failure |

## Quest Auto recovery details

### Expected source asset

```text
src/discord/assets/quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1
```

If `Bundled Quest Auto GIF failed integrity verification` appears:

1. confirm the deployed Git SHA is the intended revision;
2. confirm the file exists at the exact path above;
3. verify the file was not truncated/replaced by a manual upload step;
4. redeploy the correct source;
5. do **not** remove the integrity check just to make startup/surface refresh pass.

### Stale price

The storefront reads active supported `TYPE` price rules. If the visible price is stale:

1. confirm all four supported task types have one active TYPE rule;
2. confirm `QUEST_AUTO` surface is ACTIVE and its Discord message still exists;
3. allow the Maintenance worker one cycle (approximately 60 seconds);
4. if needed, Owner reruns `/quest-auto` to force setup/update of the same anchor;
5. verify the same Discord message ID remains active and no duplicate panel was created.

### Stale/legacy media or layout

The current layout requires one attachment named `quest-auto-demo.gif`, referenced by the embed as
`attachment://quest-auto-demo.gif`. The animation should appear inside the Rich Embed. If the message still contains
`videoplayback.mp4`, `quest-auto-demo.mp4`, multiple media attachments, or the visible
`Questshop Surface • QUEST_AUTO` footer, reconciliation/setup should clear the stale attachment set, attach the GIF and
rewrite the embed on the **same durable message**.

Quest Auto recovery uses the stable surface nonce as the primary invisible-anchor marker. The old footer lookup remains
only so older messages can be migrated without creating a duplicate panel.

Runtime preserves the existing GIF only when it has the approved filename, exact byte size and the embed image points
to that attachment's current Discord CDN/proxy URL. Any other attachment/image combination is refreshed. If the Owner
intentionally changes GIF bytes in a future release, version/change the filename or add an explicit attachment migration.

## Mandatory execution template

1. **Detect:** confirm the alert/state and capture short Support/correlation code.
2. **Contain:** use the scoped incident/surface action only.
3. **Preserve evidence:** record immutable IDs, attempts, fences and hashes; never raw secrets.
4. **Recover:** follow the relevant row above; never edit historical money evidence or blindly retry an uncertain mutation.
5. **Verify:** check domain invariants, Outbox/Review state and Discord projection/surface.
6. **Reopen:** Owner records approval, reason and exact Git SHA for the affected control.
7. **Review:** document cause, blast radius, SLO impact and a regression test.

## Special decision rules

- A possibly-sent TrueMoney or Quest mutation is verified before retry.
- A successful TrueMoney redemption over the configured maximum is credited in full, recorded as an operational warning
  and locks further vouchers until the Bangkok-day boundary. It is not an automatic manual-review hold.
- A proven Runner completion with durable provenance captures the reservation; contradictory/missing provenance remains Reserved for Review.
- Monitor evidence is valid only for the exact execution-contract fingerprint.
- Financial/Audit DLQ can be replayed but never discarded.
- Bot Administrator is validated at startup; backoffice human visibility is Owner-managed and has no automated privacy preflight.
- Aiven-managed mode does not create Questshop S3 backup artifacts or a local restore-drill claim.
- A Quest Auto presentation repair may edit/recover Discord surface content/media but must not mutate Wallet/Ledger/Payment/Order state.
