# Implementačný checklist

Postup podľa `ANALYSIS.md`. `[x]` = hotové a overené (typecheck/testy).

## 0. Projekt
- [x] `package.json` (scripts: dev, build, test, typecheck, start), `tsconfig` pre server a klienta
- [x] `.gitignore`, `.dockerignore`
- [x] `npm install` + `package-lock.json`

## 1. Shared (`shared/`)
- [x] Typy kariet, variantov, nastavení, akcií, `TableView`, `PlayerView`, eventov
- [x] Zoznam avatarov (emoji + farby), konštanty (max hráčov, limity)

## 2. Poker jadro (`server/poker/`)
- [x] `cards.ts` — balíček, crypto shuffle
- [x] `evaluator.ts` — hodnotenie 5 kariet, best-of-N (Hold'em), Omaha (2+3), popis ruky
- [x] `pots.ts` — side poty z príspevkov, uncalled bet, delenie + odd chip
- [x] `HandEngine.ts`
  - [x] blindy, button, heads-up pravidlá, blind all-in
  - [x] betovacie kolá, min-raise, short all-in neotvára betovanie
  - [x] no-limit a pot-limit
  - [x] fold-win, automatické dorozdanie pri all-in
  - [x] Pineapple discard fáza
  - [x] Omaha 4 karty + vyhodnotenie
  - [x] showdown, výsledky, 7-2 bonus
- [x] Unit testy (vitest): evaluator, Omaha, side poty, heads-up, short all-in, pot-limit, pineapple, 7-2

## 3. Server (`server/`)
- [x] `Table.ts` — hráči, sedenie, nastavenia, host príkazy, override ďalšej ruky, časovače, auto-start rúk
- [x] `SessionManager.ts` — kódy stolov, tokeny, cleanup prázdnych stolov
- [x] `index.ts` — Express (statika + SPA fallback + `/api/health` + `/api/config`), Socket.IO handlery s validáciou
- [x] HTTPS so self-signed certom (port 3443) + HTTP (3000)
- [x] Personalizovaný `TableView` (skryté cudzie karty)
- [x] Reconnect cez token, disconnect stav, kick
- [x] Chat + event log
- [x] WebRTC signalizácia (`rtc:signal`, zoznam peerov)

## 4. Klient (`client/`)
- [x] Socket klient + store (stav stola, identita v `localStorage`)
- [x] Lobby: založiť stôl / pripojiť sa (meno, avatar picker, nastavenia)
- [x] Stôl: ovál, 9 sedadiel, board, pot, button, blindy, banner špeciálneho kola
- [x] Sedadlo: avatar / video, meno, stack, stávka, karty, timer ťahu, stav (fold, all-in, offline, sit-out)
- [x] Moje karty + action bar (fold, check/call, raise slider + ½ pot / pot / all-in), pot-limit max
- [x] Pineapple discard UI
- [x] Host panel: štart/pauza, nastavenia, pridať žetóny, ďalšia ruka (Omaha/Pineapple/7-2), kick, transfer
- [x] Pozvánka (kopírovať odkaz), chat + log
- [x] Výsledok ruky (víťazi, popis ruky, 7-2 bonus)
- [x] WebRTC mesh hook (perfect negotiation), kamera/mikrofón toggle, fallback na avatara
- [x] Responzívny layout (fix 2026-11-02: horizontálny overflow lobby/host pravidiel na mobile, zalamovanie popisu ruky pri sedadle)

## 5. Docker a dokumentácia
- [x] `Dockerfile` (multi-stage), `docker-compose.yml` (porty 3000, 3443)
- [x] `README.md` — spustenie, pozvanie kamarátov v LAN, HTTPS varovanie, pravidlá

## 6. Overenie
- [x] `npm run typecheck` bez chýb
- [x] `npm test` zelené
- [x] Docker build + smoke test (len so súhlasom používateľa)

## 7. Iterácia 2 (2026-11-02) — peniaze, transakcie, UI fixy
- [x] Mobil: horizontálny overflow lobby a pravidiel hosta
- [x] Mobil: popis ruky pri sedadle prekrýval board (na úzkom stole len kategória, celý text v tooltipe)
- [x] Shared kontrakt: mena (EUR/CZK), sumy v centoch, `LedgerEntry`, `formatMoney`/`parseMoney`
- [x] Server: validácia nastavení (desatinné blindy, štart. vklad 0 – 1000 BB, mena) — agent `server-1`
- [x] Server: ledger transakcií (štart. vklad, dobitie/odobratie s poznámkou, odchod), texty logu s menou — agent `server-1`
- [x] Server: testy pre nastavenia a ledger — agent `server-1` (49/49 zelených)
- [x] Shared: symbol meny „Kč“ namiesto „CZK“ (`narrowSymbol`)
- [x] Klient: fix validátora „Štartovacie žetóny" (step=100) a desatinné vstupy — agent `client-2`
- [x] Klient: výber meny v lobby a v pravidlách hosta — agent `client-2`
- [x] Klient: dobitie/odobratie s poznámkou v paneli hosta — agent `client-2`
- [x] Klient: záložka „Transakcie" (súhrn po hráčoch + chronologický zoznam) — agent `client-2`
- [x] Klient: všetky sumy cez `formatMoney` — agent `client-2`
- [x] Integrácia: typecheck, testy 49/49, smoke test cez sockety (screenshoty v `docs/` až po sekcii 8)
- [x] Rebuild Docker kontajnera (2026-11-02 12:5x, bez čakacej miestnosti — tá je v sekcii 8)

## 8. Iterácia 3 — čakacia miestnosť a losovanie o dealer button
Hotové (agenti `server-3`, `client-4`).
- [x] Shared kontrakt: fáza stola `lobby` → `draw` → `playing`, stav losovania v `TableView`
- [x] Server: fáza `lobby` — hra sa nedá spustiť, kým nie sú aspoň 2 hráči so žetónmi — agent `server-3`
- [x] Server: voľba hosta po štarte — náhodný button / losovanie — agent `server-3`
- [x] Server: losovanie — potvrdenie „Rozumiem" od všetkých, 52 kariet rubom, každý si vytiahne 1, najvyššia vyhráva (pri rovnakej hodnote ♠ > ♥ > ♦ > ♣), timeout = náhodná karta za odpojeného/nečinného — agent `server-3`
- [x] Server: testy fáz a losovania — agent `server-3` (62/62 zelených)
- [x] Klient: obrazovka čakacej miestnosti (hráči, online stav, žetóny s poznámkou, pravidlá, Spustiť hru) — agent `client-4`
- [x] Klient: dialóg hosta „Začať losovaním o dealer button alebo rozhodnúť náhodne?" — agent `client-4`
- [x] Klient: vysvetlenie losovania pre všetkých (vrátane hosta) s tlačidlom „Rozumiem" — agent `client-4`
- [x] Klient: karty rozhádzané po stole, ťahanie, odkrytie pre všetkých, vyhlásenie dealera — agent `client-4`
- [x] Integrácia + rebuild kontajnera (e2e cez verejnú adresu: čakáreň → losovanie → prvá ruka s víťazom ako dealerom); screenshoty v `docs/` na konci

## 9. Iterácia 4 — zapamätané stoly, viac hostov, história a leaderboard
- [x] Shared kontrakt: názov stola, `adminIds`/`isAdmin`, `HandHistoryEntry`, `LeaderboardRow`, `TableSummary`
- [x] Server: viac hostov (pridelenie/odobratie práv, zakladateľ sa nedá odobrať) — agent `server-5`
- [x] Server: názov stola — agent `server-5`
- [x] Server: história rúk + leaderboard (aj pre hráčov, čo odišli) — agent `server-5`
- [x] Server: „Ukončiť hru → späť do čakárne“ (po dohraní ruky) — agent `server-5`
- [x] Server: ukladanie stolov na disk (Docker volume), obnova po reštarte, rozohraná ruka sa zruší a žetóny vrátia — agent `server-5`
- [x] Server: `table:summaries` pre zoznam „Moje stoly“ — agent `server-5`
- [x] Server: testy — agent `server-5` (86/86 zelených, reštart servera overený)
- [x] Klient: „Moje stoly“ na úvodnej obrazovke (pokračovať / zabudnúť) — agent `client-6`
- [x] Klient: čakáreň — záložky História a Leaderboard, názov stola — agent `client-6`
- [x] Klient: pridelenie/odobratie práv hosta, UI podľa `adminIds` — agent `client-6`
- [x] Klient: tlačidlo „Ukončiť hru → čakáreň“ — agent `client-6`
- [x] Integrácia + rebuild kontajnera (reštart kontajnera overený cez verejnú adresu: stôl, žetóny, transakcie aj host ostali)

## 11. Zvuky a časový limit
- [x] Predvolený časový limit na ťah 60 s (`DEFAULT_SETTINGS`, ANALYSIS.md)
- [x] Zvukový modul (Web Audio, bez externých súborov): rozdávanie, karty, žetóny, check, fold, all-in, výhra, 7-2, losovanie, chat — agent `sound-7`
- [x] Upozornenie na môj ťah + tiknutie pri posledných 10 s — agent `sound-7`
- [x] Nastavenia: „Zvukové efekty“ a „Upozornenie na ťah“ zvlášť, uložené v prehliadači — agent `sound-7`
- [x] Zapojenie zvukov do appky (menu hráča, topbar) — agent `client-6`
- [x] Rýchla zmena časového limitu počas hry v paneli hosta (30 s / 1 min / 2 min / vypnuté) — platí od ďalšieho ťahu — agent `client-6`
- [x] Integrácia, rebuild kontajnera

## 12. Pauza hráča a vrátenie sa do hry (štandardné pravidlá)
Server hotový (agent `server-8`), klienta robí agent `client-10`.
- [x] Shared kontrakt: krátka pauza (`away`), postavenie sa (`sittingOut`), dlžné blindy, spôsob návratu
- [x] Server: krátka pauza — hráč ostáva v hre, blindy sa mu strhávajú, karty sa mu hneď foldnú (check, ak je zadarmo), bez čakania na časový limit — agent `server-8`
- [x] Server: postavenie sa — hráč nedostáva karty ani neplatí blindy, server eviduje zmeškaný BB / SB — agent `server-8`
- [x] Server: návrat — „Počkať na BB“ alebo „Zaplatiť hneď“ (BB živý + SB mŕtvy, ak ho zmeškal); nový hráč počas hry rovnako — agent `server-8`
- [x] Server: pauzu celej hry môže dať len zakladateľ alebo hráč s právami hosta — agent `server-8`
- [x] Server: testy (zmeškané blindy, oba spôsoby návratu, heads-up, pauza s blindami) — agent `server-8` (111/111 zelených)
- [x] Klient: v menu „Pauza (som hneď späť)“ a „Postaviť sa od stola“, pri sedadle odznak „pauza“ / „vstal“ — agent `client-10`
- [x] Klient: dialóg návratu „Počkať na big blind“ / „Zaplatiť X a hrať hneď“ — agent `client-10`
- [x] Integrácia, rebuild kontajnera (e2e: pauza, postavenie sa, návrat so zaplatením, nový hráč počas hry)

## 13. Pravidlo 7-2 natrvalo
- [x] Server: neutrálne texty v logu (nie „Zuzka si vytiahol“, ale „Zuzka si ťahá“) — agent `server-8`
- [x] Klient: v paneli hosta → Hra prepínač „Pravidlo 7-2: zapnuté / vypnuté“ (platí od ďalšej ruky až do vypnutia), voľba „7-2 len na jednu ruku“ zmizne — agent `client-6`
- [x] Klient: odznak 7-2 na stole, kým je pravidlo zapnuté — agent `client-6`
- [x] Server: zrušiť jednorazové `nextHand.sevenDeuce`, ostáva len `sevenDeuceAlways` (+ úprava testov, ANALYSIS.md 3.3/3.4) — agent `server-8`

## 14. Mód Prasiatko + dialóg s pravidlami pred každým módom
Server robí agent `server-9`, klienta agent `client-10`.
- [x] Shared kontrakt: `GameMode`, `PiggyView`, `ModeIntroView`, `PIGGY_TARGET_WINS = 3`
- [x] Server: `host:piggy start/cancel` — vstup 1 BB od každého rozdaného hráča do prasiatka (mimo potu), potom štandardne SB/BB — agent `server-9`
- [x] Server: výherca ruky (aj časti potu) dostane zelený krúžok; prvý s 3 krúžkami berie prasiatko, mód končí (remíza = delenie) — agent `server-9`
- [x] Server: zrušenie hostom vráti každému jeho vstupy; nový hráč sa zapojí od ďalšej ruky s 0 krúžkami — agent `server-9`
- [x] Server: dialóg s pravidlami pred prvou rukou módu (Omaha, Pineapple, 7-2, Prasiatko) — ruka čaká na „Rozumiem“ od všetkých (max 60 s) — agent `server-9`
- [x] Server: testy — agent `server-9` (134/134 zelených, smoke: 8 rúk, víťaz 3/3 berie 4,20 €, žetóny sedia)
- [x] Klient: karta „Prasiatko“ v paneli hosta → Hra — agent `client-10`
- [x] Klient: 3 krúžky pri každom avatare (zelené = výhry), prasiatko na stole s aktuálnou sumou, plní sa — agent `client-10`
- [x] Klient: oslavná animácia + dialóg pre všetkých „Prasiatko skončilo — vyhráva X (suma)“ — agent `client-10`
- [x] Klient: dialóg s pravidlami módu + „Rozumiem“ — agent `client-10`
- [x] Server: presadnutie počas hry nesmie obísť blindy — agent `server-9`
- [x] Rebuild kontajnera (lokálne aj verejná adresa — je to ten istý kontajner); uložené stoly (4) prežili rebuild

## 15. Chat správy ako notifikácie
- [x] Klient: správa od iného hráča vybehne vpravo hore pod tlačidlami, max 10 s, max 3 naraz, postupne miznú — agent `client-6`
- [x] Klient: klik na notifikáciu otvorí chat; nezobrazujú sa, keď je chat otvorený, ani moje vlastné správy — agent `client-6`

## 16. Timebank
- [x] Shared kontrakt: základ 15 s, timebank 50 s, hranice 5–200 s, `turnBaseDeadline`, `timeBankMs`
- [x] Server: ušetrený základný čas / 2 → timebank; minutý timebank sa odpočíta; vždy 5–200 s; po vypršaní auto-ťah a timebank 5 s — agent `server-9`
- [x] Server: timebank sa ukladá s hráčom (prežije reštart), testy — agent `server-9` (144/144 zelených)
- [x] Klient: odpočet základu → prepnutie do „⏱ Timebank“ (iná farba), timebank pri hráčoch — agent `client-10`
- [x] Klient: cinknutie na konci základných 15 s + tiknutie pri posledných 5 s — agent `client-10`
- [x] Klient: nastavenie základného času a štartovacieho timebanku v paneli hosta — agent `client-10`
- [x] Rebuild kontajnera (lokálne aj verejná adresa)

## 17. Odchod od stola bez straty účtu, mazanie stola
Server hotový (agent `server-11`), klienta robí agent `client-12`.
- [x] Server: „Odísť od stola“ uvoľní miesto, ale hráč ostáva členom stola (stack, štatistiky, timebank, transakcie) — žiadny výber žetónov — agent `server-11`
- [x] Server: návrat cez uložený token → automaticky miesto (pôvodné, ak je voľné), stack ako pri odchode; počas hry čaká na BB alebo zaplatí — agent `server-11`
- [x] Server: odchod nikdy nezmaže stôl ani nevyhodí ostatných; ak pri stole neostane žiadny host, práva dostane náhodný prítomný hráč — agent `server-11`
- [x] Server: zakladateľ po návrate dostane práva hosta späť — agent `server-11`
- [x] Server: `host:deleteTable` len pre zakladateľa → všetkým príde „Stôl bol zmazaný“, súbor sa zmaže — agent `server-11`
- [x] Server: testy — agent `server-11` (171/171 zelených)
- [x] Klient: „Odísť od stola“ pri stole → hráč vstane (miesto ostáva, štandardné blindy) a vidí čakáreň stola pod kódom stola, hra beží ďalej; „🎲 Späť ku stolu“ → počkať na BB / zaplatiť; po obnovení stránky ostáva v čakárni (sessionStorage)
- [x] Klient: až z čakárne „Opustiť hru“ → úvodná obrazovka, stôl ostane v „Moje stoly“ so žetónmi a štatistikami (aj po zatvorení prehliadača), kým ho host nezmaže
- [x] Klient: v nastaveniach stola „Zmazať stôl“ s potvrdením (prepísať kód stola) — agent `client-12`
- [x] Klient: bug — stávka dolných hráčov prekrývala odpočet timebanku → stávka sa odsúva nad odpočet, značka SB/BB nižšie (overené meraním na 9 miestach × 1440/1024/390/360)
- [x] E2E (3 prehliadače): čakáreň počas hry, obnovenie, návrat s dialógom BB, Opustiť hru, zatvorený prehliadač → Pokračovať so zachovaným stackom
- [x] Rebuild kontajnera (lokálne aj verejná adresa) — 2026-11-02 15:3x

## 19. Zjednodušené zakladanie stola (2026-11-02)
- [x] Formulár „Založiť stôl“ bez štartovacieho vkladu (stôl vzniká so vkladom 0, žetóny host pridelí každému v čakárni)
- [x] Základný čas na ťah pevne 15 s — zmiznutý z formulára, panelu hosta aj pravidiel; server ho ignoruje a staršie stoly prepne na 15 s

## 18. Dokumentácia UI
- [x] Nové screenshoty všetkých 32 obrazoviek (desktop + mobil) z bežiaceho kontajnera v `docs/screenshots/`, `docs/UI.md` prepísané
- [ ] Zmazať zastarané `docs/screenshots/*-waiting.png` (príkaz `rm` mi nebol povolený)
- [x] Doplnené `room-playing`, `delete-table`; pretočené `timebank`, `my-tables`, `lobby`, `room`, `menu`, `host-game`, `host-rules`

## 20. Hosting nezávislý od Macu — Oracle Always Free (2026-11-02)
- [x] Rozhodnutie: Oracle Always Free VM (trvalo zadarmo, disk, pevná IP) + Caddy s Let's Encrypt na `<IP>.sslip.io`
- [x] `deploy/oracle/`: `docker-compose.cloud.yml`, `Caddyfile`, `deploy.sh` (rsync z Macu, `--with-data` prenesie stoly), `remote-setup.sh` (Docker, swap, iptables), `README.md`
- [x] Lokálny smoke test: hra za Caddy (health, Socket.IO handshake, stránka)
- [ ] Používateľ: účet Oracle, VM Ubuntu 24.04 (A1 Flex), ingress 80/443 v Security List
- [ ] `deploy/oracle/deploy.sh <IP> --with-data` a overenie hry cez `https://<IP>.sslip.io`
- [ ] Po prechode: vypnúť `poker-tunnel` na Macu a poslať hráčom novú adresu

## 21. Verejný server na NAS — limity a izolácia (2026-11-02)
- [x] Overené zo zdrojového kódu Tailscale (`ipn/ipnlocal/serve.go`): Funnel nastaví (neprepíše len pripojí) `X-Forwarded-For` na IP klienta; Funnel je verejný, hráči Tailscale nepotrebujú
- [x] `server/limits.ts`: zakladanie stolov na IP (3/h, 10/deň) aj celkovo (30/h, 100/deň), max 300 stolov, joiny, hľadanie kódov, spojenia na IP a celkovo, token bucket na udalosti (WebRTC zvlášť), členovia a transakcie stola, nepoužité stoly 24 h
- [x] Kontrola `Origin` (cudzie stránky sa nepripoja), `TRUST_PROXY` (off / xff / cloudflare), IPv6 po /64
- [x] Testy `server/test/limits.test.ts` (183/183), socket smoke (4. stôl z IP odmietnutý, globálny limit pri viacerých IP, cudzí Origin odmietnutý, 200 WebRTC správ prejde, 31. spojenie z IP odmietnuté)
- [x] Mac kontajner: `TRUST_PROXY=cloudflare`; overené cez tunel — server vidí verejnú IP, podvrhnutú `CF-Connecting-IP` Cloudflare odmietne (403)
- [x] `deploy/nas/`: spevnený compose (non-root, read-only, cap_drop ALL, internal sieť bez internetu, limity) + Tailscale Funnel sidecar; spevnenie overené lokálne
- [x] Nasadené na UGREEN NAS (Debian 12, Docker 26) cez Tailscale SSH; 6 stolov prenesených z Macu
- [x] Verejne: https://poker.taild81a8a.ts.net (Funnel, Let's Encrypt) — health, stránka, Socket.IO/WebSocket, cudzí Origin 403, server vidí skutočnú verejnú IP hráča
- [x] Oprava: hostname sidecaru `poker` zatienil kontajner hry → proxy na `poker-night:3000`, hostname `poker-tailscale`
- [x] Mac kontajnery `poker-night` a `poker-tunnel` zastavené (záloha), stoly sa nerozdelia

## 22. Pripomienky z testu kamaráta (desktop) — 2026-11-02
- [x] Moje karty na desktope v strede spodnej lišty a väčšie (92×131 px)
- [x] Žetóny: tlačidlá „+ Pridať“ / „− Zobrať“, počas ukladania zablokované (žiadne dvojité pridanie), potvrdenie „✓ Pridané 20 €“
- [x] Štatistiky: tlačidlo „📊 Štatistiky“ v hornej lište (stôl → bočný panel, čakáreň → sekcia Výsledky)
- [x] Kamera: TURN relay (coturn) cez Funnel :8443 + údaje len pre hráčov pri stole; overené relay-only spojenie cez verejnú adresu a video medzi 2 prehliadačmi
- [x] Panel hosta: riadok so žetónmi sa už nezalamuje mimo panelu

## 23. Zvuk, push-to-talk, väčšie video, ukázanie kariet, chat overlay (2026-11-02)
- [x] Zvuk na jednom mieste: tlačidlo 🔊 v lište otvorí nastavenia (efekty, upozornenie, posuvník hlasitosti efektov a hlasu hráčov); z menu ☰ odstránené
- [x] Push-to-talk (len desktop, predvolene vypnutý, kláves si hráč zvolí; pri písaní do polí sa ignoruje, pri strate fokusu stlmí)
- [x] Menu ☰: zlúčené „Postaviť sa“ a „Odísť od stola“ → jedno „Odísť od stola“ (do čakárne); „Vrátiť sa do hry“ len keď stojím
- [x] Štatistiky: tlačidlo v lište len keď nie je bočný panel (desktop má záložku Štatistiky)
- [x] Hráč s kamerou má väčší avatar (desktop 112 px, mobil 78 px), kamera 480 px; stávky a odpočet bez prekryvu na vlastnom mieste
- [x] Dobrovoľné „👁 Ukázať karty“ po skončení ruky (+3 s zobrazenia výsledku), testy `server/test/showcards.test.ts`
- [x] Desktop: posledných 5 správ za 15 s ako overlay vľavo hore, história ostáva v bočnom paneli
- [x] Omaha/Pineapple showdown: odkryté karty s menším presahom, pri pravom okraji naľavo od avatara, bočné miesta nad stávkou
- [x] 7-2 bonus už nie je na stole, ale v hornej lište („· 7-2 bonus 0,40 €“), len keď platí
- [x] Nasadené na NAS (overené cez verejnú adresu)

## 24. Spätná väzba z hry (2026-11-02 večer)
- [x] Push-to-talk presunutý pod tlačidlo mikrofónu (šípka ▾ vedľa neho, len desktop); zvuk má len efekty a hlasitosti
- [x] Ikona mikrofónu: SVG mikrofón, vypnutý = preškrtnutý mikrofón (aj pri hráčovi na stole)
- [x] „👁 Ukázať karty“ priamo na mojich kartách; odkryté karty súperov o 50 % väčšie
- [x] Módy (7-2 bonus, špeciálne kolo, Prasiatko) ako chipy v hornej lište; zo stola odstránené
- [x] Pauza / stojím mimo hry: veľký banner nad boardom namiesto rohu spodnej lišty
- [x] Vlastný potvrdzovací dialóg namiesto systémového (odchod, opustenie hry, vyhodenie, odovzdanie, práva, Prasiatko, koniec hry, zabudnutie stola)
- [x] Nasadené na NAS
- [x] „Pokračovať“ v Moje stoly otvorí čakáreň stola; počas hry hráč stojí bez automatického čakania na BB (server `table:resume { standing }`, testy), ku stolu cez „Späť ku stolu“ — nasadené

## 10. Verejná adresa zadarmo
- [x] Cloudflare quick tunnel (kontajner `poker-tunnel`) → verejná HTTPS adresa `*.trycloudflare.com`, bez účtu a bez platby
- [x] Overené cez tunel: health, stránka, WebSocket, celý socket smoke test
- [ ] README: sekcia „Hrať cez internet zadarmo“
