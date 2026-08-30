# Security Policy

## Reporting a Vulnerability

Please report security issues through
[GitHub private vulnerability reporting](https://github.com/ShuhangGe/grokbot-queue/security/advisories/new)
rather than a public issue.

## Security Model — Read This Before Using

gbq drives the Grok Bot desktop app through interfaces that were not designed
for external automation. That has concrete consequences you should understand.

### The Electron inspector is an open door while it is open

To send a message, gbq sends `SIGUSR1` to the Grok Bot process, which opens a
Node.js inspector on `127.0.0.1:9229`. **While that port is open, any process
on your machine can connect to it and fully control Grok Bot** — read every
conversation, send messages as you, and execute JavaScript in the app.

gbq closes the inspector after every operation. If you build on top of
`lib/botctl.sh`, keep that guarantee: always call `inspector_close`.

### The cloud machine is third-party hosted

Bots run on a machine managed by Cursor. Its lifecycle, snapshots and backup
policy are outside your control.

- **Do not store long-lived credentials on it.**
- `gbq ctx sync` **uploads your project source** to that machine. Evaluate
  this before pointing it at anything confidential.
- All Bots on the machine share `/workspace` and can read each other's files.

### SSH exposure

The setup instructions start `sshd` bound **only to the Tailscale address**,
with password authentication disabled. Do not change it to listen on
`0.0.0.0` — the machine may have a public interface.

Use a dedicated SSH key (`~/.ssh/grokbot_ed25519`), not your primary key.

### Scope

Issues in Cursor's Grok Bot itself are not in scope here — report those to
Cursor. This policy covers gbq's own handling of credentials, ports and
uploaded data.
