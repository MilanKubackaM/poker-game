import { describe, expect, it } from 'vitest';
import { inviteCodeFromInput } from '../../client/src/inviteCode';

describe('inviteCodeFromInput', () => {
  it('z vloženého odkazu pozvánky vytiahne kód', () => {
    expect(inviteCodeFromInput('https://poker.example.ts.net/t/abc123')).toBe('ABC123');
    expect(inviteCodeFromInput('https://poker.example.ts.net/t/ABC123/')).toBe('ABC123');
    expect(inviteCodeFromInput('Poď hrať: https://poker.example.ts.net/t/XY7Z9Q?x=1 dnes')).toBe('XY7Z9Q');
  });

  it('ručne písaný kód zväčší a vyčistí od medzier a pomlčiek', () => {
    expect(inviteCodeFromInput('ab c-12')).toBe('ABC12');
    expect(inviteCodeFromInput(' abc123 ')).toBe('ABC123');
  });

  it('bez odkazu nepustí viac ako 6 znakov', () => {
    expect(inviteCodeFromInput('ABC1234')).toBe('ABC123');
  });

  it('príliš dlhý kód v odkaze neberie ako pozvánku', () => {
    expect(inviteCodeFromInput('/t/ABC123456')).toBe('TABC12');
  });
});
