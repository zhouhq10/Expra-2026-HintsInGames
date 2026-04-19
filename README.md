# Expra 2026 - Hints in Games

## Project goal

**Helping without over-helping: Effects of hint style on performance, learning, and agency in a game-based problem-solving task.**

### Research question
Which type of hint best helps participants solve a game-like problem while still preserving their sense of agency?

### Hint conditions
- **Direct hint** - tells the player what to do
- **Strategy hint** - explains the relevant principle
- **Reflective hint** - prompts the player to think without giving the answer

### Dependent variables
Primary: task success, time to solve.
Secondary: moves/errors, hint usefulness rating, agency rating, transfer to a new puzzle without hints.

### Hypotheses
- Direct hints improve immediate performance most.
- Strategy/reflective hints improve later transfer more than direct hints.
- Direct hints reduce subjective agency more than less explicit hints.

### Bonus
- When and how should we provide the hint? The timing, and the communication way.
- How to use LLMs as a real-time tutor/team/collaborator in the game?

---

## Scope and design principles

- **One simple web-based task** (likely a small grid-based puzzle). See `experiment/README.md`.
- Start from **prewritten hints**, extend to live LLM generation if possible. The hardest scientific work is making hint types cleanly different.

---

## Deliverables (course)

- Individual lab report - **70%**
- Group poster presentation - **30%**
- Participation in other groups' experiments

---

## Expectations

- **Weekly 1-hour meeting** with the supervisor.
- **~3–5 hours/week** outside the meeting on average (more during build/pilot).
- Every meeting ends with: decisions made, tasks assigned.
- Hanqi will try to keep the **weekly decision log** in `meeting-notes/`.

---

## Timeline

See [`timeline.md`](./timeline.md) for the full week-by-week plan (readings, pre-meeting tasks, discussion prompts, deliverables).

Key dates:
- **May 3** - design frozen
- **May 10** - prototype working
- **May 24** - external pilot done
- **May 31** - final study version locked + analysis plan + pilot
- **Jun 1–14** - data collection (2-week; need to discuss if we can use Prolific)
- **Jun 15–28** - modeling + analysis
- **Jul 5** - analyses, figures, and model results done
- **Jul 12** - full poster draft
- **Jul 17** - poster day

---

## Repository structure

```
.
├── README.md              # this file - project overview + syllabus
├── timeline.md            # week-by-week plan and milestones
├── meeting-notes/         # one file per weekly meeting (YYYY-MM-DD.md)
├── materials/
│   ├── papers/            # background reading
│   └── hints/             # prewritten hint sets per condition
├── experiment/            # web task code
│   └── stimuli/           # game logic definitions (e.g., puzzels)
├── analysis/              # scripts and notebooks
│   └── data/              # raw and cleaned data
└── poster/                # drafts, figures, final poster
```