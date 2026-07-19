# I04 Evidence

Authoritative proof:

- `responsive-real-surface/` — all four fixtures plus interaction/empty/disabled/error states, captured after the real Main compositor was enlarged above 200×200.
- `live-wide/` — real AE Main viewport 250×81, horizontal.
- `live-tall/` — real AE Main viewport 132×200, vertical.
- `inspect/` — first successful I04 exact-target identity/assets/debug contract run.
- `surface-guard/` — expected failure proving fixture capture rejects real compositor surfaces smaller than 200×200.

Preserved failed attempts:

- `responsive/main/failure.json` records a transient CDP evaluation timeout.
- The first `responsive/` square screenshots exposed a CEP compositor-capture limitation: when the real surface was shorter than the 200 px fixture, Chrome repeated the lower surface edge. Those files are not visual proof of product behavior.

The authoritative geometry report is `responsive-real-surface/main/report.json`. Main was restored to its original 254×127 outer window size after each real-window test.
