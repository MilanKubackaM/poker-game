# Poker Night na domácom NAS — verejne, bez otvorených portov

Hra beží v Dockeri na NAS a von ju púšťa **Tailscale Funnel** cez vlastný sidecar kontajner `poker-tailscale`.
Funnel je verejný: kamaráti len otvoria `https://poker.<tailnet>.ts.net`, Tailscale inštalovať nemusia.
Na routeri ani na NAS sa neotvára žiadny port — tunel sa pripája z NAS von.

## Izolácia
- Kontajner hry: používateľ `node` (nie root), súborový systém len na čítanie, žiadne Linux capabilities,
  `no-new-privileges`, limit 768 MB RAM, 1 CPU, 128 procesov.
- Sieť `poker-internal` je `internal` — hra sa nedostane na internet ani do domácej siete; vidí ju len sidecar.
- Hra vidí len vlastný volume `poker-night_poker-data` (stoly, účty, fotky) a outbox e-mailov, nič z tvojich súborov na NAS.
- E-maily odosiela sidecar `poker-mailer` (curl, bez práv, len sieť von): hra zapíše správu do volume `mail-outbox`,
  sidecar ju pošle cez Gmail a zmaže. Heslo Gmailu vidí len sidecar, hra nie.
- Sidecar beží v userspace režime (bez `/dev/net/tun` a bez práv navyše) a je to samostatný uzol v tailnete,
  nie tvoj NAS.

## Video cez TURN relay
**Cloudflare TURN (prednostne):** relay po UDP — strata paketu nezastaví celý prúd ako pri TCP. Kontajner hry nemá
prístup na internet, preto prihlasovacie údaje každú hodinu vypýta sidecar `poker-turn-creds` (curl, len do
zdieľaného volume) a hra ich rozdá hráčom pri stole (platnosť 24 h, port 53 sa vynechá). Kľúč vytvoríš v Cloudflare
dashboard → **Realtime → TURN Server → Create** a do `deploy/nas/.env` na NAS doplníš `CF_TURN_KEY_ID` a
`CF_TURN_API_TOKEN`. Zadarmo je 1 000 GB odoslaných dát mesačne, potom 0,05 USD/GB. Bez kľúča (alebo keď Cloudflare
neodpovedá dlhšie než 20 h) hra použije coturn nižšie.

**Spotreba Cloudflare na `/stats`:** ten istý sidecar každých 15 min stiahne z Cloudflare Analytics (GraphQL,
`callsTurnUsageAdaptiveGroups`) odoslané dáta za aktuálny mesiac (UTC) — za celý účet, lebo free tier 1 000 GB je spoločný
pre TURN aj SFU, za kľúč hry a za dnešok. `/stats` ukáže minuté GB, zostatok a odhad na koniec mesiaca (pri 70 % alebo
keď odhad prekročí free tier „Pozor“, pri 90 % „Kritické“). Treba vytvoriť API token v Cloudflare → **My Profile → API Tokens
→ Create Custom Token** s jediným oprávnením **Account → Account Analytics → Read** a do `deploy/nas/.env` doplniť
`CF_ACCOUNT_ID` (ID účtu z dashboardu) a `CF_ANALYTICS_TOKEN`. Bez nich ostane dlaždica s návodom.

**Coturn (záloha):** keď sa kamery dvoch hráčov nevedia spojiť priamo (mobilné dáta, firemná sieť, prísny NAT), video ide cez `poker-turn`
(coturn) na `turns:<adresa>:8443` — Funnel ukončí TLS a pošle TCP do relay. Relay smie posielať dáta len na vlastnú
adresu (oba konce cez TURN), takže sa ním nedá dostať na internet ani do domácej siete. Relay má 1241 portov
(49160–50400) a najviac 1200 alokácií naraz — plný stôl s 9 kamerami ich pri spájaní zaberie až 72. Prihlasovacie údaje dostanú len
hráči pri stole (HMAC z `TURN_SECRET`, platnosť 24 h). `TURN_SECRET` a `TURN_URLS` sú len na NAS v `deploy/nas/.env`.

## E-maily cez Gmail (overenie e-mailu, zabudnuté heslo)
Overenie e-mailu je pri registrácii povinné, takže bez funkčného odosielania sa nikto nový nezaregistruje.
1. Google účet, z ktorého sa bude posielať → **Zabezpečenie → Dvojstupňové overenie** musí byť zapnuté.
2. <https://myaccount.google.com/apppasswords> → vytvor heslo aplikácie (napr. „Poker Night“) — 16 znakov.
3. Do `deploy/nas/.env` na NAS doplň (súbor má práva 600, nie je v repozitári):
   ```
   GMAIL_USER=tvoja.adresa@gmail.com
   GMAIL_APP_PASSWORD=abcdefghijklmnop
   ```
4. `deploy/nas/deploy.sh` (alebo na NAS `docker compose -f deploy/nas/docker-compose.yml up -d mailer poker`).
   Stav: `docker logs poker-mailer` (bez údajov vypíše „Gmail nie je nastavený“). Gmail povolí okolo 500 e-mailov denne.

`PUBLIC_URL` (adresa v odkazoch) doplní `ensure-env.sh` z domény Tailscale. Pri každom nasadení sa celý volume s dátami
zálohuje do `<dir>/backups/poker-data-<dátum>.tgz` (posledných 10).

## Ochrana pred zahltením (server, `server/limits.ts`, dá sa meniť cez `LIMIT_*`)
| Limit | Predvolene |
| --- | --- |
| Nové stoly z jednej IP | 3 / hod, 10 / deň |
| Nové stoly celý server (útok z mnohých IP) | 30 / hod, 100 / deň |
| Stoly uložené naraz | 300 |
| Noví hráči ku stolom | 30 / hod na IP, 600 / hod celkovo |
| Hľadanie stola / návrat s tokenom | 60 / min na IP |
| Spojenia | 30 na IP, 1000 celkovo |
| Požiadavky jedného spojenia | 15 / s (rezerva 40); WebRTC 60 / s (rezerva 300); pri 200 odmietnutiach za minútu odpojí |
| Čakajúce žiadosti o prístup | 10 na stôl, 3 z jednej IP; platnosť 15 min, po zamietnutí 5 min pauza |
| Členovia jedného stola / transakcie | 40 / 5000 |
| Nepoužitý stôl (bez hry, len zakladateľ) | zmaže sa po 24 h bez aktivity |
| Registrácia (pokusy) | 30 / hod na IP |
| Nesprávne heslo | 20 na IP a 10 na účet za 15 min |
| Zabudnuté heslo | 5 / hod na IP, 3 / hod na účet |
| Overovacie e-maily / fotky | 3 / hod / 20 / hod na účet |

Cudzie webstránky sa k hre pripojiť nemôžu (kontrola `Origin`), takže útočník nevie zneužiť prehliadače svojich návštevníkov.

## Prvé nasadenie
1. Tailscale admin (<https://login.tailscale.com/admin>): v **Access controls** povoľ Funnel
   (pri prvom spustení to admin aj sám ponúkne) a v **Settings → Keys** vytvor jednorazový auth key.
2. NAS: zapnuté SSH a Docker. Cez SSH sa sudo heslo zadať nedá, preto raz spusti
   `deploy/nas/deploy.sh --setup-sudo` — vypýta si sudo heslo NAS a povolí tvojmu používateľovi `sudo docker` bez hesla
   (`/etc/sudoers.d/poker-night-docker`). Ak si v skupine `docker`, netreba nič. Skript nespúšťaj cez `sudo` na Macu.
3. Z Macu, z koreňa repozitára:
   ```bash
   deploy/nas/deploy.sh --with-data --authkey tskey-auth-...
   ```
   `--with-data` prenesie stoly z kontajnera na Macu (len prvýkrát, inak prepíše stoly na NAS).
   Iná cesta na NAS: `--dir /volume1/docker/poker-night`.
4. Adresa: `ssh nas "sudo docker exec poker-tailscale tailscale serve status"`.

Ďalšie nasadenia: `deploy/nas/deploy.sh` (bez `--with-data` a `--authkey`).
