#!/usr/bin/env bash
set -e

npm run build
cd dist
rm -rf .git
git init
git branch -M gh-pages
git config user.name "Afterlight0338"
git config user.email "95558336+Afterlight0338@users.noreply.github.com"
git add -A
git commit -m "Deploy to hitsound.vivlos.dev [$(date -u +'%Y-%m-%d %H:%M:%S UTC')]"
git remote add origin https://github.com/Afterlight0338/hitsound-studio.git
git push origin gh-pages --force
rm -rf .git
echo "✔ Successfully deployed to https://hitsound.vivlos.dev/!"
