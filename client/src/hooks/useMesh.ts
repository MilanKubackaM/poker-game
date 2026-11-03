import { useEffect, useRef, useState } from 'react';
import type { ClientConfig, RtcPayload } from '../../../shared/types';
import { NET_SAMPLE_MS, isSlowRelay, type NetIceEvent, type NetLinkSample, type NetSample } from '../../../shared/netstats';
import { socket } from '../socket';

export interface MeshPeer {
  playerId: string;
  rtcId: string;
}

/** Kvalita spojenia s jedným hráčom (z getStats) — zobrazuje sa pri jeho videu. */
export interface LinkInfo {
  /** Spojenie ide cez TURN relay (TCP cez Funnel) namiesto priamo. */
  relayed: boolean;
  path: string;
  rttMs: number | null;
  /** Strata prichádzajúcich paketov za posledné meranie v %. */
  lossPct: number;
}

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
/** Ako dlho čakať v stave `disconnected`, kým sa skúsi ICE restart (prehliadač sám čaká až ~30 s na `failed`). */
const DISCONNECTED_RESTART_MS = 5000;
/** Cieľový jitter buffer pre zvuk — pri kolísaní siete radšej o chlp väčšie oneskorenie než sekanie. */
const AUDIO_JITTER_TARGET_MS = 150;

/** Zvuk má pri preťažení linky prednosť pred videom (Chrome/Edge; inde sa ticho ignoruje). */
async function prioritizeAudio(pc: RTCPeerConnection): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'audio') {
      continue;
    }
    try {
      const parameters = sender.getParameters();
      const encoding = parameters.encodings?.[0] as (RTCRtpEncodingParameters & { priority?: string; networkPriority?: string }) | undefined;
      if (!encoding || (encoding.priority === 'high' && encoding.networkPriority === 'high')) {
        continue;
      }
      encoding.priority = 'high';
      encoding.networkPriority = 'high';
      await sender.setParameters(parameters);
    } catch {
      continue;
    }
  }
}

async function capVideo(pc: RTCPeerConnection, peerCount: number, relayed = false): Promise<void> {
  void prioritizeAudio(pc);
  const maxBitrate = relayed ? Math.min(RELAY_VIDEO_BITRATE, videoBitrateFor(peerCount)) : videoBitrateFor(peerCount);
  const maxFramerate = relayed ? RELAY_VIDEO_FPS : VIDEO_MAX_FPS;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') {
      continue;
    }
    try {
      const parameters = sender.getParameters();
      // Pred vyjednaním je pole prázdne (Safari/Firefox); po pripojení sa zavolá znova.
      if (!parameters.encodings?.length) {
        continue;
      }
      const encoding = parameters.encodings[0];
      if (encoding.maxBitrate === maxBitrate && encoding.maxFramerate === maxFramerate) {
        continue;
      }
      encoding.maxBitrate = maxBitrate;
      encoding.maxFramerate = maxFramerate;
      await sender.setParameters(parameters);
    } catch (error) {
      console.warn('video bitrate cap failed', error);
    }
  }
}

interface PeerState {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Spojenie ide cez TURN relay po TCP/TLS (zistené z getStats) — video má menší strop. */
  relayed: boolean;
  disconnectTimer: number | null;
  /** Počítadlá z minulého merania (rýchlosti a straty sa počítajú z rozdielu). */
  counters: Counters | null;
  /** Zmeny stavu spojenia od poslednej vzorky (pre /stats). */
  events: { at: number; kind: NetIceEvent }[];
}

/** Kumulatívne počítadlá z getStats — nové meranie mínus staré = hodnota za interval. */
interface Counters {
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

interface LinkReading {
  counters: Counters;
  link: Omit<NetLinkSample, 'to' | 'state' | 'events'>;
  /** Strata všetkých prichádzajúcich paketov za interval (ikonka pri videu). */
  lossPct: number;
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
async function readLink(pc: RTCPeerConnection, previous: Counters | null): Promise<LinkReading | null> {
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
    lossPct: pct(audioLost + videoLost, audioLost + videoLost + audioReceived + videoReceived) ?? 0,
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

function connectionInfo(): NetSample['connection'] {
  const connection = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  if (!connection) {
    return undefined;
  }
  return { type: connection.type, effectiveType: connection.effectiveType, downlinkMbps: connection.downlink, rttMs: connection.rtt };
}

const MAX_PENDING_EVENTS = 20;

function note(state: PeerState, kind: NetIceEvent): void {
  state.events.push({ at: performance.now(), kind });
  if (state.events.length > MAX_PENDING_EVENTS) {
    state.events.shift();
  }
}

function restart(state: PeerState): void {
  note(state, 'restart');
  state.pc.restartIce();
}

export function useMesh(
  enabled: boolean,
  selfRtcId: string | null,
  peers: MeshPeer[],
  localStream: MediaStream | null,
  tracksVersion: number,
  iceServers: ClientConfig['iceServers'],
): { streams: Map<string, MediaStream>; links: Map<string, LinkInfo> } {
  const peerStates = useRef(new Map<string, PeerState>());
  const rtcToPlayer = useRef(new Map<string, string>());
  const localRef = useRef<MediaStream | null>(localStream);
  const peerCountRef = useRef(peers.length);
  peerCountRef.current = peers.length;
  const iceRef = useRef(iceServers);
  const [streams, setStreams] = useState(() => new Map<string, MediaStream>());
  const [links, setLinks] = useState(() => new Map<string, LinkInfo>());

  localRef.current = localStream;
  iceRef.current = iceServers;
  rtcToPlayer.current = new Map(peers.map((peer) => [peer.rtcId, peer.playerId]));

  const send = (to: string, data: RtcPayload) => {
    socket.emit('rtc:signal', { to, data }, () => undefined);
  };

  const setRemoteStream = (rtcId: string, stream: MediaStream | null) => {
    setStreams((previous) => {
      const next = new Map(previous);
      const playerId = rtcToPlayer.current.get(rtcId) ?? rtcId;
      if (stream) {
        next.set(playerId, stream);
      } else {
        next.delete(playerId);
      }
      return next;
    });
  };

  const syncTracks = (pc: RTCPeerConnection) => {
    const stream = localRef.current;
    const tracks = stream?.getTracks() ?? [];
    const senders = pc.getSenders();
    for (const track of tracks) {
      if (!senders.some((sender) => sender.track === track)) {
        pc.addTrack(track, stream!);
      }
    }
    for (const sender of senders) {
      if (sender.track && !tracks.includes(sender.track)) {
        pc.removeTrack(sender);
      }
    }
    void capVideo(pc, peerCountRef.current);
  };

  const createPeer = (rtcId: string): PeerState => {
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    const state: PeerState = { pc, polite: (socket.id ?? '') < rtcId, makingOffer: false, ignoreOffer: false, relayed: false, disconnectTimer: null, counters: null, events: [] };
    pc.ontrack = ({ track, receiver, streams: remoteStreams }) => {
      if (track.kind === 'audio') {
        try {
          (receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null }).jitterBufferTarget = AUDIO_JITTER_TARGET_MS;
        } catch {
          // Prehliadač jitterBufferTarget nepodporuje — ostane predvolený.
        }
      }
      const stream = remoteStreams[0] ?? new MediaStream([track]);
      setRemoteStream(rtcId, stream);
      track.onunmute = () => setRemoteStream(rtcId, stream);
      stream.onremovetrack = () => setRemoteStream(rtcId, stream);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        send(rtcId, { kind: 'candidate', candidate: candidate.toJSON() as RTCIceCandidateInit & { candidate: string } });
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          send(rtcId, { kind: 'description', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
        void capVideo(pc, peerCountRef.current);
      } catch (error) {
        console.warn('negotiation failed', error);
      } finally {
        state.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        void capVideo(pc, peerCountRef.current, state.relayed);
      }
      if (pc.connectionState === 'failed') {
        restart(state);
      }
    };
    // Krátky výpadok siete: namiesto čakania ~30 s na „failed“ (zamrznutý obraz aj zvuk) skúsiť ICE restart hneď.
    pc.oniceconnectionstatechange = () => {
      note(state, pc.iceConnectionState);
      if (pc.iceConnectionState === 'disconnected') {
        if (state.disconnectTimer === null) {
          state.disconnectTimer = window.setTimeout(() => {
            state.disconnectTimer = null;
            if (pc.iceConnectionState === 'disconnected' && pc.signalingState !== 'closed') {
              restart(state);
            }
          }, DISCONNECTED_RESTART_MS);
        }
      } else if (state.disconnectTimer !== null) {
        window.clearTimeout(state.disconnectTimer);
        state.disconnectTimer = null;
      }
    };
    peerStates.current.set(rtcId, state);
    syncTracks(pc);
    return state;
  };

  const closePeer = (rtcId: string) => {
    const state = peerStates.current.get(rtcId);
    if (!state) {
      return;
    }
    if (state.disconnectTimer !== null) {
      window.clearTimeout(state.disconnectTimer);
    }
    state.pc.close();
    peerStates.current.delete(rtcId);
    setRemoteStream(rtcId, null);
    const playerId = rtcToPlayer.current.get(rtcId) ?? rtcId;
    setLinks((previous) => {
      if (!previous.has(playerId)) {
        return previous;
      }
      const next = new Map(previous);
      next.delete(playerId);
      return next;
    });
  };

  const peerKey = peers.map((peer) => peer.rtcId).sort().join('|');
  const lastSelf = useRef<string | null>(selfRtcId);

  useEffect(() => {
    if (lastSelf.current !== selfRtcId) {
      lastSelf.current = selfRtcId;
      for (const rtcId of [...peerStates.current.keys()]) {
        closePeer(rtcId);
      }
    }
    if (!enabled || !selfRtcId) {
      for (const rtcId of [...peerStates.current.keys()]) {
        closePeer(rtcId);
      }
      return;
    }
    const wanted = new Set(peers.map((peer) => peer.rtcId));
    for (const rtcId of [...peerStates.current.keys()]) {
      if (!wanted.has(rtcId)) {
        closePeer(rtcId);
      }
    }
    for (const rtcId of wanted) {
      if (!peerStates.current.has(rtcId)) {
        createPeer(rtcId);
      }
    }
  }, [enabled, peerKey, selfRtcId]);

  useEffect(() => {
    for (const state of peerStates.current.values()) {
      syncTracks(state.pc);
    }
  }, [tracksVersion, localStream]);

  // Pri zmene počtu protihráčov prepočítať strop bitrate (viac ľudí = menej na každého).
  useEffect(() => {
    for (const state of peerStates.current.values()) {
      void capVideo(state.pc, peers.length, state.relayed);
    }
  }, [peers.length]);

  // Diagnostika: cesta spojenia (priamo / cez relay), RTT a straty — ikonka pri videu; celá vzorka ide na server pre /stats.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let serverRttMs: number | undefined;
    let cancelled = false;
    const tick = async () => {
      const entries = [...peerStates.current.entries()];
      if (entries.length === 0) {
        return;
      }
      const links = await Promise.all(
        entries.map(async ([rtcId, state]): Promise<NetLinkSample | null> => {
          const playerId = rtcToPlayer.current.get(rtcId);
          if (!playerId) {
            return null;
          }
          const now = performance.now();
          const events = state.events.splice(0).map((event) => ({ ageMs: Math.round(now - event.at), kind: event.kind }));
          const base: NetLinkSample = { to: playerId, state: state.pc.iceConnectionState, events: events.length ? events : undefined };
          if (state.pc.connectionState !== 'connected') {
            state.counters = null;
            return base;
          }
          const reading = await readLink(state.pc, state.counters).catch(() => null);
          if (!reading) {
            return base;
          }
          state.counters = reading.counters;
          const relayed = !!reading.link.relay;
          const tcpRelay = relayed && isSlowRelay(reading.link.path ?? '', iceRef.current);
          if (tcpRelay !== state.relayed) {
            state.relayed = tcpRelay;
            void capVideo(state.pc, peerCountRef.current, tcpRelay);
          }
          const info: LinkInfo = { relayed, path: reading.link.path ?? '?', rttMs: reading.link.rttMs ?? null, lossPct: reading.lossPct };
          setLinks((previous) => {
            const before = previous.get(playerId);
            if (before && before.relayed === info.relayed && before.path === info.path && before.rttMs === info.rttMs && before.lossPct === info.lossPct) {
              return previous;
            }
            const next = new Map(previous);
            next.set(playerId, info);
            return next;
          });
          return { ...base, ...reading.link };
        }),
      );
      if (cancelled || !socket.connected) {
        return;
      }
      const tracks = localRef.current?.getTracks() ?? [];
      const live = (kind: string) => tracks.some((track) => track.kind === kind && track.enabled && track.readyState === 'live');
      const sample: NetSample = {
        serverRttMs,
        hidden: document.visibilityState === 'hidden',
        camera: live('video'),
        microphone: live('audio'),
        connection: connectionInfo(),
        links: links.filter((link): link is NetLinkSample => link !== null),
      };
      const sentAt = performance.now();
      socket.timeout(NET_SAMPLE_MS).emit('net:stats', sample, (error: Error | null) => {
        serverRttMs = error ? NET_SAMPLE_MS : Math.round(performance.now() - sentAt);
      });
    };
    const timer = window.setInterval(() => void tick(), NET_SAMPLE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  const iceKey = JSON.stringify(iceServers);
  useEffect(() => {
    for (const state of peerStates.current.values()) {
      try {
        state.pc.setConfiguration({ ...state.pc.getConfiguration(), iceServers: iceRef.current });
        if (state.pc.connectionState === 'failed' || state.pc.iceConnectionState === 'failed') {
          restart(state);
        }
      } catch (error) {
        console.warn('ICE config update failed', error);
      }
    }
  }, [iceKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onSignal = async ({ from, data }: { from: string; data: RtcPayload }) => {
      const state = peerStates.current.get(from) ?? createPeer(from);
      const { pc } = state;
      try {
        if (data.kind === 'description') {
          const description = data.description as RTCSessionDescriptionInit;
          const offerCollision = description.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
          state.ignoreOffer = !state.polite && offerCollision;
          if (state.ignoreOffer) {
            return;
          }
          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription) {
              send(from, { kind: 'description', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
            }
          }
        } else if (data.kind === 'candidate') {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (error) {
            if (!state.ignoreOffer) {
              throw error;
            }
          }
        }
      } catch (error) {
        console.warn('signal handling failed', error);
      }
    };
    socket.on('rtc:signal', onSignal);
    return () => {
      socket.off('rtc:signal', onSignal);
    };
  }, [enabled]);

  useEffect(
    () => () => {
      for (const rtcId of [...peerStates.current.keys()]) {
        closePeer(rtcId);
      }
    },
    [],
  );

  return { streams, links };
}
