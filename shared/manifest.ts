/**
 * The web app manifest refers to the app itself in `related_applications` (`platform: "webapp"`), so a browser tab can
 * ask `navigator.getInstalledRelatedApps()` whether Poker Night is installed and offer "Otvor v aplikácii". On desktop
 * Chrome / Edge the entry's `id` must be the app's absolute manifest id (e.g. `https://poker.example.ts.net/`), which
 * depends on the host the game is served from. The built manifest therefore keeps it relative (`"/"`) and the server
 * resolves it per request; `tools/verify-client.ts` resolves the local build the same way before comparing.
 */
interface RelatedApplication {
  platform?: unknown;
  id?: unknown;
  url?: unknown;
}

export function resolveManifest(raw: string, origin: string): string {
  const manifest = JSON.parse(raw) as { related_applications?: RelatedApplication[] };
  if (Array.isArray(manifest.related_applications)) {
    manifest.related_applications = manifest.related_applications.map((app) =>
      app.platform === 'webapp' ? { ...app, ...(typeof app.id === 'string' ? { id: new URL(app.id, origin).href } : {}), ...(typeof app.url === 'string' ? { url: new URL(app.url, origin).href } : {}) } : app,
    );
  }
  return JSON.stringify(manifest, null, 2) + '\n';
}
