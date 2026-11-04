/*
 * Poker Night service worker. It exists so the app can be installed (Chrome, Edge, Safari "Add to Dock") and so an
 * installed window shows a readable message instead of a browser error when the server is unreachable.
 *
 * It deliberately caches nothing: every page and script still comes from the server, so a deploy takes effect on the
 * next load and tools/verify-client.ts keeps checking exactly the code the browser runs. Only page navigations pass
 * through it; scripts, API calls and the Socket.IO connection go straight to the network.
 */
const OFFLINE_PAGE = `<!doctype html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b2e1f">
<title>Poker Night — bez pripojenia</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; padding: 16px; box-sizing: border-box; background: #08110d; color: #eef3ee;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; text-align: center; }
  h1 { font-family: Georgia, serif; color: #e8c26e; margin: 0 0 8px; }
  p { color: #9bb0a5; max-width: 420px; margin: 0 auto 20px; }
  button { font: inherit; padding: 10px 22px; border-radius: 10px; border: 0; background: #e8c26e; color: #1b1b1f; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>Poker Night</h1>
  <p>Server je teraz nedostupný. Skontroluj internetové pripojenie a skús to znova.</p>
  <button type="button" onclick="location.reload()">Skúsiť znova</button>
</main>
</body>
</html>`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') {
    return;
  }
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        return preloaded || (await fetch(event.request));
      } catch {
        return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
    })(),
  );
});
