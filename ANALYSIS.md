# Analýza — Poker Night (online poker stôl s kamarátmi)

## 1. Cieľ

Webová hra pre partiu kamarátov. Jeden hráč založí **session (stôl)**, pošle odkaz, ostatní sa pripoja.
Zakladateľ (**host**) spravuje žetóny a pravidlá — aj počas hry môže vyhlásiť jedno špeciálne kolo
(Omaha, Pineapple, pravidlo 7-2). Každý hráč má avatara a môže si zapnúť webkameru, ktorá avatara
nahradí — stôl tak pôsobí ako živý.

Výstup musí ísť spustiť lokálne cez `docker compose up` bez ďalších závislostí.

## 2. Roly a používateľské scenáre

| Rola | Čo môže |
| --- | --- |
| Host | založiť stôl, zdieľať odkaz, spustiť/pozastaviť hru, pridávať žetóny ľubovoľnému hráčovi, meniť blindy, štartovací stack (pri založení 0 — žetóny sa prideľujú v čakárni), štartovací timebank, predvolený variant, výšku 7-2 bonusu, vyhlásiť špeciálne kolo pre ďalšiu hru, vyhodiť hráča, odovzdať rolu hosta; zakladateľ navyše zmazať stôl (po zadaní kódu stola) |
| Hráč | pripojiť sa cez odkaz, zvoliť meno + avatar, hrať (fold/check/call/bet/raise/all-in), sit-out, zapnúť/vypnúť kameru a mikrofón, chat |

Scenáre:
1. Host otvorí appku → „Založiť stôl" → zadá meno, avatar, blindy, štart. stack → dostane odkaz `/t/ABCD12`.
2. Kamarát otvorí odkaz → zadá meno + avatar → sadne si na voľné miesto.
3. Host klikne „Spustiť hru" → rozdávajú sa ruky automaticky jedna za druhou.
4. Počas hry host klikne „Ďalšia ruka: Omaha" → ďalšia ruka je Omaha (pot-limit), potom sa vráti predvolený variant.
5. Hráč minie žetóny → je automaticky sit-out, host mu pridá žetóny → vracia sa do hry od ďalšej ruky.
6. Hráč zapne kameru → na jeho mieste sa všetkým zobrazí živé video namiesto avatara.
7. Hráč obnoví stránku / vypadne wifi → po návrate sedí na tom istom mieste (token v `localStorage`).
8. Hráč klikne „Odísť od stola“ → vráti sa na úvodnú obrazovku, miesto sa uvoľní (počas ruky sa zahodí a miesto sa
   uvoľní po jej dohraní). Účet ostáva: stack, štatistiky, timebank a zmeškané blindy sa uložia, do ledgeru sa nič
   nezapisuje (žetóny mu pri stole stále patria). Stôl ostáva v „Moje stoly“ aj po zatvorení prehliadača.
9. Hráč sa vráti (`table:resume` s uloženým tokenom) → automaticky si sadne na svoje miesto, ak je voľné, inak na prvé
   voľné; pri plnom stole „Stôl je plný — počkaj, kým sa uvoľní miesto“ (členstvo ostáva). Počas hry (po prvej ruke)
   čaká na big blind ako nový hráč (dlží aspoň BB); v čakárni / pri losovaní si rovno sadne. Bez žetónov čaká na vklad.
   Ak sa vráti ešte počas ruky, z ktorej odchádza, odchod sa zruší.
10. Zakladateľ ostáva zakladateľom navždy (mení sa len cez `host:transfer`). Keď odíde a pri stole nesedí nikto
    s právami hosta, dostane ich náhodný sediaci hráč; po návrate zakladateľ práva hosta dostane späť. Iný hráč
    s právami hosta ich odchodom stráca. `host:transfer` a `host:deleteTable` sú len pre zakladateľa (keď je preč,
    nedajú sa použiť).
11. Odchod hráča stôl nikdy nemaže ani nevyhadzuje ostatných. Stôl zmaže len zakladateľ v nastaveniach (musí
    prepísať kód stola) alebo expirácia po 90 dňoch bez aktivity.
12. Vyhodenie hostom je naopak cash-out: zápis „Vyhodenie hostom“ do ledgeru, token prestane platiť (návrat zlyhá,
    „Moje stoly“ ho hlásia ako `missing`).

## 3. Herné pravidlá

### 3.1 Spoločný základ
- 2–9 hráčov, balíček 52 kariet, kryptograficky bezpečné miešanie (`crypto.randomInt`, Fisher–Yates).
- Dealer button, small blind, big blind; button sa posúva na ďalšieho aktívneho hráča.
- **Heads-up**: button = small blind, preflop začína button, postflop začína big blind.
- Hráč, ktorý nevie pokryť blind, ide all-in za to, čo má.
- Ulice: preflop → flop (3) → turn (1) → river (1) → showdown.
- Akcie: fold, check, call, bet/raise (na sumu „raise to"), all-in.
- Min-raise = posledné navýšenie (minimálne BB). **All-in za menej ako plný raise neotvára betovanie**
  hráčom, ktorí už v kole konali (môžu len call/fold).
- Keď už nikto nemôže konať (všetci all-in / jeden zostal s žetónmi), board sa dorozdá automaticky s pauzou.
- **Nedorovnaná stávka** (uncalled bet) sa vracia hráčovi pred rozdelením potu.
- **Side poty** z príspevkov hráčov; foldnuté žetóny zostávajú v pote ako „dead money".
- Delenie potu pri zhode; zvyšný žetón ide prvému víťazovi vľavo od buttonu.
- Pri showdowne sa odkryjú karty všetkých hráčov, ktorí nefoldli.
- Časový limit na ťah: základ 15 s + osobný timebank (štart 50 s, min. 5 s, max. 200 s; polovica ušetreného základu sa pripíše), 0 = bez limitu → po vypršaní auto-check, inak auto-fold.
  - Na každý ťah má hráč základný čas (`actionTimeoutSec`, pevne 15 s — nedá sa zmeniť ani pri založení, ani v nastaveniach; staršie stoly sa pri načítaní prepnú na 15 s). Keď konal v ňom, pripíše sa mu polovica ušetreného
    základu (ušetrených 10 s → +5 s; v ms, zaokrúhlené nadol). Po uplynutí základu (`turnBaseDeadline`) beží jeho timebank až do
    `turnDeadline`; minutý čas sa odpočíta. Po každej zmene sa timebank oreže na 5–200 s — nikdy neklesne pod 5 s (ani po úplnom
    vypršaní, keď server za hráča checkne/folduje), nikdy nepresiahne 200 s.
  - Štartovací timebank (`timeBankSec`, 5–200 s, predvolene 50 s) dostane hráč pri príchode ku stolu; zmena nastavenia platí len pre
    nových hráčov. Timebank sa drží naprieč rukami, návratom do čakárne aj reštartom servera (staršie súbory = `timeBankSec`).
  - `actionTimeoutSec = 0` → žiadne časovače, timebank sa nemení. Hráč na krátkej pauze koná hneď a timebank sa mu nemení.
    Odpojenému hráčovi sa celkový čas skráti najviac na 15 s od odpojenia; odpočíta sa len skutočne minutý čas po základe.
  - Pineapple discard, losovanie o button a úvod módu majú vlastné limity bez timebanku.

### 3.1a Pauza hráča, postavenie sa od stola a zmeškané blindy
- **Krátka pauza** (`player:away`, WC/cigareta) — môže si ju dať každý hráč, v ktorejkoľvek fáze. Hráč ostáva rozdávaný
  a **platí blindy**; keď je na ťahu, server hneď (bez čakania na časový limit) checkuje, ak je to zadarmo, inak folduje;
  v Pineapple hneď zahodí kartu. Pauza prežije odpojenie aj reštart servera. Celú hru pozastaví len vlastník/host (`host:pause`).
- **Postavenie sa od stola** (`player:sitout { value: true }`) — hráč nedostáva karty a neplatí blindy, ale eviduje sa mu
  dlh `missedBlinds` (len vo fáze `playing` po prvej ruke; v čakárni a pri losovaní nikto nič nedlží, návrat do čakárne dlhy maže).
  - Pri každej rozdanej ruke sa pre každého, kto sedí a nedostal karty (postavený, čakajúci na návrat, bez žetónov), pozrie,
    či mu cez miesto prešiel blind: BB prešiel, keď jeho miesto leží v oblúku *(miesto BB minulej ruky, miesto BB tejto ruky]*
    v smere hry, SB analogicky. Každý prejdený blind posunie dlh o stupeň `none → big → small-and-big`
    (zmeškaný len SB sa splatí živým BB — typ nemá stav „len SB“). Prvá ruka hry nič neeviduje.
  - Nový hráč, ktorý príde počas hry (po prvej ruke), dlží `big` a automaticky čaká na big blind (`wait-bb`), môže prepnúť na `post`.
  - Hráč bez žetónov sa eviduje rovnako ako postavený; po dobití hrá hneď, ak ho medzitým nemínul žiaden blind, inak čaká na BB.
- **Návrat** (`player:return { mode }`): nič nedlží → sadne si hneď (to isté robí `player:sitout { value: false }`, ktoré pri dlhu
  odmietne: „Najprv si vyber, či počkáš na big blind alebo zaplatíš“).
  - `wait-bb`: dostane karty presne v ruke, v ktorej by bol na pozícii BB (počíta sa, akoby už bol rozdaný), a dá bežný BB.
  - `post`: hrá od najbližšej ruky z ľubovoľnej pozície — dá **živý BB** (je to jeho stávka, preflop môže checkovať, ak nikto
    nenavýšil; min-raise sa nemení) a pri `small-and-big` aj **mŕtvy SB** (ide do hlavného potu, nie je to jeho stávka, nedáva
    nárok na pot). Na pozícii BB dá len bežný BB; na pozícii SB počká ešte jednu ruku (zo SB sa doplácať nedá — SB ho pritom minie,
    takže potom dopláca BB + mŕtvy SB). Pri nedostatku žetónov sa platí najprv živá, potom mŕtva časť (all-in ako pri blindoch).
  - Keď by bez vracajúcich sa hráčov ostal menej ako 2 bežní hráči (napr. heads-up), vracajúci sa dostanú karty hneď a nič nedoplácajú.
  - Dealer button dostávajú len bežne hrajúci hráči.
- **Zmena miesta počas hry** (`seat:take` vo fáze `playing` po prvej ruke, medzi rukami) — blindom sa presadnutím nedá vyhnúť:
  hrajúci hráč sa po presadnutí berie ako vracajúci sa, ktorý zmeškal BB (`missedBlinds` aspoň `big`, `returnMode: 'wait-bb'`,
  môže prepnúť na `post`); postavený / čakajúci hráč si dlh ponechá (aspoň `big`) aj svoju voľbu návratu.
  Výnimka: keby bez neho ostal menej ako 2 hráči (heads-up) — presadnutie je bez následkov. V čakárni a pred prvou rukou sa nič neeviduje.

### 3.2 Varianty
| Variant | Karty v ruke | Vyhodnotenie | Betovanie |
| --- | --- | --- | --- |
| Texas Hold'em (default) | 2 | najlepších 5 zo 7 | No-limit |
| Omaha | 4 | **presne 2 z ruky + presne 3 z boardu** (6 × 10 kombinácií) | Pot-limit |
| Pineapple | 3 → po preflop betovaní každý **zahodí 1 kartu** (súčasne, s časovým limitom; timeout = zahodí sa 3. karta) | ako Hold'em | No-limit |

Pot-limit maximum: `raise to = aktuálna stávka + (pot + všetky stávky na stole + suma na dorovnanie)`.

### 3.3 Pravidlo 7-2
- Ak hráč **vyhrá pot** (aj bez showdownu) a v ruke má **7 a 2** (ľubovoľné farby), každý ďalší hráč,
  ktorý bol v ruke rozdaný, mu zaplatí **bonus** (nastaviteľný, predvolene 2× BB, max. do výšky svojho stacku).
- Karty víťaza sa pri 7-2 výhre odkryjú všetkým.
- Platí len pri 2-kartových variantoch (Hold'em, Pineapple po discarde), pri Omahe sa ignoruje.
- Zapína sa **pre celú hru** nastavením stola `sevenDeuceAlways`: platí pre ruky rozdané po zapnutí, kým ho host nevypne
  (rozdaná ruka si pravidlá ponechá). Udalosti „Pravidlo 7-2 je zapnuté (od ďalšej ruky)“ / „Pravidlo 7-2 je vypnuté“.
  Na jednu ruku sa už vyhlásiť nedá.

### 3.4 Špeciálne kolo („jedno kolo") vs. trvalé nastavenia
- Trvalé: predvolený variant, 7-2 zapnuté/vypnuté, blindy, bonus, štartovací timebank, štart. stack.
- **Ďalšia ruka**: host nastaví prepis `{ variant? }`, ktorý platí presne pre najbližšiu ruku
  a potom sa automaticky zruší (zastarané pole `sevenDeuce` server ignoruje). Všetkým sa zobrazí banner („Ďalšia ruka: OMAHA").
- Zmeny blindov/variantu počas rozdanej ruky sa prejavia až od ďalšej ruky.

### 3.5 Prasiatko (mód)
- Host ho spustí (`host:piggy { action: 'start' }`) v čakárni alebo počas hry (nie počas losovania o button); platí od
  najbližšej rozdanej ruky (`startedAtHand`), pred ňou sa ukáže úvod s pravidlami (3.6). Vstup = BB v čase spustenia, cieľ = 3 výhry.
- Pred každou rukou dá **každý rozdaný hráč** (aj hráč na krátkej pauze) vstup do prasiatka — odpočíta sa zo stacku ešte pred
  blindami, **nejde do potu**; potom sa hrá štandardne (SB, BB…). Postavení a čakajúci hráči neplatia a nehrajú.
- Hráč, ktorému by po vstupe neostal ani cent (stack ≤ vstup), **nedostane karty a nič nezaplatí** — žetóny si ponechá, eviduje sa
  ako hráč bez žetónov (zmeškané blindy, „čaká na dokúpenie“) a vráti sa po dobití nad výšku vstupu alebo po skončení Prasiatka.
- Po dohraní ruky dostane **každý, kto vyhral akúkoľvek časť potu** (aj bez showdownu, aj pri delenom pote), jeden krúžok
  (max. 3). Kto prvý dosiahne 3, berie celé prasiatko (pripíše sa mu po ruke). Viacerí naraz si ho delia rovnakým dielom,
  zvyšný cent ide prvému víťazovi vľavo od buttonu. Prasiatko potom ostane `finished` ešte `PIGGY_CELEBRATION_MS` (oslava + dialóg),
  ďalšia ruka sa rozdá najskôr po tomto čase; potom `piggy = null` a hrá sa bez neho.
- Kto príde / vráti sa počas Prasiatka, má od svojej prvej rozdanej ruky 0 krúžkov. Kto odíde, stráca krúžky; jeho vstupy
  ostávajú v prasiatku.
- **Zrušenie** (`host:piggy { action: 'cancel' }`): každý prítomný dostane späť presne svoje vstupy (počas rozdanej ruky ako čakajúce
  žetóny); vstupy hráčov, ktorí odišli, sa rovnomerne rozdelia medzi prítomných prispievateľov (keď nie je nikto taký, medzi
  všetkých prítomných), zvyšný cent prvému vľavo od buttonu. Vstupy ani výplaty sa nezapisujú do ledgeru (sú to presuny medzi hráčmi
  ako pot); v leaderboarde sa vstupy v prasiatku neprejavia ako stack, kým sa nevyplatia.
- Návrat do čakárne Prasiatko nezruší — pokračuje pri ďalšom spustení hry (aj s krúžkami). Reštart servera: bežiace Prasiatko sa uloží;
  pri zrušenej rozohranej ruke sa vrátia aj vstupy zaplatené pri jej rozdaní. Skončené (`finished`) sa po reštarte nezobrazuje.
- Udalosti: „Host spúšťa Prasiatko — vstup 0,20 € do prasiatka pred každou rukou, prvý s 3 výhrami berie všetko“,
  „Do prasiatka ide 3 × 0,20 € (spolu 0,60 €)“, „Zuzka získava krúžok v Prasiatku (2/3)“, „Zuzka vyhráva Prasiatko — 4,20 €!“,
  „Prasiatko si delia Zuzka (0,61 €) a Peťo (0,60 €)!“, „Host ruší Prasiatko — vstupy sa vracajú“, „Z prasiatka sa vracia: …“.

### 3.6 Úvod módu (pravidlá pred prvou rukou)
- Keď má najbližšia ruka mód, ktorý v minulej rozdanej ruke nebol — Omaha, Pineapple (špeciálne kolo aj predvolený variant),
  pravidlo 7-2 (prvá ruka po zapnutí), Prasiatko (prvá ruka po spustení) — server ruku nerozdá a nastaví
  `modeIntro { mode, participants, acknowledged, deadline }` (účastníci = hráči, ktorí v nej dostanú karty).
- `mode:ack` potvrdzuje „Rozumiem“; odpojení, hráči na krátkej pauze, postavení a odchádzajúci sa potvrdia automaticky. Keď
  potvrdia všetci alebo uplynie `MODE_INTRO_TIMEOUT_SEC`, úvod zmizne a ruka sa rozdá po krátkej pauze (1,5 s). Kto príde počas úvodu, len sa pozerá.
- Viac nových módov naraz (napr. Pineapple + 7-2) sa ukáže **postupne**, jeden dialóg po druhom (poradie variant → 7-2 → Prasiatko).
- Opakovane sa neukazuje pri po sebe idúcich rukách rovnakého módu. Prvá ruka hry (aj po návrate z čakárne) ukáže úvod pre
  predvolený variant, len ak to nie je Hold'em. Omaha → Hold'em → Omaha ukáže úvod Omahy znova; 7-2 sa po vloženej Omahe
  (kde 7-2 neplatí) znova neukazuje. Vypnutie a zapnutie 7-2 / nové spustenie Prasiatka ho ukáže znova.
- Pauza celej hry alebo návrat do čakárne úvod zruší — pred rozdaním sa ukáže znova. Keď host počas úvodu zmení pravidlá tak,
  že mód v ďalšej ruke nebude (zruší špeciálne kolo, vypne 7-2, zruší Prasiatko), úvod sa zavrie. Pri reštarte sa uloží, ktoré módy
  už boli rozdané (úvod sa neopakuje); otvorený úvod sa neukladá.

## 4. Architektúra

```
Browser (React + Vite)  ──Socket.IO──►  Node 22 server (Express + Socket.IO)
   │  ▲                                    ├─ SessionManager (in-memory mapy stolov)
   │  │  WebRTC mesh (video/audio P2P)      ├─ Table (hráči, nastavenia, časovače, host príkazy)
   └──┴──── signalizácia cez Socket.IO ─────┤─ HandEngine (čistá logika jednej ruky)
                                            └─ evaluator (hodnotenie 5-kartových rúk)
```

- **Jeden proces, jeden kontajner, žiadna DB** — stav je v pamäti a každý stôl sa priebežne ukladá ako JSON
  do `DATA_DIR/tables/<KÓD>.json`; po reštarte servera sa stoly načítajú (rozohraná ruka sa zruší, hra je pozastavená).
- **Server je autorita.** Klient posiela len zámery (`action`, `discard`, host príkazy), server validuje.
- **Personalizovaný stav**: každý klient dostane `TableView`, kde sú cudzie karty skryté (anti-cheat).
- **HandEngine** je čistá trieda bez časovačov a I/O → plne unit-testovateľná. Časovače (timeout ťahu,
  automatické dorozdanie, pauza medzi rukami) rieši `Table`.
- **Identita**: pri vstupe server vydá `playerId` + tajný `token`; klient ho drží v `localStorage` pod kódom stola.
- **Webkamera**: WebRTC mesh (každý s každým, vhodné do ~9 ľudí), perfect-negotiation pattern,
  signalizácia cez existujúci socket (`rtc:signal`). STUN konfigurovateľný cez env (`ICE_SERVERS`);
  v LAN funguje aj bez internetu.
- **Avatary**: emoji + farba pozadia (lokálne, žiadne CDN). Keď je zapnutá kamera, `<video>` nahradí avatara.

### 4.1 Bezpečný kontext pre kameru (dôležité)
`getUserMedia` funguje len na `https://` alebo `http://localhost`. Kamaráti na `http://192.168.x.x` by kameru
nemali. Preto server popri HTTP (port 3000) beží aj na **HTTPS (port 3443) so self-signed certifikátom**
generovaným pri štarte (alebo vlastný cert cez env). Prehliadač ukáže varovanie, ktoré treba raz odkliknúť.

### 4.2 Tech stack
| Vrstva | Voľba | Dôvod |
| --- | --- | --- |
| Jazyk | TypeScript (strict) | spoločné typy klient/server |
| Server | Express + Socket.IO 4 | rooms, reconnect, ack |
| Klient | React 18 + Vite | rýchly vývoj, bundluje všetko (žiadne runtime CDN) |
| Testy | Vitest | evaluator, side poty, engine |
| Build servera | esbuild (bundle do `dist/server.js`) | jednoduchý runtime |
| Docker | multi-stage `node:22-alpine` | jeden image, `docker compose up` |

Jeden `package.json` (bez workspace) — `shared/` sa importuje relatívne zo servera aj klienta.

## 5. Protokol (Socket.IO udalosti)

Klient → server (všetky s ack `{ ok, error? }`):
- `table:create { name, avatar, settings }` → `{ code, playerId, token }`
- `table:join { code, name, avatar }` (vždy nový člen) / `table:resume { code, playerId, token }` (sediaci hráč sa len
  pripojí, člen, ktorý odišiel, si znova sadne; chyby „Relácia vypršala“, „Stôl je plný — počkaj, kým sa uvoľní miesto“)
- `table:summaries { items: [{ code, playerId, token }] }` → `{ summaries, missing }` (aj pre členov, ktorí odišli;
  `missing` = stôl neexistuje / bol zmazaný alebo hráča vyhodili)
- `seat:take { seat }`, `player:sitout { value }` (postaviť sa / sadnúť si späť, ak nič nedlží),
  `player:leave` (odchod so zachovaním účtu — pozri scenár 8),
  `player:update { name?, avatar?, camera? }`
- `player:away { value: boolean }` (krátka pauza), `player:return { mode: 'wait-bb' | 'post' }` (návrat po postavení sa)
- `game:action { type, amount? }`, `game:discard { cardIndex }`
- `host:start`, `host:pause` (len vlastník / hráč s právami hosta, inak „Toto môže len host“), `host:settings { ... }`,
  `host:addChips { playerId, amount }`, `host:nextHand { variant? }`, `host:kick { playerId }`, `host:transfer { playerId }`
- `host:deleteTable { code }` — len zakladateľ („Stôl môže zmazať len zakladateľ“), `code` musí byť kód stola
  („Kód stola nesedí“); všetkým v miestnosti príde `table:deleted`, stôl zmizne z pamäte aj z disku
- `host:piggy { action: 'start' | 'cancel' }` (Prasiatko; chyby „Prasiatko už beží“, „Prasiatko nebeží“,
  „Počas rozhodovania o dealer buttone sa Prasiatko nedá spustiť“, „Neplatná voľba“)
- `mode:ack {}` (potvrdenie pravidiel módu; chyby „Pravidlá módu sa teraz nepotvrdzujú“, „Nie si účastníkom tejto ruky“)
- `chat:send { text }`
- `rtc:signal { to, data }`

Server → klient:
- `table:state TableView` (po každej zmene, personalizovaný)
- `table:event { kind, text, ... }` (log: kto čo spravil, výsledky rúk, 7-2 bonus)
- `table:history TableEvent[]` (po pripojení), `rtc:signal { from, data }`
- `table:left { kicked: boolean }` — socket bol odpojený od stola: `kicked: false` = dobrovoľný odchod (token ostáva
  platný na návrat), `kicked: true` = vyhodenie (token zabudnúť)
- `table:deleted { code, byName }` — zakladateľ `byName` stôl zmazal; klient ho zabudne a vráti sa na úvod

## 6. Riziká a rozhodnutia

| Riziko | Riešenie |
| --- | --- |
| Chyby v side potoch / min-raise | čistý engine + unit testy na hraničné prípady |
| Kamera nefunguje v LAN cez http | HTTPS so self-signed certom (port 3443) |
| Mesh WebRTC pri 9 ľuďoch = 8 streamov na klienta | nízke rozlíšenie (320×240, 15 fps), kamera je voliteľná |
| Hráč za NAT-om mimo LAN | STUN v `ICE_SERVERS`; TURN mimo scope (dá sa doplniť env premennou) |
| Reštart servera počas hry | stoly sa ukladajú na disk (Docker volume); rozohraná ruka sa zruší a žetóny vrátia, hra čaká na hosta |
| Odpojený hráč blokuje hru | časový limit ťahu + host môže vyhodiť |

## 7. Mimo scope (zatiaľ)
Účty/registrácia, databáza (stačí JSON súbor na stôl), turnaje a rastúce blindy, TURN server, mobilné natívne appky, hand history export.


## Ochrana verejného servera

Limity sú v `server/limits.ts` (premenné prostredia `LIMIT_*`) a popis v `deploy/nas/README.md`. Kľúč klienta je IP
(IPv6 po /64). Hlavičky proxy sa berú len pri `TRUST_PROXY=xff` (Tailscale Funnel, Caddy — posledná položka
X-Forwarded-For) alebo `cloudflare` (CF-Connecting-IP); inak adresa spojenia. Socket.IO prijme len spojenia bez `Origin`
alebo s `Origin` rovnakým ako `Host` (prípadne z `ALLOWED_ORIGINS`).
