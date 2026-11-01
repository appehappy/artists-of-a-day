#!/bin/zsh
# Build the site for archive.appppe.com/experiments/artists-of-a-day/ and deploy it to
# its Netlify site (the archive site proxies that path to it; see README, Hosting).
# The build includes the generated data (site/public/data, site/public/fields), which
# isn't in git, so deploys go from here rather than from GitHub. Upload any new images
# first with scripts/upload_images.sh.
set -eu
cd "${0:A:h}/.."
source scripts/deploy.env
[[ -n "${NETLIFY_SITE_ID:-}" ]] || { echo "Set NETLIFY_SITE_ID in scripts/deploy.env"; exit 1; }

cd site
PUBLIC_IMAGE_BASE="$PUBLIC_IMAGE_BASE" npm run build:archive
rm -rf dist/review # a local review page, not for the public site
npx --yes netlify-cli@latest deploy --prod --dir dist --site "$NETLIFY_SITE_ID" \
  --message "Artists of a Day $(git rev-parse --short HEAD)"
