# Poker Night na Oracle Always Free (beží aj pri vypnutom Macu)

Hra beží na bezplatnom VM v Oracle Cloud, za [Caddy](https://caddyserver.com) s automatickým HTTPS certifikátom.
Adresa je `https://<IP-s-pomlčkami>.sslip.io` (napr. `https://129-153-10-20.sslip.io`) — bez registrácie domény a nemení sa,
kým VM existuje. HTTPS je nutné kvôli kamere a mikrofónu.

## 1. Účet (raz, ~10 min)
1. Zaregistruj sa na <https://signup.cloud.oracle.com> — vyber **Always Free**, domovský región blízko (napr. Frankfurt).
2. Overenie karty strhne a hneď vráti malú sumu. Always Free zdroje sa neplatia; účet neprepínaj na „Pay As You Go“.

## 2. VM (raz)
1. Console → **Compute → Instances → Create instance**.
2. Image: **Canonical Ubuntu 24.04**.
3. Shape: **Ampere A1 Flex** (Always Free, 1–4 OCPU, 6–24 GB RAM). Ak hlási „Out of capacity“, skús inú Availability Domain
   alebo **VM.Standard.E2.1.Micro** (1 GB RAM — skript si pridá swap, build bude pomalší).
4. Networking: nechaj vytvoriť VCN s **public subnet** a zaškrtni **Assign a public IPv4 address**.
5. SSH keys: **Upload public key** — napr. `~/.ssh/id_ed25519.pub` (nový: `ssh-keygen -t ed25519`).
6. Create a poznač si **Public IP address**.

## 3. Otvoriť porty 80 a 443 (raz)
Instance → **Subnet → Security List → Add Ingress Rules**:

| Source CIDR | Protocol | Destination port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | UDP | `443` |

(Firewall priamo vo VM otvorí skript sám.)

## 4. Nasadenie (z Macu, z koreňa repozitára)
```bash
deploy/oracle/deploy.sh <PUBLIC_IP> --with-data
```
- `--with-data` prenesie aj doterajšie stoly z lokálneho kontajnera `poker-night` (žetóny, história, leaderboard).
  Pri ďalších nasadeniach ho vynechaj, inak prepíše stoly na VM stavom z Macu.
- Iný kľúč: `--ssh-key ~/.ssh/oracle`; iný používateľ (Oracle Linux image): `--user opc`.
- Skript nainštaluje Docker, otvorí firewall, zbuildí hru (beží aj typecheck a testy) a spustí ju. Na konci vypíše adresu.

Každú ďalšiu zmenu nasadíš tým istým príkazom (bez `--with-data`). Stoly sú v Docker volume `poker-night_poker-data`
a prežijú rebuild aj reštart VM.

## Užitočné
```bash
ssh ubuntu@<IP> 'sudo docker logs --tail 50 poker-night'     # logy hry
ssh ubuntu@<IP> 'sudo docker logs --tail 50 poker-caddy'     # logy HTTPS/certifikátu
```
Video ide priamo medzi hráčmi (WebRTC) a používa len STUN; hráči na mobilných dátach ho nemusia vidieť. TURN server
(napr. `coturn` na tom istom VM) sa dá doplniť cez premennú `ICE_SERVERS`.
