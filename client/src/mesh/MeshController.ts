import { NET_SAMPLE_MS, type NetIceEvent, type NetLinkSample, type NetSample } from '../../../shared/netstats';
import type { Ack, ClientConfig, RtcPayload } from '../../../shared/types';
import { socket } from '../socket';
import { attachSignalHandler, detachSignalHandler, drainSignals } from './inbox';
import {
  WATCHDOG_MS,
  RecoveryLimiter,
  belongsToSession,
  decide,
  initialFlow,
  isHealthy,
  isOfferer,
  newSessionId,
  offerAction,
  rebaseFlow,
  resetAction,
  trackFlow,
  HEALTHY_MS,
  type FlowState,
  type LinkConnectionState,
  type LinkSnapshot,
  type MeshRole,
  type RecoveryReason,
} from './logic';
import { capVideo, connectionInfo, readAudioPackets, readLink, setAudioJitterTarget, slowRelay, type Counters } from './rtc';

/** Protihráč v mesh sieti — príznak mikrofónu je zo stavu stola (watchdog podľa neho vie, či má tiecť zvuk). */
export interface MeshPeer {
  playerId: string;
  rtcId: string;
  microphone: boolean;
}

export interface MeshInput {
  enabled: boolean;
  selfId: string | null;
  peers: readonly MeshPeer[];
  localStream: MediaStream | null;
  iceServers: ClientConfig['iceServers'];
}

/** Ako dlho čakať na potvrdenie `rtc:signal` zo servera. */
const SIGNAL_ACK_MS = 5000;
/** Kandidátov, ktorí prídu pred popisom spojenia, si pamätáme len obmedzene. */
const MAX_PENDING_CANDIDATES = 100;
const MAX_PENDING_EVENTS = 20;

type CandidateInit = Extract<RtcPayload, { kind: 'candidate' }>['candidate'];

/** Jedno `RTCPeerConnection` s jedným protihráčom; nová relácia = nové spojenie. */
interface Session {
  id: string;
  pc: RTCPeerConnection;
  /** Odosielače pevných transceiverov (odpovedajúci ich pozná až po prijatí ponuky). */
  audio: RTCRtpSender | null;
  video: RTCRtpSender | null;
  startedAt: number;
  /** Popis (ponuka / odpoveď) už odišiel — dovtedy vlastní kandidáti čakajú, aby neprišli pred ním. */
  described: boolean;
  outgoing: CandidateInit[];
  /** Kandidáti protihráča, ktorí prišli pred jeho popisom. */
  incoming: CandidateInit[];
  iceRestartAt: number | null;
  stream: MediaStream | null;
  streamKey: string;
}

/** Stav spojenia s jedným protihráčom naprieč reláciami. */
interface Link {
  rtcId: string;
  peer: MeshPeer;
  role: MeshRole;
  session: Session | null;
  /** Signály a vyjednávanie s jedným protihráčom idú za sebou (kandidát nesmie predbehnúť ponuku). */
  chain: Promise<void>;
  limiter: RecoveryLimiter;
  connected: boolean;
  notConnectedSince: number;
  disconnectedSince: number | null;
  inbound: FlowState;
  outbound: FlowState;
  healthySince: number | null;
  /** Ponúkajúci dostal `reset`, ale obnovu zatiaľ nedovolilo obmedzenie — spraví ju watchdog. */
  pendingReset: boolean;
  relayed: boolean;
  counters: Counters | null;
  events: { at: number; kind: NetIceEvent }[];
  closed: boolean;
}

function connectionState(pc: RTCPeerConnection): LinkConnectionState {
  const state = (pc as RTCPeerConnection & { connectionState?: string }).connectionState;
  if (state) {
    return state as LinkConnectionState;
  }
  // Starší prehliadač bez `connectionState` — odvodiť z ICE.
  switch (pc.iceConnectionState) {
    case 'checking':
      return 'connecting';
    case 'completed':
      return 'connected';
    default:
      return pc.iceConnectionState as LinkConnectionState;
  }
}

function note(link: Link, kind: NetIceEvent): void {
  link.events.push({ at: performance.now(), kind });
  if (link.events.length > MAX_PENDING_EVENTS) {
    link.events.shift();
  }
}

/** getStats, ktoré neodpovie (zaseknutý prehliadač), nesmie zastaviť watchdog — výsledok sa vtedy berie ako neznámy. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function liveTrack(stream: MediaStream | null, kind: 'audio' | 'video'): MediaStreamTrack | null {
  return stream?.getTracks().find((track) => track.kind === kind && track.readyState === 'live') ?? null;
}

/**
 * Mesh sieť hlasu a videa (každý s každým). Zásady:
 * - ponúka vždy strana s menším socket id (žiadne kolízie ponúk),
 * - spojenie má pevne 1× audio + 1× video transceiver; zapnutie mikrofónu/kamery = `replaceTrack`, nikdy renegociácia,
 * - každá ponuka nesie id relácie; nová relácia = čisté spojenie,
 * - watchdog každé 3 s obnoví zaseknuté, zlyhané alebo „tiché“ spojenie (s obmedzením a exponenciálnym čakaním).
 */
export class MeshController {
  private links = new Map<string, Link>();
  private input: MeshInput = { enabled: false, selfId: null, peers: [], localStream: null, iceServers: [] };
  private running = false;
  private selfId: string | null = null;
  private watchdogTimer: number | null = null;
  private statsTimer: number | null = null;
  private lastTick = 0;
  private ticking = false;
  private serverRttMs: number | undefined;
  private streams = new Map<string, MediaStream>();
  private iceKey = '';

  constructor(private readonly onStreams: (streams: Map<string, MediaStream>) => void) {}

  /** Nové vstupy z Reactu (zapnutie, protihráči, lokálne stopy, ICE servery). */
  update(input: MeshInput): void {
    this.input = input;
    const active = input.enabled && !!input.selfId;
    if (!active) {
      this.stop();
      return;
    }
    if (this.selfId !== input.selfId) {
      // Nový vlastný socket = iné roly voči všetkým; staré spojenia nemajú zmysel.
      this.closeAll();
      this.selfId = input.selfId;
    }
    this.start();
    const iceKey = JSON.stringify(input.iceServers);
    if (iceKey !== this.iceKey) {
      this.iceKey = iceKey;
      this.applyIceServers();
    }
    const added = this.syncPeers();
    this.syncTracks();
    const described = this.drain();
    const now = performance.now();
    for (const link of added) {
      if (link.role === 'offerer') {
        continue;
      }
      // Prichádzajúci odpovedajúci si vyžiada ponuku od každého, od koho ešte nič nemá (ponuka sa mohla stratiť).
      if (!described.has(link.rtcId)) {
        link.limiter.noteStart(now);
        this.send(link.rtcId, { kind: 'reset', reason: 'hello' });
      }
    }
  }

  /** Úplné zastavenie (odchod od stola, iné okno prevzalo hráča). */
  stop(): void {
    if (!this.running && this.links.size === 0) {
      return;
    }
    this.running = false;
    detachSignalHandler(this.onSignal);
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.closeAll();
    this.selfId = null;
  }

  private start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    attachSignalHandler(this.onSignal);
    this.lastTick = performance.now();
    this.watchdogTimer = window.setInterval(() => void this.watchdog(), WATCHDOG_MS);
    this.statsTimer = window.setInterval(() => void this.sampleStats(), NET_SAMPLE_MS);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Protihráči a stopy
  // -------------------------------------------------------------------------------------------------------------------

  private syncPeers(): Link[] {
    const wanted = new Map(this.input.peers.map((peer) => [peer.rtcId, peer]));
    for (const [rtcId, link] of this.links) {
      const peer = wanted.get(rtcId);
      if (!peer || peer.playerId !== link.peer.playerId) {
        this.closeLink(link);
      }
    }
    const added: Link[] = [];
    const now = performance.now();
    for (const [rtcId, peer] of wanted) {
      const existing = this.links.get(rtcId);
      if (existing) {
        existing.peer = peer;
        continue;
      }
      const link: Link = {
        rtcId,
        peer,
        role: isOfferer(this.selfId!, rtcId) ? 'offerer' : 'answerer',
        session: null,
        chain: Promise.resolve(),
        limiter: new RecoveryLimiter(),
        connected: false,
        notConnectedSince: now,
        disconnectedSince: null,
        inbound: initialFlow(now),
        outbound: initialFlow(now),
        healthySince: null,
        pendingReset: false,
        relayed: false,
        counters: null,
        events: [],
        closed: false,
      };
      this.links.set(rtcId, link);
      added.push(link);
      if (link.role === 'offerer') {
        link.limiter.noteStart(now);
        this.startSession(link, false);
      }
    }
    if (added.length) {
      this.recapAll();
    }
    return added;
  }

  /** Zapnutie/vypnutie mikrofónu alebo kamery: len `replaceTrack` na existujúcich odosielačoch — bez renegociácie. */
  private syncTracks(): void {
    for (const link of this.links.values()) {
      if (link.session) {
        void this.applyTracks(link, link.session);
      }
    }
  }

  private async applyTracks(link: Link, session: Session): Promise<void> {
    const stream = this.input.localStream;
    const pairs: [RTCRtpSender | null, MediaStreamTrack | null][] = [
      [session.audio, liveTrack(stream, 'audio')],
      [session.video, liveTrack(stream, 'video')],
    ];
    for (const [sender, track] of pairs) {
      if (!sender || sender.track === track) {
        continue;
      }
      try {
        await sender.replaceTrack(track);
      } catch (error) {
        if (link.session === session) {
          console.warn('replaceTrack failed', error);
        }
      }
    }
    if (link.session === session && session.audio && session.video) {
      void capVideo(session.audio, session.video, this.links.size, link.relayed);
    }
  }

  private recapAll(): void {
    for (const link of this.links.values()) {
      const session = link.session;
      if (session?.audio && session.video) {
        void capVideo(session.audio, session.video, this.links.size, link.relayed);
      }
    }
  }

  private applyIceServers(): void {
    for (const link of this.links.values()) {
      const pc = link.session?.pc;
      if (!pc) {
        continue;
      }
      try {
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers: this.input.iceServers });
      } catch (error) {
        console.warn('ICE config update failed', error);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Relácie
  // -------------------------------------------------------------------------------------------------------------------

  private createSession(link: Link, id: string): Session {
    const pc = new RTCPeerConnection({ iceServers: this.input.iceServers });
    const now = performance.now();
    const session: Session = {
      id,
      pc,
      audio: null,
      video: null,
      startedAt: now,
      described: false,
      outgoing: [],
      incoming: [],
      iceRestartAt: null,
      stream: null,
      streamKey: '',
    };
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || link.session !== session) {
        return;
      }
      const init = candidate.toJSON() as CandidateInit;
      if (session.described) {
        this.send(link.rtcId, { kind: 'candidate', session: id, candidate: init });
      } else if (session.outgoing.length < MAX_PENDING_CANDIDATES) {
        session.outgoing.push(init);
      }
    };
    pc.ontrack = ({ track, receiver }) => {
      if (track.kind === 'audio') {
        setAudioJitterTarget(receiver);
      }
      this.refreshStream(link, session);
    };
    pc.onconnectionstatechange = () => this.onStateChange(link, session);
    pc.oniceconnectionstatechange = () => {
      if (link.session === session) {
        note(link, pc.iceConnectionState);
      }
      this.onStateChange(link, session);
    };
    link.session = session;
    link.connected = false;
    link.notConnectedSince = now;
    link.disconnectedSince = null;
    link.counters = null;
    link.healthySince = null;
    return session;
  }

  /** Ponúkajúci: nové spojenie s pevnými transceivermi a ponuka hneď (aj bez lokálnych stôp). */
  private startSession(link: Link, recovery: boolean): void {
    this.closeSession(link);
    if (recovery) {
      note(link, 'session');
    }
    link.pendingReset = false;
    const session = this.createSession(link, newSessionId());
    const stream = this.input.localStream;
    const init = (): RTCRtpTransceiverInit => ({ direction: 'sendrecv', streams: stream ? [stream] : [] });
    session.audio = session.pc.addTransceiver(liveTrack(stream, 'audio') ?? 'audio', init()).sender;
    session.video = session.pc.addTransceiver(liveTrack(stream, 'video') ?? 'video', init()).sender;
    this.refreshStream(link, session);
    this.enqueue(link, () => this.sendOffer(link, session, false));
  }

  private async sendOffer(link: Link, session: Session, iceRestart: boolean): Promise<void> {
    if (link.session !== session) {
      return;
    }
    const offer = await session.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (link.session !== session) {
      return;
    }
    await session.pc.setLocalDescription(offer);
    if (link.session !== session) {
      return;
    }
    this.send(link.rtcId, { kind: 'description', session: session.id, description: { type: 'offer', sdp: offer.sdp } });
    this.flushOutgoing(link, session);
  }

  private flushOutgoing(link: Link, session: Session): void {
    session.described = true;
    for (const candidate of session.outgoing.splice(0)) {
      this.send(link.rtcId, { kind: 'candidate', session: session.id, candidate });
    }
  }

  private async flushIncoming(session: Session): Promise<void> {
    for (const candidate of session.incoming.splice(0)) {
      await session.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private closeSession(link: Link): void {
    const session = link.session;
    if (!session) {
      return;
    }
    link.session = null;
    link.connected = false;
    link.counters = null;
    const { pc } = session;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      // Už zatvorené.
    }
    if (session.stream && this.streams.get(link.peer.playerId) === session.stream) {
      this.streams.delete(link.peer.playerId);
      this.publishStreams();
    }
  }

  private closeLink(link: Link): void {
    link.closed = true;
    this.closeSession(link);
    this.links.delete(link.rtcId);
  }

  private closeAll(): void {
    for (const link of [...this.links.values()]) {
      this.closeLink(link);
    }
    if (this.streams.size) {
      this.streams.clear();
      this.publishStreams();
    }
  }

  private onStateChange(link: Link, session: Session): void {
    if (link.session !== session) {
      return;
    }
    const now = performance.now();
    const state = connectionState(session.pc);
    if (state === 'connected') {
      if (!link.connected) {
        link.connected = true;
        // Tok zvuku sa meria až od pripojenia.
        link.inbound = initialFlow(now);
        link.outbound = initialFlow(now);
        if (session.audio && session.video) {
          void capVideo(session.audio, session.video, this.links.size, link.relayed);
        }
      }
    } else if (link.connected) {
      link.connected = false;
      link.notConnectedSince = now;
    }
    link.disconnectedSince = session.pc.iceConnectionState === 'disconnected' ? (link.disconnectedSince ?? now) : null;
  }

  /** Vzdialený stream z prijímačov (nie z `event.streams` — druhá strana nemusí stream oznamovať). */
  private refreshStream(link: Link, session: Session): void {
    if (link.session !== session) {
      return;
    }
    const tracks = session.pc
      .getReceivers()
      .map((receiver) => receiver.track)
      .filter((track): track is MediaStreamTrack => !!track && track.readyState === 'live');
    const key = tracks
      .map((track) => track.id)
      .sort()
      .join('|');
    if (!tracks.length || key === session.streamKey) {
      return;
    }
    session.streamKey = key;
    session.stream = new MediaStream(tracks);
    this.streams.set(link.peer.playerId, session.stream);
    this.publishStreams();
  }

  private publishStreams(): void {
    this.onStreams(new Map(this.streams));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Signalizácia
  // -------------------------------------------------------------------------------------------------------------------

  private send(to: string, data: RtcPayload): void {
    // Bez spojenia so serverom by Socket.IO správu poslal až po reconnecte — pod novým socket id, teda zastaranú.
    if (!socket.connected) {
      return;
    }
    socket.timeout(SIGNAL_ACK_MS).emit('rtc:signal', { to, data }, (error: Error | null, response?: Ack) => {
      if (error || !response?.ok) {
        const link = this.links.get(to);
        const last = link?.events.at(-1);
        // Jedna udalosť za dávku chýb (kandidáti idú po desiatkach).
        if (link && !(last?.kind === 'signal-error' && performance.now() - last.at < 1000)) {
          note(link, 'signal-error');
        }
      }
    });
  }

  private enqueue(link: Link, task: () => Promise<void>): void {
    link.chain = link.chain.then(task).catch((error: unknown) => {
      if (!link.closed) {
        console.warn('mesh signaling failed', error);
      }
    });
  }

  /** Volá inbox; `false` = správu zatiaľ nevieme spracovať (odosielateľ ešte nie je v stave stola) → ostane v bufferi. */
  private readonly onSignal = (from: string, data: RtcPayload): boolean => {
    const link = this.links.get(from);
    if (!this.running || !link) {
      return false;
    }
    this.enqueue(link, () => this.handleSignal(link, data));
    return true;
  };

  /** Prehrá signály, ktoré čakali v bufferi; vráti protihráčov, od ktorých prišiel popis spojenia. */
  private drain(): Set<string> {
    const described = new Set<string>();
    for (const { from, data } of drainSignals((from) => this.links.has(from))) {
      if (data.kind === 'description') {
        described.add(from);
      }
      this.onSignal(from, data);
    }
    return described;
  }

  private async handleSignal(link: Link, data: RtcPayload): Promise<void> {
    if (link.closed) {
      return;
    }
    if (data.kind === 'reset') {
      this.handleReset(link);
      return;
    }
    if (typeof data.session !== 'string') {
      return;
    }
    if (data.kind === 'candidate') {
      await this.handleCandidate(link, data.session, data.candidate);
      return;
    }
    const { type, sdp } = data.description;
    if (type === 'offer' && link.role === 'answerer') {
      await this.handleOffer(link, data.session, sdp);
    } else if (type === 'answer' && link.role === 'offerer') {
      await this.handleAnswer(link, data.session, sdp);
    }
  }

  private async handleOffer(link: Link, sessionId: string, sdp: string | undefined): Promise<void> {
    let session = link.session;
    if (!session || offerAction(session.id, sessionId) === 'replace') {
      this.closeSession(link);
      session = this.createSession(link, sessionId);
    }
    const { pc } = session;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    if (link.session !== session) {
      return;
    }
    // Prijaté transceivery: posielať aj prijímať, s mojimi aktuálnymi stopami (alebo zatiaľ bez nich).
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track?.kind;
      if (kind === 'audio' && !session.audio) {
        session.audio = transceiver.sender;
      } else if (kind === 'video' && !session.video) {
        session.video = transceiver.sender;
      } else {
        continue;
      }
      try {
        if (transceiver.direction !== 'sendrecv') {
          transceiver.direction = 'sendrecv';
        }
      } catch (error) {
        console.warn('transceiver direction failed', error);
      }
    }
    await this.applyTracks(link, session);
    const stream = this.input.localStream;
    for (const sender of [session.audio, session.video]) {
      const withStreams = sender as (RTCRtpSender & { setStreams?: (...streams: MediaStream[]) => void }) | null;
      if (stream && withStreams?.setStreams) {
        try {
          withStreams.setStreams(stream);
        } catch {
          // Nepodporované — druhá strana si stream aj tak skladá z prijímačov.
        }
      }
    }
    if (link.session !== session) {
      return;
    }
    const answer = await pc.createAnswer();
    if (link.session !== session) {
      return;
    }
    await pc.setLocalDescription(answer);
    if (link.session !== session) {
      return;
    }
    this.send(link.rtcId, { kind: 'description', session: session.id, description: { type: 'answer', sdp: answer.sdp } });
    this.flushOutgoing(link, session);
    await this.flushIncoming(session);
    this.refreshStream(link, session);
  }

  private async handleAnswer(link: Link, sessionId: string, sdp: string | undefined): Promise<void> {
    const session = link.session;
    if (!session || !belongsToSession(session.id, sessionId) || session.pc.signalingState !== 'have-local-offer') {
      return;
    }
    await session.pc.setRemoteDescription({ type: 'answer', sdp });
    if (link.session !== session) {
      return;
    }
    await this.flushIncoming(session);
    this.refreshStream(link, session);
  }

  private async handleCandidate(link: Link, sessionId: string, candidate: CandidateInit): Promise<void> {
    const session = link.session;
    if (!session || !belongsToSession(session.id, sessionId)) {
      return;
    }
    if (!session.pc.remoteDescription) {
      if (session.incoming.length < MAX_PENDING_CANDIDATES) {
        session.incoming.push(candidate);
      }
      return;
    }
    await session.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  /** Ponúkajúci: odpovedajúci žiada novú ponuku (nemá spojenie, alebo mu netečie zvuk). */
  private handleReset(link: Link): void {
    if (link.role !== 'offerer') {
      return;
    }
    note(link, 'reset');
    const action = resetAction(link.session?.startedAt ?? null, link.limiter, performance.now());
    if (action === 'now') {
      this.recover(link, null);
    } else if (action === 'later') {
      link.pendingReset = true;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Watchdog
  // -------------------------------------------------------------------------------------------------------------------

  /** Obnova spojenia: ponúkajúci začne novú reláciu, odpovedajúci požiada o novú ponuku. */
  private recover(link: Link, reason: RecoveryReason | null): boolean {
    if (!link.limiter.tryAttempt(performance.now())) {
      return false;
    }
    if (reason) {
      note(link, reason);
    }
    if (link.role === 'offerer') {
      this.startSession(link, true);
    } else {
      note(link, 'reset');
      this.send(link.rtcId, { kind: 'reset', reason: reason ?? undefined });
    }
    return true;
  }

  private localMicSending(session: Session | null): boolean {
    const track = liveTrack(this.input.localStream, 'audio');
    // Push-to-talk (nestlačený kláves) = stopa `enabled = false` — vtedy sa odchádzajúci zvuk nekontroluje.
    return !!track && track.enabled && session?.audio?.track === track;
  }

  private async watchdog(): Promise<void> {
    if (!this.running || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.watchdogTick();
    } finally {
      this.ticking = false;
    }
  }

  private async watchdogTick(): Promise<void> {
    this.drain();
    const now = performance.now();
    // Karta bola zamrznutá (telefón na pozadí, priškrtené časovače) — ticho zvuku sa meria odznova.
    const frozen = now - this.lastTick > WATCHDOG_MS * 3;
    this.lastTick = now;
    const hidden = document.visibilityState === 'hidden';
    const links = [...this.links.values()];
    const packets = await Promise.all(
      links.map((link) => (link.connected && link.session ? withTimeout(readAudioPackets(link.session.pc), WATCHDOG_MS) : Promise.resolve(null))),
    );
    if (!this.running) {
      return;
    }
    const at = performance.now();
    links.forEach((link, index) => {
      if (link.closed) {
        return;
      }
      const session = link.session;
      if (frozen) {
        link.inbound = rebaseFlow(link.inbound, at);
        link.outbound = rebaseFlow(link.outbound, at);
      }
      const reading = packets[index];
      if (link.connected && reading) {
        link.inbound = trackFlow(link.inbound, reading.inbound, link.peer.microphone, at);
        link.outbound = trackFlow(link.outbound, reading.outbound, this.localMicSending(session), at);
      }
      const snapshot: LinkSnapshot = {
        role: link.role,
        hasSession: !!session,
        state: session ? connectionState(session.pc) : 'new',
        notConnectedSince: link.notConnectedSince,
        disconnectedSince: link.disconnectedSince,
        iceRestartAt: session?.iceRestartAt ?? null,
        inbound: link.inbound,
        outbound: link.outbound,
        hidden,
      };
      if (isHealthy(snapshot, at)) {
        link.healthySince ??= at;
        if (at - link.healthySince > HEALTHY_MS) {
          link.limiter.markHealthy();
        }
      } else {
        link.healthySince = null;
      }
      if (link.pendingReset && link.role === 'offerer' && link.limiter.canAttempt(at)) {
        link.pendingReset = false;
        if (this.recover(link, null)) {
          return;
        }
      }
      const decision = decide(snapshot, at);
      if (decision.kind === 'ice-restart' && session) {
        session.iceRestartAt = at;
        note(link, 'restart');
        this.enqueue(link, () => this.sendOffer(link, session, true));
      } else if (decision.kind === 'recover') {
        this.recover(link, decision.reason);
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Štatistiky pre /stats
  // -------------------------------------------------------------------------------------------------------------------

  /** Diagnostika: cesta spojenia, RTT, straty, udalosti obnovy — celá vzorka ide na server pre /stats. */
  private async sampleStats(): Promise<void> {
    const links = [...this.links.values()];
    if (!this.running || links.length === 0) {
      return;
    }
    const samples = await Promise.all(
      links.map(async (link): Promise<NetLinkSample> => {
        const now = performance.now();
        const events = link.events.splice(0).map((event) => ({ ageMs: Math.round(now - event.at), kind: event.kind }));
        const session = link.session;
        const base: NetLinkSample = { to: link.peer.playerId, state: session ? session.pc.iceConnectionState : 'new', events: events.length ? events : undefined };
        if (!session || connectionState(session.pc) !== 'connected') {
          link.counters = null;
          return base;
        }
        const reading = await readLink(session.pc, link.counters).catch(() => null);
        if (!reading || link.session !== session) {
          return base;
        }
        link.counters = reading.counters;
        const relayed = slowRelay(reading.link, this.input.iceServers);
        if (relayed !== link.relayed) {
          link.relayed = relayed;
          if (session.audio && session.video) {
            void capVideo(session.audio, session.video, this.links.size, relayed);
          }
        }
        return { ...base, ...reading.link };
      }),
    );
    if (!this.running || !socket.connected) {
      return;
    }
    const tracks = this.input.localStream?.getTracks() ?? [];
    const live = (kind: string) => tracks.some((track) => track.kind === kind && track.enabled && track.readyState === 'live');
    const sample: NetSample = {
      serverRttMs: this.serverRttMs,
      hidden: document.visibilityState === 'hidden',
      camera: live('video'),
      microphone: live('audio'),
      connection: connectionInfo(),
      links: samples,
    };
    const sentAt = performance.now();
    socket.timeout(NET_SAMPLE_MS).emit('net:stats', sample, (error: Error | null) => {
      this.serverRttMs = error ? NET_SAMPLE_MS : Math.round(performance.now() - sentAt);
    });
  }
}
