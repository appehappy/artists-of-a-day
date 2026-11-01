#!/bin/zsh
# Upload the artwork (site/media/img and site/media/thumbs, ~13 GB, symlinks into
# Dropbox) to the Bunny storage zone the hosted site takes its images from. Re-runs
# only send what's new or changed. Needs rclone and a remote for the storage zone; see
# scripts/deploy.env.example. Extra arguments go to rclone (e.g. --dry-run).
set -eu
cd "${0:A:h}/.."
source scripts/deploy.env

command -v rclone >/dev/null || { echo "rclone isn't installed: brew install rclone"; exit 1; }
remote="${IMAGE_DEST%%:*}"
rclone listremotes | grep -qx "$remote:" || { echo "No rclone remote '$remote': run rclone config"; exit 1; }

# Caching is set on the pull zone (a year: images never change once published).
for dir in thumbs img; do
  echo "== $dir"
  rclone copy -L "site/media/$dir" "${IMAGE_DEST}$dir" \
    --transfers "${TRANSFERS:-16}" --checkers 16 --size-only \
    --progress --stats-one-line "$@"
done
