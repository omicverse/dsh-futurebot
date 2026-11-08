# dsh-futurebot

Bots for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A bot is a persistent AI individual. It has a name, standing instructions from you, its own workspace, and its own conversation, which continues across days and tasks. It keeps a memory that only it writes, pursues an agenda it can revise, hands work to other bots and picks up their answers, and works in groups toward goals.

This plugin is the reference implementation accompanying the Perspective *The second half of the harness era: from agents to Bots*. The Perspective proposes five conditions for a mature Bot. The first four can be checked operationally, and this repository includes [scripts that test each of them](conditions/README.md) against a live Harness.

| Condition in the Perspective | What the plugin provides | Test |
| --- | --- | --- |
| Continuing earlier work | One ongoing conversation per bot; work between bots survives restarts | [`c1-continuing.mjs`](conditions/c1-continuing.mjs) |
| Learning from experience | Memory written only by the bot: records, conclusions and corrections, kept apart | [`c2-learning.mjs`](conditions/c2-learning.mjs) |
| Revising its plans | An agenda whose every change carries a reason; folders it watches wake it with new evidence | [`c3-revising.mjs`](conditions/c3-revising.mjs) |
| Long-term collaboration | Notes on each collaborator; delegation between bots; groups with staged goals | [`c4-collaboration.mjs`](conditions/c4-collaboration.mjs) |

The fifth condition, consciousness, is outside what software features can establish. The plugin makes no claim about it.

**Status: 0.1.0-alpha.** Works against DeepSeek Harness `0.2.2-rc.1`. Interfaces and stored data may change before 0.1.0.

## Requirements

- DeepSeek Harness `0.2.2-rc.1` or a later `0.2.x` release. Prereleases are published under npm's `next` tag, not `latest`.
- Node.js 24.9 or later and [pnpm](https://pnpm.io) on your `PATH` (the Harness uses pnpm to install plugins).
- A model the Harness can use. The examples assume DeepSeek with `DEEPSEEK_API_KEY` set.

## Install

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
git clone https://github.com/omicverse/dsh-futurebot.git
cd dsh-futurebot
npm install
npm run build
dsh plugin --profile web add "$(pwd)"
DEEPSEEK_API_KEY=… dsh web
```

`dsh plugin add` links this directory into the `web` profile. Open the address `dsh web` prints. A **Bots** entry appears in the sidebar.

## First steps

1. Open **Bots** and choose **New bot**. Give it a name and instructions, for example *Lin, analyses transcriptomics data*. Its workspace defaults to `~/futurebots/<name>`.
2. Create a second bot and tick **Coordinator**. The coordinator receives your requests and hands work to the others.
3. Choose **Open conversation** on the coordinator and ask it for something that needs the analyst, for example *Ask Lin how many primes there are below 10,000 and tell me.* The coordinator sends the work; Lin answers in its own conversation; the answer comes back by itself and the coordinator reports to you.
4. Open **Details** on a bot to see its memory, agenda, watched folders and its work with other bots.
5. Under **Groups**, create a group with an admin and ask it for a goal in stages. The admin plans; you press **Start**; each stage goes to its owner and the admin checks it.

## What a bot can do

Each bot's conversation gets these tools. Ordinary Harness conversations do not.

| Tool | Purpose |
| --- | --- |
| `bot_list`, `bot_send` | See the other bots; give one a message or a piece of work. The recipient's final answer in the turn that handled the work comes back to the sender automatically and wakes it. |
| `memory_note`, `memory_search` | Keep and look up records, conclusions and corrections. A correction marks what it replaces instead of deleting it. A note can be about the user or another bot. |
| `agenda_update` | Add, revise, reorder, finish or drop goals, always with a reason and, when there is one, the evidence that prompted it. |
| `watch_folder` | Be woken when files in a folder change while the bot is idle. Changes the bot makes itself do not count. |
| `search_own` | Search the bot's own conversation, including turns that no longer fit in context. |
| `goal_plan`, `goal_check` | For a group's admin: plan a goal in stages and check each finished stage. |

Bots can also use whatever tools the Harness gives their base agent, including the Harness's own scheduling tool for waking at a given time.

## Permissions and approvals

Each bot has one of three permissions, mapped onto the Harness's own controls:

- **Read only**: read-only sandbox. Writing or running anything that changes files needs your approval each time.
- **Work in its workspace**: writes and runs commands inside its workspace. Anything outside needs your approval.
- **Allow everything**: no sandbox and no approvals.

Before the Harness asks you, the plugin answers some approval requests itself:

- If a bot is set to ask once per conversation (the default for new bots) and you already allowed the same kind of operation in that conversation, the request is allowed.
- In a group whose admin reviews first, the admin judges a member's request with one short model call. It can deny the request, and the member is told why. It can pass the request to you. It can approve only if you turned that on for the group. Each decision is recorded in the group log.
- Everything else, including any review that fails or takes too long, goes to you.

## How it maps onto the Harness

The plugin never runs its own agent loop and never writes custom session events.

| Bot property | Harness mechanism |
| --- | --- |
| Conversation and workspace | An ordinary session in a Workspace registered for the bot's folder |
| Identity, team, memory, agenda, group rules | Prompt contexts registered on that session's agent. The system prompt and tool list stay identical across bots, so they share a prompt-cache prefix. Memory and agenda refresh at most every ten turns, because the Harness logs a full snapshot each time context text changes. |
| Work between bots and group messages | Follow-up turns with the plugin's own message source; `session/event` (`user/message`, `assistant/message`, `turn/end`) tells which turn handled which piece of work |
| Evidence | A file-system watch per watched folder |
| Approvals | An `approval/request` listener placed ahead of the user's prompt |
| Records | The plugin's storage domains (`futurebot`, `futurebot_jobs`, `futurebot_mind`, `futurebot_groups`) under `$DSH_HOME/storages` |
| Page and conversation rows | A `main` panel with a `sidebar.panellist` entry; a Conversation node Definition that renders messages between bots as compact rows |

## Data and safety

- Everything stays on your machine: bot records, memory, agendas, jobs and group logs live in JSON under `$DSH_HOME/storages`, and conversations in the Harness's own session store.
- Like every Harness plugin, this one runs inside the Harness process without a sandbox of its own. Bots act through the Harness's tools, under the sandbox and approvals each bot's permission sets.
- The HTTP API under `/futurebot/api` accepts only requests that carry the Harness's own browser credential.
- **Allow everything** removes the sandbox for that bot. Use it in an environment you are prepared for a model to change.
- An admin's review is a model's judgment, and what members write in the group can influence it. Leave "let the admin approve on my behalf" off for work you would not approve without reading.

## Known limits

- Each bot has one conversation, so work from other bots and your own messages share it.
- Group screens poll every two seconds, because the Harness does not let plugins push their own events to the browser.
- Messages in group logs and details show as plain text; Markdown is not rendered.
- "Ask once per conversation" is remembered in memory and resets when the Harness restarts.
- Every bot and every group seat is registered as a Harness Workspace, so the sidebar grows with the number of bots.

## Development

```sh
npm test          # unit tests (vitest)
npm run typecheck # host and client against the pinned Harness types
npm run build     # lib/host/index.js and lib/client.js
node e2e/group.mjs --url '<address printed by dsh web>'   # groups and approvals against a live Harness
```


## License

MIT
