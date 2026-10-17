#!/usr/bin/env bash
#
# Publish Rookeepa to GitHub and switch on GitHub Pages.
#
#   ./scripts/publish.sh                        # <your-account>/rookeepa
#   ./scripts/publish.sh rookeepa/rookeepa      # an organisation, or another name
#   ./scripts/publish.sh me/my-books private    # keep it to yourself
#
# Needs the GitHub CLI, signed in once:
#
#   brew install gh
#   gh auth login
#
# Then the app is live at https://<owner>.github.io/<repo>/ a minute or two
# after the Deploy workflow finishes. There is no build step to configure.

set -euo pipefail

TARGET="${1:-}"
VISIBILITY="${2:-public}"
DESCRIPTION="Free, open-source, local-first bookkeeping for small business — runs entirely in your browser, no account and no subscription."

case "$VISIBILITY" in
  public|private) ;;
  *) echo "Visibility must be 'public' or 'private' (got '$VISIBILITY')." >&2; exit 1 ;;
esac

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI not found. Install it with:  brew install gh" >&2
  exit 1
}

if ! gh auth status >/dev/null 2>&1; then
  echo "Not signed in to GitHub. Run:  gh auth login" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

if [ -z "$TARGET" ]; then
  TARGET="$(gh api user -q .login)/rookeepa"
fi

# Accept "owner/repo", or just "repo" to mean your own account.
case "$TARGET" in
  */*)
    OWNER="${TARGET%%/*}"
    REPO="${TARGET##*/}"
    ;;
  *)
    OWNER="$(gh api user -q .login)"
    REPO="$TARGET"
    ;;
esac

if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
  echo "Give the target as owner/repo, e.g. rookeepa/rookeepa or me/my-books." >&2
  exit 1
fi

git rev-parse --verify HEAD >/dev/null 2>&1 || {
  echo "This repository has no commits yet — commit something first." >&2
  exit 1
}

echo "Publishing $OWNER/$REPO ($VISIBILITY)…"

if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  # The repository already exists (you created it on GitHub, say). Point this
  # clone at it and push, instead of trying to create it a second time.
  echo "Repository already exists — pushing to it."
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "https://github.com/$OWNER/$REPO.git"
  else
    git remote add origin "https://github.com/$OWNER/$REPO.git"
  fi
  git push -u origin HEAD:main
else
  echo "Creating the repository."
  gh repo create "$OWNER/$REPO" \
    --"$VISIBILITY" \
    --source=. \
    --remote=origin \
    --push \
    --description "$DESCRIPTION"
fi

# Turn on Pages, served by the workflow in .github/workflows/pages.yml.
if gh api "repos/$OWNER/$REPO/pages" >/dev/null 2>&1; then
  echo "GitHub Pages is already enabled."
else
  echo "Enabling GitHub Pages (source: GitHub Actions)…"
  gh api -X POST "repos/$OWNER/$REPO/pages" -f build_type=workflow >/dev/null
fi

echo
echo "Repository:  https://github.com/$OWNER/$REPO"
echo "Live app:    https://$OWNER.github.io/$REPO/"
echo
echo "The Deploy workflow runs on every push to main. Watch the first run with:"
echo "  gh run watch --repo $OWNER/$REPO"
