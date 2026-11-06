import { useEffect, useRef, useState } from 'react';
import type { ClientConfig } from '../../../shared/types';
import { MeshController, type MeshPeer } from '../mesh/MeshController';

export type { MeshPeer } from '../mesh/MeshController';

/**
 * Hlas a video s ostatnými hráčmi (mesh sieť). Celá logika je v `MeshController`; hook mu len odovzdáva vstupy
 * a vracia vzdialené streamy podľa id hráča (video dlaždice, prehrávanie zvuku, indikátor hovorenia).
 */
export function useMesh(
  enabled: boolean,
  selfRtcId: string | null,
  peers: MeshPeer[],
  localStream: MediaStream | null,
  tracksVersion: number,
  iceServers: ClientConfig['iceServers'],
): { streams: Map<string, MediaStream> } {
  const [streams, setStreams] = useState(() => new Map<string, MediaStream>());
  const controllerRef = useRef<MeshController | null>(null);
  controllerRef.current ??= new MeshController(setStreams);
  const peerKey = peers
    .map((peer) => `${peer.rtcId}:${peer.playerId}:${peer.microphone ? 1 : 0}`)
    .sort()
    .join('|');
  const iceKey = JSON.stringify(iceServers);
  const latest = useRef({ peers, iceServers, localStream });
  latest.current = { peers, iceServers, localStream };

  useEffect(() => {
    const { peers: currentPeers, iceServers: currentIce, localStream: currentStream } = latest.current;
    controllerRef.current!.update({ enabled, selfId: selfRtcId, peers: currentPeers, localStream: currentStream, iceServers: currentIce });
  }, [enabled, selfRtcId, peerKey, iceKey, localStream, tracksVersion]);

  useEffect(() => {
    const controller = controllerRef.current!;
    return () => controller.stop();
  }, []);

  return { streams };
}
