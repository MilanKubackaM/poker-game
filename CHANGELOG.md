# Changelog

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
