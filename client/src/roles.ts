import type { TableView } from '../../shared/types';

/**
 * Má hráč práva hosta? `adminIds` obsahuje len hostí, ktorí sedia pri stole — zakladateľ, ktorý odišiel, v ňom nie je
 * (po návrate práva dostane späť). Starší server `adminIds` neposiela — vtedy platí len zakladateľ (`hostId`).
 */
export function isAdminId(view: TableView, playerId: string): boolean {
  return view.adminIds ? view.adminIds.includes(playerId) : playerId === view.hostId;
}

/** Môžem ja (`youId`) ovládať stôl — spúšťať hru, meniť pravidlá, vyhadzovať…? */
export function isAdmin(view: TableView): boolean {
  return isAdminId(view, view.youId);
}

/** Som zakladateľ (vlastník) stola — jediný, kto môže vlastníctvo odovzdať. */
export function isOwner(view: TableView): boolean {
  return view.hostId === view.youId;
}

/** Bankár stola; starší server `bankerId` neposiela — vtedy je bankárom zakladateľ. */
export function bankerIdOf(view: TableView): string {
  return view.bankerId || view.hostId;
}

/** Som bankár — jediný, kto dobíja/vyberá žetóny a potvrdzuje platby v cashoute. */
export function isBanker(view: TableView): boolean {
  return bankerIdOf(view) === view.youId;
}
