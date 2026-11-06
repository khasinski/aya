# Audyt UX Conversation GUI

Stan na 6 listopada 2026. Audyt dotyczy lokalnego kodu i testowej kompilacji Aya.

## Sprawdzone stany

- Długa historia i strumieniowanie: zachowanie przewijania, przycisk powrotu do najnowszej wiadomości, kolejka oraz zdarzenia od podrzędnych agentów. Osobny test używa rzeczywistego Codexa, 120 wcześniej przygotowanych wiadomości widoku, narzędzia, sterowania i kolejki.
- Wysyłanie: opóźnione potwierdzenie, zakończenie tury przed potwierdzeniem, odrzucenie wysyłki, automatyczna kolejna tura, blokada podwójnego steer oraz ochrona edytowanej pozycji kolejki. Nieudana wysyłka zachowuje nowy szkic i przenosi poprzednią wiadomość do wstrzymanej kolejki.
- Pytania i zgody: synchroniczne i asynchroniczne odpowiedzi, edycja, ponowienie, odświeżenie oraz pytania o sekret. Sekretne odpowiedzi asynchroniczne są blokowane w historii czatu.
- Załączniki: wybór plików, wklejony obraz, limit 20, brak uchwytu po odświeżeniu i oznaczenie plików wymagających ponownego dodania. Próba przeciągnięcia pliku wyświetla informację o alternatywie.
- Snippets: wstawienie w miejscu kursora, automatyczne wysłanie lub kolejka, otwarcie ustawień oraz zachowanie po rozłączeniu.
- Artefakty: wyszukiwanie, nieprzeczytane zmiany, pusty wynik, błąd podglądu i zapisu, przywrócenie po odświeżeniu oraz panel w wąskim podziale.
- Odporność: awaria renderera, odzyskanie działającego procesu, oczekujące zgody, szkic, rozłączenie i ponowne połączenie. Aktywny tryb unsafe approvals jest widoczny w nagłówku.

## Pozostałe ograniczenia i luki testowe

1. **Przeciąganie plików nie dodaje załączników.** GUI pokazuje komunikat i wskazuje przycisk dodawania; pełna obsługa drop pozostaje do wykonania.
2. **Historia działań narzędzi jest ograniczona do bieżącej tury.** Rozpoczęcie następnej czyści listę działań w widoku; szczegółowy przegląd działań z poprzednich tur wymaga osobnego projektu historii.
3. Test rzeczywistego agenta obejmuje Codexa; scenariusze pozostałych obsługiwanych agentów korzystają z testowych atrap. W długiej historii testu Codexa wcześniejsze wiadomości są przygotowane w widoku, a nie wygenerowane przez rzeczywiste wielogodzinne sesje.
4. Testy działają w ukrytym oknie. Mierzą stabilność widoku i położenia treści, ale nie zastępują obserwacji migania na fizycznym ekranie, testu czytnika ekranu ani pełnego audytu kontrastu i klawiatury. Test obrazu ze schowka używa syntetycznego zdarzenia i testowej zawartości schowka.

Główne scenariusze automatyczne znajdują się w `e2e/conversation-gui.spec.ts`, `e2e/gui-resilience.spec.ts`, `e2e/gui-queue-state.spec.ts`, `e2e/gui-steer-state.spec.ts`, `e2e/gui-steer-completion.spec.ts`, `e2e/snippets.spec.ts` i `e2e/gui-live-flicker.spec.ts`.
