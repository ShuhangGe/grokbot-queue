# Contributing

## Before you start

Run the health check — it tells you which parts of the control path work:

```bash
gbq doctor
```

## The fragile part

gbq controls Grok Bot by driving its Electron UI. **There is no official API.**
DOM selectors in `lib/botctl.sh` (`.sand-prompt-field`, `button.sand-agent-item`,
`aria-label="Send message"`) can break whenever Cursor ships an update.

That is why there are three fallback levels (L1 exact selectors → L2 heuristics
→ L3 computer use). If you fix a broken selector, **fix L1 and leave L2 alone** —
L2 deliberately avoids `sand-*` classes so it survives redesigns.

Test a specific level with:

```bash
GBQ_FORCE_LEVEL=2 gbq bots
```

L1 and L2 should print identical output.

## Shell conventions

This codebase is bash targeting macOS, which means BSD userland. Two traps that
have already bitten us:

- **`sed` needs `-E`.** BSD sed does not support `\+` or `\?`.
- **Write `${var}` when a non-ASCII character follows.** `$var（` makes bash
  read the UTF-8 bytes as part of the variable name.

`set -euo pipefail` is on. Watch for `while read` loops (they exit 1 at EOF) and
commands that legitimately fail — both need `|| true`.

Run `bash -n` on anything you change.

## Testing changes

There is no automated suite yet. At minimum, verify by hand:

```bash
gbq doctor                    # all green
gbq bots                      # lists your Bots
GBQ_FORCE_LEVEL=2 gbq bots    # same output as above
gbq ask -b <bot> 'echo test'  # end-to-end
```

## Before opening a PR

- Do not commit anything from `~/.config/gbq/` — real hostnames and paths live
  there.
- Do not include your tailnet IP, Bot names, or SSH keys in code or docs.
- Record any new gotcha in `INTERNALS.md`. That table is the most useful part
  of this repo for the next person.
