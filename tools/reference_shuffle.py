"""Independent reference implementation of the Poker Night shuffle (Python standard library only).

It shares no code with the server. It exists so that anyone can check that the TypeScript implementation
(server/poker/fairDeck.ts) does exactly what README.md describes:

    python3 tools/reference_shuffle.py
    # prints the deck for the test vector in README.md; it must match:
    # 3d 2s 9c Jd Kh Ad Kc 2h 3h 8d ...

To rebuild the deck of a real hand, pass the values from a proof in a fairness export:

    python3 tools/reference_shuffle.py <table> <roundId> <serverSeed> [<playerId>=<seed> ...]
"""
import hashlib
import hmac
import struct
import sys


def deck(table, round_id, server_seed, seeds):
    material = b"poker-night/shuffle/v1\0" + table.encode() + b"\0" + round_id.encode() + b"\0" + bytes.fromhex(server_seed)
    for player_id in sorted(seeds):
        material += player_id.encode() + b"\0" + bytes.fromhex(seeds[player_id])
    key = hashlib.sha256(material).digest()

    def words():
        counter = 0
        while True:
            block = hmac.new(key, struct.pack(">I", counter), hashlib.sha256).digest()
            counter += 1
            for offset in range(0, 32, 4):
                yield struct.unpack(">I", block[offset:offset + 4])[0]

    stream = words()

    def below(n):
        limit = 2**32 - (2**32 % n)
        while True:
            value = next(stream)
            if value < limit:
                return value % n

    cards = [rank + suit for suit in "shdc" for rank in "23456789TJQKA"]
    for index in range(51, 0, -1):
        swap = below(index + 1)
        cards[index], cards[swap] = cards[swap], cards[index]
    return cards


if __name__ == "__main__":
    if len(sys.argv) >= 4:
        table, round_id, server_seed = sys.argv[1:4]
        player_seeds = dict(arg.split("=", 1) for arg in sys.argv[4:])
    else:
        table, round_id, server_seed = "ABC123", "0011223344556677", "01" * 32
        player_seeds = {"player-a": "02" * 32, "player-b": "03" * 32}
    print(" ".join(deck(table, round_id, server_seed, player_seeds)))
