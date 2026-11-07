# Poker Night — popis, spustenie a prevádzka

Súkromný online poker stôl pre partiu kamarátov. Host založí stôl, pošle odkaz, ostatní si prisadnú.
Každý má avatara a môže si zapnúť webkameru (a mikrofón) — video nahradí avatara priamo na mieste pri stole.

- **Varianty:** Texas Hold'em (no-limit), Omaha (pot-limit, voliteľne no-limit), Pineapple
- **Špeciálne kolo:** host počas hry vyhlási na jednu ďalšiu ruku Omahu alebo Pineapple
- **Pravidlo 7-2:** kto vyhrá pot so 7-2, dostane od každého hráča v ruke bonus (nastaviteľný); host ho zapína pre celú hru (od ďalšej ruky, kým ho nevypne)
- **Prasiatko:** host spustí mód, v ktorom pred každou rukou dá každý rozdaný hráč 1 BB do prasiatka (mimo potu); kto vyhrá ruku, dostane krúžok, prvý s 3 krúžkami berie celé prasiatko. Zrušenie vráti každému jeho vstupy
- **Pravidlá pred novým módom:** pred prvou rukou Omahy, Pineapple, pravidla 7-2 aj Prasiatka sa všetkým ukážu pravidlá a ruka sa rozdá, keď všetci kliknú „Rozumiem“ (najviac po 60 s)
- **Pauza hráča:** krátka pauza (blindy sa platia, server za hráča hneď checkuje/folduje) alebo postavenie sa od stola — návrat po big blinde alebo so zaplatením zmeškaných blindov (štandard cash game)
- **Host:** spustenie/pauza celej hry (len vlastník alebo hráč s právami hosta), blindy, čas na ťah, pridelenie roly bankára, vyhodenie hráča, odovzdanie hosta, zmazanie stola (len zakladateľ, po zadaní kódu stola)
- **Bankár (🏦):** jediný, kto mení hráčom žetóny (predvolene zakladateľ, host rolu kedykoľvek presunie — ak bankár drží peniaze, vyberie sa, či ich odovzdá novému). Pri dobití/výbere sa zaklikne **Zaplatené** (peniaze prešli hneď) alebo **Na dlh** (vyrovná sa po hre); história je verejne na karte hráča. Hráč pri príchode dostane 0 žetónov
- **Cashout** (Výsledky stola): ako v Splitwise — kto komu koľko pošle najmenším počtom prevodov, so započítaním toho, čo kto zaplatil bankárovi a čo dlží; bankár odkliká splatené dlhy a prebehnuté prevody (omyl sa dá zrušiť). Aplikácia peniaze nespracúva, len ich eviduje
- **Prístup ku stolu:** nový hráč z odkazu len požiada o prístup — host (zakladateľ alebo hráč s právami hosta) ho pustí alebo zamietne (v čakárni ako karta „čaká na schválenie“, počas hry žiadosť svieti hore na ploche). Kým nie je schválený, server mu neposiela nič zo stola (stav, chat, kamery). Žiadosť prežije obnovenie stránky, vyprší po 15 min, po zamietnutí sa dá z rovnakej siete požiadať znova až o 5 min. Vracajúci sa člen (Moje stoly / uložený token) schválenie nepotrebuje, vyhodený áno
- **Odchod a návrat:** „Odísť od stola“ hráča postaví a presunie do čakárne stola (hra beží ďalej, „Späť ku stolu“ = počkať na BB alebo zaplatiť). Až „Opustiť hru“ v čakárni uvoľní miesto, ale účet ostáva — stack, štatistiky aj timebank sa uložia a pri návrate (z „Moje stoly“, aj po zatvorení prehliadača) sa hráč automaticky posadí späť. Odchod hráča stôl nikdy nezmaže. Roly sa nikdy nedávajú náhodnému hráčovi: keď odíde bankár, bankárom sa stane zakladateľ (ak sedí), inak niektorý host; keď pri stole neostane nikto s právami hosta, prevezme ich bankár. Ak nesedí nikto s rolou, hra beží ďalej, ale nikto nepúšťa nových hráčov ani nedobíja, kým sa nevráti zakladateľ, host alebo bankár (zakladateľ po návrate dostane práva späť)
- **Stôl:** side poty, all-in runout, heads-up pravidlá, pevný čas na ťah (základ 15 s + osobný timebank 5–200 s, štart 50 s) s auto-check/fold, reconnect po obnovení stránky, chat a priebeh hry
- **Kamery:** WebRTC P2P (mesh) — video ide priamo medzi hráčmi, server len sprostredkuje signalizáciu
- **Kto hovorí:** hráč, od ktorého práve ide zvuk, má zelený pulzujúci okraj avatara a zelený mikrofón (meranie hlasitosti v prehliadači, nič nejde na server)
- **Roly pri stole:** ♛ zakladateľ, ★ spoluhost, 🏦 bankár — ikonka pred menom pri stole aj v čakárni
- **Vysvetlivky:** menu ☰ → 📖 Vysvetlivky — pravidlá módov, priebeh ruky, pauza, bankár a cashout so screenshotmi z hry ([VYSVETLIVKY.sk.md](VYSVETLIVKY.sk.md))
- **Overiteľné miešanie:** do každého balíčka prispieva náhodou aj prehliadač každého hráča (commit–reveal); po hre si hráč stiahne dôkazy (Štatistiky → História) a overí ich skriptom `tools/verify-fairness.ts`. Celý model dôvery je po anglicky v [README.md](../README.md)

Vizuál všetkých obrazoviek (desktop + mobil): [UI.md](UI.md)

## Spustenie v Dockeri

```bash
docker compose up --build
```

Potom otvor **http://localhost:3000**.

Zastavenie: `docker compose down`.

### Uložené stoly

Stoly sa priebežne ukladajú (do ~1 s po každej zmene a pri vypínaní servera) ako JSON súbory
`DATA_DIR/tables/<KÓD>.json`. V Dockeri je `DATA_DIR=/app/data` na pomenovanom volume `poker-data`, takže stoly
prežijú reštart aj `docker compose up --build`. Hráči sa po reštarte vrátia na rovnaký odkaz a pokračujú:

- rozohraná ruka sa zruší a každý dostane späť žetóny, ktoré mal pred ňou (vrátane čakajúcich dobití),
- bežiaca hra je pozastavená — host ju obnoví tlačidlom **Spustiť**; losovanie o dealer button sa vráti do čakárne,
- ledger, história rúk, leaderboard, práva hostov aj chat ostávajú.

Stôl sa zmaže len vtedy, keď ho zmaže zakladateľ (v nastaveniach, po zadaní kódu stola), alebo keď je bez aktivity
dlhšie ako 90 dní. Odchod hráčov (ani všetkých) stôl nemaže. Zmazanie všetkých uložených stolov:

```bash
docker compose down -v
```

Pri vývoji bez Dockera sa ukladá do `./data` (v `.gitignore`); zmažeš ho jednoducho `rm -rf data`.

### Účty hráčov (od v1.2.0)

Hrať sa dá len s účtom. Registrácia: e-mail, hráčske meno (jedinečné, 3–20 znakov, rovnaké pri všetkých stoloch) a heslo
zadané dvakrát (aspoň 8 znakov). Kým hráč neklikne na odkaz v overovacom e-maile, nemôže založiť stôl ani sa pripojiť.
Prihlásiť sa dá e-mailom alebo hráčskym menom. V **Profile** sa mení meno, heslo, e-mail, profilová fotka (prehliadač ju
zmenší na 256 px) a sú tam globálne štatistiky (ruky, výhry, najväčší pot, výsledok zvlášť pre EUR a CZK, zoznam stolov).

- Peniaze sa medzi stolmi neprenášajú — každý stôl má vlastný stack, transakcie a vyúčtovanie ako doteraz.
- Ten istý účet pri tom istom stole môže byť len na jednom zariadení: keď ho otvorí inde, staré zariadenie sa vráti do
  lobby. Rôzne stoly na rôznych zariadeniach sú v poriadku.
- **Zabudnuté heslo** pošle odkaz (platí 1 hodinu) len na overený e-mail. Po zmene hesla sa ostatné zariadenia odhlásia.
- Účty sú v `DATA_DIR/users.json` (heslá ako `scrypt`, prihlásenia a odkazy len ako SHA-256), fotky v `DATA_DIR/photos/`.
- **Stoly spred v1.2.0** (anonymní hráči) sa pri prvom štarte zálohujú do `DATA_DIR/backup-v1.1.0/` a ostanú len na
  čítanie: v **Moje stoly → Archív** ich vidí každý, kto pri nich sedel v tomto prehliadači, a jedným klikom si ich prevezme
  do účtu (započítajú sa do štatistík a uvidí ich na každom zariadení).

E-maily (overenie, obnovenie hesla) server len zapíše do priečinka `MAIL_OUTBOX_DIR`; na NAS ich odošle sidecar `mailer` cez
Gmail SMTP (pozri `deploy/nas/README.md`). Bez `MAIL_OUTBOX_DIR` (vývoj, lokálny Docker) sa e-mail aj s odkazom len vypíše
do logu servera — odkaz z neho skopíruješ do prehliadača.

## Hra s kamarátmi v rovnakej sieti (LAN / wifi)

1. Zisti IP adresu svojho počítača (macOS: `ipconfig getifaddr en0`), napr. `192.168.1.20`.
2. Spusti s ňou (pridá sa do certifikátu):
   ```bash
   PUBLIC_HOST=192.168.1.20 docker compose up --build
   ```
3. Kamarátom pošli odkaz na **HTTPS** verziu: `https://192.168.1.20:3443/t/KOD_STOLA`
   Tlačidlo „Pozvať" ho skopíruje samo — keď máš stôl otvorený cez `localhost` a je nastavené `PUBLIC_HOST`,
   odkaz automaticky smeruje na `https://PUBLIC_HOST:3443`.

### Prečo HTTPS a varovanie prehliadača

Prehliadače povolia kameru a mikrofón **len na zabezpečenej stránke** (`https://` alebo `http://localhost`).
Na `http://192.168.x.x` by kamera nefungovala, preto server beží aj na porte **3443 s self-signed certifikátom**,
ktorý si vygeneruje pri štarte. Prehliadač pri prvom otvorení ukáže varovanie — klikni na
„Rozšírené → Pokračovať na stránku" (Chrome) / „Zobraziť podrobnosti → navštíviť webovú stránku" (Safari).

Ak máš vlastný certifikát (napr. z `mkcert`), pripoj ho:

```yaml
    environment:
      TLS_CERT_FILE: /certs/cert.pem
      TLS_KEY_FILE: /certs/key.pem
    volumes:
      - ./certs:/certs:ro
```

### Hráči mimo tvojej siete

Treba sprístupniť porty 3000/3443 (port forwarding, tunel typu Tailscale / Cloudflare Tunnel / ngrok).
Video funguje cez verejný STUN server; pri prísnych NAT-och treba TURN server — nastavíš ho cez `ICE_SERVERS`:

```yaml
      ICE_SERVERS: '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
```

## Inštalácia ako aplikácia (PWA)

Poker Night sa dá nainštalovať ako aplikácia s vlastným oknom a ikonou v Docku / na paneli úloh. Je to stále tá istá
webová stránka zo servera, takže nová verzia sa prejaví hneď po nasadení a nič sa neinštaluje zvlášť pre Mac a Windows.

V lobby svieti tlačidlo **Nainštalovať ako aplikáciu**:

- **Chrome / Edge (Windows, Mac, Android):** otvorí inštalačný dialóg prehliadača. Po inštalácii sa v karte prehliadača
  zmení na **Otvor v aplikácii** (len desktop; Chrome / Edge 139+ otvorí odkaz rovno v nainštalovanej aplikácii)
- **Ostatné (všetky prehliadače na iPhone/iPade, Safari na Macu 17+, Samsung Internet, Firefox, Edge na Androide,
  prehliadače v aplikáciách ako Messenger či Instagram):** inštaláciu na jedno ťuknutie nepovoľujú, tlačidlo preto otvorí
  animovaný návod pre rozpoznaný prehliadač — kreslený výsek obrazovky so zvýrazneným tlačidlom, krok po kroku, a šípka
  „tu“ k skutočnému tlačidlu prehliadača (`client/src/installGuide.ts`). Prehliadač v aplikácii najprv pošle stránku
  otvoriť v Safari/Chrome. Aplikácia pridaná cez Safari má vlastné
  úložisko oddelené od prehliadača, takže uložené stoly a záznamy pre overenie férovosti z prehliadača v nej nie sú
  (a naopak), a „Otvor v aplikácii“ sa tu ponúknuť nedá

Inštalácia funguje len cez HTTPS (alebo `localhost`). Service worker (`client/public/sw.js`) nič neukladá do cache, len
pri nedostupnom serveri ukáže hlásenie „Server je teraz nedostupný“. Ikony sa generujú z `tools/icons/*.svg` skriptom
`tools/make-icons.sh`.

## Ako sa hrá

1. Zaregistruj sa (alebo sa prihlás), over e-mail a na úvodnej obrazovke založ stôl (blindy, variant).
2. Tlačidlom **🔗 Pozvať** skopíruj odkaz a pošli ho kamarátom.
3. Keď sú všetci pri stole, otvor **♛ Host** → **Spustiť hru**. Ruky sa rozdávajú automaticky.
4. Počas hry v **♛ Host → Hra** vyhlásiš špeciálne kolo pre ďalšiu ruku, v **Pravidlá** meníš nastavenia
   (platia od ďalšej ruky), v **Hráči a žetóny** prideľuješ rolu bankára; bankár tam (a na kartách hráčov v čakárni) dobíja žetóny (komu dôjdu, nedostáva karty, kým mu nedobije; ak ho medzitým minuli blindy, počká na big blind).
5. 📷 / 🎙️ v hornej lište zapína kameru a mikrofón.

Pravidlá v detaile (heads-up, min-raise, side poty, Pineapple discard, 7-2) sú v [ANALYSIS.md](../ANALYSIS.md).

## Vývoj bez Dockera

```bash
npm install
npm run dev          # server na :3000 + Vite na :5173 (otvor http://localhost:5173)
npm test             # unit testy (evaluator, side poty, engine, randomizovaná kontrola žetónov)
npm run typecheck
```

Demo obrazovky s ukážkovými dátami (bez servera): `http://localhost:5173/?demo=table`
(`lobby`, `invite`, `waiting`, `table`, `omaha`, `pineapple`, `showdown`, `chat`, `menu`, `host-game`, `host-rules`, `host-players`).

## Konfigurácia (env)

| Premenná | Predvolene | Význam |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HTTPS_PORT` | `3443` | HTTPS port, `0` = vypnuté |
| `PUBLIC_HOST` | – | IP/hostname (čiarkou oddelené) pridané do self-signed certifikátu |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | – | vlastný certifikát namiesto self-signed |
| `ICE_SERVERS` | Google STUN | JSON zoznam STUN/TURN serverov pre WebRTC |
| `DATA_DIR` | `./data` (Docker: `/app/data`) | adresár, kam sa ukladajú stoly a sieťové štatistiky (`net/`) |
| `TURN_URLS`, `TURN_SECRET` | – | vlastný coturn relay (dočasné HMAC údaje len pre hráčov pri stole) |
| `TURN_ICE_FILE` | – | súbor s údajmi Cloudflare TURN (zapisuje sidecar `turn-creds`); má prednosť pred coturnom |
| `STATS_TOKEN` | – | kľúč k stránke `/stats`; bez neho je v produkcii vypnutá, pri vývoji otvorená |
| `PUBLIC_URL` | `http://localhost:5173` | verejná adresa hry pre odkazy v e-mailoch (overenie, obnovenie hesla) |
| `MAIL_OUTBOX_DIR` | – | priečinok, kam server zapíše e-maily pre odosielací sidecar; bez neho sa e-maily len vypíšu do logu |
| `MAIL_FROM` | – | hlavička odosielateľa, napr. `Poker Night <hra@gmail.com>` (pri Gmaile musí sedieť s `GMAIL_USER`) |

## Sieťové štatistiky (`/stats`)

Stránka pre správcu servera na hľadanie príčiny sekania kamier a zvuku. Otvára sa odkazom `/stats#key=<STATS_TOKEN>`
(kľúč sa uloží v prehliadači a z adresy zmizne; `deploy/nas/deploy.sh` odkaz vypíše na konci).

- Každý hráč pri stole raz za 5 s pošle za každé spojenie: cestu (priamo / relay a protokol), RTT, prenos v oboch
  smeroch, straty, koľko zvuku musel prehliadač doplniť (počuteľné sekanie), zamrznutia obrazu, odhad dostupného
  uploadu a či prehliadač obmedzuje video pre CPU alebo šírku pásma; plus odozvu servera a či je hra na pozadí.
- **Živé**: posledných 15 min z pamäte servera. **História**: z `DATA_DIR/net/<deň>.jsonl` (7 dní, najviac 300 MB),
  dlhšie rozsahy sa zlučujú do intervalov (rýchlosti priemerom, sekanie a RTT maximom).
- **Matica spojení** (riadok = kto posiela, stĺpec = kto prijíma): zlý celý riadok = upload odosielateľa, zlý celý
  stĺpec = sieť prijímateľa, zlé len spojenia cez relay = relay. **Diagnóza** to vyhodnotí za vybraný čas — klikni do
  grafu na moment sekania.
- Udalosti: výpadky a reštarty spojení, zamrznutia, sekanie zvuku, odpojenia od servera.
- Server pridáva záťaž NAS (load), CPU a zasekanie (event loop) servera hry. Samotné médiá cez server hry nejdú, takže
  záťaž relay je odhad zo súčtu hlásení hráčov.

## Obmedzenia

- Stav stola (`table:state`) ide pri každej zmene bez ledgeru, histórie a leaderboardu — tie posiela `table:meta`
  pri pripojení celé a potom len nové položky. WebSocket správy sú komprimované (permessage-deflate).
- Rozohraná ruka sa pri reštarte servera neukladá — zruší sa a žetóny sa vrátia (pozri „Uložené stoly“).
- Kamery idú P2P každý s každým; pri 9 hráčoch so zapnutou kamerou to je 8 streamov na zariadenie
  (video je preto max. 480 px / 15 fps a bitrate na stream sa podľa počtu ľudí obmedzí na 600 → 250 kbps).

## Štruktúra

```
shared/          spoločné typy a konštanty (klient + server)
server/poker/    čistá logika pokru: balíček, evaluator, side poty, HandEngine
server/          Table (stôl, host príkazy, časovače), SessionManager, Socket.IO + HTTP(S) server
server/test/     vitest testy
client/src/      React UI, WebRTC mesh (hooks/useMesh.ts), demo režim (demo/)
tools/           overenie férovosti (verify-fairness.ts, reference_shuffle.py) a klienta (verify-client.ts)
docs/            UI screenshoty
```
