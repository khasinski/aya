#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

cache_dir="${RUNNER_TEMP:?}/e2e-system-deps"
package_manifest() {
  dpkg-query -W -f='${db:Status-Abbrev}\t${binary:Package}\t${Version}\n' |
    awk -F '\t' '$1 == "ii " { print $2 "\t" $3 }' | sort
}

case "${1:?prepare or install}" in
  prepare)
    # Keep the runner's third-party mirrors out of the cold install too.
    sudo rm -f /etc/apt/sources.list.d/*google* \
      /etc/apt/sources.list.d/*chrome* \
      /etc/apt/sources.list.d/*microsoft* \
      /etc/apt/sources.list.d/*vscode*
    mkdir -p "$cache_dir"
    package_manifest > "$RUNNER_TEMP/e2e-packages-before.tsv"
    echo "image=${ImageOS:?}-${ImageVersion:?}" >> "$GITHUB_OUTPUT"
    echo "packages=$(sha256sum "$RUNNER_TEMP/e2e-packages-before.tsv" | cut -d ' ' -f 1)" >> "$GITHUB_OUTPUT"
    ;;
  install)
    if [[ "${SYSTEM_DEPS_CACHE_HIT:-false}" == true ]]; then
      # Restore installed files AND dpkg state, on the identical runner image
      # and base package manifest only. No apt update/download/configure here.
      sudo tar -xf "$cache_dir/installed.tar" -C /
      sudo ldconfig
      package_manifest > "$RUNNER_TEMP/e2e-packages-restored.tsv"
      diff -u "$cache_dir/packages.tsv" "$RUNNER_TEMP/e2e-packages-restored.tsv"
      echo "Electron system dependencies restored from cache"
    else
      # Preserve Playwright's complete, version-matched package list, including
      # Firefox/WebKit dependencies and fonts, rather than hand-maintaining it.
      npx playwright install-deps
      sudo apt-get install -y xvfb
      package_manifest > "$cache_dir/packages.tsv"
      mapfile -t changed_packages < <(
        comm -13 "$RUNNER_TEMP/e2e-packages-before.tsv" "$cache_dir/packages.tsv" | cut -f 1
      )
      # --no-recursion records directory metadata without archiving whole /usr.
      # alternatives/fontconfig retain the configured font links and caches;
      # the dpkg database retains package presence and configuration state.
      {
        if (( ${#changed_packages[@]} )); then
          dpkg-query -L "${changed_packages[@]}"
        fi
        find /var/lib/dpkg /etc/alternatives /var/cache/fontconfig \
          ! -name 'lock*'
      } | sort -u > "$RUNNER_TEMP/e2e-package-paths.txt"
      while IFS= read -r path; do
        if [[ -e "$path" || -L "$path" ]]; then
          printf '%s\0' "${path#/}"
        fi
      done < "$RUNNER_TEMP/e2e-package-paths.txt" > "$RUNNER_TEMP/e2e-package-paths.nul"
      sudo tar --create --file "$cache_dir/installed.tar" --directory / \
        --no-recursion --null --files-from "$RUNNER_TEMP/e2e-package-paths.nul"
      # actions/cache runs without sudo, and must be able to read the archive.
      sudo chown "$(id -u):$(id -g)" "$cache_dir/installed.tar"
      echo "Cached ${#changed_packages[@]} new or upgraded packages"
    fi
    ;;
  *) exit 2 ;;
esac
