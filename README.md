# gbq — run tasks on multiple Cursor Grok Bots, in parallel

**English** · [简体中文](README.zh-CN.md)

Your laptop's RAM stays flat no matter how many tasks you fan out. The work
happens on Grok Bot's cloud machine; locally there is only one Electron UI.

```bash
gbq ask -b my-bot 'What are the notable crypto stories this week? Cite sources and dates.'
```

The Bot opens a real browser, reads live pages, and comes back with URLs and
datelines.

```bash
gbq run 'audit error handling in src/api' 'summarize the test gaps' 'check for unused deps'
```

Three tasks, distributed across your Bots, running at the same time.

---

## Why this exists

Running N agents locally costs N × 150–335 MB and climbs with every task you
add. gbq holds at **~400 MB regardless of how many Bots or tasks you run**,
because each Bot has its own `exec-daemon` process in the cloud and your
machine only hosts the UI shell.

Measured on a 2-Bot setup:

| | Local agents | gbq |
|---|---|---|
| RAM on your machine | 150–335 MB × N | **~400 MB, flat** |
| Where work runs | your laptop | cloud (8 cores / 15 GiB) |
| Break-even | — | 3rd concurrent task |

Two Bots running 30-second tasks overlapped for 28 of those seconds — **1.88x
wall-clock speedup**, verified by timestamp, not by assumption. A 4-task batch
finished in 26 seconds.

---

## Quick start

You need: the Grok Bot desktop app running, Tailscale on both ends under the
same account, and `ssh node python3 curl lsof` locally.

```bash
git clone https://github.com/ShuhangGe/grokbot-queue ~/gbq
cd ~/gbq && chmod +x bin/gbq
export PATH="$HOME/gbq/bin:$PATH"

gbq setup      # guided; auto-detects the Linux node on your tailnet
gbq doctor     # health check — run this first whenever something breaks
gbq bots
gbq ask -b <bot> 'print the kernel version of the machine you are on'
```

**`gbq setup` will stop at the SSH step the first time. That is expected** —
the cloud machine ships without `sshd`. The wizard prints a command; paste it
to any Bot, then re-run setup. Full walkthrough in [SETUP.md](SETUP.md).

---

## Commands

```bash
gbq bots                          # list Bots
gbq ask  -b <bot> 'question'      # send, wait for the reply, print it
gbq send -b <bot> 'message'       # fire and forget
gbq read -b <bot> [-n N] [-A]     # read recent conversation

gbq ctx add <local-dir> [name]    # register a project so Bots can read your code
gbq ctx list | sync | rm
gbq run --ctx <name> 'task'...    # sync code, dispatch, wait, collect

gbq submit [-b <bot>] 'task'...   # queue without waking anyone
gbq dispatch                      # wake Bots that have pending work
gbq status | wait | collect | clean

gbq doctor
```

Exit code `0` on success, non-zero on failure.

---

## How it works

Cursor ships no public API for Grok Bot. gbq drives it through two channels:

```
local                            cloud (one machine, Bots share it)
  │
  ├─ submit   ──SSH──────────>   /workspace/gbq/<bot>/inbox/*.task
  │                              all task bodies in a single round trip
  │
  ├─ dispatch ─Electron CDP──>   one wake-up message per Bot
  │                                      │
  │                              Bots read their inbox and work in parallel
  │                                      │
  └─ collect  ──SSH──────────<   /workspace/gbq/<bot>/outbox/*.json
```

**Dispatch cost scales with the number of Bots, not the number of tasks.** One
hundred tasks across four Bots still costs about 16 seconds to dispatch,
because task bodies travel over SSH and only the wake-up goes through the UI.

The UI channel works by sending `SIGUSR1` to the Grok Bot process, which opens
a Node inspector; from there `webContents.executeJavaScript` reaches the
renderer. Since that depends on DOM selectors that any Cursor release can
change, there are three fallback levels:

| Level | Mechanism | Kicks in when |
|---|---|---|
| L1 | CDP + exact selectors | default |
| L2 | CDP + heuristics — widest `contenteditable`, list detected by repeated sibling structure | Cursor changes CSS classes |
| L3 | computer use (screenshot + click) | the DOM is unreachable |

L2 touches no `sand-*` class at all, and returns output identical to L1 in
testing. `gbq doctor` reports which level is currently live.

[INTERNALS.md](INTERNALS.md) documents the architecture and 16 gotchas found
while building this — the Tailscale SSH daemon hijacking port 22, off-Space
clicks that report success while doing nothing, ProseMirror ignoring direct
DOM writes, and more.

---

## Using it from an AI agent

Point your agent at [AGENTS.md](AGENTS.md) — it specifies each primitive's
blocking behavior, stdout format, exit codes, and failure modes.

Claude Code users can install the bundled skill:

```bash
ln -s "$PWD/.claude/skills/grokbot" ~/.claude/skills/grokbot
```

---

## Limitations

Stated plainly, because they shape whether this is useful to you:

| Limitation | Detail |
|---|---|
| Dispatch is serial | Only one Bot can be active at a time; switching costs ~4s each |
| Practical ceiling: 4–8 Bots | Beyond that, dispatch overhead and 8-core contention eat the gains |
| Bots share one machine | Not one machine per Bot — shared CPU, RAM, and `/workspace` |
| Bots have persistent memory | Unlike disposable workers, context accumulates across tasks |
| Everything depends on the desktop app running | Closing Grok Bot takes the cloud node offline too — **both** the SSH and CDP channels die |
| `sshd` does not survive container restarts | Started with `nohup`, not systemd — see SETUP.md |
| Built on UI automation | A Cursor update can break L1; L2 and L3 exist for that reason |
| Some sites are blocked in the cloud | `theblock.co`, `cointelegraph.com`, Google News return `ERR_BLOCKED_BY_RESPONSE`; CoinDesk works |

---

## Security

Read [SECURITY.md](SECURITY.md) before using this on anything sensitive. The
short version:

- While gbq is sending, `127.0.0.1:9229` accepts connections from **any local
  process**, each of which could then fully control Grok Bot. gbq closes it
  after every operation.
- `gbq ctx sync` **uploads your source code** to a Cursor-hosted machine.
- Never store long-lived credentials on that machine.
- `sshd` binds to the Tailscale address only; use a dedicated key.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The most valuable contribution is
keeping the selectors working after Cursor updates — and recording whatever
you learn in `INTERNALS.md`.

## Docs

| File | Audience |
|---|---|
| [SETUP.md](SETUP.md) | installation, configuration, troubleshooting |
| [AGENTS.md](AGENTS.md) | AI agents — primitive semantics, exit codes, failure modes |
| [INTERNALS.md](INTERNALS.md) | maintainers — architecture, measurements, gotchas |
| [README.zh-CN.md](README.zh-CN.md) | 中文文档 |

## License

MIT — see [LICENSE](LICENSE).
