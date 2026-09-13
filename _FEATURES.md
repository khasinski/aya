# Aya — capability inventory

Wygenerowane przez `featuring` (gather.py) uruchomione przez wrapper macOS
`recall-loop/skills/capability-audit/scripts/featuring_macos.py`.

- Zakres skanu: repozytorium bez `node_modules,dist,dist-electron,dist-test,release,playwright-report,test-results,tests,e2e,.github,screenshots,internal,docs`
- Zmierzone: **149 plikow, 1107 symboli, 128 plikow zrodlowych, 1083 symboli publicznych, 225 typow**
- Entry pointy wskazane przez skan: `start` @ electron/pty-host.ts:199, `App` @ src/App.tsx:664
- A/B potwierdzajace, ze wrapper byl potrzebny (pusty cache): bez wrappera `No parseable files found`, z wrapperem 478/2057 (przed wykluczeniami)

## POCHODZENIE POZYCJI - przeczytaj, zanim policzysz procent

Ten spis ma DWA zrodla i mieszanie ich zawyza kazda miare niezaleznosci:

- **Ze skanu featuring (63 pozycje)** — wszystko z kotwicami `electron/*.ts` i `src/*.ts(x)`.
- **Z transkrypcji recznej (9+ pozycji)** — wszystko z kotwicami `bin/aya`, `scripts/` i `build/`.

Powod jest mierzalny, nie uznaniowy: parser `featuring`/`tree-sitting` czyta na tym repo
WYLACZNIE `.ts`, `.tsx`, `.css` i jeden `.js`. Zmierzone w wyjsciu `gather.py`: 995 x `.ts`,
307 x `.tsx`, 9 x `.css`, 1 x `.js`, oraz **zero** wystapien `.cjs`, `.sh`, `.plist`. Drzewo
katalogow skanu **nie zawiera wiersza `bin/`**, a `scripts/` figuruje jako `2 files, 0 symbols
[bash]` mimo pieciu plikow w gicie. Naglowek skanu deklaruje `Languages: bash, ...`, ale pliki
bash sa LICZONE i daja zero symboli.

Skutek: cale CLI (`bin/aya`, 15 mozliwosci uzytkownika), trzy skrypty `.cjs` i plist uprawnien
sa dla narzedzia pierwszego stopnia NIEWIDOCZNE. Nie doda ich zadne ponowne uruchomienie
`featuring` — trzeba je utrzymywac recznie.

Kontrola przy kazdej regeneracji: porownaj liste plikow ze skanu z `git ls-files` i nazwij
roznice, ZANIM policzysz jakikolwiek procent pokrycia.

Kazda pozycja niesie kotwice `plik:linia`.

---

## Terminale i ich cykl zycia

- **Trwaly terminal przezywajacy zamkniecie aplikacji** — PTY zyje w odlaczonym hoscie. `start` @ electron/pty-host.ts:199, `computeHostIdentity` @ electron/pty-host.ts, `scheduleIdleShutdown` @ electron/pty-host.ts
- **Ponowne podlaczenie do zywej sesji po restarcie renderera** — `asHostIdentity` @ electron/pty-host-client.ts, `flushEvents` @ electron/pty-host-client.ts
- **Rejestr dzialajacych hostow PTY** — `writeHostRecord` / `readHostRecords` / `removeHostRecord` / `listHostRecords` @ electron/pty-host-registry.ts
- **Wykrywanie i sprzatanie osieroconych hostow** — `isHostArgv` / `scopeFromEnvDump` / `parseSnapshot` / `readLeaderGone` @ electron/pty-host-sweep.ts, electron/pty-host-staleness.ts
- **Bufor odtwarzania ostatniego wyjscia przy reconnect** — `appendToOutputBuffer` / `getBufferedOutput` @ electron/pty.ts
- **Szukanie w buforze terminala** — `searchPtyOutput` @ electron/pty.ts
- **Sklejanie sasiadujacych zdarzen PTY** — `coalesceAdjacentData` @ electron/pty-event-coalescer.ts
- **Log zdarzen cyklu zycia PTY** — electron/pty-log.ts (PTY_LOG_FILE)

## Uklad okna i paneli

- **Tilingowe splity jako drzewo BSP** — `isSplitNode` / `splitTreeLeafCount` / `isStorableSplitTree` @ electron/split-tree.ts, src/split-tree.ts
- **Wiele okien z zachowaniem pozycji** — `loadWindowState` / `trackWindowState` @ electron/window-state.ts, `isWindowState` @ electron/window-state-pure.ts
- **Przypisanie projektu do okna (slices)** — `hit` @ electron/window-slices.ts
- **Pelny ekran wlasnej roboty na macOS** — `applyMacOsWindowHack` / `isAyaFullScreen` / `toggleAyaFullScreen` @ electron/main.ts

## Sterowanie z linii polecen (`aya`)

- **Otwarcie projektu** — `aya open [path]` / `aya [path]` @ bin/aya:238, :328
- **Fokus okna** — `aya focus` @ bin/aya:251, `focusWindow` @ electron/control.ts
- **Powiadomienie systemowe** — `aya notify` @ bin/aya:254
- **Status agenta w panelu** — `aya status set|waiting|done|error|clear` @ bin/aya:318
- **Lista paneli projektu** — `aya pane list` @ bin/aya:281, `formatPaneList` @ electron/pane-target.ts
- **Odczyt wyjscia innego panelu** — `aya pane read` @ bin/aya:284, `candidates` @ electron/pane-target.ts
- **Wpisanie tekstu do innego panelu** — `aya pane send [--submit]` @ bin/aya:293
- **Most zdalny po stdio** — `aya remote --stdio` @ bin/aya:269
- **Serwer kontroli nasluchujacy na gniezdzie** — `startControlServer` @ electron/control.ts, `parseControlRequest` @ electron/control-protocol.ts

## Agenci i presety

- **Katalog wykrywanych harnessow** — `scanHarnesses` / `commandExists` / `isSafeBinaryName` @ electron/harnesses.ts
- **Presety wbudowane i uzytkownika** — `listPresets` / `savePresets` / `normalizePreset` / `isAgentKind` @ electron/presets.ts
- **Wznawianie sesji agenta po OSC 9001** — `extractAyaOsc` / `parseAyaOscSession` / `parseAyaOscStatus` @ electron/osc-extractor.ts
- **Reguly ekranu per agent (czy czeka)** — `rulesForAgent` / `hasAgentRules` / `evaluateScreen` @ electron/agent-screen-rules.ts
- **Bezglowy mirror VT do czytania ekranu panelu** — `scanPane` / `screenRows` / `writeVtPane` / `resizeVtPane` @ electron/vt-state.ts
- **Monitor sesji agenta (cctop)** — `describeSession` / `mapCctopStatus` @ electron/session-monitor.ts

## Uwaga i powiadomienia

- **Rail uwagi: kto czeka lub padl we wszystkich projektach** — `attentionRows` / `attentionFor` / `isActionableLevel` @ src/attention.ts
- **Wykrywanie promptu i dzwonka** — `detectApproval` / `looksBusy` @ src/bell.ts
- **Dzwieki terminala per zdarzenie** — `shouldPlayTerminalSound` / `terminalSoundUrl` / `normalizeSoundOverrides` @ src/terminal-sound-prefs.ts
- **Odznaka na docku** — `useDockBadge` @ src/hooks/useTerminalSignals.ts

## Git i worktrees

- **Status repozytorium w pasku stanu** — `getGitInfo` / `parseStatusWithBranch` @ electron/git.ts
- **Diff zmienionych plikow** — `getGitDiff` @ electron/git.ts
- **Worktrees: lista, status, tworzenie, usuwanie** — `listWorktrees` / `listWorktreeStatus` / `parseWorktrees` @ electron/git.ts
- **Link do PR/brancha na GitHubie** — `getGitHubLink` / `isGitHubCliAvailable` / `currentBranch` @ electron/github.ts
- **Wykrywanie cwd procesu w panelu** — `parseLsofCwd` / `getProcessCwd` @ electron/process-cwd.ts

## Wyszukiwanie

- **Wyszukiwarka projektow, terminali, wyjscia i akcji** — `SearchModal` @ src/components/SearchModal.tsx
- **Tryb History: czytanie historii rozmow harnessa** — `extractClaudeMessages` / `extractCodexMessages` / `claudeProjectDirName` / `isNoiseUserText` @ electron/harness-search.ts
- **Podwojny Shift jako skrot wyszukiwarki** — `handleKeyDown` / `handleKeyUp` @ src/double-shift.ts

## Snippety, motywy, wyglad

- **Snippety wstrzykiwane do panelu** — `listSnippets` / `saveSnippets` / `normalizeSnippet` @ electron/snippets.ts, `snippetPtyPayload` @ src/snippet-payload.ts
- **Motywy terminala z importem** — `loadThemes` / `saveThemes` / `isTheme` / `isThemeColors` @ electron/themes.ts
- **Integracja z Omarchy (motyw systemowy)** — `readOmarchyTheme` / `readOmarchyStatus` / `isColor` @ electron/omarchy.ts
- **Mapowanie palety na chrome i terminal** — `paletteToChromeVars` / `paletteToThemeColors` @ src/theme-skin.ts

## Zuzycie limitow

- **Chip zuzycia Claude** — `parseUsage` / `isUsageData` / `claudeUsageFileForConfigDir` @ electron/usage.ts
- **Chip zuzycia Codex** — `resetCodexUsageCaches` / `isoFromUnixSeconds` @ electron/usage-codex.ts
- **Instalator hooka zuzycia** — `hookCommand` / `hookScriptSource` / `hasStopHook` / `settingsFileForConfigDir` @ electron/usage-hook.ts
- **Instalator hooka statusu (Claude)** — `statusHookCommand` / `statusHookScriptSource` / `installStatusHook` / `statusHookStatus` @ electron/status-hook.ts
- **Instalator hooka statusu (Codex)** — `codexNotifyLine` / `findTopLevelNotify` / `notifyIsOurs` / `withoutCodexNotify` @ electron/status-hook-codex.ts

## Konfiguracja i stan

- **Konfiguracja projektow na dysku** — `normalizeTab` / `normalizeRemoteProject` / `slugify` @ electron/config.ts
- **Hot reload konfiguracji z dysku** — `startConfigWatcher` / `handleHome` / `handleProjects` / `pollOnce` @ electron/config-watcher.ts, `sliceForFilename` / `isProjectConfigFilename` @ electron/config-watcher-pure.ts
- **Tlumienie echa wlasnych zapisow** — `hashConfig` / `recordWrite` / `isEcho` @ electron/config-echo.ts
- **Zapis atomowy stanu** — `writeFileAtomic` @ electron/atomic-write.ts
- **Konfiguracja per-projekt w repo** — electron/project-local.ts
- **Walidacja ladunkow IPC** — `requireString` / `requireStringArray` / `requirePositiveInt` / `validate*` @ electron/validation.ts

## Aya Web (experimental)

- **Serwer HTTP + WebSocket podajacy ten sam UI** — `startWebServer` / `parseCookies` / `originAllowed` / `sessionFor` / `throttled` @ electron/web-server.ts
- **Poswiadczenia i haslo** — `generateWebPassword` / `hashWebPassword` / `normalizeWebConfig` / `defaultWebConfig` @ electron/web-config.ts
- **Przechwycenie kanalow IPC dla mostu web** — `captureIpcHandlers` / `hasCapturedIpcHandler` @ electron/web-ipc.ts
- **Klient przegladarkowy** — `createWebAya` @ src/web/bridge.ts, `connectWebTransport` @ src/web/transport.ts, `shortcutForKey` @ src/web/shortcuts.ts

## Sesje zdalne (early)

- **Otwarcie projektu na zdalnym hoscie przez SSH** — `createRemoteProjectOnHost` / `listRemoteDirectory` / `createRemoteDirectory` @ electron/remote-client.ts
- **Snapshot obszaru roboczego zdalnego Aya** — `remoteSnapshot` @ electron/remote-protocol.ts, `startRemoteServer` / `listDirectories` / `expandRemotePath` @ electron/remote-server.ts
- **Diagnostyka polaczenia zdalnego** — `checkRemoteHealth` @ electron/remote-client.ts
- **Odzyskanie otwarcia przy starszym zdalnym hoscie** — `recoverExistingRemoteProject` @ electron/remote-client.ts

## Aktualizacje i powloka

- **Odzyskiwanie po nieudanej aktualizacji (ShipIt)** — `normalizePendingUpdate` / `attemptsOf` / `shouldCleanShipItCache` / `markPendingUpdate` @ electron/update-recovery.ts
- **Ustalenie PATH powloki logowania** — `shellPathProbeArgv` / `parseResolvedPath` / `mergePath` @ electron/shell-path.ts
- **Wybor powloki uzytkownika** — `userShell` @ electron/shell.ts
- **CLI `aya` w spakowanej aplikacji** — `rewriteAsarPath` / `bundledAyaCliPath` @ electron/cli-path.ts, `parseShimTargets` / `shQuote` @ electron/cli-shim.ts
- **Otwieranie linkow zewnetrznych** — `parseExternalUrl` @ electron/navigation.ts

## Podsumowania (Apple Intelligence / Ollama / OpenAI)

- **Jednolinijkowe podsumowanie panelu i projektu** — `unavailableLocalSummary*` @ electron/main.ts, `normalizeLocalSummaryError` @ electron/local-summary-errors.ts, `localSummaryUnavailableMessage` @ src/local-summary-errors.ts
- **Helper natywny** — electron/native/aya-local-summary.swift.in, pakowany przez package.json asarUnpack

## Narzedzia deweloperskie i pakowanie  [transkrypcja reczna - poza zasiegiem parsera]

- **Zrzuty ekranu emulatora w zadanych scenariuszach** — `npm run emulator:shot` @ package.json:31
  -> scripts/emulator-shot.cjs:9-10 (warianty: `[scenario ...] [--out DIR] [--width N]
  [--height N]`), sterowane przez src/emulator/scenarios.ts; udokumentowane w
  src/emulator/README.md:29-31
- **Serwer deweloperski Electrona** — `npm run dev:electron` @ package.json:21 ->
  scripts/dev-electron.sh
- **Seed danych do zrzutow bez prawdziwych nazw projektow** — scripts/seed-screenshot.sh,
  opisany w screenshots/README.md
- **Przycinanie pakietu po spakowaniu** — scripts/after-pack-prune.cjs, wpiety jako
  `afterPack` @ package.json:98
- **Kompilacja natywnego helpera podsumowan i hacka okna macOS** —
  scripts/build-macos-window-hack.cjs:14-15, wolany przez `npm run build:electron`

## Uprawnienia i podpisywanie (macOS)  [transkrypcja reczna - poza zasiegiem parsera]

- **Mikrofon dla narzedzi uruchamianych w terminalu** — `com.apple.security.device.audio-input`
  @ build/entitlements.mac.plist, wraz z opisem `NSMicrophoneUsageDescription` @
  package.json:112, ktory tlumaczy uzytkownikowi, ze Aya sama nie nagrywa i jak cofnac zgode.
  Pinowane przez tests/entitlements.test.mjs:15 (uprawnienie) i :27 (tresc opisu)
- **Hardened runtime dla node-pty i natywnych modulow** — `allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`,
  `allow-dyld-environment-variables` @ build/entitlements.mac.plist:5-12

## Skroty klawiszowe

- **13 akcji + rodziny focus-pane-* i project-N** — `ShortcutActions` / `useAppShortcuts` @ src/hooks/useAppShortcuts.ts, emiter @ electron/main.ts, mirror web @ src/web/shortcuts.ts
- **Klawisz Enter w rich TUI kontra powloka** — `enterKeyAction` @ src/terminal-keys.ts
- **Klawisz Option na macOS** — `shouldUseXtermOptionAsMeta` / `leftOptionMetaSequence` @ src/terminal-option-key.ts
