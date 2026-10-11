#!/usr/bin/env bash
# Commits whatever a Claude Code session left changed in this project when it finishes a turn,
# so committing is nobody's job and never comes up in the chat. Wired up as a Stop hook in
# .claude/settings.json. Silent by design: it prints nothing and always exits 0.
#
# Inside Craft Studio the app commits each turn's changes itself (src/host/teamwork.ts), so a Claude
# session that Craft Studio started is left to it.
case "${CLAUDE_AGENT_SDK_CLIENT_APP:-}" in rocket/*) exit 0 ;; esac

cd "$(dirname "$0")/.." || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" || exit 0

# Never in the middle of something done by hand, and only on a branch.
gitdir=$(git rev-parse --git-dir)
for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply; do
  [ -e "$gitdir/$state" ] && exit 0
done
git symbolic-ref -q HEAD >/dev/null || exit 0

git add -A 2>/dev/null || exit 0
git diff --cached --quiet && exit 0

# The message names what changed: "Update hub.ts, store.ts (+3 more)".
mapfile -t files < <(git diff --cached --name-only)
names=$(printf '%s\n' "${files[@]:0:3}" | xargs -d '\n' -n1 basename | paste -sd, | sed 's/,/, /g')
more=$(( ${#files[@]} - 3 ))
[ "$more" -gt 0 ] && names="$names (+$more more)"
git commit -q --no-verify -m "Update $names" -m "Committed automatically at the end of a Claude Code turn." >/dev/null 2>&1
exit 0
