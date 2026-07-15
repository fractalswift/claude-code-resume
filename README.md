# Claude Session Manager

A terminal UI for browsing and resuming Claude sessions.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Claude CLI](https://claude.ai/download)

## Install

```sh
bun add -g claude-session-manager
```

## Usage

```sh
cs
```

- Browse your sessions with arrow keys
- Type or press "/" to search via session content
- Press "S" to sort by location of chat start rather than just most recent
- Press Enter to resume a chat and be moved to that location.

## Note on session history

Claude Code deletes session transcripts after 30 days by default, so `cs` can only show sessions still on disk. To keep sessions around longer, add to `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 90
}
```
