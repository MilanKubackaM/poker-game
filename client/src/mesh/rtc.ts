import { isSlowRelay, type NetLinkSample, type NetSample } from '../../../shared/netstats';
import type { ClientConfig } from '../../../shared/types';

/**
 * Strop bitrate a fps odchádzajúceho videa podľa počtu protihráčov — v mesh sieti posiela každý svoje video
 * každému zvlášť, takže pri 8 protihráčoch je upload 8× bitrate a telefón kóduje 8 streamov.
 */
export function videoBitrateFor(peerCount: number): number {
  if (peerCount <= 2) {
    return 600_000;
  }
  if (peerCount <= 4) {
    return 400_000;
  }
  return 250_000;
}

const VIDEO_MAX_FPS = 15;
/**
 * Cez TURN relay po TCP/TLS (vlastný coturn cez Funnel) má video menší strop — plná linka by relay zahltila a zamŕzal by
 * obraz aj zvuk. Relay po UDP (Cloudflare) strop nepotrebuje.
 */
const RELAY_VIDEO_BITRATE = 180_000;
const RELAY_VIDEO_FPS = 12;
/** Cieľový jitter buffer pre zvuk — pri kolísaní siete radšej o chlp väčšie oneskorenie než sekanie. */
const AUDIO_JITTER_TARGET_MS = 150;

/** Väčší jitter buffer pre prichádzajúci zvuk (Chrome/Edge/Safari; inde sa ticho ignoruje). */
export function setAudioJitterTarget(receiver: RTCRtpReceiver): void {
  try {
    const target = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
    if ('jitterBufferTarget' in target) {
      target.jitterBufferTarget = AUDIO_JITTER_TARGET_MS;
    }
  } catch {
    // Prehliadač jitterBufferTarget nepodporuje — ostane predvolený.
  }
}

/** Zvuk má pri preťažení linky prednosť pred videom (Chrome/Edge; inde sa ticho ignoruje). */
async function prioritizeAudio(sender: RTCRtpSender): Promise<void> {
  try {
    const parameters = sender.getParameters();
    const encoding = parameters.encodings?.[0] as (RTCRtpEncodingParameters & { priority?: string; networkPriority?: string }) | undefined;
    if (!encoding || (encoding.priority === 'high' && encoding.networkPriority === 'high')) {
      return;
    }
    encoding.priority = 'high';
    encoding.networkPriority = 'high';
    await sender.setParameters(parameters);
  } catch {
    // Nepodporované — zvuk ide s predvolenou prioritou.
  }
}

/**
 * Strop videa a priorita zvuku. Odosielače sa vyberajú podľa transceivera (nie podľa `sender.track`), lebo pri vypnutej
 * kamere / mikrofóne je stopa `null` a parametre sa aj tak majú nastaviť dopredu.
 */
export async function capVideo(audio: RTCRtpSender, video: RTCRtpSender, peerCount: number, relayed = false): Promise<void> {
  void prioritizeAudio(audio);
  const maxBitrate = relayed ? Math.min(RELAY_VIDEO_BITRATE, videoBitrateFor(peerCount)) : videoBitrateFor(peerCount);
  const maxFramerate = relayed ? RELAY_VIDEO_FPS : VIDEO_MAX_FPS;
  try {
    const parameters = video.getParameters();
    // Pred vyjednaním je pole prázdne (Safari/Firefox); po pripojení sa zavolá znova.
    if (!parameters.encodings?.length) {
      return;
    }
    const encoding = parameters.encodings[0];
    if (encoding.maxBitrate === maxBitrate && encoding.maxFramerate === maxFramerate) {
      return;
    }
    encoding.maxBitrate = maxBitrate;
    encoding.maxFramerate = maxFramerate;
    await video.setParameters(parameters);
  } catch (error) {
    console.warn('video bitrate cap failed', error);
  }
}

/** Je spojenie cez pomalý relay (TCP/TLS)? */
export function slowRelay(link: Pick<NetLinkSample, 'relay' | 'path'>, iceServers: ClientConfig['iceServers']): boolean {
  return !!link.relay && isSlowRelay(link.path ?? '', iceServers);
}

/** Počítadlá paketov zvuku pre watchdog (null = štatistika zatiaľ neexistuje, napr. ešte neprišiel žiadny paket). */
export async function readAudioPackets(pc: RTCPeerConnection): Promise<{ inbound: number | null; outbound: number | null }> {
  const report = await pc.getStats();
  let inbound: number | null = null;
  let outbound: number | null = null;
  report.forEach((stat: Stat) => {
    const kind = (stat.kind ?? stat.mediaType) as string | undefined;
    if (kind !== 'audio') {
      return;
    }
    if (stat.type === 'inbound-rtp') {
      inbound = (inbound ?? 0) + count(stat, 'packetsReceived');
    } else if (stat.type === 'outbound-rtp') {
      outbound = (outbound ?? 0) + count(stat, 'packetsSent');
    }
  });
  return { inbound, outbound };
}

/** Kumulatívne počítadlá z getStats — nové meranie mínus staré = hodnota za interval. */
export interface Counters {
  at: number;
  pairId: string | null;
  bytesSent: number;
  bytesReceived: number;
  audioInBytes: number;
  audioLost: number;
  audioReceived: number;
  audioConcealed: number;
  audioSamples: number;
  jitterBufferDelay: number;
  jitterBufferEmitted: number;
  videoInBytes: number;
  videoLost: number;
  videoReceived: number;
  freezes: number;
  freezeSec: number;
  audioOutBytes: number;
  videoOutBytes: number;
}

export interface LinkReading {
  counters: Counters;
  link: Omit<NetLinkSample, 'to' | 'state' | 'events'>;
}

type Stat = Record<string, unknown>;

function count(stat: Stat, key: string): number {
  const value = stat[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optional(stat: Stat | undefined, key: string): number | undefined {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pct(part: number, total: number): number | undefined {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : undefined;
}

/**
 * Jedno meranie spojenia: cesta ICE (host/srflx/relay + protokol), RTT, prenos v oboch smeroch, straty, koľko zvuku
 * musel prehliadač doplniť, zamrznutia obrazu a prečo prehliadač obmedzuje odchádzajúce video.
 */
export async function readLink(pc: RTCPeerConnection, previous: Counters | null): Promise<LinkReading | null> {
  const report = await pc.getStats();
  const byId = new Map<string, Stat>();
  let selectedId: string | null = null;
  let audioIn: Stat | undefined;
  let videoIn: Stat | undefined;
  let videoOut: Stat | undefined;
  let remoteLoss: number | undefined;
  const now = performance.now();
  const counters: Counters = {
    at: now,
    pairId: null,
    bytesSent: 0,
    bytesReceived: 0,
    audioInBytes: 0,
    audioLost: 0,
    audioReceived: 0,
    audioConcealed: 0,
    audioSamples: 0,
    jitterBufferDelay: 0,
    jitterBufferEmitted: 0,
    videoInBytes: 0,
    videoLost: 0,
    videoReceived: 0,
    freezes: 0,
    freezeSec: 0,
    audioOutBytes: 0,
    videoOutBytes: 0,
  };
  report.forEach((stat: Stat) => {
    byId.set(stat.id as string, stat);
    const kind = (stat.kind ?? stat.mediaType) as string | undefined;
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      selectedId = stat.selectedCandidatePairId;
    } else if (stat.type === 'inbound-rtp' && kind === 'audio') {
      audioIn = stat;
      counters.audioInBytes += count(stat, 'bytesReceived');
      counters.audioLost += Math.max(0, count(stat, 'packetsLost'));
      counters.audioReceived += count(stat, 'packetsReceived');
      counters.audioConcealed += Math.max(0, count(stat, 'concealedSamples') - count(stat, 'silentConcealedSamples'));
      counters.audioSamples += count(stat, 'totalSamplesReceived');
      counters.jitterBufferDelay += count(stat, 'jitterBufferDelay');
      counters.jitterBufferEmitted += count(stat, 'jitterBufferEmittedCount');
    } else if (stat.type === 'inbound-rtp' && kind === 'video') {
      videoIn = stat;
      counters.videoInBytes += count(stat, 'bytesReceived');
      counters.videoLost += Math.max(0, count(stat, 'packetsLost'));
      counters.videoReceived += count(stat, 'packetsReceived');
      counters.freezes += count(stat, 'freezeCount');
      counters.freezeSec += count(stat, 'totalFreezesDuration');
    } else if (stat.type === 'outbound-rtp' && kind === 'audio') {
      counters.audioOutBytes += count(stat, 'bytesSent');
    } else if (stat.type === 'outbound-rtp' && kind === 'video') {
      videoOut = stat;
      counters.videoOutBytes += count(stat, 'bytesSent');
    } else if (stat.type === 'remote-inbound-rtp' && typeof stat.fractionLost === 'number') {
      remoteLoss = Math.max(remoteLoss ?? 0, stat.fractionLost * 100);
    }
  });
  let selected: Stat | undefined = selectedId ? byId.get(selectedId) : undefined;
  if (!selected) {
    report.forEach((stat: Stat) => {
      if (stat.type === 'candidate-pair' && (stat.selected === true || (stat.nominated === true && stat.state === 'succeeded'))) {
        selected = stat;
      }
    });
  }
  if (!selected) {
    return null;
  }
  const pair: Stat = selected;
  counters.pairId = String(pair.id);
  counters.bytesSent = count(pair, 'bytesSent');
  counters.bytesReceived = count(pair, 'bytesReceived');
  const local = byId.get(pair.localCandidateId as string);
  const remote = byId.get(pair.remoteCandidateId as string);
  const localType = String(local?.candidateType ?? '?');
  const remoteType = String(remote?.candidateType ?? '?');
  const protocol = String(local?.relayProtocol ?? local?.protocol ?? '?');
  const rtt = optional(pair, 'currentRoundTripTime');
  const avail = optional(pair, 'availableOutgoingBitrate');

  const elapsed = previous ? now - previous.at : 0;
  const delta = (key: keyof Omit<Counters, 'at' | 'pairId'>): number | undefined => {
    if (!previous || elapsed <= 0) {
      return undefined;
    }
    // Po reštarte ICE je nový pár a jeho počítadlá idú od nuly.
    if ((key === 'bytesSent' || key === 'bytesReceived') && previous.pairId !== counters.pairId) {
      return counters[key];
    }
    return Math.max(0, counters[key] - previous[key]);
  };
  const kbps = (key: keyof Omit<Counters, 'at' | 'pairId'>): number | undefined => {
    const bytes = delta(key);
    return bytes === undefined ? undefined : Math.round((bytes * 8) / elapsed);
  };
  const audioLost = delta('audioLost') ?? 0;
  const audioReceived = delta('audioReceived') ?? 0;
  const videoLost = delta('videoLost') ?? 0;
  const videoReceived = delta('videoReceived') ?? 0;
  const emitted = delta('jitterBufferEmitted') ?? 0;
  const limitation = videoOut?.qualityLimitationReason;
  const freezeSec = delta('freezeSec');
  return {
    counters,
    link: {
      path: `${localType}/${protocol}→${remoteType}`,
      relay: localType === 'relay' || remoteType === 'relay',
      rttMs: rtt === undefined ? undefined : Math.round(rtt * 1000),
      upKbps: kbps('bytesSent'),
      downKbps: kbps('bytesReceived'),
      availKbps: avail === undefined ? undefined : Math.round(avail / 1000),
      audioInKbps: audioIn ? kbps('audioInBytes') : undefined,
      audioLossPct: audioIn ? pct(audioLost, audioLost + audioReceived) : undefined,
      concealPct: audioIn ? pct(delta('audioConcealed') ?? 0, delta('audioSamples') ?? 0) : undefined,
      jitterMs: audioIn && optional(audioIn, 'jitter') !== undefined ? Math.round(optional(audioIn, 'jitter')! * 1000) : undefined,
      jitterBufferMs: emitted > 0 ? Math.round(((delta('jitterBufferDelay') ?? 0) / emitted) * 1000) : undefined,
      videoInKbps: videoIn ? kbps('videoInBytes') : undefined,
      videoLossPct: videoIn ? pct(videoLost, videoLost + videoReceived) : undefined,
      videoInFps: optional(videoIn, 'framesPerSecond'),
      videoInHeight: optional(videoIn, 'frameHeight'),
      freezes: videoIn ? delta('freezes') : undefined,
      freezeMs: videoIn && freezeSec !== undefined ? Math.round(freezeSec * 1000) : undefined,
      audioOutKbps: kbps('audioOutBytes'),
      videoOutKbps: videoOut ? kbps('videoOutBytes') : undefined,
      videoOutFps: optional(videoOut, 'framesPerSecond'),
      videoOutHeight: optional(videoOut, 'frameHeight'),
      limit: limitation === 'none' || limitation === 'cpu' || limitation === 'bandwidth' || limitation === 'other' ? limitation : undefined,
      remoteLossPct: remoteLoss === undefined ? undefined : Math.round(remoteLoss * 10) / 10,
    },
  };
}

export function connectionInfo(): NetSample['connection'] {
  const connection = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  if (!connection) {
    return undefined;
  }
  return { type: connection.type, effectiveType: connection.effectiveType, downlinkMbps: connection.downlink, rttMs: connection.rtt };
}
