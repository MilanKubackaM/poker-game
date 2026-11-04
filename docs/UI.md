# Poker Night — vizuál UI

Screenshoty sú z reálnych React komponentov hry, vyrenderovaných s ukážkovými dátami (demo režim `/?demo=<obrazovka>`),
nasnímané z bežiaceho Docker kontajnera. Desktop = 1440×900, mobil = 390×844 (iPhone 14). Webkamery sú v deme
simulované obrázkom — v reálnej hre je na ich mieste živé video hráča.

Demo si vieš pozrieť aj sám: `http://localhost:3000/?demo=table` (zoznam obrazoviek je na konci).

---

## 1. Úvodná obrazovka

### Založenie stola / pripojenie
Prezývka, avatar (emoji + farba), názov stola, mena (€ / Kč), blindy, štartovací vklad, základný čas na ťah a pripojenie cez kód.

| Desktop | Mobil |
| --- | --- |
| ![Úvod desktop](screenshots/desktop-lobby.png) | ![Úvod mobil](screenshots/mobile-lobby.png) |

### Moje stoly
Stoly, pri ktorých si sedel, si prehliadač pamätá — fáza hry, počet hráčov online, tvoj stack, „Pokračovať“ / „Zabudnúť“.

| Desktop | Mobil |
| --- | --- |
| ![Moje stoly desktop](screenshots/desktop-my-tables.png) | ![Moje stoly mobil](screenshots/mobile-my-tables.png) |

### Pozvánka cez odkaz
Kamarát otvorí odkaz `/t/K7QX2M`, vyberie si meno a avatara a prisadne si.

| Desktop | Mobil |
| --- | --- |
| ![Pozvánka desktop](screenshots/desktop-invite.png) | ![Pozvánka mobil](screenshots/mobile-invite.png) |

## 2. Čakáreň stola

### Pohľad hosta
Kód a odkaz na pozvanie, hráči (online/offline, kamera, žetóny), pripisovanie peňazí s poznámkou, pravidlá,
„Spustiť hru“ (od 2 hráčov so žetónmi), výsledky stola (leaderboard + história).

| Desktop | Mobil |
| --- | --- |
| ![Čakáreň host desktop](screenshots/desktop-room.png) | ![Čakáreň host mobil](screenshots/mobile-room.png) |

### Pohľad hráča
| Desktop | Mobil |
| --- | --- |
| ![Čakáreň hráč desktop](screenshots/desktop-room-guest.png) | ![Čakáreň hráč mobil](screenshots/mobile-room-guest.png) |

### Čakáreň s rozohraným Prasiatkom a pauzami hráčov
| Desktop | Mobil |
| --- | --- |
| ![Čakáreň Prasiatko desktop](screenshots/desktop-room-piggy.png) | ![Čakáreň Prasiatko mobil](screenshots/mobile-room-piggy.png) |

### Čakáreň počas hry — „Odísť od stola“ (ostatní hrajú ďalej, návrat „Späť ku stolu“, odchod „Opustiť hru“)
| Desktop | Mobil |
| --- | --- |
| ![Čakáreň počas hry desktop](screenshots/desktop-room-playing.png) | ![Čakáreň počas hry mobil](screenshots/mobile-room-playing.png) |

## 3. Dealer button po štarte hry

### Voľba hosta — losovanie alebo náhodne
| Desktop | Mobil |
| --- | --- |
| ![Voľba desktop](screenshots/desktop-dealer-choice.png) | ![Voľba mobil](screenshots/mobile-dealer-choice.png) |

### Pravidlá losovania pre všetkých („Rozumiem“, poradie farieb ♠ > ♥ > ♦ > ♣)
| Desktop | Mobil |
| --- | --- |
| ![Pravidlá losovania desktop](screenshots/desktop-draw-explain.png) | ![Pravidlá losovania mobil](screenshots/mobile-draw-explain.png) |

### Ťahanie z 52 kariet rozhádzaných po stole
| Desktop | Mobil |
| --- | --- |
| ![Ťahanie desktop](screenshots/desktop-draw-pick.png) | ![Ťahanie mobil](screenshots/mobile-draw-pick.png) |

### Výsledok losovania
| Desktop | Mobil |
| --- | --- |
| ![Výsledok losovania desktop](screenshots/desktop-draw-done.png) | ![Výsledok losovania mobil](screenshots/mobile-draw-done.png) |

## 4. Hra

### Texas Hold'em — si na ťahu
Dealer button, SB/BB, stávky, pot so side potmi, odpočet základného času, akcie Fold / Call / Raise + slider a rýchle voľby.

| Desktop | Mobil |
| --- | --- |
| ![Stôl desktop](screenshots/desktop-table.png) | ![Stôl mobil](screenshots/mobile-table.png) |

### Timebank
Po 15 s základného času cinkne a začne sa míňať osobný timebank (oranžový krúžok).

| Desktop | Mobil |
| --- | --- |
| ![Timebank desktop](screenshots/desktop-timebank.png) | ![Timebank mobil](screenshots/mobile-timebank.png) |

### Showdown a 7-2 bonus
| Desktop | Mobil |
| --- | --- |
| ![Showdown desktop](screenshots/desktop-showdown.png) | ![Showdown mobil](screenshots/mobile-showdown.png) |

### Omaha (pot-limit)
| Desktop | Mobil |
| --- | --- |
| ![Omaha desktop](screenshots/desktop-omaha.png) | ![Omaha mobil](screenshots/mobile-omaha.png) |

### Pineapple — výber karty na zahodenie
| Desktop | Mobil |
| --- | --- |
| ![Pineapple desktop](screenshots/desktop-pineapple.png) | ![Pineapple mobil](screenshots/mobile-pineapple.png) |

## 5. Módy a ich pravidlá

### Dialóg s pravidlami pred prvou rukou módu — Omaha
| Desktop | Mobil |
| --- | --- |
| ![Pravidlá Omaha desktop](screenshots/desktop-mode-intro-omaha.png) | ![Pravidlá Omaha mobil](screenshots/mobile-mode-intro-omaha.png) |

### Dialóg s pravidlami — Prasiatko
| Desktop | Mobil |
| --- | --- |
| ![Pravidlá Prasiatko desktop](screenshots/desktop-mode-intro-piggy.png) | ![Pravidlá Prasiatko mobil](screenshots/mobile-mode-intro-piggy.png) |

### Prasiatko počas hry
Prasiatko pri pote so sumou, pri každom hráčovi 3 krúžky (zelené = vyhraté ruky).

| Desktop | Mobil |
| --- | --- |
| ![Prasiatko desktop](screenshots/desktop-piggy.png) | ![Prasiatko mobil](screenshots/mobile-piggy.png) |

### Prasiatko vyhraté
| Desktop | Mobil |
| --- | --- |
| ![Prasiatko vyhraté desktop](screenshots/desktop-piggy-won.png) | ![Prasiatko vyhraté mobil](screenshots/mobile-piggy-won.png) |

## 6. Pauza a návrat do hry

### Krátka pauza („som hneď späť“)
| Desktop | Mobil |
| --- | --- |
| ![Pauza desktop](screenshots/desktop-away.png) | ![Pauza mobil](screenshots/mobile-away.png) |

### Návrat po postavení sa — počkať na BB alebo zaplatiť
| Desktop | Mobil |
| --- | --- |
| ![Návrat desktop](screenshots/desktop-return-dialog.png) | ![Návrat mobil](screenshots/mobile-return-dialog.png) |

## 7. Ovládanie hosta

### Hra — štart/pauza, 7-2 natrvalo, čas na ťah, špeciálne kolá, Prasiatko
| Desktop | Mobil |
| --- | --- |
| ![Host hra desktop](screenshots/desktop-host-game.png) | ![Host hra mobil](screenshots/mobile-host-game.png) |

### Prasiatko beží
| Desktop | Mobil |
| --- | --- |
| ![Host Prasiatko desktop](screenshots/desktop-host-piggy.png) | ![Host Prasiatko mobil](screenshots/mobile-host-piggy.png) |

### Ukončenie hry → návrat do čakárne
| Desktop | Mobil |
| --- | --- |
| ![Návrat do čakárne desktop](screenshots/desktop-to-lobby.png) | ![Návrat do čakárne mobil](screenshots/mobile-to-lobby.png) |

### Pravidlá stola
| Desktop | Mobil |
| --- | --- |
| ![Host pravidlá desktop](screenshots/desktop-host-rules.png) | ![Host pravidlá mobil](screenshots/mobile-host-rules.png) |

### Zmazanie stola (len zakladateľ, potvrdenie kódom stola)
| Desktop | Mobil |
| --- | --- |
| ![Zmazanie stola desktop](screenshots/desktop-delete-table.png) | ![Zmazanie stola mobil](screenshots/mobile-delete-table.png) |

### Hráči a žetóny — pripísanie/odobratie s poznámkou, práva hosta
| Desktop | Mobil |
| --- | --- |
| ![Host hráči desktop](screenshots/desktop-host-players.png) | ![Host hráči mobil](screenshots/mobile-host-players.png) |

## 8. Chat, transakcie, štatistiky

### Chat
| Desktop | Mobil |
| --- | --- |
| ![Chat desktop](screenshots/desktop-chat.png) | ![Chat mobil](screenshots/mobile-chat.png) |

### Správy ako notifikácie (max 3, každá 10 s)
| Desktop | Mobil |
| --- | --- |
| ![Notifikácie desktop](screenshots/desktop-chat-toasts.png) | ![Notifikácie mobil](screenshots/mobile-chat-toasts.png) |

### Transakcie
| Desktop | Mobil |
| --- | --- |
| ![Transakcie desktop](screenshots/desktop-transactions.png) | ![Transakcie mobil](screenshots/mobile-transactions.png) |

### Leaderboard
| Desktop | Mobil |
| --- | --- |
| ![Leaderboard desktop](screenshots/desktop-leaderboard.png) | ![Leaderboard mobil](screenshots/mobile-leaderboard.png) |

### História rúk
| Desktop | Mobil |
| --- | --- |
| ![História desktop](screenshots/desktop-history.png) | ![História mobil](screenshots/mobile-history.png) |

## 9. Menu hráča
Krátka pauza, postaviť sa, zvukové efekty a upozornenie na ťah, pozvánka, „Odísť od stola“ (do čakárne stola, nikdy nie na úvodnú obrazovku).

| Desktop | Mobil |
| --- | --- |
| ![Menu desktop](screenshots/desktop-menu.png) | ![Menu mobil](screenshots/mobile-menu.png) |

---

## Demo obrazovky

`lobby`, `my-tables`, `invite`, `room`, `room-guest`, `room-piggy`, `dealer-choice`, `draw-explain`, `draw-pick`, `draw-done`,
`table`, `timebank`, `showdown`, `omaha`, `pineapple`, `mode-intro-omaha`, `mode-intro-piggy`, `piggy`, `piggy-won`, `away`,
`return-dialog`, `host-game`, `host-piggy`, `to-lobby`, `host-rules`, `host-players`, `chat`, `chat-toasts`, `transactions`,
`leaderboard`, `history`, `menu`, `room-playing`, `delete-table`, `table-roles`, `speaking` (`?speaking=p1,p4`), `help` (`?chapter=piggy` — Vysvetlivky, pozri [VYSVETLIVKY.sk.md](VYSVETLIVKY.sk.md)), `timebank-full` (`?turn=<id>` — kontrola prekryvu odpočtu so stávkou na 9 miestach)

Príklad: `http://localhost:3000/?demo=draw-pick`
