# Plan — local computer workstation for Digital employees (Agent Hangar Desktop)

Status: **approved and implemented** (2026-11-07). Differences from the proposal, found while building:

- The app lists the employees with `GET /api/employees?mine=1` (only the ones the person manages): the platform's
  contract keeps the full list out of the app token.
- The numbered elements of the last screen are saved with the task, so a click by element number still works when the
  task comes back after a decision (found by the real-screen smoke test).
- The real-screen smoke test (`tests/unit/computer-real.test.ts`, opt-in with `HANGAR_REAL_COMPUTER=1`) and the demo use
  a tiny WinForms "Mini ERP" compiled on the fly (`tests/computer/MiniErp.cs`) instead of Notepad: Windows 11 Notepad
  keeps unsaved tabs, so it would leave traces on the person's machine.
- One employee per computer at a time (the panel switches employees by turning the workstation off and on).

## 1. Goal and shape

A Digital employee operates the GUI of the machine where Agent Hangar Desktop is installed: it looks at the screen,
clicks, types, presses keys, scrolls and opens the apps the person allowed. It works only on a machine where the person
explicitly turned it on, for an employee they manage, inside apps they picked.

It is the same shape as the VS Code workstation, with the GUI in place of files and terminal:

```
Desktop app (main process)                         Platform (central_agents)
features/computer/worker.ts                        /hooks/worker/heartbeat   -> next task (claimed)
  heartbeat loop ─────────────────────────────────▶ /hooks/worker/tasks/{id}/agui -> employee brain (instructions,
  AG-UI round, client tools = desktop_*  ◀──────────     skills, MCPs, memory), returns our tool calls
  for each call:
    guard (allowed app? window? combo?)  local
    gate  (every action except look/scroll) ──────▶ /gate  desktop:<action> -> commit detection + authority
                                                       (screenshot as evidence, timeline event, secret://)
    driver: capture / click / type / key
    progress (tool step, window after)   ─────────▶ /progress
  result done | failed | waiting        ─────────▶ /result
```

Same rules as the governed Linux desktop (`services/desktop.py`): same tool names and schemas, same commit detection
(salvar/confirmar/enviar/pagar…, `Salvar como…` only opens a dialog, the "Sim" right after an approved click is covered,
retry of an approved click without effect is covered, repeated confirmation is refused), the click runs where the
person approved, `secret://` typing, allowed-app list. The difference: the decisions move into a shared core that both
the container tools and the new worker gate use, so one rule set governs both desktops.

## 2. Platform changes (central_agents)

1. **Shared decision core** — refactor `services/desktop.py`: `_commit_ref`, `_covered_dialog`, `_retry_of`,
   `_confirmations`, `_approved_where`, `OPEN_KEYS`, `DIALOG`, `COMMIT` and the evidence/gate step become functions
   that take `(ctx, label|key|text, window, where, screenshot)` instead of calling the container. Container tools keep
   their exact behavior (existing tests must pass unchanged).
2. **New `services/desktop_local.py`** — the gate for an external worker's GUI actions:
   - refs `desktop:open | desktop:click | desktop:type | desktop:key` (sent to `/gate` as `tool`); look/scroll need no gate.
   - every gated action writes the `desktop` event on the task timeline (action, target, value, window, machine,
     approved / covered_by) — the same events the container writes, so `_confirmations`/`_retry_of` work unchanged.
   - commit-like → `platform:desktop_commit | desktop_pay | desktop_send` through `tasksmod._gate`, the screenshot sent
     by the worker stored as task evidence (`tela-….png`) and referenced in the approval ("Tela: …"), exactly like now.
   - answers: `allowed` (+ `where` approved, `approved`, `covered_by`), `waiting` (+ `request_id`), `denied`
     (+ message, also used for the "NÃO CONFIRMEI: repeated confirmation" check), `simulated` (shadow mode).
   - `text: "secret://name"` → resolved with `secrets_vault.resolve(…, f"desktop:{slug}")`, returned **only** in the gate
     response to the authenticated worker; the timeline shows `[segredo]`; never enters the conversation.
3. **Hooks** — `WorkerGateBody` gains `screenshot` (base64 PNG, ≤ 2 MB, only for click/key/type-with-Enter) and
   `ProgressBody` gains `desktop: {after_window}` (patches the last `desktop` event; `_retry_of` needs it).
4. **No shadowing** — `desktop._avail` is false when `employee.runtime == "external"` (the worker's machine is that
   employee's desktop), so the runtime never drops our client tools for the platform tools with the same names.
5. **App scope** — `GET /api/employees` and `PUT /api/employees/{slug}/runtime` get `member_route(allow_app=True)`
   (the `manage` permission is still checked in `find`), so the Desktop app can list the employees the person manages
   and turn one into its worker.
6. **Employee screen** — `worker_info` shows "Computador (HOST) · apps: …" so managers see where it runs.
7. **Tests (pytest)** — commit click → waiting with evidence file; plain click → allowed + event; covered "Sim";
   retry; repeated confirmation refused; Return outside a dialog not gated; `secret://` value only in the gate answer and
   `[segredo]` on the timeline; shadow mode; container tools regression.

## 3. Desktop app changes (hangar)

New feature `src/main/features/computer/` (registered in `features/index.ts`):

| File                   | Role                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controller.ts`        | per-machine config (enabled employees, allowed apps), enable/disable, state broadcast, IPC `computer:*`                                                                                                         |
| `worker.ts`            | the loop ported from `extensions/vscode/src/worker.ts`: heartbeat, AG-UI rounds, `runCalls` with gate, decisions on return, saved state per task (`userData/computer/task-<id>.json`), orphan resume, keepalive |
| `agui.ts`, `client.ts` | pure ports of `parseAgui`, `compact`, `decisionResult`, `toolOk`, `WorkerClient` (+ screenshot field)                                                                                                           |
| `tools.ts`             | tool specs with the same names/schemas as `desktop.py` (`desktop_open/look/click/type/key/scroll/screenshot`)                                                                                                   |
| `guard.ts`             | pure checks before any input: allowed app, hard-blocked apps, point inside the target window, blocked combos                                                                                                    |
| `presence.ts`          | human-input detection and the pause state machine (clock injected, unit-tested)                                                                                                                                 |
| `overlay.ts`           | the "controlling this computer" indicator, window highlight and kill switch                                                                                                                                     |
| `apps.ts`              | installed-app discovery (Start Menu shortcuts + running windows) for the picker                                                                                                                                 |
| `driver/`              | `types.ts` (interface), `windows.ts` + `helper/HangarDesktopHelper.cs`, `fake.ts` (tests/e2e)                                                                                                                   |

Renderer: `features/computer/` — a "Posto no computador" panel: pick an employee you manage, turn it on for this
machine, pick allowed apps (with warnings), see status (online, current task, last actions), Stop.

### 3.1 Drivers

A small helper process speaking JSON lines over stdio, written in C# against OS APIs: `SendInput`
(mouse/keyboard, Unicode typing), `SetForegroundWindow`, `WindowFromPoint`/`GetAncestor`, `GetWindowThreadProcessId`,
`PrintWindow(PW_RENDERFULLCONTENT)` for **window** capture, UI Automation (`System.Windows.Automation`) for the numbered
elements and `IsPassword`, `GetLastInputInfo` for presence, per-monitor DPI awareness. It is compiled on first use with
the in-box `csc.exe` (.NET Framework 4.x, present on every Windows 10/11) into `userData`, cached by source hash —
no new native npm module, no build toolchain, no download. Fallback: the same C# via PowerShell `Add-Type`.

Why not a library: `@nut-tree/nut-js` moved prebuilt binaries behind a paid registry; `robotjs` is unmaintained;
the `@nut-tree-fork` / `@jitsi/robotjs` forks work but give no UI Automation, no per-window capture and no password-field
check, which the safety rules need. The interface keeps the door open:

- **macOS** (built 2026-11-07, `driver/macos.ts` + `helper/HangarDesktopHelper.swift`): the same JSON-lines protocol;
  CGEvent for input, ScreenCaptureKit (macOS 14+) capturing only the allowed apps, the Accessibility API for elements and
  secure text fields; compiled on first use with `swiftc` (or shipped prebuilt as `resources/computer-helper-macos`).
  Needs Accessibility + Screen Recording grants. **Not run yet on a Mac** (no Mac here).
- **Linux X11** (built 2026-11-07, `driver/linux.ts`): xdotool + xprop + ImageMagick `import` + xprintidle + AT-SPI
  (python3-gi); verified on Xvfb + openbox with a GTK form in Docker. **Wayland**: only XWayland apps (no global input
  without the portal).

The model sees a downscaled capture of the target window (≤ 1366 px wide); coordinates are mapped back.

### 3.2 Screenshots to the model

AG-UI tool messages are text-only in the runtime. After the tool results of a step, the worker adds one user message
with AG-UI `binary` image parts and the same marker the runtime uses for server tools ("Imagens devolvidas pelas
ferramentas nesta etapa …"), so the runtime's `_prune_images` keeps only the latest ones; the worker also keeps only the
last 3 captures in its saved state. Needs a vision model on the employee (otherwise the tools still return the
accessibility elements as text). No runtime change.

## 4. Safety rules (enforced in the main process, before every action)

1. **Opt-in per employee and per machine** — off by default. The person signs in, picks an employee they manage,
   turns it on for _this_ machine and picks the allowed apps. The worker token (`ewk_…`) is kept with `safeStorage`
   (DPAPI). Turning it off stops the worker at once and (optionally) returns the employee to the platform runtime.
2. **Allowed apps only** — an app = executable path + process name. Before each input: the target window is foreground,
   its process is allowed, the point is inside it and the window under the point belongs to an allowed process
   (dialogs owned by the app count). Typing/keys only with an allowed app in front. Captures are of that window only,
   never the full screen — other apps are never shown to the model.
   - **Never allowed:** Agent Hangar Desktop itself, Task Manager, Settings, Registry, MMC, Windows Security,
     credential/UAC prompts. Elevated windows are unreachable anyway (UIPI) and the model is told so.
   - **Allowed with a warning:** browsers (the portal is there — an agent in your signed-in browser could act as you),
     terminals (use the VS Code workstation), File Explorer.
   - **Blocked keys:** Win+anything, Ctrl+Alt+Del, Alt+Tab, Ctrl+Esc, Alt+Esc; app switching only via `desktop_open`.
3. **Visible indicator + kill switch** — while a task runs: an always-on-top pill ("● <Employee> está usando este
   computador · tarefa #N · Parar"), a colored border around the controlled window and a tray icon state. Both are
   content-protected, so they never show in the captures. **Ctrl+Alt+End** stops from anywhere. Stop = abort the
   in-flight action, release any held keys/buttons, stop the heartbeat (stays off until the person turns it on again),
   hand the task back (`result waiting` + note "parado pela pessoa").
4. **Pause when the person moves the mouse/keyboard** — the helper compares `GetLastInputInfo` with its own injection
   times; input that is not ours pauses the worker before its next action. The pill shows "Pausado — você está usando o
   computador · Retomar · Parar"; it resumes after 15 s without input (configurable) or on "Retomar". After a pause the
   worker re-captures and, if the window changed, gives the model the new screen instead of acting blind. Locked screen
   or a secure desktop → paused.
5. **Gate for commit-like actions** — section 2.2; the approval carries the screenshot; the click happens where the
   person approved.
6. **Secrets never shown to the model** — `secret://name` resolved by the platform vault, typed by the helper, never
   logged or saved; typed only into a focused field that UI Automation reports as a password field (otherwise refused).
7. **Audit** — every gated action is a `desktop` event on the task timeline (written by the platform at gate time) plus
   a `tool` step with result and duration; a local JSONL log (no screenshots, no secrets) is viewable in the panel.

## 5. Tests

- **Unit (vitest)**: AG-UI parse/compact/image pruning; guard (blocked apps, combos, point-in-window, owned dialogs);
  presence state machine; coordinate scaling; worker loop with fake driver + fake client — gate waiting → saved state →
  task returns with the decision → click at the approved point; denied; shadow; secret never in saved state or log;
  stop releases keys and hands the task back; orphan resume.
- **e2e (Playwright, mock platform)** `tests/e2e/computer-workstation.spec.ts`: mock platform gains `/api/employees`,
  runtime, `/hooks/worker/*` with a scripted AG-UI brain (look → type → click "Salvar" → waiting → approve → click →
  done); fake driver (`HANGAR_COMPUTER_DRIVER=fake`, nothing real moves in CI). Checks: opt-in panel, indicator visible,
  approval with screenshot, timeline events, simulated human input pauses, Stop hands the task back.
- **Real-driver smoke (opt-in, Windows)** like `workspace-real.spec.ts`: Notepad, type, Ctrl+S gated.
- Platform pytest as in 2.7.

## 6. Docs and demo

- hangar: `docs/FEATURES.md`, `docs/SECURITY.md` (new threat-model section: GUI control), `docs/ARCHITECTURE.md`,
  README section; platform: computer use docs + CHANGELOG entry.
- Live demo on this machine: an employee opens Notepad (allowed), writes a text, Ctrl+S → approval with the screen in
  Decisões → approve in the app → saved; move the mouse → pause → resume; Ctrl+Alt+End → stop.
- No release, tag or push without your explicit OK.

## 7. Limits and follow-ups (not in this work)

- **One workstation per employee**: the platform has one worker token per employee, so the same employee can't be in
  VS Code and on the computer at once (turning one on revokes the other). Follow-up: token per workstation.
- macOS / Linux drivers; unattended work (locked screen) is not possible by design; "work only when idle" mode.
- The VS Code worker core and this one are copies; a shared package can come later.
