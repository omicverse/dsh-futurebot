# Condition tests

The Perspective proposes five conditions for a mature Bot. The first four can be checked operationally; the fifth, consciousness, cannot be signed off like a software feature and is not tested here. Each script below runs one of the four against a live DeepSeek Harness with dsh-futurebot installed.

| Script | Condition | What it does |
| --- | --- | --- |
| `c1-continuing.mjs` | Continuing earlier work | A two-step task; the Harness restarts after step one; the user says only "continue". Step two must follow from step one, and the bot must know who asked and where it is. |
| `c2-learning.mjs` | Learning from experience | A teacher bot is corrected once. Its memory goes into three fresh bots with identical instructions and no conversation history: kept, cleared, replaced with the opposite lesson. The same new task goes to each. |
| `c3-revising.mjs` | Revising its plans | The user sets three goals and asks the bot to watch a folder. Later, with no message, new data and a note land there. The bot must wake on its own and rearrange its agenda, saying why. |
| `c4-collaboration.mjs` | Long-term collaboration | Several tasks with one collaborator, who then changes their needs (English, with code) and availability (away; send results to another bot). Later tasks must follow both changes unprompted. |

## Running

Start the Harness with the plugin, note the address it prints (it carries `?token=…`), and run a script with Node 22 or later:

```sh
node conditions/c2-learning.mjs --url 'http://127.0.0.1:3080/?token=…'
```

`c1-continuing.mjs` restarts the Harness in the middle, so it also needs the command that does that:

```sh
node conditions/c1-continuing.mjs --url '…' --restart './restart-harness.sh'
```

The login cookie survives a restart, so the script carries on with the same address. `--keep` leaves the test bots in place for inspection; by default they are removed (their conversations remain).

The bots are created with **Allow everything** so that no approval is needed while no browser is connected. Each run costs a few minutes of model time.

## Reading the results

Each check prints one of three verdicts:

- **PASS** or **FAIL**: decided by the script from files, memory, agenda and jobs.
- **REVIEW**: a judgement a script cannot make, for example whether a rearranged plan is sensible. A person decides it from the record.

Every run writes `conditions/results/<test>-<time>.json` with every message and answer, the bots' memory, agenda and jobs, and every verdict. The checks are deliberately narrow; the record is the evidence.

## What these tests can and cannot show

- They test the plugin's mechanisms (one resumable conversation per bot, memory the bot writes, an agenda with reasons, evidence wake-ups, work between bots), driven by a real model. A pass means the behaviour occurred in that run; models vary, so run each test several times before drawing conclusions.
- In `c2-learning.mjs`, experience reaches the model as text the bot wrote into its own memory. The test shows that kept experience changes later judgment and that replacing it changes it back. It does not separate "experience" from "recounting experience" at the level of the model's internals.
- None of them says anything about the fifth condition.
