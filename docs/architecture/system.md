# Questshop system architecture

```text
Discord interactions → SQLite domain services → /data/questshop.db
                                      ↓
                         Jobs + Notifications workers
                                      ↓
                   Discord / TrueMoney / Quest APIs
```

The Runtime is single-instance. Domain services own short SQLite transactions; workers persist external intent before
an external mutation and do not hold a database transaction across network I/O. Notifications edit one Discord message
per aggregate/destination using desired/delivered versions.
