# Changelog

## v1.2.0 — 2026-11-07

### English

**Player accounts**
- Everyone now plays with an account. You register with an email address, a username and a password typed twice. Each
  field tells you what is wrong before you submit. You must confirm your email by clicking the link in the email before you can
  create or join a table. You can resend the email or correct the address.
- Log in with your email or your username and your password. The login lasts 180 days on that device.
- „Forgot password" sends a one-time link to your confirmed email. The link is valid for 1 hour. After a reset or a
  password change, your other devices are logged out.
- In Profile you can change your username, password and email, choose an emoji avatar and upload a profile photo.
  The photo is shrunk in your browser to a small square and replaces the emoji everywhere at the table.
- One username for every table, unique regardless of upper or lower case. When you rename yourself, every table you
  belong to shows the new name.

**Devices**
- Your account follows you across devices. „My tables" lists your tables on every device you log in on, and you can
  continue on any of them. Rejoining a table you are already a member of no longer needs the host's approval.
- One device per table: if you open a table on another device, the old device leaves the table and returns to the
  lobby. It does not take the table back on its own, even after its connection drops. You can still play
  different tables on different devices at the same time.
- No more orphaned players after switching devices, so merging players is no longer needed and has been removed.

**Statistics and money**
- Money stays separate for each table. Every table has its own chips, transactions and cash-out, as before.
- Profile → Statistics shows your totals across all tables: tables played, hands played, hands won, win rate,
  biggest pot and overall result, with euros and crowns kept separate. It also lists every table with your result.
  The statistics are kept even after a table is deleted.

**Tables from before accounts**
- Tables created before v1.2.0 are backed up and become read-only. You find them under My tables → Archive on
  every browser that sat at them. They show the leaderboard, hand history, transactions, cash-out and your own hands.
- „Claim" adds such a table to your account. It then counts in your statistics and is visible on all your devices.

**Jukebox**
- The jukebox now plays at most at half the previous volume, so 100 % on the slider is 50 % of the player. Voices
  at the table are easier to hear.

**Server**
- Emails are sent through Gmail by a separate small container. The game server still has no internet access and
  never sees the mail password.
- Every deploy first backs up all game data (tables, accounts, photos).

### Slovensky

**Účty hráčov**
- Hrá sa už len s účtom. Pri registrácii zadáš e-mail, hráčske meno a heslo dvakrát. Každé pole ukáže, čo je
  zle, ešte pred odoslaním. Kým neklikneš na odkaz v overovacom e-maile, nemôžeš založiť stôl ani sa k nemu pripojiť. E-mail sa
  dá poslať znova alebo opraviť adresu.
- Prihlásiš sa e-mailom alebo hráčskym menom a heslom. Prihlásenie na zariadení platí 180 dní.
- „Zabudol som heslo" pošle na overený e-mail jednorazový odkaz platný 1 hodinu. Po obnovení alebo zmene hesla sa
  ostatné tvoje zariadenia odhlásia.
- V Profile si zmeníš hráčske meno, heslo aj e-mail, vyberieš emoji avatara a nahráš profilovú fotku. Prehliadač
  fotku zmenší na malý štvorec a pri stole sa zobrazí všade namiesto emoji.
- Jedno hráčske meno pre všetky stoly, jedinečné bez ohľadu na veľké a malé písmená. Po premenovaní sa nové meno
  zobrazí pri všetkých tvojich stoloch.

**Zariadenia**
- Účet ide s tebou na každé zariadenie. „Moje stoly" vidíš všade, kde sa prihlásiš, a pokračovať môžeš z
  ktoréhokoľvek. Návrat k stolu, ktorého si členom, už nepotrebuje schválenie hosta.
- Jeden stôl na jednom zariadení: keď stôl otvoríš na inom zariadení, staré od neho odíde a vráti sa do lobby. Samo
  si ho späť nevezme, ani keď mu vypadne spojenie. Rôzne stoly na rôznych zariadeniach naraz hrať môžeš.
- Po prechode na iné zariadenie už nevzniká osirotený hráč, preto zlučovanie hráčov už netreba a je odstránené.

**Štatistiky a peniaze**
- Peniaze sa medzi stolmi neprenášajú. Každý stôl má ako doteraz vlastné žetóny, transakcie a vyúčtovanie.
- Profil → Štatistiky ukazuje súčty zo všetkých stolov: počet stolov, odohrané a vyhrané ruky, percento výhier,
  najväčší pot a celkový výsledok, zvlášť v eurách a v korunách. Je tam aj zoznam stolov s tvojím výsledkom.
  Štatistiky ostanú aj po zmazaní stola.

**Stoly spred účtov**
- Stoly založené pred v1.2.0 sú zálohované a už len na čítanie. Nájdeš ich v Moje stoly → Archív v každom
  prehliadači, z ktorého si pri nich sedel. Je v nich leaderboard, história rúk, transakcie, vyúčtovanie aj tvoje ruky.
- „Prevziať do účtu" pridá taký stôl k tvojmu účtu. Potom sa započíta do štatistík a uvidíš ho na všetkých
  zariadeniach.

**Jukebox**
- Jukebox hrá najviac na polovicu doterajšej hlasitosti, takže 100 % na posuvníku je 50 % prehrávača. Hlasy pri
  stole sú lepšie počuť.

**Server**
- E-maily odosiela cez Gmail samostatný malý kontajner. Server hry ďalej nemá prístup na internet a heslo k pošte
  nevidí.
- Každé nasadenie najprv zálohuje všetky dáta hry (stoly, účty, fotky).

## v1.1.0 — 2026-11-06

### English

**Voice and video**
- Fixed players not hearing each other in larger games. The last 8-player game showed two causes: an offer sent before
  the other browser was listening was lost forever (some pairs never connected, for over two hours), and switching the
  microphone or camera renegotiated every connection, so one direction could go silent until someone reloaded.
- New connection model: one side always makes the offer, the audio and video slots are fixed, and turning the
  microphone or camera on or off no longer renegotiates anything.
- Connections repair themselves: a stuck, failed or silent connection is rebuilt automatically within seconds, and
  signals that arrive early are kept until the table is ready.
- Opening the table in a second window or on another device pauses the old one, with a „Continue here" button.
- Each player's audio plays whenever it is actually flowing. Playback blocked by the browser is retried on the next tap.
- Per-player volume (0–150 %) and mute: click a player at the table. The setting is yours only.

**Players and hosts**
- Merge players: when someone reconnects from another device as a new player, the host can move the old player's
  chips, transactions, statistics, history and roles to the new one. The old player disappears completely.
- The host can kick any member (seated, in a hand, offline or already left), except the table owner. Kicked players
  must ask the host to rejoin, and their chips stay in the transactions so the cash-out balances.
- Members who left the table are listed for the host („Left the table").

**Game modes**
- Omaha and Pineapple can run for a number of hands or permanently until the host turns them off.
- Piggy can run as a series of N games or permanently, and can be combined with the other modes. „End after this
  game" and „Cancel now (refund)" are available.
- Pineapple: 10 seconds to discard, then a random card is discarded.
- Time bank: ¼ of the unused base time is added (was ½).

**Jukebox**
- A YouTube jukebox. The host switches it on or off, and everyone sets their own volume.
- Only the winner of the last hand can add a song, one per won hand. The queue holds 5 songs and everyone can see
  it. Songs cannot be skipped or seeked.

**Interface**
- The side panel has one level of tabs: Chat · Log · Transactions · Leaderboard · History · Cash-out.
- History shows your own cards and result for every hand, plus Piggy payouts.
- Colour-coded action buttons. Pre-actions and live actions keep the same positions, and clicks are ignored for a
  moment when your turn starts, to prevent misclicks.
- You can change seats only at the start of a game. Seats are spread evenly around the table.
- Version number in the lobby, and a „New version available — reload" prompt after a deploy.

### Slovensky

**Hlas a video**
- Opravené: hráči sa vo väčšej partii navzájom nepočuli. Posledná hra s 8 hráčmi ukázala dve príčiny: ponuka spojenia,
  ktorá prišla skôr, než ju druhý prehliadač počúval, sa navždy stratila (niektoré dvojice sa nespojili ani za viac
  ako dve hodiny), a zapnutie mikrofónu či kamery znova vyjednávalo každé spojenie, takže jeden smer mohol stíchnuť,
  kým niekto neobnovil stránku.
- Nový spôsob spájania: ponuku posiela vždy jedna strana, zvuk a video majú pevné miesto v spojení a zapnutie či
  vypnutie mikrofónu alebo kamery už nič znova nevyjednáva.
- Spojenia sa opravujú samy: zaseknuté, zlyhané alebo tiché spojenie sa do pár sekúnd automaticky obnoví a signály,
  ktoré prídu priskoro, sa podržia, kým je stôl pripravený.
- Otvorenie stola v druhom okne alebo na inom zariadení pozastaví to staré a ponúkne „Pokračovať tu".
- Zvuk hráča hrá vždy, keď naozaj tečie. Keď ho prehliadač zablokuje, skúsi sa znova pri najbližšom ťuknutí.
- Hlasitosť (0–150 %) a stlmenie jednotlivých hráčov: klikni na hráča pri stole. Nastavenie platí len pre teba.

**Hráči a host**
- Zlúčenie hráčov: keď sa niekto pripojí z iného zariadenia ako nový hráč, host presunie žetóny, transakcie,
  štatistiky, históriu a roly starého hráča na nového. Starý hráč úplne zmizne.
- Host môže vyhodiť ktoréhokoľvek člena (pri stole, v ruke, offline aj toho, kto už odišiel) okrem zakladateľa.
  Vyhodený sa vráti len so súhlasom hosta a jeho žetóny ostávajú v transakciách, aby sedel cashout.
- Členovia, ktorí odišli od stola, sú pre hosta v zozname „Odišli od stola".

**Herné módy**
- Omaha a Pineapple sa dajú hrať na počet kôl alebo natrvalo, kým ich host nevypne.
- Prasiatko sa dá spustiť ako séria N hier alebo natrvalo a dá sa kombinovať s ostatnými módmi. K dispozícii je
  „Ukončiť po tejto hre" aj „Zrušiť hneď a vrátiť vklady".
- Pineapple: na zahodenie karty je 10 sekúnd, potom sa zahodí náhodná karta.
- Timebank: pripisuje sa ¼ nevyužitého základného času (predtým ½).

**Jukebox**
- Jukebox s pesničkami z YouTube. Host ho zapína a vypína, hlasitosť si nastavuje každý sám.
- Pesničku pridáva len víťaz poslednej ruky, jednu za každú vyhratú ruku. Front má najviac 5 pesničiek a vidia ho
  všetci. Pesničky sa nedajú preskočiť ani pretáčať.

**Rozhranie**
- Bočný panel má jednu úroveň záložiek: Chat · Priebeh · Transakcie · Leaderboard · História · Cashout.
- História ukazuje pri každej ruke tvoje karty a výsledok aj výhry z Prasiatka.
- Farebné akčné tlačidlá. Predvoľby a skutočné akcie sú na rovnakých miestach a na začiatku tvojho ťahu sa kliky
  na chvíľu ignorujú, aby nedošlo k preklepu.
- Miesto pri stole sa dá zmeniť len na začiatku hry. Miesta sú okolo stola rozložené rovnomerne.
- Číslo verzie na úvodnej obrazovke a po nasadení výzva „Je dostupná nová verzia — Obnoviť".

## v1.0.0

First version: private poker table with cameras, chips and banker, verifiable shuffle, installable app, in-game help.

Prvá verzia: súkromný pokerový stôl s kamerami, žetónmi a bankárom, overiteľným miešaním, inštalovateľnou aplikáciou a
pomocníkom v hre.
