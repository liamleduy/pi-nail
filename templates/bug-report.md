---
description: Fixing a bug. Repro, expected vs actual, suspected area, root-cause-first.
---
# Bug
<one-line symptom>

# Repro
1. <steps / command>

# Expected vs actual
- Expected: <...>
- Actual: <... include exact error text>

# Where to look
- <files/functions, recent changes>

# Constraints
- Find the root cause before editing; fix it where all callers route through, not just the reported path.
- Add or update a test that fails before the fix.

# Done when
- Repro no longer fails; tests pass: <command>
