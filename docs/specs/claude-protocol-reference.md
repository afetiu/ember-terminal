# Claude Code stdio protocol — reference for Ember

Status: research reference, 2026-11-03. Sources: `@anthropic-ai/claude-agent-sdk@0.3.317`
(`sdk.d.ts`, `sdk-tools.d.ts`, `sdk.mjs` transport/query code) and live runs of
`claude.exe` **2.1.316** on the mini PC. Everything marked **[verified]** was observed on the
wire; everything else comes from the SDK type definitions.

Goal: Ember drives Claude Code through the same structured protocol the Agent SDK and IDE
extensions use, instead of screen-scraping the full-screen TUI.

---

## 1. Spawning

### 1.1 Exact args the SDK passes

The TS SDK builds this argv (from `ProcessTransport` in `sdk.mjs`), in this order, adding only
the options that are set:

```
claude --output-format stream-json --verbose --input-format stream-json
  [--thinking=adaptive | --max-thinking-tokens N | --thinking=disabled] [--thinking-display X]
  [--effort low|medium|high|xhigh|max] [--max-turns N] [--max-budget-usd X] [--task-budget N]
  [--model M] [--agent NAME] [--betas a,b] [--json-schema JSON] [--debug-file F | --debug]
  [--permission-prompt-tool=stdio  (when a canUseTool callback is supplied)
   | --permission-prompt-tool MCP_TOOL_NAME]
  [--permission-prompts host|none]
  [--continue] [--resume SESSION_ID]
  [--allowedTools a,b] [--disallowedTools a,b] [--tools a,b | --tools=default]
  [--mcp-config '{"mcpServers":{...}}'] [--setting-sources user,project,local] [--strict-mcp-config]
  [--permission-mode default|acceptEdits|bypassPermissions|plan|dontAsk|auto]
  [--allow-dangerously-skip-permissions] [--fallback-model M]
  [--include-hook-events] [--include-partial-messages] [--session-mirror]
  [--add-dir D]... [--await-initialize | --plugin-dir D ...]
  [--fork-session] [--resume-session-at UUID] [--resume-drops-turn N]
  [--session-id UUID] [--no-session-persistence] [--managed-settings JSON]
  [--settings JSON] [extraArgs...]
```

Notes:
- **No `-p` is passed.** stream-json input implies print/headless mode. [verified: our driver
  passed no `-p` and it worked]
- Env: `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (if unset), `NODE_OPTIONS` deleted, `DEBUG` deleted
  unless `DEBUG_CLAUDE_AGENT_SDK`. `enableFileCheckpointing` →
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` (needed for `rewind_files`).
- System prompt, append-system-prompt, custom agents, skills, SDK MCP servers and hook
  callbacks are **not** argv — they ride in the `initialize` control request (§3.1).
- Other useful CLI flags (from `claude --help`): `--replay-user-messages` (echo stdin user
  messages back on stdout with `isReplay:true`; requires both stream-json formats),
  `--system-prompt`, `--append-system-prompt`, `--name`, `--no-session-persistence`.

### 1.2 Recommended Ember spawn

```
claude.exe --output-format stream-json --verbose --input-format stream-json
  --include-partial-messages --replay-user-messages
  --permission-prompt-tool stdio --permission-mode default
  [--resume <id> | --session-id <uuid>]
```
- cwd = the project directory. **Use the long path**, not an 8.3 short path: with cwd
  `C:\Users\AGON-M~1\...`, a plain Write was escalated as a `safetyCheck` ("suspicious Windows
  path pattern") and could not be auto-allowed. [verified]
- Delete `CLAUDECODE` from env when spawning from inside a Claude session.
- Set `CLAUDE_CODE_ENTRYPOINT` to something Ember-specific only if you are sure nothing gates
  on it; `sdk-ts` is the known-good value.

### 1.3 Auth

Uses the normal Claude subscription login — nothing to pass. [verified] `system/init` had
`"apiKeySource":"none"`, and the `initialize` response had
`account: {"email":"afetiu3@gmail.com","subscriptionType":"Claude Ultra","apiProvider":"firstParty"}`.
A `rate_limit_event` with the subscription windows arrives on each turn. If the user is logged
out, assistant messages carry `error:"authentication_failed"`; there is no login flow on this
channel (`auth_status` messages exist for an in-flight login, but `/login` is a TUI thing).

---

## 2. Wire format

- Newline-delimited JSON, both directions. One object per line.
- stdin carries: `user` messages, `control_request` (host→CLI), `control_response`
  (answers to CLI→host requests), `control_cancel_request`.
- stdout carries: every `SDKMessage` (§4) plus `control_request` (CLI→host),
  `control_response` (answers to host requests), `keep_alive`.
- **Closing stdin ends the session** after the current work drains (process exits 0). [verified]
- Unknown types appear in practice — 2.1.316 emitted `command_lifecycle`,
  `system/post_turn_summary`, `system/task_summary` that are not in the SDK union. Ignore
  unknown `type`/`subtype` values; never crash on them.

### 2.1 Control request envelope

```jsonc
// either direction
{"type":"control_request","request_id":"req_abc","request":{"subtype":"…", /* fields */}}
// reply
{"type":"control_response","response":{"subtype":"success","request_id":"req_abc","response":{ /* payload */ }}}
{"type":"control_response","response":{"subtype":"error","request_id":"req_abc","error":"message"}}
// withdraw your own in-flight request (no reply)
{"type":"control_cancel_request","request_id":"req_abc"}
```
`ControlResponse` may also carry `pending_permission_requests`, `pending_user_dialog_requests`,
`pending_elicitation_requests` (arrays of control_requests still waiting — the SDK re-processes
them; used after a reconnect/re-initialize).

Unknown subtype → `{"subtype":"error","error":"Unsupported control request subtype: X"}`. [verified]

---

## 3. Control requests

### 3.1 Host → CLI

`initialize` must be the **first** thing sent (`startup_failure_reason: "initialize_not_first"`
exists). The SDK sends it immediately on spawn.

| subtype | request fields | response |
|---|---|---|
| `initialize` | `hooks?: {[HookEvent]: [{matcher?, hookCallbackIds: string[], timeout?, onFailure?:'continue'\|'block'}]}`, `sdkMcpServers?: string[]`, `sdkMcpServerConfigs?`, `sdkMcpServerManifests?`, `jsonSchema?`, `systemPrompt?: string[]`, `appendSystemPrompt?`, `planModeInstructions?`, `toolAliases?`, `excludeDynamicSections?`, `agents?: {[name]: AgentDefinition}`, `title?`, `skills?: string[]`, `promptSuggestions?`, `agentProgressSummaries?`, `forwardSubagentText?`, `supportedDialogKinds?: string[]`, `perTaskStopAffordance?`, `plugins?: [{type:'local', path}]` | `commands: SlashCommand[]`, `agents: AgentInfo[]`, `output_style`, `available_output_styles`, `models: ModelInfo[]`, `account: AccountInfo`, `claude_code_version`, `fast_mode_state`, … [verified extra keys: `pid`, `current_permission_mode`, `session_state`, `capabilities`, `user_output_styles_dir`, `remote_control_*`] |
| `interrupt` | `cancel_queued?: boolean` | `{still_queued: uuid[], cancelled?: uuid[]}` |
| `set_permission_mode` | `mode: PermissionMode` | — |
| `set_model` | `model?: string\|null` (null = default) | [verified] `{model:"claude-sonnet-5-5"}` + a replayed user msg `<local-command-stdout>Set model to …` |
| `set_max_thinking_tokens` | `max_thinking_tokens?: number\|null`, `thinking_display?: 'summarized'\|'omitted'\|'highlights'\|null` | — |
| `apply_flag_settings` | `settings: {}` (e.g. `{effortLevel:'high'}`) | — |
| `update_settings` | `source:'localSettings'\|'userSettings'`, `settings` | — (persists to disk) |
| `get_settings` | — | resolved settings |
| `get_context_usage` | `detail?: 'summary'\|'full'` | `{categories[{id,name,tokens,color,kind}], totalTokens, maxTokens, rawMaxTokens, percentage, gridRows, model, memoryFiles, mcpTools, agents, skills…}` [verified] |
| `get_session_cost` | — | session cost |
| `get_usage` | `skip_behaviors?` | plan usage rows (experimental) |
| `list_models` | — | `ModelInfo[]` |
| `mcp_status` | `liveReply?` | `{mcpServers: McpServerStatus[]}` [verified] |
| `mcp_reconnect` | `serverName` | — |
| `mcp_toggle` | `serverName`, `enabled` | — |
| `mcp_set_servers` | `servers: {[name]: config}` | added/removed/errors |
| `mcp_read_resource` | `serverName`, `uri` | `{contents[]}` |
| `mcp_call` | `tool`, `arguments?`, `timeout_ms?`, … | call result (host calls an MCP tool directly) |
| `mcp_message` | `server_name`, `message: JSONRPC` | (also CLI→host, for SDK in-process MCP servers) |
| `rewind_files` | `user_message_id`, `dry_run?` | `{canRewind, error?, filesChanged?, insertions?, deletions?}` (needs checkpointing env) |
| `cancel_async_message` | `message_uuid` | drops a queued user message |
| `stop_task` | `task_id` | stops a background task/subagent |
| `background_tasks` | `tool_use_id?` | Ctrl+B equivalent: background running Bash/subagents |
| `get_task_output` | `task_id` | `{output, total_bytes, truncated}` |
| `file_suggestions` | `query` | the TUI's `@` fuzzy file suggestions |
| `read_file` | `path`, `max_bytes?`, `encoding?` | `{contents, absPath, truncated?}` |
| `seed_read_state` | `path`, `mtime` | marks a file as already read |
| `register_repo_root` | `directory`, `reload_*?` | — |
| `reload_plugins` / `reload_skills` / `reload_output_styles` | … | new lists |
| `rename_session` | `title`, `session_id?` | — |
| `set_color` | `color` | — |
| `get_hooks_listing` | — | hook events/matchers (the /hooks menu data) |
| `list_permission_rules` | — | `{state:{rules[], workspaceDirectories[], originalCwd, managedOnly}}` |
| `get_binary_version` | — | version |

`PermissionMode = 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`.

### 3.2 CLI → host (Ember must answer)

| subtype | fields | answer (`response` payload) |
|---|---|---|
| `can_use_tool` | `tool_name`, `input`, `tool_use_id`, `display_name?`, `title?`, `description?`, `permission_suggestions?: PermissionUpdate[]`, `blocked_path?`, `decision_reason?`, `decision_reason_type?` (`rule\|mode\|safetyCheck\|classifier\|hook\|…`), `classifier_approvable?`, `suppress_always_allow_rule?`, `default_to_no?`, `matched_ask_rule?`, `agent_id?` (subagent), `mcp_server?`, `requires_user_interaction?` | allow: `{behavior:'allow', updatedInput?: {...}, updatedPermissions?: PermissionUpdate[], toolUseID?}` · deny: `{behavior:'deny', message: string, interrupt?: boolean}` |
| `hook_callback` | `callback_id`, `input: HookInput`, `tool_use_id?` | `SyncHookJSONOutput` (`continue?`, `decision?`, `systemMessage?`, `reason?`, `hookSpecificOutput?`) |
| `elicitation` | `mcp_server_name`, `message`, `mode?: 'form'\|'url'`, `url?`, `requested_schema?`, `title?`… | `{action:'accept'\|'decline'\|'cancel', content?}` |
| `request_user_dialog` | `dialog_kind`, `payload`, `tool_use_id?` | per kind; only sent for kinds declared in `initialize.supportedDialogKinds` |
| `mcp_message` | `server_name`, `message` | `{mcp_response}` (only if Ember hosts in-process MCP servers) |

The CLI can withdraw a pending request with `control_cancel_request` (e.g. a permission prompt
after an interrupt) — Ember must close the corresponding UI.

`PermissionUpdate` (for "always allow" buttons):
```ts
{type:'addRules'|'replaceRules'|'removeRules', rules:[{toolName, ruleContent?}], behavior:'allow'|'deny'|'ask', destination}
{type:'setMode', mode, destination}
{type:'addDirectories'|'removeDirectories', directories:string[], destination}
destination = 'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'
```
Echo back a `permission_suggestions` entry in `updatedPermissions` to implement "Yes, and don't
ask again". Respect `suppress_always_allow_rule` (hide that button).

Sample [verified, Write in default mode]:
```json
{"type":"control_request","request_id":"30b1922b-…","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
 "input":{"file_path":"C:\\…\\work\\note.txt","content":"hello"},"description":"note.txt",
 "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
 "decision_reason":"Claude requested permissions to write to …, which contains a suspicious Windows path pattern that requires manual approval.",
 "decision_reason_type":"safetyCheck","classifier_approvable":false,"tool_use_id":"toolu_01F5…","suppress_always_allow_rule":true}}
{"type":"control_response","response":{"subtype":"success","request_id":"30b1922b-…","response":{"behavior":"allow","updatedInput":{"file_path":"C:\\…\\note.txt","content":"hello"}}}}
```
Read-only shell commands (`echo hi`) were auto-allowed with no `can_use_tool`
(`tool_result_meta.permission_decision: {decision:"accept", source:"config", reason_type:"subcommandResults"}`). [verified]

---

## 4. stdout messages (`SDKMessage`)

Every message has `uuid` and `session_id`. Grouped by purpose:

### 4.1 Conversation
- **`system/init`** — emitted at the **start of every turn** (not once per process). [verified]
  Fields: `cwd, session_id, tools[], mcp_servers[{name,status,source}], model, permissionMode,
  slash_commands[], terminal_slash_commands?[], apiKeySource, claude_code_version,
  output_style, agents[], skills[], plugins[{name,path,source,version}], plugin_errors?,
  fast_mode_state, effort?, view_mode?, capabilities[]` plus (2.1.316) `memory_paths,
  original_cwd, additional_directories, powershell_path, user_message_uuids`.
  Real `capabilities`: `interrupt_receipt_v1, interrupt_cancel_queued_v1,
  interrupt_send_now_v1, interrupt_requeue_taken_v1, msg_lifecycle_v1,
  ask_user_question_unanswered_v1, mcp_read_resource_v1, mcp_tool_ui_meta_v1, ui_surface_v1, …`
- **`assistant`** — `{message: BetaMessage, parent_tool_use_id, error?, aborted?, agent_id?,
  subagent_type?, user_message_uuid(s)?, supersedes?, context_usage?, usage_report?}`.
  **One assistant message per completed content block**; several share `message.id`, each with
  one block, `stop_reason:null`. Blocks: `text`, `thinking` (thinking text was empty +
  signature on Haiku 5.5 — display is summarized/omitted), `tool_use`, server tool blocks.
- **`user`** — tool results come back as `user` messages: `message.content =
  [{type:'tool_result', tool_use_id, content, is_error}]`, plus `tool_use_result` (the
  tool's structured Output object — render from this, e.g. Edit's `structuredPatch`) and
  `tool_result_meta[{id, permission_decision:{decision, source}}]`. With
  `--replay-user-messages`, your own sent messages come back with `isReplay:true`.
  Local slash command output also arrives as a replayed user message:
  `"<local-command-stdout>Compacted </local-command-stdout>"`.
- **`stream_event`** (only with `--include-partial-messages`) — `{event: BetaRawMessageStreamEvent,
  parent_tool_use_id, ttft_ms?}`: `message_start`, `content_block_start`,
  `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`,
  `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`. The full
  `assistant` message for a block arrives right after that block's deltas.
- **`result`** — end of a turn. `subtype: 'success' | 'error_during_execution' |
  'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`;
  `is_error, result (text), num_turns, duration_ms, duration_api_ms, total_cost_usd
  (cumulative for the process), usage, modelUsage, permission_denials[], stop_reason,
  terminal_reason ('completed'|'aborted_streaming'|'aborted_tools'|'max_turns'|…),
  user_message_uuid(s), local_command? (set for /context, /compact…), errors[]`.
  `total_cost_usd` is API-list price even on a subscription — label it "equivalent cost".

### 4.2 State / progress
- `system/status` — `{status: 'requesting'|'compacting'|null, permissionMode?, compact_result?}`.
- `system/compact_boundary` — `{compact_metadata:{trigger:'manual'|'auto', pre_tokens,
  post_tokens, duration_ms, preserved_segment?}}`, followed by a user message with the summary.
- `system/session_state_changed` — `idle|running|requires_action`.
- `system/api_retry`, `system/control_request_progress`.
- `system/thinking_tokens` — running estimate while the model thinks. [verified]
- `tool_progress` — `{tool_use_id, tool_name, elapsed_time_seconds, parent_tool_use_id}` heartbeat for long tools.
- `tool_use_summary`, `system/task_summary`, `system/post_turn_summary` (one-line status of the
  turn, e.g. `"ran echo hi via Bash; replied done"`). [verified]
- `rate_limit_event` — `{rate_limit_info:{status, resetsAt, rateLimitType, utilization, overage…}}`.
- `command_lifecycle` (undocumented, 2.1.316) — `{command_uuid, state:'queued'|'started'|'completed'|'cancelled'}`
  per user message you sent. This is the queue indicator. [verified]
- `prompt_suggestion` (if `promptSuggestions` in initialize).
- `system/notification` `{key,text,priority,timeout_ms}`, `system/informational`,
  `system/local_command_output`, `system/memory_recall`, `system/permission_denied`,
  `system/model_refusal_fallback|no_fallback`, `auth_status`, `conversation_reset`
  (`/clear`: new conversation id), `system/commands_changed` (replace slash list),
  `system/files_persisted`, `system/worker_shutting_down`, `system/session_writes_lost`,
  `active_goal`, `keep_alive`.

### 4.3 Subagents / background tasks
- `system/task_started` `{task_id, tool_use_id, description, subagent_type, task_type, is_backgrounded, parent_task_id, prompt}`
- `system/task_progress` `{task_id, usage:{total_tokens, tool_uses, duration_ms}, last_tool_name, summary}`
- `system/task_updated` `{task_id, patch:{status, end_time, error, is_backgrounded}}`
- `system/task_notification` `{task_id, status:'completed'|'failed'|'stopped', output_file, summary, usage}`
- `system/background_tasks_changed` `{tasks:[…]}` — **level signal, REPLACE semantics**; reset
  to empty on process restart.
- Subagent assistant/user frames carry `parent_tool_use_id` (the Agent tool_use) and `agent_id`.

### 4.4 Hooks (with `--include-hook-events`, SessionStart is shown even without)
`system/hook_started`, `system/hook_progress`, `system/hook_response`
`{hook_id, hook_name, hook_event, stdout, stderr, exit_code, outcome}`. [verified: SessionStart
hook ran ~5.7 s before the init response — user hooks run in this mode too]

---

## 5. Sending input

### 5.1 User message
```json
{"type":"user","uuid":"<client uuid>","parent_tool_use_id":null,
 "message":{"role":"user","content":"Reply with the word ok."}}
```
Optional: `priority:'now'|'next'|'later'`, `shouldQuery:false` (append without starting a
turn), `pasted_content`, `inline_pastes`, `client_composed:true` (disables `@` expansion and
slash dispatch). Send your own `uuid` — it is echoed in `user_message_uuid(s)` on the reply,
the `result`, `status`, and `command_lifecycle`, which is how Ember binds replies to sends.

### 5.2 Images / documents
Content blocks, exactly as in the Messages API [verified: 16×16 blue PNG → "Blue"]:
```json
{"type":"user","uuid":"…","parent_tool_use_id":null,"message":{"role":"user","content":[
  {"type":"text","text":"What single color fills this image? One word."},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo…"}}]}}
```
PDFs: `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":…}}`.
Ember must do the clipboard read / file pick and base64 it itself.

### 5.3 `@file` mentions
Expanded **by the CLI** from plain text (unless `client_composed`). [verified: "@note.txt" — the
model saw the file contents attached]. Autocomplete data: `file_suggestions` control request.

### 5.4 Slash commands
Send them as a plain user message (`"/compact"`, `"/context"`). The available set is
`system/init.slash_commands` / `initialize.commands` (name, description, argumentHint,
aliases, builtin). `terminal_slash_commands` are the ones bound to the terminal UI — hide them.
- `/context` [verified]: synthetic assistant message (`model:"<synthetic>"`) with a markdown
  table + structured `context_usage`, then `result` with `local_command:"context"`, cost 0.
- `/compact` [verified]: `status: compacting` → `status:null, compact_result:'success'` →
  `compact_boundary` → summary user message → `<local-command-stdout>Compacted` → `result`.
- Skills (`/da-labs`, `/ember`, plugin skills) run as prompts.
- Built-ins advertised in -p mode on 2.1.316 include: clear, compact, context, config
  (key=value only), model, effort, fast, output-style, mcp (reconnect/enable/disable args),
  init, review/code-review, usage, rename, reload-plugins/skills, goal, autocompact, color,
  focus, doctor, loop, schedule, insights, recap. Interactive pickers (`/resume`, `/login`,
  `/permissions` UI, `/hooks` UI, `/agents` UI, `/ide`, `/vim`, `/terminal-setup`,
  `/statusline`, `/bug`) are not in the list.

### 5.5 Queueing and interrupt [verified]
- Sending a user message while a turn runs **queues** it (`command_lifecycle: queued`). It runs
  as the next turn after the current `result`. (Messages may also be folded into the running
  turn between tool calls — see `user_message_uuids`.)
- `interrupt` mid-stream: response `{"still_queued":["601f…"]}` arrives immediately; the partial
  assistant message is flushed (with the text so far), a user message
  `"[Request interrupted by user]"` is emitted, `result` comes with
  `subtype:"error_during_execution"`, `is_error:true`, `terminal_reason:"aborted_streaming"`,
  the interrupted command gets `command_lifecycle: cancelled` — and then **the queued
  message starts running automatically**. Use `interrupt` with `cancel_queued:true` (or
  `cancel_async_message`) to drop the queue too.
- Per the SDK docs, a pending `can_use_tool` can be withdrawn with `control_cancel_request`
  after an interrupt (not exercised in our runs).

### 5.6 Special tools
- **AskUserQuestion** [verified]: arrives as `can_use_tool` with `tool_name:"AskUserQuestion"`,
  `requires_user_interaction:true`, `input.questions[{question, header, options[{label,
  description, preview?}], multiSelect}]` (1–4 questions, 2–4 options; "Other" is the UI's
  job). Answer by **allowing with `updatedInput` = original input + `answers`**:
  ```json
  {"behavior":"allow","updatedInput":{"questions":[…],"answers":{"Which color do you prefer?":"Red"}}}
  ```
  Multi-select = comma-separated labels; free text "Other" = the typed text. Optional
  `annotations: {[question]: {notes?, preview?, unanswered?: 'skipped'|'replied_in_chat'|'dismissed'}}`
  (`unanswered` only if init `capabilities` has `ask_user_question_unanswered_v1`). Tool
  result seen by the model: `Your questions have been answered: "Which color…"="Red"…`.
- **ExitPlanMode**: in `plan` mode arrives as `can_use_tool`; the plan text is in the tool input
  (and `ExitPlanModeOutput.plan/filePath`). Approve = allow (and send `set_permission_mode`
  to `default`/`acceptEdits`, or return `updatedPermissions:[{type:'setMode',…}]`); keep
  planning = deny with feedback `message`.
- **TodoWrite / Task tools**: no prompt; read `tool_use.input.todos[{content, status,
  activeForm}]` from assistant messages to render the checklist.
- **EnterPlanMode**, mode switches: `system/status.permissionMode` reports the new mode.

---

## 6. Sessions: resume, continue, fork

- Transcripts are written to the same place as the TUI's:
  `~/.claude/projects/<cwd-key>/<session_id>.jsonl` (cwd-key = path with `\ : ~ .` → `-`).
  Same format; lines are tagged `"entrypoint":"sdk-ts"` vs `"sdk-cli"`. [verified]
- `--resume <id>` loads the history (must run from the same cwd). [verified:
  `claude --resume 3a06… -p "What exact word did I first ask…"` answered from history.]
- `--resume <id> --fork-session` → same history, **new** `session_id`. [verified]
- `--continue` = most recent session in cwd. `--session-id <uuid>` = choose the id for a new
  session (lets Ember know the id before the first init). `--resume-session-at <msg uuid>` =
  resume truncated at a message (edit/rewind a conversation).
- SDK helper functions read the same store: `listSessions`, `getSessionInfo`,
  `getSessionMessages`, `getSubagentMessages`, `renameSession`, `tagSession`, `forkSession`,
  `deleteSession` — Ember can import `@anthropic-ai/claude-agent-sdk` in the main process just
  for these, or parse the jsonl directly.
- TUI interop: an SDK-created session is a normal transcript, so `claude --resume <id>` in the
  TUI should open it (verified only through `--resume <id> -p`; whether the TUI's `/resume`
  *picker* lists `sdk-ts` sessions was not tested).
- Only one process should own a session at a time.

---

## 7. What the TUI can do that this mode cannot — and what Ember does instead

| TUI feature | In stream-json mode | Ember plan |
|---|---|---|
| `/login`, `/logout` | not available | run `claude /login` in a real terminal tab (or `claude setup-token`); detect `authentication_failed` |
| `/model` picker | `set_model` + `initialize.models` | own picker |
| effort / thinking | `apply_flag_settings {effortLevel}`, `set_max_thinking_tokens`, `/effort x` | own control |
| permission mode (Shift+Tab) | `set_permission_mode` | own toggle; show `status.permissionMode` |
| `/config` UI | `get_settings`, `update_settings`, `/config key=value` | own settings screen |
| `/resume` picker | none | own list from `~/.claude/projects` (or SDK `listSessions`) → respawn with `--resume` |
| `/mcp` UI | `mcp_status`, `mcp_toggle`, `mcp_reconnect`; OAuth for `needs-auth` servers is not on this channel | own panel; for auth fall back to TUI `/mcp` |
| `/context`, `/cost`, usage | `get_context_usage`, `get_session_cost`, `get_usage`, `rate_limit_event` | own meter |
| status line | not emitted (statusline is a terminal command) | build from init + result + rate limits |
| `!` bash mode | **not supported** — `"!echo bangtest"` went to the model as a prompt and it ran Bash itself [verified] | Ember runs the command in its own pty and sends the output with `shouldQuery:false` (or as context in the next message) |
| `#` memory shortcut | not a protocol feature | Ember appends to CLAUDE.md / memory file itself, or sends `/memory`-style prompt |
| `@` mentions | expanded by CLI; suggestions via `file_suggestions` | own autocomplete popup |
| image paste | content blocks | own paste handler → base64 |
| vim mode, keybindings | n/a | Ember's editor |
| `/hooks` UI | `get_hooks_listing` (read-only) | read-only view; edit settings files |
| `/permissions` UI | `list_permission_rules`, `update_settings` | own editor |
| background tasks, Ctrl+B, subagent progress, "+N agents" | `task_*` messages, `background_tasks_changed`, `background_tasks`, `stop_task`, `get_task_output` | own task tray |
| rewind (Esc Esc) | `rewind_files` (needs checkpointing env) + `--resume-session-at` for conversation | own "rewind to here" |
| `/clear` | `/clear` → `conversation_reset` with new conversation id | handle reset |
| permission dialogs | `can_use_tool` | own dialog incl. "always allow" via `updatedPermissions` |
| `/ide`, `/terminal-setup`, `/doctor` (terminal), `/exit` | terminal-only | open TUI on the same session (`claude --resume <id>` in a pty tab) |
| anything else missing | — | **escape hatch:** kill the stdio process, open the TUI on the same session id, and respawn stdio when it closes |

---

## 8. CHANGELOG and version detection

- The npm package `@anthropic-ai/claude-code` does **not** ship a CHANGELOG (it is a thin
  wrapper: `bin/claude.exe` stub, `cli-wrapper.cjs`, `install.cjs`, `sdk-tools.d.ts`).
- Changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
  (raw: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md, headings `## 2.1.317`).
- GitHub releases mirror each version with the notes as body: tags `v2.1.317`, …
  https://github.com/anthropics/claude-code/releases (atom: `…/releases.atom`).
- Detect a new version in a GitHub Action (any of):
  ```bash
  npm view @anthropic-ai/claude-code version          # latest (2.1.317 today)
  npm view @anthropic-ai/claude-code dist-tags --json # {"stable":"2.1.311","next":"2.1.317","latest":"2.1.317"}
  curl -s https://registry.npmjs.org/@anthropic-ai/claude-code/latest | jq -r .version
  gh api repos/anthropics/claude-code/releases/latest -q .tag_name
  gh release view v2.1.317 -R anthropics/claude-code --json body -q .body
  npm view @anthropic-ai/claude-agent-sdk version     # SDK (0.3.317 tracks CLI 2.1.317)
  ```
  Store the last seen version (repo variable / cache / committed file), run on `schedule:`
  cron, and on change diff the new SDK `sdk.d.ts` against the previous one — the type file is
  the best machine-readable protocol changelog.
- Note the `stable` dist-tag lags `latest`; the user's installed CLI auto-updates on its own channel.

---

## 9. Real sample (trimmed) — one turn, `Reply with the word ok.`

```
→ {"type":"control_request","request_id":"req_c99","request":{"subtype":"initialize","hooks":{},"supportedDialogKinds":[]}}
← {"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup",…}
← {"type":"system","subtype":"hook_response","outcome":"success","exit_code":0,…}
← {"type":"control_response","response":{"subtype":"success","request_id":"req_c99","response":{"commands":[…],"models":[…],"account":{…},…}}}   (8.6 s after spawn)
→ {"type":"user","message":{"role":"user","content":"Reply with the word ok."},"parent_tool_use_id":null,"uuid":"ec77…"}
← {"type":"command_lifecycle","command_uuid":"ec77…","state":"queued"} / "started"
← {"type":"system","subtype":"init","session_id":"3a06…","model":"claude-haiku-5-5","permissionMode":"default","apiKeySource":"none",…}
← {"type":"system","subtype":"status","status":"requesting","user_message_uuids":["ec77…"]}
← {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day",…}}
← {"type":"stream_event","event":{"type":"message_start",…}} … content_block_delta text_delta "ok"
← {"type":"assistant","message":{"id":"msg_011…","content":[{"type":"text","text":"ok"}],"stop_reason":null,…}}
← stream_event content_block_stop / message_delta(stop_reason end_turn) / message_stop
← {"type":"system","subtype":"post_turn_summary","status_detail":"replied 'ok' as requested",…}
← {"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":1,"duration_ms":4312,"total_cost_usd":0.0043,"terminal_reason":"completed","user_message_uuid":"ec77…"}
← {"type":"command_lifecycle","command_uuid":"ec77…","state":"completed"}
```
Raw logs from these runs: `%TEMP%\ember-proto-research\run-*.jsonl` (basic, ask, img).

---

## 10. Risks for a full UI on this protocol

1. **Moving target.** The protocol is versioned only by `capabilities` strings; 2.1.316 already
   emits message types missing from SDK 0.3.317's union. The CLI auto-updates under Ember.
   Mitigation: tolerant parser, feature-detect via `capabilities`, track `sdk.d.ts` diffs in CI,
   optionally pin the CLI binary Ember spawns.
2. **Startup latency.** ~4–9 s from spawn to `initialize` response on the box (user
   SessionStart hook + 30+ MCP servers + plugins). Keep one warm process per tab; don't
   respawn per message.
3. **Interactive-only features** (login, MCP OAuth, `/resume` picker, terminal commands) need
   either Ember-native rebuilds or the TUI escape hatch on the same session id.
4. **Permission semantics are subtle** (safety checks, `suppress_always_allow_rule`,
   `classifier_approvable`, subagent `agent_id`, cancellation). A wrong default = silent
   auto-approval or a stuck turn; never leave a `can_use_tool` unanswered.
5. **Queue/interrupt model** differs from the TUI: queued messages auto-run after an interrupt
   unless `cancel_queued` is used.
6. **One owner per session** — the TUI and the stdio process must not run the same session
   concurrently.
7. **Windows paths**: 8.3 short paths trigger safety prompts; use long cwd paths.
8. **Cost display**: `total_cost_usd` is list-price even on a subscription.
