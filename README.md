# Canvas Inbox Messenger

Download the [macOS and Windows packages from Releases](https://github.com/davashby/canvas-inbox-messenger/releases). Both packages include the shared plugin source and setup scripts for both platforms. Follow the setup section for your operating system below.

Version 0.4.0 supports Windows and macOS with Node.js 22 or newer. This is a local desktop plugin for BYU-Idaho Canvas (`https://byui.instructure.com`). It requires a local execution environment; it is not a hosted web/mobile connection. No credentials or student data are included in this package.

The workflow has five stages:

1. Show available courses with names, exact course codes, IDs, and supplied dates; ask which to use.
2. Ask for conditions in natural language, such as a grade threshold or no recorded activity since Monday.
3. Show all matching students and ask the teacher to approve the list.
4. Ask what the message should say, or help draft it.
5. Show the personalized message and obtain separate approval before sending.

The teacher's own Canvas account sends a separate private Inbox conversation to each student. The Instructure documentation MCP provides API reference only; this plugin's Canvas API server supplies live data and messaging.

## Windows setup

Install Node.js 22 or newer with Node added to PATH, and the Codex CLI/desktop application with local MCP and plugin support. Close and reopen the desktop app after installing Node. Windows PowerShell 5.1, included with Windows, handles token storage; no PowerShell modules are required.

Extract the ZIP to a permanent folder. Open PowerShell in the extracted `canvas-inbox-plugin` folder. All commands below run from that folder.

Create a personal access token in Canvas using your own instructor account. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\set-token.ps1
```

Paste the token into the hidden prompt. The script stores an encrypted token at `%APPDATA%\Canvas Inbox Messenger\token.dpapi`, protected by Windows DPAPI for your Windows account. Set up the token separately on each computer; do not copy the encrypted token file to a colleague. The internal `get-token.ps1` helper is for the launcher; do not run it manually because its output contains the token.

Register the extracted folder as a local plugin and register its tools:

```powershell
$canvasMarketplace = node .\scripts\prepare-marketplace.mjs
codex plugin marketplace add "$canvasMarketplace"
codex plugin add canvas-inbox-plugin@canvas-inbox-local
$canvasNode = node -p "process.execPath"
$canvasStart = (Resolve-Path .\scripts\start.mjs).Path
codex mcp add canvas-inbox -- "$canvasNode" "$canvasStart"
```

The marketplace helper creates a local marketplace and copies the plugin into your application-data folder. The explicit MCP registration above points to the extracted folder, so keep it in place. If you move it or install an updated ZIP, rerun the registration commands from the new folder. No administrator session is needed. If your institution blocks PowerShell scripts through Group Policy, ask your IT team for an approved setup method.

Restart the desktop app, begin a new Local chat, select Canvas Inbox Messenger, and ask “Show my available Canvas courses.”

## macOS setup

Install Node.js 22 or newer and the Codex CLI/desktop application with local plugin support. Extract the ZIP to a permanent folder and open Terminal in its `canvas-inbox-plugin` folder.

```bash
bash scripts/set-token.sh
canvas_marketplace="$(node scripts/prepare-marketplace.mjs)"
codex plugin marketplace add "$canvas_marketplace"
codex plugin add canvas-inbox-plugin@canvas-inbox-local
canvas_node="$(node -p 'process.execPath')"
canvas_start="$PWD/scripts/start.mjs"
codex mcp add canvas-inbox -- "$canvas_node" "$canvas_start"
```

The hidden token prompt stores your own token in macOS Keychain under service `canvas-inbox-plugin`, account `byui.instructure.com`. Existing Keychain tokens and saved Mac course selections remain compatible. `scripts/start.sh` is retained for existing Mac MCP registrations. Restart the app and begin a new Local chat after installation.

## Course scope and tools

`list_available_courses` lists courses with active teacher enrollments and Canvas available status, without changing the saved selection. Canvas may return older courses or sandboxes with those statuses; supplied dates help the teacher identify intended courses. A Canvas ID such as 76 is distinct from a course code such as SPAN101.

`configure_course_codes` saves the full teacher-selected set using exact codes and IDs. Student selection, assignment access, and sending are restricted to that set and rechecked against Canvas. Changing the set invalidates recipient lists and message previews.

`preview_recipients` finds matching students without message text. `get_recipient_list` retrieves the complete audience in pages. After teacher approval, `approve_recipient_list` permits drafting. `preview_message` takes the approved `recipient_list_id`, subject, and body template, preserving exactly those students. `get_preview_recipients` shows rendered messages; `send_preview` sends only after final teacher approval. Each send call handles up to 20 students; approved batches continue until complete or stopped. Recipient lists and message previews expire after 30 minutes and are held only in server memory.

Saved course scope is located at:

- Windows: `%APPDATA%\Canvas Inbox Messenger\course-scope.json`
- macOS: `~/Library/Application Support/Canvas Inbox Messenger/course-scope.json`

## Course links in messages

During drafting, ask for a course item in ordinary language, for example: “Include links to the Week 3 study guide and the practice quiz.” The assistant searches the selected course's published pages, assignments, quizzes, and discussions, clarifies ambiguous matches, then includes the chosen links in your final message preview. New Quizzes are found through Canvas assignment links.

Messages contain readable titles followed by full Canvas browser URLs. The Conversations API does not guarantee HTML or Markdown link formatting. The URLs can appear within a sentence or in an appended “Course links” section. Each course's message resolves its own items, so students receive that course's URLs. The recipient-list approval and final send approval still apply; changing links creates a new message preview.

The new `list_course_links` tool accepts `course_id`, optional `types` (`page`, `assignment`, `quiz`, `discussion`), optional title/ID `search`, and pagination. `preview_message.course_links` accepts up to 20 references with a unique `key`, returned `type` and `id`, and optional `label`. Pages use their returned URL slug as `id`. A body placeholder such as `{{link:study_guide}}` places that link; links without placeholders are appended. The server verifies item publication and the destination's course before previewing. Student access can still depend on unlock dates, prerequisites, and differentiated assignments.

Reading links additionally requires Canvas API permissions to read course pages, assignments, quizzes, and discussion topics. If an endpoint is unavailable, the tool reports that category rather than silently treating it as empty. References: [Pages](https://developerdocs.instructure.com/services/canvas/resources/pages), [Assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments), [Quizzes](https://developerdocs.instructure.com/services/canvas/resources/quizzes), [Discussions](https://developerdocs.instructure.com/services/canvas/resources/discussion_topics), [Conversations](https://developerdocs.instructure.com/services/canvas/resources/conversations).

## Conditions and permissions

Course grades use current or final percentage. Assignment grades use posted, non-excused score divided by possible points; unposted or ungraded submissions are excluded. Activity uses enrollment `last_activity_at`, which records course activity rather than a verified login. Relative periods use `inactive_for_days`; calendar boundaries use `inactive_since` with an ISO timestamp including timezone. The assistant clarifies ambiguous periods and whether never-active students should be included. Grade and activity rules can be combined with all or any.

The token must permit listing courses, assignments, enrollments, and assignment submissions, plus creating conversations. It inherits your Canvas account permissions. Each student receives a single-recipient private conversation, which Canvas may merge into an existing private thread with that student. If sending stops partway, inspect the uncertain recipient in Canvas before starting a new send.

## Checks and troubleshooting

Run the automated checks from the plugin folder on either platform:

```text
node --test server/canvas.test.mjs server/course-scope.test.mjs server/workflow.test.mjs server/platform.test.mjs server/course-links.test.mjs
```

If tools are missing, check `codex mcp get canvas-inbox`, confirm the displayed paths still exist, and restart the app in Local mode. If Node is missing, reinstall Node with PATH enabled or rerun registration using the resolved absolute Node path. If startup reports missing credentials, rerun the platform's token setup under the same operating-system account as the desktop app. Never paste the token into chat or put it in `mcp.json`.

The workflow checks and Mac startup were verified during development. Windows paths are covered by automated checks; PowerShell execution, DPAPI encryption/decryption, and desktop startup still need a check on a real Windows computer.
