#!/bin/sh
# Stamp each local stylesheet and script in index.html with a hash of its
# contents (e.g. js/app.js?v=3f9c2a1b), so browsers fetch a fresh copy only
# when a file has actually changed. Run after editing, before uploading:
#
#   ./bust-cache.sh
set -e
cd "$(dirname "$0")"

for f in css/style.css js/app.js; do
  v=$(shasum "$f" | cut -c1-8)
  F="$f" V="$v" perl -pi -e 's/(["\x27])\Q$ENV{F}\E(?:\?v=[0-9a-f]*)?\1/$1$ENV{F}?v=$ENV{V}$1/g' index.html
  echo "$f?v=$v"
done
