/** Kód stola má 6 znakov (`generateCode` na serveri); adresa pozvánky je `/t/<KÓD>`. */
export const TABLE_CODE_LENGTH = 6;

const LINK_CODE = /\/t\/([A-Za-z0-9]{4,8})(?=[/?#\s]|$)/;

/**
 * Hodnota poľa „Kód stola“: z vloženého odkazu pozvánky (`https://…/t/ABC123`) vytiahne kód, inak nechá len písmená
 * a číslice. Na iPhone sa odkaz z pozvánky otvorí v prehliadači, nie v nainštalovanej appke — hráč ho tak môže
 * skopírovať a vložiť v appke celý.
 */
export function inviteCodeFromInput(value: string): string {
  const fromLink = value.match(LINK_CODE);
  if (fromLink) {
    return fromLink[1].toUpperCase();
  }
  return value
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, TABLE_CODE_LENGTH);
}
