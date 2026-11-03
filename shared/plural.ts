/** „1 kolo“, „3 kolá“, „5 kôl“ */
export function handsLabel(count: number): string {
  return `${count} ${count === 1 ? 'kolo' : count >= 2 && count <= 4 ? 'kolá' : 'kôl'}`;
}
