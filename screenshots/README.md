# Screenshots

`hero.png` is the image referenced from the project README. Since 1ff1d11
(0.8.0) it is NOT a composite of `main.png` + `snippets-drawer.png` any more -
it is the emulator's `tiling` scenario, byte-identical to
`docs/assets/aya-tiling.png`. Regenerate it with:

```sh
npm run emulator:shot -- tiling --out screenshots
mv screenshots/tiling.png screenshots/hero.png
```

`main.png` and `snippets-drawer.png` are archived source captures, kept on
purpose: they are the only shots in the repo of the REAL app (every current
`docs/assets/aya-*.png` is an emulator shot). Nothing references them - the
`-append` recipe that once combined them into `hero.png` is gone.

To re-capture them with mocked data (no real project names or paths from your
machine):

```sh
./scripts/seed-screenshot.sh
AYA_HOME=/tmp/aya-demo AYA_DEV=1 npm run dev
# take the screenshot once the window is up, save as screenshots/main.png
# then:
rm -rf /tmp/aya-demo /tmp/aya-demo-projects
```

The seed script populates `/tmp/aya-demo` with the design's three demo
projects (armillary / atlas-api / portfolio-site), each backed by a real
git repo under `/tmp/aya-demo-projects/<name>` so the status bar shows a
clean branch.
