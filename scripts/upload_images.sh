#!/bin/zsh
# Upload the artwork (site/media/img and site/media/thumbs, ~13 GB, symlinks into
# Dropbox) to the Cloudflare R2 bucket the hosted site takes its images from.
# Re-runs only send what's new or changed. Needs rclone and an R2 remote; see
# scripts/deploy.env.example.
set -eu
cd "${0:A:h}/.."
source scripts/deploy.env

command -v rclone >/dev/null || { echo "rclone isn't installed: brew install rclone"; exit 1; }
rclone listremotes | grep -qx "${R2_REMOTE}:" || { echo "No rclone remote '${R2_REMOTE}': run rclone config"; exit 1; }

# Images never change once published (new posts add new files), so browsers and
# Cloudflare can keep them for a year.
for dir in thumbs img; do
  echo "== $dir"
  rclone copy -L "site/media/$dir" "${R2_REMOTE}:${R2_BUCKET}/$dir" \
    --transfers 32 --checkers 32 --fast-list --size-only \
    --header-upload "Cache-Control: public, max-age=31536000, immutable" \
    --progress --stats-one-line
done
