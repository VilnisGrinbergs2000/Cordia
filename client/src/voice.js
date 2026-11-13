import { useEffect, useRef, useState } from 'react';
import { openCamera, openMicrophone } from './audioPrefs';
import { getIceConfig, loadIceServers } from './ice';

const SCREEN_QUALITIES = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 }
};

const SCREEN_FPS_OPTIONS = [15, 30, 60];

function readPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // storage can be unavailable
  }
}

export function useVoice(socket) {
  const [channel, setChannel] = useState(null);
  const [participants, setParticipants] = useState({});
  const [streams, setStreams] = useState({});
  const [localStream, setLocalStream] = useState(null);
  const [localVideo, setLocalVideo] = useState(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [speaking, setSpeaking] = useState({});
  const [screenQuality, setScreenQualityState] = useState(() => {
    const stored = readPreference('cordia:screen-quality', '720p');
    return SCREEN_QUALITIES[stored] ? stored : '720p';
  });
  const [screenFps, setScreenFpsState] = useState(() => {
    const stored = Number(readPreference('cordia:screen-fps', '30'));
    return SCREEN_FPS_OPTIONS.includes(stored) ? stored : 30;
  });
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const [screenPickerSources, setScreenPickerSources] = useState([]);
  const [screenPickerLoading, setScreenPickerLoading] = useState(false);
  const [screenPickerError, setScreenPickerError] = useState('');

  const pcs = useRef(new Map());
  const analysers = useRef(new Map());
  const audioCtxRef = useRef(null);
  const localStreamRef = useRef(null);
  const micCleanupRef = useRef(null);
  const joinTokenRef = useRef(0);
  const channelRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const mutedRef = useRef(false);
  const cameraRef = useRef(false);
  const sharingRef = useRef(false);
  const screenQualityRef = useRef(screenQuality);
  const screenFpsRef = useRef(screenFps);
  const screenPickerResolverRef = useRef(null);
  const screenPickerOpenRef = useRef(false);
  // The channel currently on screen, published by the shell: the stage page
  // joins from its own button and only knows the channel id.
  const channelContextRef = useRef(null);

  useEffect(() => {
    loadIceServers();
  }, []);

  function emitState() {
    if (!socket) return;
    socket.emit('voice:state', {
      muted: mutedRef.current,
      video: cameraRef.current || sharingRef.current,
      sharing: sharingRef.current
    });
  }

  function setSpeakingFor(key, value) {
    if (!key) return;
    setSpeaking((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }

  function detachAnalyser(key) {
    const entry = analysers.current.get(key);
    if (entry) {
      clearInterval(entry.timer);
      try {
        entry.source.disconnect();
      } catch {
        // ignore
      }
      analysers.current.delete(key);
    }
    setSpeaking((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function attachAnalyser(stream, key) {
    if (!key || !stream || !stream.getAudioTracks?.().length) return;
    const existing = analysers.current.get(key);
    if (existing?.stream === stream) return;
    detachAnalyser(key);
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let lastSpoken = 0;
      const timer = setInterval(() => {
        if (key === socket?.id && mutedRef.current) {
          lastSpoken = 0;
          setSpeakingFor(key, false);
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) {
          const value = (data[index] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        if (rms > 0.045) lastSpoken = now;
        setSpeakingFor(key, now - lastSpoken < 380);
      }, 110);
      analysers.current.set(key, { stream, source, timer });
    } catch {
      // analysis is optional
    }
  }

  function detachAllAnalysers() {
    for (const key of [...analysers.current.keys()]) detachAnalyser(key);
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setSpeaking({});
  }

  function screenPreset() {
    return SCREEN_QUALITIES[screenQualityRef.current] || SCREEN_QUALITIES['720p'];
  }

  function hasDesktopScreenPicker() {
    return Boolean(
      window.cordiaDesktop?.listDisplaySources &&
        window.cordiaDesktop?.selectDisplaySource
    );
  }

  function resetScreenPicker() {
    screenPickerOpenRef.current = false;
    setScreenPickerOpen(false);
    setScreenPickerLoading(false);
    setScreenPickerSources([]);
    setScreenPickerError('');
  }

  function closeScreenPicker() {
    const resolve = screenPickerResolverRef.current;
    screenPickerResolverRef.current = null;
    resetScreenPicker();
    window.cordiaDesktop?.clearDisplaySource?.().catch(() => {});
    resolve?.(null);
  }

  async function openScreenPicker() {
    if (screenPickerOpenRef.current) return null;

    screenPickerOpenRef.current = true;
    setScreenPickerOpen(true);
    setScreenPickerSources([]);
    setScreenPickerError('');
    setScreenPickerLoading(hasDesktopScreenPicker());

    const choice = new Promise((resolve) => {
      screenPickerResolverRef.current = resolve;
    });

    if (!hasDesktopScreenPicker()) return choice;

    try {
      const sources = await window.cordiaDesktop.listDisplaySources();
      if (!screenPickerResolverRef.current) return null;
      const list = Array.isArray(sources) ? sources : [];
      setScreenPickerSources(list);
      if (!list.length) setScreenPickerError('No screens or windows were found.');
    } catch {
      if (screenPickerResolverRef.current) {
        setScreenPickerError('Could not list screens and windows.');
      }
    } finally {
      if (screenPickerResolverRef.current) setScreenPickerLoading(false);
    }

    return choice;
  }

  async function chooseScreenSource(sourceId) {
    const resolve = screenPickerResolverRef.current;
    if (!resolve) return;
    if (!sourceId) {
      closeScreenPicker();
      return;
    }

    screenPickerResolverRef.current = null;
    resetScreenPicker();

    if (sourceId === 'native' || !hasDesktopScreenPicker()) {
      resolve('native');
      return;
    }

    try {
      const selected = await window.cordiaDesktop.selectDisplaySource(sourceId);
      if (!selected) {
        window.cordiaDesktop?.clearDisplaySource?.().catch(() => {});
      }
      resolve(selected ? sourceId : null);
    } catch {
      resolve(null);
    }
  }

  function screenMaxBitrate() {
    const preset = screenPreset();
    const pixelRate = preset.width * preset.height * screenFpsRef.current;
    // 1080p60 needs roughly 10-12 Mbps to stay readable; the old 8 Mbps cap
    // was the real reason high frame rates looked soft. 12 Mbps is still far
    // below what a LAN or a normal home uplink carries.
    return Math.min(12_000_000, Math.max(900_000, Math.round(pixelRate * 0.09)));
  }

  async function applyVideoSenderLimits(pc) {
    if (!pc?.__videoSender) return;
    try {
      const parameters = pc.__videoSender.getParameters();
      if (!parameters.encodings?.length) return;
      const isScreen = sharingRef.current;
      parameters.encodings[0].maxBitrate = isScreen ? screenMaxBitrate() : 2_000_000;
      if (isScreen) parameters.encodings[0].maxFramerate = screenFpsRef.current;
      // Screen content is text: dropping resolution to keep the frame rate is
      // exactly backwards, because a 30 fps readable screen beats a 60 fps
      // blurry one.
      parameters.degradationPreference = isScreen ? 'maintain-resolution' : 'balanced';
      await pc.__videoSender.setParameters(parameters);
    } catch {
      // parameters can be unavailable until negotiation completes
    }
  }

  function applyAllVideoLimits() {
    for (const pc of pcs.current.values()) applyVideoSenderLimits(pc);
  }

  async function applyScreenConstraints() {
    const track = screenTrackRef.current;
    if (!track) return;
    const preset = screenPreset();
    try {
      await track.applyConstraints({
        width: { max: preset.width, ideal: preset.width },
        height: { max: preset.height, ideal: preset.height },
        frameRate: { max: screenFpsRef.current, ideal: screenFpsRef.current }
      });
    } catch {
      // some capture sources do not support live constraint changes
    }
  }

  function setScreenQuality(value) {
    if (!SCREEN_QUALITIES[value] || value === screenQualityRef.current) return;
    screenQualityRef.current = value;
    setScreenQualityState(value);
    writePreference('cordia:screen-quality', value);
    if (sharingRef.current) {
      applyScreenConstraints();
      applyAllVideoLimits();
    }
  }

  function setScreenFps(value) {
    const fps = Number(value);
    if (!SCREEN_FPS_OPTIONS.includes(fps) || fps === screenFpsRef.current) return;
    screenFpsRef.current = fps;
    setScreenFpsState(fps);
    writePreference('cordia:screen-fps', fps);
    if (sharingRef.current) {
      applyScreenConstraints();
      applyAllVideoLimits();
    }
  }

  function negotiatePeer(peerId) {
    const pc = pcs.current.get(peerId);
    if (!pc || pc.signalingState !== 'stable' || !socket) return;
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('webrtc:signal', {
          to: peerId,
          data: { type: 'offer', sdp: pc.localDescription }
        });
      })
      .catch(() => {});
  }

  function createPeer(peerId) {
    const existing = pcs.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection(getIceConfig());
    pcs.current.set(peerId, pc);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
      const activeVideo = screenTrackRef.current || cameraTrackRef.current;
      if (activeVideo) {
        pc.__videoSender = pc.addTrack(activeVideo, localStreamRef.current);
        applyVideoSenderLimits(pc);
      }
    } else if (channelRef.current?.listener) {
      // A stage listener has no local track, but still needs an audio m-line or
      // the offer would carry no media and the speakers would be silent.
      try {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch {
        // older browsers: fall back to no media section
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') applyVideoSenderLimits(pc);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('webrtc:signal', {
          to: peerId,
          data: { type: 'candidate', candidate: event.candidate }
        });
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0];
      if (stream) {
        setStreams((prev) => (prev[peerId] === stream ? prev : { ...prev, [peerId]: stream }));
        attachAnalyser(stream, peerId);
      }
    };
    return pc;
  }

  function closePeer(peerId) {
    const pc = pcs.current.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      pcs.current.delete(peerId);
    }
    detachAnalyser(peerId);
    setStreams((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }

  function cleanup(emitLeave) {
    joinTokenRef.current += 1;
    if (emitLeave && socket && channelRef.current) socket.emit('voice:leave');
    detachAllAnalysers();
    for (const [peerId, pc] of pcs.current) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      pcs.current.delete(peerId);
    }
    if (micCleanupRef.current) {
      micCleanupRef.current();
      micCleanupRef.current = null;
    } else if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (cameraStreamRef.current) cameraStreamRef.current.getTracks().forEach((track) => track.stop());
    else if (cameraTrackRef.current) cameraTrackRef.current.stop();
    if (screenTrackRef.current) screenTrackRef.current.stop();
    localStreamRef.current = null;
    channelRef.current = null;
    cameraStreamRef.current = null;
    cameraTrackRef.current = null;
    screenTrackRef.current = null;
    mutedRef.current = false;
    cameraRef.current = false;
    sharingRef.current = false;
    if (screenPickerResolverRef.current) closeScreenPicker();

    setChannel(null);
    setParticipants({});
    setStreams({});
    setLocalStream(null);
    setLocalVideo(null);
    setMuted(false);
    setDeafened(false);
    setCameraOn(false);
    setSharing(false);
    setConnecting(false);
  }

  function setChannelContext(context) {
    channelContextRef.current = context || null;
  }

  async function join(target) {
    if (!socket) return;
    if (channelRef.current && channelRef.current.id === target.id) return;
    cleanup(!!channelRef.current);
    const token = joinTokenRef.current;
    setConnecting(true);
    setError('');
    // A stage is a room with an audience: only speakers hold a microphone, so a
    // listener joins without getUserMedia and is muted from the first frame.
    const context = channelContextRef.current?.id === target.id ? channelContextRef.current : null;
    const channelType = target?.type || context?.type || null;
    const canSpeak = target?.canSpeak ?? context?.canSpeak ?? true;
    const listener = channelType === 'stage' && !canSpeak;
    try {
      await loadIceServers();
      let stream = null;
      if (listener) {
        mutedRef.current = true;
        setMuted(true);
      } else {
        const mic = await openMicrophone();
        if (joinTokenRef.current !== token) {
          mic.cleanup();
          return;
        }
        micCleanupRef.current = mic.cleanup;
        stream = mic.stream;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      if (stream && socket?.id) attachAnalyser(stream, socket.id);
      channelRef.current = {
        id: target.id,
        name: target.name,
        serverId: target.serverId,
        type: channelType,
        listener
      };
      setChannel(channelRef.current);
      socket.emit('voice:join', { channelId: target.id });
      if (listener) emitState();
    } catch {
      if (joinTokenRef.current === token) {
        setError(
          listener
            ? 'Could not join this stage.'
            : 'Microphone access is required to join voice.'
        );
      }
    } finally {
      if (joinTokenRef.current === token) setConnecting(false);
    }
  }

  function leave() {
    cleanup(true);
    setError('');
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
    }
    if (next) setSpeakingFor(socket?.id, false);
    emitState();
  }

  function toggleDeafen() {
    setDeafened((value) => !value);
  }

  async function applyOutgoingVideo(track) {
    for (const [peerId, pc] of pcs.current) {
      try {
        if (pc.__videoSender) {
          await pc.__videoSender.replaceTrack(track || null);
        } else if (track) {
          pc.__videoSender = pc.addTrack(track, localStreamRef.current || new MediaStream());
          if (pc.signalingState === 'stable') negotiatePeer(peerId);
        }
        await applyVideoSenderLimits(pc);
      } catch {
        // ignore
      }
    }
  }

  async function toggleCamera() {
    if (!channelRef.current) return;
    if (cameraRef.current) {
      cameraRef.current = false;
      setCameraOn(false);
      const stream = cameraStreamRef.current;
      const track = cameraTrackRef.current;
      cameraStreamRef.current = null;
      cameraTrackRef.current = null;
      if (stream) stream.getTracks().forEach((item) => item.stop());
      else if (track) track.stop();
      setLocalVideo(null);
      await applyOutgoingVideo(null);
      emitState();
      return;
    }

    if (sharingRef.current) {
      sharingRef.current = false;
      setSharing(false);
      const shared = screenTrackRef.current;
      screenTrackRef.current = null;
      if (shared) shared.stop();
      setLocalVideo(null);
    }

    try {
      const camera = await openCamera({ width: 1280, height: 720 });
      const track = camera.getVideoTracks()[0];
      cameraStreamRef.current = camera;
      cameraTrackRef.current = track;
      cameraRef.current = true;
      setCameraOn(true);
      setLocalVideo(new MediaStream([track]));
      track.onended = () => {
        if (cameraTrackRef.current === track) {
          cameraStreamRef.current = null;
          cameraTrackRef.current = null;
          cameraRef.current = false;
          setCameraOn(false);
          setLocalVideo(null);
          applyOutgoingVideo(null);
          emitState();
        }
      };
      await applyOutgoingVideo(track);
      emitState();
    } catch {
      setError('Camera access is unavailable.');
    }
  }

  function stopScreen() {
    const track = screenTrackRef.current;
    screenTrackRef.current = null;
    if (track) track.stop();
    sharingRef.current = false;
    setSharing(false);
    setLocalVideo(null);
    applyOutgoingVideo(null);
    emitState();
  }

  async function toggleScreen() {
    if (!channelRef.current) return;
    if (sharingRef.current) {
      stopScreen();
      return;
    }

    const pickedSource = await openScreenPicker();
    if (!pickedSource) return;

    if (cameraRef.current) {
      cameraRef.current = false;
      setCameraOn(false);
      const cameraStream = cameraStreamRef.current;
      const cameraTrack = cameraTrackRef.current;
      cameraStreamRef.current = null;
      cameraTrackRef.current = null;
      if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
      else if (cameraTrack) cameraTrack.stop();
      setLocalVideo(null);
    }

    try {
      const preset = screenPreset();
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: preset.width, max: preset.width },
          height: { ideal: preset.height, max: preset.height },
          frameRate: { ideal: screenFpsRef.current, max: screenFpsRef.current }
        },
        audio: false
      });
      const track = display.getVideoTracks()[0];
      track.contentHint = 'detail';
      screenTrackRef.current = track;
      sharingRef.current = true;
      setSharing(true);
      setLocalVideo(new MediaStream([track]));
      track.onended = () => {
        if (screenTrackRef.current === track) stopScreen();
      };
      await applyScreenConstraints();
      await applyOutgoingVideo(track);
      emitState();
    } catch {
      // user cancelled the picker
    } finally {
      if (pickedSource !== 'native') {
        window.cordiaDesktop?.clearDisplaySource?.().catch(() => {});
      }
    }
  }

  useEffect(() => {
    if (!socket?.id) return;
    setParticipants((prev) => {
      const current = prev[socket.id];
      if (!current) return prev;
      const video = cameraOn || sharing;
      if (current.muted === muted && current.video === video && current.sharing === sharing) {
        return prev;
      }
      return { ...prev, [socket.id]: { ...current, muted, video, sharing } };
    });
  }, [socket?.id, muted, cameraOn, sharing]);

  useEffect(() => {
    if (!socket) return undefined;

    function onParticipants(list) {
      const map = {};
      for (const participant of list) map[participant.socketId] = participant;
      setParticipants(map);
      for (const participant of list) {
        if (participant.socketId === socket.id) continue;
        const pc = createPeer(participant.socketId);
        if (pc.signalingState === 'stable') negotiatePeer(participant.socketId);
      }
    }

    function onPeerJoined(participant) {
      setParticipants((prev) => ({ ...prev, [participant.socketId]: participant }));
    }

    function onPeerLeft({ socketId }) {
      closePeer(socketId);
      setParticipants((prev) => {
        if (!(socketId in prev)) return prev;
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    }

    function onPeerState({ socketId, muted: peerMuted, video, sharing: peerSharing }) {
      setParticipants((prev) => {
        if (!prev[socketId]) return prev;
        return {
          ...prev,
          [socketId]: { ...prev[socketId], muted: peerMuted, video, sharing: peerSharing }
        };
      });
    }

    async function onSignal({ from, data }) {
      if (!data) return;
      const pc = pcs.current.get(from) || createPeer(from);
      try {
        if (data.type === 'offer') {
          if (pc.signalingState !== 'stable') {
            try {
              await pc.setLocalDescription({ type: 'rollback' });
            } catch {
              // ignore rollback errors
            }
          }
          await pc.setRemoteDescription(data.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('webrtc:signal', { to: from, data: { type: 'answer', sdp: pc.localDescription } });
          if (cameraTrackRef.current || screenTrackRef.current) {
            setTimeout(() => {
              if (pcs.current.get(from)?.signalingState === 'stable') negotiatePeer(from);
            }, 700);
          }
        } else if (data.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(data.sdp);
          }
        } else if (data.type === 'candidate') {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch {
            // candidate may arrive early
          }
        }
      } catch {
        // ignore transient WebRTC errors
      }
    }

    function onForceMute(payload) {
      mutedRef.current = true;
      setMuted(true);
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }
      setSpeakingFor(socket.id, false);
      if (payload?.reason) setError(payload.reason);
      emitState();
    }

    function onVoiceError(payload) {
      cleanup(false);
      setError(payload?.error || 'Could not join voice.');
    }

    function onVoiceClosed() {
      cleanup(false);
      setError('The voice channel was closed.');
    }

    // A dropped socket used to end the call and leave the person to rejoin by
    // hand. socket.io reconnects on the same object, so the call is rebuilt
    // instead: the peers are gone either way, but the channel is not.
    function onDisconnect() {
      const target = channelRef.current;
      if (!target) return;
      cleanup(false);
      setError('Voice reconnecting...');
      const attempt = () => {
        if (!socket.connected) return;
        socket.off('connect', attempt);
        setError('');
        join(target);
      };
      socket.on('connect', attempt);
    }

    socket.on('voice:participants', onParticipants);
    socket.on('voice:peer-joined', onPeerJoined);
    socket.on('voice:peer-left', onPeerLeft);
    socket.on('voice:peer-state', onPeerState);
    socket.on('webrtc:signal', onSignal);
    socket.on('voice:force-mute', onForceMute);
    socket.on('voice:error', onVoiceError);
    socket.on('voice:closed', onVoiceClosed);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('voice:participants', onParticipants);
      socket.off('voice:peer-joined', onPeerJoined);
      socket.off('voice:peer-left', onPeerLeft);
      socket.off('voice:peer-state', onPeerState);
      socket.off('webrtc:signal', onSignal);
      socket.off('voice:force-mute', onForceMute);
      socket.off('voice:error', onVoiceError);
      socket.off('voice:closed', onVoiceClosed);
      socket.off('disconnect', onDisconnect);
      cleanup(false);
    };
  }, [socket]);

  return {
    channel,
    participants,
    streams,
    localStream,
    localVideo,
    muted,
    deafened,
    cameraOn,
    sharing,
    connecting,
    error,
    speaking,
    screenQuality,
    screenFps,
    setScreenQuality,
    setScreenFps,
    screenPickerOpen,
    screenPickerSources,
    screenPickerLoading,
    screenPickerError,
    screenPickerDesktop: hasDesktopScreenPicker(),
    chooseScreenSource,
    cancelScreenPicker: closeScreenPicker,
    setChannelContext,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreen,
    setError
  };
}
