# Experiment

Web-based experimental task. Runs in the browser; logs trial data for later analysis.

---

## Hints

Hints for each puzzle × condition are stored in `../materials/hints/`. Three conditions:
- **direct** - tells the player what to do
- **strategy** - explains the relevant principle
- **reflective** - prompts the player to think without giving the answer

---

## Contents

- `stimuli/` - puzzle definitions (one file per puzzle)
- (to be added) task code, instructions, logging

---

## Logging

At minimum, per trial: participant ID, condition, puzzle ID, success, time to solve, every action with timestamp, hint requests, hint usefulness rating, agency rating.
