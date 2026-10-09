#!/bin/bash
# The rc variables are read inside the check expressions, which check() runs
# with eval; shellcheck cannot see into those strings.
# shellcheck disable=SC2034
# Exercises subquery-deploy's git handling against a scratch clone: the host's
# local edits come back whether the deploy succeeds or fails, no stash entry
# is left behind, untracked files (.yarn/) do not get in the way, and only a
# commit on main is deployed. yarn, subql and docker are replaced with a
# command that succeeds, or with one that fails.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
git() { command git -c user.email=t@t -c user.name=t "$@"; }

git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
( cd "$T/work" && echo 'endpoint: repo' > pezkuwi.yaml && git add . && git commit -qm one && git push -q origin main )
git clone -q "$T/origin.git" "$T/host" 2>/dev/null
( cd "$T/host" && echo 'endpoint: host-local' > pezkuwi.yaml && mkdir .yarn && echo cache > .yarn/x )

make_script () {  # make_script <build command>
  sed -e "s#^cd /opt/subquery\$#cd $T/host#" \
      -e "s#^yarn install --frozen-lockfile\$#$1#" \
      -e 's#^\./node_modules/\.bin/subql .*$#true#' \
      -e 's#^docker compose .*$#true#' \
      "$HERE/subquery-deploy" > "$T/deploy"
  chmod +x "$T/deploy"
}
push_commit () { ( cd "$T/work" && echo "$1" > other.txt && git add . && git commit -qm "$1" && git push -q origin main && git rev-parse HEAD ); }

pass=0; fail=0
check () { if eval "$2"; then echo "ok    $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
host_edit () { grep -q host-local "$T/host/pezkuwi.yaml"; }
stashes () { (cd "$T/host" && git stash list | wc -l); }

make_script true
S2=$(push_commit two)
"$T/deploy" "$S2" >/dev/null 2>&1; rc=$?
check "a deploy of main's head succeeds"                '[ $rc = 0 ] && [ "$(cd "$T/host" && git rev-parse HEAD)" = "$S2" ]'
check "the host's local edit is back"                   'host_edit'
check "no stash entry is left"                          '[ "$(stashes)" = 0 ]'
check "untracked files are untouched"                   '[ -f "$T/host/.yarn/x" ]'

make_script false
S3=$(push_commit three)
"$T/deploy" "$S3" >/dev/null 2>&1; rc=$?
check "a failing build fails the deploy"                '[ $rc != 0 ]'
check "the local edit is back after a failure"          'host_edit && [ "$(stashes)" = 0 ]'

make_script true
S4=$(push_commit four); S5=$(push_commit five)
"$T/deploy" "$S4" >/dev/null 2>&1; rc=$?
check "a SHA behind main's head is not deployed"        '[ $rc != 0 ] && host_edit && [ "$(stashes)" = 0 ]'

( cd "$T/work" && git checkout -qb side && echo x > side.txt && git add . && git commit -qm side && git push -q origin side )
SIDE=$(cd "$T/work" && git rev-parse HEAD)
"$T/deploy" "$SIDE" >/dev/null 2>&1; rc=$?
check "a commit that is not on main is refused"          '[ $rc != 0 ] && [ "$(cd "$T/host" && git rev-parse HEAD)" != "$SIDE" ] && host_edit'

"$T/deploy" 'abc; id' >/dev/null 2>&1; rc=$?
check "anything but a full SHA is refused"               '[ $rc = 2 ]'

echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
