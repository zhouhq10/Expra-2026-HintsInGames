# Experiment

Web-based prototype for the Expra-2026 project **"Hints in Games"** (TU Darmstadt, Cognitive Science). Measures how different hint types affect performance on number-sequence puzzles.

## Structure

- **Frontend:** plain HTML/CSS/vanilla JS in `index.html`, `style.css`, `js/`. No build tools.
- **Backend:** small FastAPI server in `server.py`. Two jobs:
  1. Static-file serving (replaces `python -m http.server`).
  2. `/api/hint` — proxies requests to the Anthropic API. Keeps the API key server-side.
- **Hints are generated at runtime by Claude.** Each condition (`direct`, `strategy`, `reflective`) gets its own system prompt from `prompts.py`. After the first hint, the participant can ask follow-up questions — the LLM stays strictly in its assigned hint type.

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

The file `experiment/.env` contains your API key and is therefore listed in `.gitignore` — git ignores it automatically and it never lands on GitHub. **Don't try to force it in.** If you accidentally push a key: revoke it immediately at [console.anthropic.com](https://console.anthropic.com) and create a new one.

---

## Setup

```bash
cd experiment

# 1. Create a virtual Python environment
python -m venv .venv
source .venv/bin/activate          # macOS/Linux
# .venv\Scripts\activate            # Windows

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure the API key
cp .env.example .env
# edit .env and paste your key after ANTHROPIC_API_KEY=

# 4. Start the server
python server.py
```

Server runs on [http://localhost:8000](http://localhost:8000).

## URL parameters

- `?condition=direct|strategy|reflective|control` — selects the hint condition. If missing, a random condition is assigned (`condition_assigned=random` in the log).
- `?id=<some-string>` — overrides the randomly generated participant ID. Useful when the experimenter wants to pre-assign IDs.

Example: `http://localhost:8000/?condition=strategy&id=p_001`

## Phase flow

1. **Baseline** (5 trials, no hints) — measures baseline ability.
2. **Training** (10 trials, hints for the 3 hint conditions) — the lightbulb appears only here and only when not in `control`.
3. **Test** (5 trials, no hints) — measures learning transfer.

(Currently `data/sequences.json` only has 6 dummy sequences — real sequences will be added before the pilot.)

## CSV logging

At the end of the experiment, a CSV is downloaded via the browser:

```
experiment_<participant_id>_<condition>_<timestamp>.csv
```

Columns (one row per trial):

| Column                    | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `participant_id`          | from URL `?id=...` or randomly generated (`p_XXXXXX`) |
| `condition`               | `direct` / `strategy` / `reflective` / `control`     |
| `condition_assigned`      | `url`, `random`, or `manual`                         |
| `phase`                   | `baseline` / `training` / `test`                     |
| `trial_id`                | e.g. `train_03`                                      |
| `sequence`                | shown sequence as a string, e.g. `2,4,8,16,32`       |
| `correct_answer`          | expected solution                                    |
| `participant_answer`      | final input (empty on skip)                          |
| `is_correct`              | `true`/`false`                                       |
| `was_skipped`             | `true` if trial was skipped after 5 wrong attempts   |
| `is_bottleneck`           | `true` if this trial is the bottleneck task          |
| `solving_time_ms`         | from sequence display to final answer                |
| `num_attempts`            | number of submit clicks                              |
| `num_wrong_attempts`      | number of wrong submits                              |
| `hint_used`               | `true` if at least one hint was requested            |
| `hint_trigger`            | `manual` / `auto` / `none`                           |
| `time_to_first_hint_ms`   | time to first hint, or empty                         |
| `hint_count`              | number of hint requests in this trial (incl. follow-ups) |
| `hint_texts`              | all hints in this trial, separated by `\|\|`           |
| `llm_model`               | which Claude model generated the hints               |
| `timestamp`               | ISO string                                           |

## Architecture

```
Browser  ─POST /api/hint─►  server.py (FastAPI)  ─HTTPS─►  api.anthropic.com
                              │
                              .env  (ANTHROPIC_API_KEY — never visible in browser)
```

Key points:

- **API key stays server-side** in `.env`. The browser never sees it. `.env` is gitignored.
- **Server is stateless.** Conversation state (multi-turn history per trial) lives in the frontend and is sent along with every hint request.
- **System prompts** in `prompts.py` enforce that the LLM stays strictly in its assigned hint type — even when the participant asks "just give me the answer". This is methodologically critical for clean comparison data between conditions.

## Model choice

Default: `claude-haiku-4-5` (cheapest option, good for high pilot volumes). Override via `LLM_MODEL=` in `.env`:

- `claude-sonnet-4-6` — about 3x more expensive, stronger instruction following.
- `claude-opus-4-7` — about 5x more expensive than sonnet, in case hint constraints get violated during the pilot.

## Known limitations / TODOs

- Auto-trigger (hint after 60 s of inactivity or 2 wrong answers) not yet implemented (currently manual only).
- Concrete bottleneck sequence not yet designed (schema is ready via the `is_bottleneck` flag).
- Real sequences + final hint wording will be added before the internal pilot (May 17).
