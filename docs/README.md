# Experiment

Web-based prototype for the Expra-2026 project **"Hints in Games"** (TU Darmstadt, Cognitive Science). Measures how different hint types affect performance on number-sequence puzzles.

## Structure

- **Frontend:** plain HTML/CSS/vanilla JS in `index.html`, `style.css`, `js/`. No build tools.
- **Backend:** small FastAPI server in `server.py`. Two jobs:
  1. Static-file serving (replaces `python -m http.server`).
  2. `/api/hint` — proxies requests to the OpenAI API (GPT). Keeps the API key server-side.
- **Hints are generated at runtime by GPT.** Each condition (`direct`, `strategy`, `reflective`) gets its own system prompt from `prompts.py`. After the first hint, the participant can ask follow-up questions — the LLM stays strictly in its assigned hint type. The LLM is *told* the correct answer and rule, so it never has to work them out itself.
- **Each task has a 2:30 time limit** with a visible countdown. When it runs out, the next task is shown automatically.
- **Scoring:** a correct answer is worth 100 points plus a time bonus (`max(0, 150 − seconds taken)`), so faster answers score higher (max 250 per task). Unsolved tasks score 0.
- **Results are saved automatically on the host computer** at the end (folder `docs/data/results/`), even when a friend plays over the local network. A manual download button is also available as a backup.

## Git / GitHub for beginners

If you've never used GitHub before, here's the minimum you need to contribute. All commands run in the terminal (macOS: `Terminal.app`, Windows: `Git Bash`, Linux: your normal terminal).

### What is what?

- **Git**: the version-control tool that runs on your machine. Stores the history of your changes locally.
- **GitHub**: the online service that hosts our repository. Keeps your local repo in sync with the rest of the team's.

### One-time setup (per machine)

```bash
git --version
```
Checks whether git is installed. Something like `git version 2.x.x` means you're good. If you get `command not found`: on macOS run `xcode-select --install` once; on Windows install from [git-scm.com](https://git-scm.com).

```bash
git config --global user.name "First Last"
git config --global user.email "your.mail@stud.tu-darmstadt.de"
```
Sets your name and email for git. Shows up on every commit so people can see who changed what. Only do this once per machine.

### Cloning the project

"Cloning" = downloading the whole repo (with full history) from GitHub onto your machine.

```bash
cd ~/Documents
```
Switches to the folder where you want the project to live. Adjust the path to wherever you work.

```bash
git clone https://github.com/<owner>/Expra-2026-HintsInGames.git
```
Downloads the repo and creates a folder called `Expra-2026-HintsInGames`. You'll find the HTTPS URL on the GitHub page of the repo, under the green **"Code"** button.

```bash
cd Expra-2026-HintsInGames
```
Switches into the freshly created project folder. From here you can follow the regular Setup section below.

### Daily workflow

**Before** you start working — pull the latest changes from the server:

```bash
git pull
```
Fetches all commits other people pushed in the meantime and merges them into your local copy. Always do this before you start working — otherwise you'll have conflicts later.

**While** you work — see what you've changed:

```bash
git status
```
Lists files you've modified since the last commit (red = not yet staged, green = already staged for commit).

```bash
git diff
```
Shows line-by-line **what** has changed in each modified file (plus signs for added lines, minus signs for removed ones).

**When** you're done — save and share your changes:

```bash
git add <filename>
```
Stages a specific file for the next commit. Instead of a single name, `git add .` stages **all** modified files at once.

```bash
git commit -m "feat: short description of what you did"
```
Saves all staged changes as a "commit" locally. The message in `-m "..."` should describe what changed.

```bash
git push
```
Sends all your local commits up to GitHub so the others can see them.

### When something goes wrong

| Error message | What to do |
|---|---|
| `Your branch is behind` | Run `git pull` first, then push again. |
| `rejected — non-fast-forward` | Someone else pushed in the meantime. Run `git pull --rebase`, then `git push`. |
| `Merge conflict in <file>` | Open the file in your editor, search for `<<<<<<<` and `>>>>>>>`, manually decide which version is right, then `git add <file>` and `git commit`. |
| `Permission denied` on push | Personal Access Token missing — see next section. |

### Push authentication (Personal Access Token)

GitHub no longer accepts your regular password for pushes. You need a **Personal Access Token (PAT)**, set up once:

1. On github.com → top-right profile picture → **Settings**
2. Scroll down on the left → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
3. Top-right **Generate new token (classic)**
4. Note: e.g. "Expra repo Mac", expiration: 90 days or longer, scopes: tick **only `repo`**
5. **Copy the token** — it's shown only once!

On your first `git push`, the terminal will ask for a username (= your GitHub username) and password (= the token, NOT your GitHub password). macOS stores it in the Keychain afterwards so you only enter it once.

### Commit style

We use **Conventional Commits** — every commit message starts with a prefix:

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructuring without behavior change
- `docs:` — documentation change
- `chore:` — housekeeping (dependencies, configs, etc.)

Example: `git commit -m "fix: lightbulb was clickable in baseline phase"`

### What you should NOT push

The file `docs/.env` contains your API key and is therefore listed in `.gitignore` — git ignores it automatically and it never lands on GitHub. **Don't try to force it in.** If you accidentally push a key: revoke it immediately at [platform.openai.com](https://platform.openai.com/api-keys) and create a new one.

---

## Setup (step by step, for first-timers)

You only do steps 1–4 **once** per computer. After that, starting the experiment
is just step 5. Every command goes into the **terminal** (macOS: open
`Terminal.app`; Windows: open `Git Bash` or `PowerShell`).

**0. Install Python (once).** Type `python3 --version` (macOS/Linux) or
`python --version` (Windows). If you see something like `Python 3.11.x`, you're
fine. If you get an error, install Python 3 from
[python.org/downloads](https://www.python.org/downloads/) and tick
**"Add Python to PATH"** during the Windows installer.

**1. Go into the `docs/` folder.** From the project folder you cloned:

```bash
cd docs
```

**2. Create a virtual Python environment (once).** This keeps the project's
packages separate from the rest of your system:

```bash
python3 -m venv .venv         # macOS/Linux   (use "python" on Windows)
source .venv/bin/activate     # macOS/Linux
# .venv\Scripts\activate      # Windows (run this line instead)
```

After this your terminal line starts with `(.venv)`. That means it worked.
You need to run the `activate` line again every time you open a new terminal.

**3. Install the dependencies (once):**

```bash
pip install -r requirements.txt
```

**4. Add your Claude API key (once):**

```bash
cp .env.example .env          # macOS/Linux
# copy .env.example .env      # Windows
```

Then open the new `.env` file in a text editor and paste your key after
`OPENAI_API_KEY=`. You get a key at
[platform.openai.com/api-keys](https://platform.openai.com/api-keys) (or your
university account if a shared key has been provided). Without a valid key the
page still loads, but the hint lightbulb won't return any hints.
**Never share or commit this file** — it's gitignored on purpose.

**5. Start the experiment:**

```bash
python server.py
```

Leave this terminal window open — the server runs as long as it stays open.
Press `Ctrl+C` to stop it.

## Running & testing it

When the server starts, it prints two web addresses:

```
  Local:   http://localhost:8000
  Network: http://192.168.x.x:8000   (share this with testers on the same Wi-Fi)
```

**To test it yourself:** open **http://localhost:8000** in your browser (Chrome,
Firefox, Safari, …) on the same computer that runs the server.

**To let a friend test it:** make sure their device (laptop/phone) is on the
**same Wi-Fi** as your computer, then send them the **Network** address
(`http://192.168.x.x:8000`). They open it in their browser and play the
experiment. **The results CSV is saved on *your* computer** (in
`docs/data/results/`), not on theirs — so you always get the data back.

> The first time you start the server, macOS/Windows may pop up a firewall
> dialog asking whether to allow incoming connections. Click **Allow**, otherwise
> friends on the Wi-Fi can't reach the page. Only run this on a network you
> trust — there is no password protection.

**Fast test mode:** add `?timelimit=40` to the URL to shorten the per-task limit
from 2:30 to 40 seconds, so you can click through a full run quickly to check
that everything works. Example:
`http://localhost:8000/?timelimit=40&condition=direct`

If you ever change a file and the browser still shows the old version, do a
**hard reload**: `Cmd+Shift+R` (macOS) or `Ctrl+Shift+R` (Windows).

## URL parameters

- `?condition=direct|strategy|reflective|control` — selects the hint condition. If missing, a random condition is assigned (`condition_assigned=random` in the log).
- `?id=<some-string>` — overrides the randomly generated participant ID. Useful when the experimenter wants to pre-assign IDs.
- `?timelimit=<seconds>` — overrides the 2:30 (150 s) per-task limit. Mainly for fast testing, e.g. `?timelimit=40`.

You can combine them: `http://localhost:8000/?condition=strategy&id=p_001&timelimit=40`

## Phase flow

Three phases, **25 tasks** total (the lightbulb appears only in **training**, and only when the condition is not `control`):

1. **Baseline** (8 tasks, no hints) — measures ability before any help.
2. **Training** (9 tasks, hints available for the 3 hint conditions).
3. **Test** (8 tasks, no hints) — the **same 8 sequences as baseline**, to measure how much improved.

Every task has a 2:30 countdown; running out of time moves on to the next task and scores 0 for that task.

## Where the data goes

When a participant finishes, the CSV is **automatically saved on the computer
running the server** (the host), in:

```
docs/data/results/experiment_<participant_id>_<condition>_<timestamp>.csv
```

This works even when the participant played over the local network from another
device. The end screen also has a **"Download data"** button that saves a copy in
the participant's own browser — that's just a backup. (`docs/data/results/`
is gitignored, so participant data never lands in the repo.)

Each CSV has one row per task, followed by a short `SUMMARY` block (totals and
averages, including average solving time per task overall and per phase).

Columns (one row per task):

| Column                    | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `participant_id`          | from URL `?id=...` or randomly generated (`p_XXXXXX`) |
| `condition`               | `direct` / `strategy` / `reflective` / `control`     |
| `condition_assigned`      | `url`, `random`, or `manual`                         |
| `phase`                   | `baseline` / `training` / `test`                     |
| `trial_id`                | e.g. `train_03`                                      |
| `sequence`                | shown sequence incl. the `?`, e.g. `2,4,8,16,32,?`   |
| `correct_answer`          | expected solution                                    |
| `participant_answer`      | final / last input (empty if never answered)         |
| `is_correct`              | `true`/`false`                                       |
| `was_skipped`             | always `false` (skipping was removed)                |
| `timed_out`               | `true` if the 2:30 limit ran out before a correct answer |
| `is_bottleneck`           | `true` if this task is the bottleneck task           |
| `solving_time_ms`         | from task display to final answer (capped at the time limit) |
| `num_attempts`            | number of submit clicks                              |
| `num_wrong_attempts`      | number of wrong submits                              |
| `points_completion`       | 100 if solved, else 0                                |
| `points_time_bonus`       | `max(0, 150 − seconds taken)` if solved, else 0      |
| `points_total`            | `points_completion + points_time_bonus`              |
| `hint_used`               | `true` if at least one hint was requested            |
| `hint_trigger`            | `manual` / `auto` / `none`                           |
| `time_to_first_hint_ms`   | time to first hint, or empty                         |
| `hint_count`              | number of hint requests in this task (incl. follow-ups) |
| `hint_texts`              | all hints in this task, separated by `\|\|`            |
| `llm_model`               | which Claude model generated the hints               |
| `timestamp`               | ISO string                                           |

## Architecture

```
Browser  ─POST /api/hint────►  server.py (FastAPI)  ─HTTPS─►  api.openai.com
         ─POST /api/results─►       │
                                    ├─ .env                  (OPENAI_API_KEY — never visible in browser)
                                    └─ data/results/*.csv    (results saved on the host)
```

Key points:

- **API key stays server-side** in `.env`. The browser never sees it. `.env` is gitignored.
- **Server is stateless** for hints. Conversation state (multi-turn history per trial) lives in the frontend and is sent along with every hint request.
- **Results are written by the server** (`POST /api/results`) to `data/results/` so the data ends up on the host even when a participant plays over the local network.
- **System prompts** in `prompts.py` enforce that the LLM stays strictly in its assigned hint type — even when the participant asks "just give me the answer". This is methodologically critical for clean comparison data between conditions.

## Model choice

Default: `gpt-4o-mini` (cheap and fast, good for high pilot volumes). Override via `LLM_MODEL=` in `.env`:

- `gpt-4o` — about 10x more expensive, noticeably stronger instruction following.
- `gpt-5-mini` — modern, mid-range pricing, often stricter on the "never reveal the answer" rule.

## Known limitations / TODOs

- Auto-trigger (hint after 60 s of inactivity or 2 wrong answers) not yet implemented (currently manual only).
- Concrete bottleneck sequence not yet designed (schema is ready via the `is_bottleneck` flag).
- The network mode has **no authentication** — only run it on a trusted Wi-Fi.
- Hint wording in `prompts.py` may still be tuned before the pilot.
