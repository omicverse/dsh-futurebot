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

## Design coverage

The Perspective asks a good deal of a Bot beyond the five conditions in its Table 1. This table follows the whole text section by section. For each item it shows how [OmicOS](https://github.com/omicverse/omicos), where these Bots were first built, handles it, what this plugin does today, and what is still missing here. "Planned" in the OmicOS column means designed but not released.

Status: **Done** means the plugin meets the item, and where a test is named, the test checks it. **Partial** means part of it is in place. **Not yet** means the plugin does not attempt it.

| Perspective asks for | OmicOS Bot | dsh-futurebot today | Status and what is missing here |
| --- | --- | --- | --- |
| ***Why Bots, not agents (Section 1, Figure 1a)*** | | | |
| **A Bot-centred product.** You create and cultivate a Bot first, then route tasks through it. | Bots have their own tab. Each has a name, a line of work, an avatar and a base expert agent. | A Bots page. Each bot has a name, instructions, a workspace, a base agent and a model. | **Done**. |
| **Presence outside the app.** For example, an email address or a phone number for each Bot. | Bots answer in WeChat, Feishu, Slack and other chat apps. A mail connector is available. | Bots live only in the Harness web interface. | **Not yet**. |
| **Many people and many Bots together**, including research that a Bot starts and people then join (Section 9). | One user's bots. Planned: bot friends and groups across users. | One user's bots. | **Not yet**. Only the bot's own user can take part. |
| **Looking for work on its own.** With no task assigned, the Bot looks for something useful to do. | The bot or an event can start a turn, up to a daily cap per bot. | Bots wake only for messages, replies, watched folders and Harness schedules. An idle bot never starts anything by itself. | **Not yet**. |
| ***The five conditions (Section 2, Table 1)*** | | | |
| **1. Continuing earlier work.** Work state, unfinished items and relationships carry across tasks and sessions. | One conversation per counterpart: each user–bot pair, bot–bot pair and group. A full context is either compacted or continued in a new segment with a handoff note, on the same Python kernel. Unfinished work is settled after a restart. | One ongoing conversation per bot, compacted by the Harness. Unfinished work between bots survives restarts. `search_own` reaches turns that no longer fit in context. | **Done** ([c1](conditions/c1-continuing.mjs)). The bot's exchanges with you and with other bots all share one conversation. |
| **2. Learning from experience.** Successes, failures and corrections build a memory tree unique to the Bot and change its later decisions. Instructions and memory improve from feedback. | Bot and group memory, tidied after idle periods. Key points recorded after each turn, with full-text search. Planned: memory that belongs to the bot rather than to any one user, recorded as things happen, connected to the user's research memory tree. | Memory that only the bot writes. Records, inferences and corrections are kept apart, each with its source. A correction marks the entry it replaces. | **Partial** ([c2](conditions/c2-learning.mjs)). Memory is a flat list, not a tree. Nothing is kept unless the bot chooses to write it, so the outcomes of its work are not captured automatically. Feedback never revises the bot's instructions. |
| **3. Revising its plans.** Sets goals, re-prioritises, and revises or ends plans on new evidence, within its authorization. Scheduled execution alone does not count. | Group goals in stages. Turns started by the bot or by events. | An agenda in which every change records a reason and its evidence. Watched folders wake an idle bot. | **Partial** ([c3](conditions/c3-revising.mjs)). File changes are the only source of new evidence. There is no authorization scope to plan within (see "Decisions inside and outside the agreed scope"). |
| **4. Long-term collaboration.** Relationships across tasks. A Bot's answers are shaped by its private exchanges with the other Bots, and these outlast any one conversation or team. | Private chats between any two bots. Work is handed over with its files. Groups have an admin, batched replies, `[PASS]` and an idle guard. Local coding agents can run as bots. | `bot_send` with automatic replies and chain limits. Notes on each collaborator. Groups with staged goals and admin review. | **Done** ([c4](conditions/c4-collaboration.mjs)). Work between bots carries text only; files cannot be attached. |
| **5. Consciousness.** | No claim. | No claim. | Outside what software can establish. |
| ***How people and Bots organise research (Sections 3 and 4)*** | | | |
| **Raising questions unprompted.** From months of accumulated data or the records of several projects, a Bot flags an anomaly and asks whether it merits study. | Turns started by events. | A watched folder or a reply from another bot wakes the bot, which can then revise its agenda or message others. | **Partial**. There are no other triggers, such as new records in a database or an external event. |
| **Roles and relationships that form through work** rather than being fixed in advance. Over time these become stable divisions of labour (Section 10). | A coordinator that can create and edit bots and groups. | The user creates every bot and group and appoints the coordinator and admins. Bots keep notes on their collaborators. | **Partial**. Bots cannot create other bots, recruit members or start groups. |
| **Challenge in both directions.** Disagreements are kept on record and settled with new evidence, not by a majority of Bots. | Not yet. | Corrections are kept. Open disagreements are not recorded. | **Not yet**. |
| **Seeing what a recommendation rests on.** People should not have to decide from records that only the Bot has read. | Analysis steps open in a side panel. Recalled memory is shown above the answer. | Every bot turn is an ordinary Harness conversation with its tool calls. Details shows memory, agenda and work with other bots. | **Partial**. Recommendations do not cite the records they rest on. |
| ***Costs and research demand (Section 5)*** | | | |
| **A full cost account**: running the system, human effort, experiments and services, and rework. | Token usage per bot. A daily cap on automatic turns. | Nothing per bot. The Harness counts tokens per session. | **Not yet**. |
| **Knowing what is worth doing and when to stop.** Weigh what more evidence could change against what it costs. | A group idle guard and a limit on redoing a goal stage. | A group idle guard (six rounds) and a redo limit (three). Agenda goals can be dropped with a reason. | **Partial**. Nothing weighs the cost of further work against its expected value. |
| ***Shared scientific infrastructure (Section 6)*** | | | |
| **Finding collaborators beyond one user**: identity, capability descriptions and discovery (for example A2A), then working out who offers what. | Calls external agents over A2A. Planned: a network of bots across labs. | `bot_list` shows the user's own bots and what they do. | **Not yet**. |
| **Results with provenance and dependencies.** Results travel with their sources and the conclusions they rest on. Revising a conclusion flags the work built on it. | Files handed between bots carry a hash and their source. Goal evidence is free text. | Memory entries record where and when they were written. Goal evidence is free text. | **Not yet**. Conclusions are not linked to the ones they depend on, and revising one flags nothing. |
| **Graded evidence.** Model explanations, computed results and independent measurements count differently. Negative results, overturned hypotheses and open uncertainty are kept. | Not yet. | Records, inferences and corrections are kept apart. | **Partial**. There is no grade for validated results, and nowhere to mark a result as negative or a question as open. |
| **A Bot shared across groups, carrying experience across members and projects** (also Section 9), with data permissions kept per project. | Planned: memory owned by the bot. | Memory and agenda belong to the bot and outlast any task. One user, and memory is not scoped by project. | **Not yet**. |
| **A dependable service**: stated limits of capability, a named responsible person, run records, and a handover that shows a successor the unfinished work, the basis of past judgments and the resources already committed. | Run records for every conversation. Usage per bot. | Every turn, every piece of work between bots and every group message is recorded. Deleting a bot keeps its conversation. | **Partial**. There is no statement of limits, no responsible person, and no handover summary or export. |
| ***Autonomy and human responsibility (Section 7, Figure 3)*** | | | |
| **Decisions inside and outside the agreed scope.** People and Bots decide together whether research is worth doing, the holders of resources commit them, the Bot works within the agreed scope, and anything beyond it goes back to the decision makers (Figure 3a). | Three permission levels that only the user sets. The admin reviews members' requests. Allow once per conversation. A daily cap on automatic turns. | Three permission levels mapped onto the Harness sandbox. Ask once per conversation. The admin reviews members' requests, and by default may only deny them or pass them to you. | **Partial**. The scope is a sandbox, not a set of agreed resources and goals, and there is no per-bot budget for turns, tokens or cost. |
| **Room to dissent.** A Bot can give reasons, propose alternatives and ask for reassessment instead of only complying. | Left to the model and its instructions. | Left to the model and its instructions. | **Not yet**. |
| **Drift from the original purpose.** Check whether judgments accumulated over time still serve the goal rather than countable outputs. | Not yet. | The agenda keeps every change and its reason, so drift can be reviewed by hand. | **Not yet**. |
| **Risk across split tasks.** Sensitive work split into harmless-looking pieces across Bots. | Planned: restrictions the user stated travel with work a bot delegates. | Delegated work carries only the message. | **Not yet**. |
| **Memory safety.** Memory keeps sources and dependencies, separates observations, hypotheses, validated results and corrections, and resists injected content. | Fixed, not yet released: messages from other bots are no longer taken as the user's own words when memory is formed. | Only the bot writes its memory, and each entry keeps its source and kind. Whatever the bot reads can still end up in memory. | **Partial**. |
| **Data-use limits and erasure.** Restrictions on source data follow it into summaries and memory, and deletion reaches every copy. | Not yet. | Memory is plain JSON under `$DSH_HOME/storages` that you can inspect and delete. | **Not yet**. |
| **Watching long-term risks** (Figure 3b): unverified explanations reused from memory, goals drifting toward countable outputs, converging research directions, researchers losing practice, and dependence on a few platforms. | Not yet. | No indicators. Keeping data local in plain JSON under an MIT licence limits dependence on any one platform. | **Not yet**. |
| **Bots as possible objects of ethical concern** if evidence of experience appears. | Out of scope. | Out of scope. | Outside what software can establish. |
| ***Evaluation (Section 8)*** | | | |
| **Long-running comparisons.** Inject new data, corrected annotations, resource limits or a collaborator's withdrawal. Compare with no AI, workflow managers, agent products, one Bot and several Bots, under the same model, tools and budget, with all costs recorded. | No published evaluation. | Four condition scripts inject new evidence and a change in a collaborator. | **Partial**. There are no resource-limit or withdrawal events, no baseline comparisons and no cost records. |
| **Contributions not confirmed only by other Bots.** Agreement between Bots that share models is not independent evidence. | The admin bot checks each goal stage. | The admin bot passes or sends back each goal stage; you can only start, pause, resume, stop or clear the goal. | **Not yet**. A stage cannot require your check or an external one. |
| ***Predictions for 2029 (Section 9)*** | | | |
| **Bots placing requests with facilities.** Within an authorized budget, a Bot submits, revises and withdraws requests to computing, data and experimental services. | Bots can run the platform's pipelines and, where enabled, cloud compute jobs. | Local tools only. | **Not yet**. |
| **Records for studying Bot groups.** Trace how questions arise and how relationships form and change (Section 10). | Conversations and group logs. | Work between bots, group logs and agenda history are stored as JSON. | **Partial**. There is no timeline or export. |

OmicOS also has features that the Perspective does not ask for and this plugin does not have. These include a mobile app, a library of avatars, private bots walled off from the team, groups bound to a project, kernel variables handed over with work, and speaking in a group as one of your bots.

## Development

```sh
npm test          # unit tests (vitest)
npm run typecheck # host and client against the pinned Harness types
npm run build     # lib/host/index.js and lib/client.js
node e2e/group.mjs --url '<address printed by dsh web>'   # groups and approvals against a live Harness
```


## License

MIT
