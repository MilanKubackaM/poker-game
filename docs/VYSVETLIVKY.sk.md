# Vysvetlivky — obsah, vzhľad a súvisiace označenia

> Stav: **implementované** (menu ☰ → 📖 Vysvetlivky). Dokument popisuje, čo okno obsahuje, ako vyzerá, kde berie
> obrázky a ako sú pri stole označené roly a hovoriaci hráč — Vysvetlivky ich hráčom vysvetľujú.

Kód: `client/src/components/HelpDialog.tsx`, štýly `client/src/help.css`, obrázky `client/public/help/*.webp`.

---

## 1. Cieľ

Hráč, ktorý si prisadne prvýkrát (alebo zabudol, ako funguje Prasiatko), si má vedieť **sám, priamo pri stole**
prečítať, ako appka funguje — bez pýtania sa v chate. Jedno miesto, kde je vysvetlené:

- herné módy (Hold'em, Omaha, Pineapple, špeciálne kolo, 7-2, Prasiatko),
- priebeh ruky (čas na ťah, timebank, predvoľby, all-in a viac behov, odkrytie boardu),
- pauza, postavenie sa, návrat, odchod od stola,
- žetóny a peniaze (bankár, dobitie, „keď mi dôjdu žetóny“, cashout),
- roly (zakladateľ, spoluhost, bankár) a ich ikonky,
- kamera, mikrofón, **kto práve hovorí**, zvuk, chat, štatistiky, férovosť.

Čo to **nie je**: návod na prevádzku servera (`docs/SETUP.sk.md`) ani model dôvery (`README.md`).

---

## 2. Kde sa otvára

Položka **„📖 Vysvetlivky“** v menu ☰ hornej lišty — pri stole aj v čakárni, na desktope aj na mobile.

Poradie položiek v menu (mobil; na desktope sú prvé štyri riadky priamo v lište):

```
☕  Krátka pauza
📷  Kamera                    zapnutá
🎙  Mikrofón                  zapnutý
🔊  Zvuk                      zapnutý
🎚  Nastavenia zvuku               ▾
────────────────────────────────────
▶  Vrátiť sa do hry                     ← len keď stojím
📖  Vysvetlivky
🔗  Kopírovať pozvánku
🚪  Odísť od stola / Opustiť hru
```

Okno sa otvára cez portál do `<body>` (horná lišta má `backdrop-filter`, ktorý by inak fixed modal uzavrel do seba).

---

## 3. Vzhľad

### Desktop (≥ 761 px)

Veľký modal **max 1040 × 88vh**, dvojstĺpcový: vľavo kapitoly v skupinách, vpravo obsah kapitoly. Obsah sa scrolluje
sám, zoznam kapitol ostáva na mieste.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  📖 Vysvetlivky                                                          ✕  │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ ZAČÍNAME              │  🐷 Prasiatko                                         │
│  🚀 Rýchly štart       │  🐷 Host spustil Prasiatko — hrá sa niekoľko rúk…    │
│  ♠ Ako sa hrá Hold'em │  1. Pred každou rukou dá každý … vstup 1 BB = 0,20 € │
│ HERNÉ MÓDY            │  2. …                                                │
│  🃏 Omaha              │  ┌──────────────────────────────────────────────┐   │
│  🍍 Pineapple          │  │ ●○○ 1 výhra    ●●○ 2 výhry — ešte jedna…     │   │ ← živé komponenty
│  ✨ Špeciálne kolo     │  └──────────────────────────────────────────────┘   │
│  7·2 Pravidlo 7-2     │  ┌──────────────────────────────────────────────┐   │
│ ▸🐷 Prasiatko          │  │        screenshot z desktopovej hry          │   │ ← klik = zväčšiť
│ HRA                   │  └──────────────────────────────────────────────┘   │
│  ⏱ Čas a predvoľby    │  Prasiatko pri pote ukazuje sumu, krúžky výhry      │
│  🔥 All-in a behy      │  ┌ PRI TOMTO STOLE ─────────────────────────────┐   │
│  ☕ Pauza a odchod     │  │ Prasiatko beží: 4,20 € · ty ●●○              │   │
│ PENIAZE A ROLY        │  └──────────────────────────────────────────────┘   │
│  🏦 Žetóny a bankár    │                       ‹ Pravidlo 7-2   Čas na ťah ›  │
│  ♛ Roly pri stole     │                                                      │
│ OSTATNÉ               │                                                      │
│  🎙 Kamera a zvuk      │                                                      │
│  📊 Štatistiky         │                                                      │
│  📱 Appka              │                                                      │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

- Aktívna kapitola je zvýraznená zlatou; dole „‹ predchádzajúca / ďalšia ›“ — dá sa čítať ako manuál od začiatku.
- **Screenshoty** sú obrázky z desktopovej verzie hry. Klik na obrázok ho otvorí na celú obrazovku (zatvorí klik alebo Esc).
- **Box „Pri tomto stole“** (zlatý rámik) ukazuje reálny stav stola k téme: blindy, kto je host a bankár, či je 7-2
  zapnuté a za koľko, stav prasiatka a moje krúžky, môj timebank, môj stav (hrám / pauza / čakám na BB).
- Posledná otvorená kapitola sa pamätá v `localStorage` (len pohodlie, bez neho to funguje tiež).
- Zatvorenie: ✕, Esc, klik na pozadie.

### Mobil (≤ 760 px)

Celá obrazovka (rešpektuje safe-area hore aj dole). Kapitoly sú **vodorovne scrollovateľné chipy** pod hlavičkou,
aktívny chip sa sám posunie do stredu; pod nimi obsah kapitoly. Tabuľky sa dajú posúvať do strany.

### Keď som počas čítania na ťahu

Hra sa kvôli Vysvetlivkám **nezastaví**. Keď na mňa príde rad, hore v okne sa objaví pulzujúci pruh
**„⏳ Si na ťahu — Späť ku stolu“** (klik zavrie okno). Zvuk upozornenia na ťah zaznie ako vždy a predvoľby
nastavené pred otvorením platia ďalej.

---

## 4. Obrázky a animácie

### Screenshoty (`client/public/help/*.webp`)

Robia sa z demo obrazoviek (`/?demo=<obrazovka>`) v rozlíšení 1440 × 900, takže ukazujú skutočné UI hry. Generuje ich
`tools/make-help-shots.mjs` (Playwright + `cwebp`), spolu ~1,2 MB, načítavajú sa až pri otvorení kapitoly (`loading="lazy"`).

| Súbor | Demo obrazovka | Kapitola |
| --- | --- | --- |
| `room` | čakáreň s hráčmi | Rýchly štart |
| `table` | stôl, si na ťahu | Hold'em |
| `omaha`, `mode-intro-omaha` | Omaha, dialóg pravidiel módu | Omaha, Špeciálne kolo |
| `pineapple` | výber karty na zahodenie | Pineapple |
| `host-game` | ♛ Host → Hra | Špeciálne kolo |
| `showdown` | výhra so 7-2 | Pravidlo 7-2 |
| `piggy`, `piggy-won` | prasiatko pri pote, výhra | Prasiatko |
| `timebank`, `pre-actions` | míňa sa timebank, predvoľby | Čas na ťah |
| `run-vote`, `run-twice`, `rabbit` | hlasovanie 1×/2×/3×, dva boardy, odkrytie boardu | All-in |
| `away`, `return-dialog`, `room-playing` | pauza, návrat, čakáreň počas hry | Pauza a odchod |
| `host-players`, `cashout`, `transactions` | bankár dobíja, cashout, transakcie | Žetóny a bankár |
| `table-roles` | stôl s ♛, ★ a 🏦 pri menách | Roly |
| `speaking` | stôl s dvoma hovoriacimi hráčmi | Kamera a zvuk |
| `chat-toasts`, `leaderboard`, `history`, `draw-pick` | notifikácie, štatistiky, losovanie | Ostatné |

Nové obrázky po zmene UI: `npm run dev:client` a `node tools/make-help-shots.mjs` (návod v hlavičke skriptu).

### Živé ukážky (React komponenty, nie obrázky)

- **Kto hovorí** — dva avatary, jeden so zeleným pulzujúcim okrajom a mikrofónom (tie isté štýly ako pri stole).
- **Ikonky rolí** — ♛ Zakladateľ, ★ Spoluhost, 🏦 Bankár, ♛🏦 Zakladateľ a bankár (komponent `RoleBadge`).
- **Krúžky prasiatka** — `PiggyDots` s 1 a 2 výhrami.
- **Karty** — poradie kombinácií a príklady (Omaha „štyri srdcia nie sú farba“, 7-2) skutočnými kartami z hry.

---

## 5. Princíp textov

- **Čísla sa berú zo stola**, nie natvrdo: blindy, mena, bonus 7-2, čas na ťah, timebank, pot-limit/no-limit v Omahe,
  vstup do prasiatka.
- **Jeden zdroj pravdy pre módy:** body pravidiel Omahy, Pineapple, 7-2 a Prasiatka sú tie isté ako v dialógu pred prvou
  rukou módu (`modeInfo` v `GameModes.tsx`); Vysvetlivky k nim pridávajú príklady a obrázky.
- Krátke vety, číslované kroky, tučné len kľúčové pojmy; ikony rovnaké ako v UI (☕, ♛, ★, 🏦, 🐷, 👀, 📊).

---

## 6. Kapitoly

| Skupina | Kapitola | Obsah | Pri tomto stole |
| --- | --- | --- | --- |
| Začíname | 🚀 Rýchly štart | 6 krokov od pozvánky po cashout | variant, blindy, host, bankár, stav hry |
| | ♠ Ako sa hrá Hold'em | flop/turn/river, blindy, akcie, no-limit, **poradie kombinácií s kartami** | SB / BB |
| Herné módy | 🃏 Omaha | pravidlá módu + príklad farby | pot-limit / no-limit |
| | 🍍 Pineapple | pravidlá módu, 10 s na zahodenie, potom sa zahodí **náhodná** karta | — |
| | ✨ Špeciálne kolo | vyhlásenie hostom (max 50 rúk alebo **natrvalo** do vypnutia), banner v lište, „Rozumiem“, kombinácia s Prasiatkom / 7-2 | naplánovaný variant a počet / natrvalo |
| | 7·2 Pravidlo 7-2 | pravidlá + príklad výpočtu bonusu | zapnuté a za koľko |
| | 🐷 Prasiatko | pravidlá + živé krúžky, **séria** (1–20 hier alebo natrvalo, pravidlá len pri prvej hre), „Ukončiť po tejto hre“ vs. „Zrušiť hneď a vrátiť vklady“ | suma, séria a moje krúžky |
| Hra | ⏱ Čas na ťah a predvoľby | základný čas, timebank (¼ ušetreného, max 200 s), auto check/fold, 4 predvoľby | základný čas, môj timebank |
| | 🔥 All-in, viac behov a koniec ruky | side pot, hlasovanie 1×/2×/3× (platí najmenšia), ukázať karty, odkryť board za 1 BB | — |
| | ☕ Pauza, postavenie sa a odchod | tabuľka pauza / postaviť sa / odísť, návrat (počkať na BB / zaplatiť), Opustiť hru | môj stav |
| Peniaze a roly | 🏦 Žetóny, bankár a vyplácanie | bankár, 0 žetónov pri príchode, **o žetóny sa žiada u bankára** (Zaplatené / Na dlh), keď dôjdu žetóny, cashout | bankár, moje žetóny |
| | ♛ Roly pri stole | ikonky rolí (živá ukážka), tabuľka právomocí, schvaľovanie nových hráčov, **vyhodenie** (každého okrem seba a zakladateľa; žetóny ostanú v transakciách, návrat len so súhlasom hosta), **zlúčenie** hráča z iného zariadenia („Zlúčiť do…“), sekcia „Odišli od stola“ | zoznam ľudí s rolami |
| Ostatné | 🎙 Kamera, mikrofón, zvuk a chat | P2P video, **kto práve hovorí** (živá ukážka), **hlasitosť / stlmenie jedného hráča** (klik na miesto, 0–150 %, len u mňa, 🔇 pri mieste), push-to-talk, zvuk, mobil ☰, chat | — |
| | 🎵 Jukebox | host zapína/vypína; pesničku z YouTube pridá len víťaz poslednej ruky (1 za výhru, max 10 min); front max 5, vidia ho všetci; nedá sa preskočiť ani pretáčať; hlasitosť má každý vlastnú | — |
| | 📊 Štatistiky a férovosť | leaderboard, história, overiteľné miešanie, úprimný limit | — |
| | 📱 Appka, dealer button a výpadky | inštalácia, losovanie ♠ > ♥ > ♦ > ♣, reconnect | — |

---

## 7. Označenie rolí — host a bankár

Roly sú označené **ikonkou pred menom hráča, všade rovnako** (jeden komponent `RoleBadge` v `HostPlayers.tsx`):

| Ikonka | Rola | Kde |
| --- | --- | --- |
| **♛** (zlatá) | zakladateľ stola = hlavný host | pri mieste za stolom, v čakárni, v paneli hosta |
| **★** (modrá) | spoluhost — má práva hosta | pri mieste za stolom, v čakárni, v paneli hosta |
| **🏦** | bankár — dobíja žetóny | pri mieste za stolom (**nové** — predtým len v čakárni), v čakárni, v paneli hosta, v cashoute |

- Ak má hráč viac rolí, ikonky idú za sebou: **♛ 🏦 Milan** = zakladateľ, ktorý je aj bankár.
- V čakárni a v paneli hosta je navyše textový štítok: **host** (zlatý — nové), **spoluhost** (modrý), **bankár** (zelený).
- Pri mieste za stolom sa ikonky nikdy neskrátia — pri dlhom mene sa skráti meno (`…`), nie ikonka.
- Tooltipy: „Hlavný host (zakladateľ stola)“, „Spoluhost — má práva hosta“, „Bankár — dobíja žetóny a potvrdzuje platby v cashoute“.

Vysvetlivky: kapitola **♛ Roly pri stole** (živá ukážka ikoniek + screenshot stola s ♛, ★ a 🏦) a box „Pri tomto stole“
so zoznamom ľudí s rolami.

---

## 8. Kto práve hovorí

Hráč, od ktorého práve ide zvuk, je označený **zeleným pulzujúcim okrajom avatara (alebo videa)** a **zeleným
mikrofónom** v pravom dolnom rohu avatara — pri stole aj v čakárni. Keď prestane hovoriť, označenie po ~0,45 s zhasne.

Ako to funguje (`client/src/voiceActivity.ts`, prahy v `client/src/voiceLevel.ts`):

- Prehliadač každého hráča meria **hlasitosť zvuku**, ktorý mu chodí od ostatných (a vlastného mikrofónu), 10× za sekundu
  cez Web Audio `AnalyserNode`. Nič sa neposiela na server — každý si to počíta sám zo zvuku, ktorý aj tak počuje.
- Meria sa len hráč so **zapnutým mikrofónom**. Vypnutý mikrofón, nestlačený push-to-talk alebo stlmená stopa = ticho.
- **Hysterézia:** začne svietiť nad hlasitosťou 0,04 (RMS), zhasne až pod 0,02 a po 450 ms ticha — krátke pauzy medzi
  slovami ho nerozblikajú.
- Funguje aj vtedy, keď mám zvuk stlmený (meria sa stream, nie reproduktor) — vidím, kto hovorí, aj keď ho nepočujem.
- Prehliadač spustí meranie až po prvom kliknutí/ťuknutí na stránku (pravidlo autoplay) — do vtedy sa nič neoznačí.
- Pri `prefers-reduced-motion` okraj nepulzuje, len svieti.
- Vypnutý mikrofón pri zapnutej kamere ostáva označený ako doteraz — **červený preškrtnutý mikrofón**.

Vysvetlivky: kapitola **🎙 Kamera, mikrofón, zvuk a chat** (živá ukážka hovoriaceho a tichého avatara + screenshot stola).

---

## 9. Otvorené body (nie sú súčasťou tejto verzie)

1. **Žiadosť o žetóny v appke** — teraz sa treba bankárovi ozvať v chate; tlačidlo „Požiadať bankára“ by bola nová funkcia so zmenou servera.
2. **Hľadanie** v okne Vysvetliviek.
3. **Bublina pre nového hráča** „📖 Vysvetlivky sú v menu ☰“ pri prvom príchode ku stolu.
4. **Odkazy z dialógov módov** („Viac vo Vysvetlivkách“) priamo na kapitolu.
