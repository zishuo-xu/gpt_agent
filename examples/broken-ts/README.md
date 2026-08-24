# Broken TypeScript demo workspace

This fixture intentionally contains one defect: `src/math.ts` subtracts in
`add()`, while the Node built-in test expects a sum. It has no third-party
runtime or test dependency. Node 22.6+ can execute the `.ts` files using its
lightweight type stripping; the project's supported Node version is 22+.

The demo runner copies this directory to a fresh temporary workspace before
starting MyAgent. The files in this example are never modified by the demo.

Manual check (from this directory):

```bash
node --test tests/*.test.ts # expected: fail
```
