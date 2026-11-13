import { useEffect, useRef, useState } from 'react';
import { openMicrophone } from './audioPrefs';
import { getIceConfig, loadIceServers } from './ice';
import { getSigningKey } from './e2ee';
import { signCallBinding, verifyCallBinding } from './ratchet';
import { useScreenPicker } from './screenSource';

function sdpFingerprint(sdp) {
  const match = /a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/i.exec(String(sdp || ''));
  return match ? `${match[1].toUpperCase()} ${match[2].toUpperCase()}` : '';
}

export function useCall(socket, meId) {
  const [call, setCall] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [remoteVideo, setRemoteVideo] = useState(false);
  const [localScreen, setLocalScreen] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [security, setSecurity] = useState('idle');
  const [securityNote, setSecurityNote] = useState('');
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState('');
  const callRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const micCleanupRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const sharingRef = useRef(false);
  const bindingRef = useRef(null);
  const callGenerationRef = useRef(0);
  const mutedRef = useRef(false);
  const noticeTimerRef = useRef(null);
  const picker = useScreenPicker();

  function update(next) {
    callRef.current = next;
    setCall(next);
  }

  function flashNotice(message) {
    clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 5200);
  }

  function resetSecurity() {
    bindingRef.current = null;
    setSecurity('idle');
    setSecurityNote('');
  }

  async function ensureMic() {
    if (localStreamRef.current) return localStreamRef.current;
    const generation = callGenerationRef.current;
    const mic = await openMicrophone();
    if (callGenerationRef.current !== generation || !callRef.current) {
      mic.cleanup();
      throw new Error('Call ended.');
    }
    micCleanupRef.current = mic.cleanup;
    localStreamRef.current = mic.stream;
    return mic.stream;
  }

  function stopScreen() {
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (sharingRef.current) {
      sharingRef.current = false;
      setSharing(false);
      setLocalScreen(null);
      if (callRef.current?.id && socket) {
        socket.emit('call:signal', { callId: callRef.current.id, data: { type: 'sharing', on: false } });
      }
    }
    const sender = pcRef.current?.__videoSender;
    if (sender) sender.replaceTrack(null).catch(() => {});
  }

  function teardown() {
    callGenerationRef.current += 1;
    stopScreen();
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    if (micCleanupRef.current) {
      micCleanupRef.current();
      micCleanupRef.current = null;
    } else if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    mutedRef.current = false;
    setMuted(false);
    setRemoteStream(null);
    setRemoteVideo(false);
    resetSecurity();
    if (picker.open) picker.cancel();
    update(null);
  }

  function publishFingerprint(pc) {
    const current = callRef.current;
    if (!socket || !current?.id || !pc?.localDescription) return;
    const fingerprint = sdpFingerprint(pc.localDescription.sdp);
    if (!fingerprint) return;
    const payload = { callId: current.id, userId: Number(meId) || 0, fingerprint };
    const signing = getSigningKey();
    signCallBinding(signing?.privateKey, payload)
      .then((signature) => {
        if (callRef.current?.id !== current.id) return;
        // An unsigned fingerprint is still useful: the other side learns that we
        // have no identity key, which is different from a signature that failed.
        socket.emit('call:signal', {
          callId: current.id,
          data: { type: 'dtls', fingerprint, signature, userId: payload.userId }
        });
      })
      .catch(() => {});
  }

  async function checkBinding(pc) {
    const peerBinding = bindingRef.current;
    const current = callRef.current;
    if (!peerBinding || !current?.peer?.id || !pc?.remoteDescription) return;
    const actual = sdpFingerprint(pc.remoteDescription.sdp);
    if (!actual) return;

    // The fingerprint we were told about must be the one actually negotiated.
    if (peerBinding.fingerprint !== actual) {
      setSecurity('failed');
      setSecurityNote('The call fingerprint does not match the negotiated one.');
      return;
    }

    const peerKey = current.peer.e2eeSigningPublicKey;
    if (!peerBinding.signature) {
      setSecurity('unverified');
      setSecurityNote('The other side could not sign this call.');
      return;
    }
    if (!peerKey) {
      setSecurity('unverified');
      setSecurityNote('This person has no encryption identity to verify against.');
      return;
    }

    const ok = await verifyCallBinding(
      peerKey,
      { callId: current.id, userId: current.peer.id, fingerprint: peerBinding.fingerprint },
      peerBinding.signature
    );
    if (callRef.current?.id !== current.id) return;
    setSecurity(ok ? 'verified' : 'failed');
    setSecurityNote(ok ? '' : 'The call signature did not verify.');
  }

  function createPeer() {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection(getIceConfig());
    pcRef.current = pc;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate || !socket || !callRef.current?.id) return;
      socket.emit('call:signal', {
        callId: callRef.current.id,
        data: { type: 'candidate', candidate: event.candidate }
      });
    };
    pc.ontrack = (event) => {
      const track = event.track;
      if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
      const stream = remoteStreamRef.current;
      if (!stream.getTracks().some((entry) => entry.id === track.id)) stream.addTrack(track);
      setRemoteStream(new MediaStream(stream.getTracks()));
      if (track.kind === 'video') {
        setRemoteVideo(true);
        track.onended = () => setRemoteVideo(false);
        track.onmute = () => setRemoteVideo(false);
        track.onunmute = () => setRemoteVideo(true);
      }
    };
    return pc;
  }

  async function sendOffer() {
    if (!socket || !callRef.current?.id) return;
    const pc = createPeer();
    const offer = await pc.createOffer();
    if (!callRef.current?.id) return;
    await pc.setLocalDescription(offer);
    socket.emit('call:signal', {
      callId: callRef.current.id,
      data: { type: 'offer', sdp: pc.localDescription }
    });
    publishFingerprint(pc);
  }

  async function renegotiate() {
    const pc = pcRef.current;
    if (!pc || !socket || !callRef.current?.id) return;
    if (pc.signalingState !== 'stable') {
      const retry = () => {
        if (pc.signalingState !== 'stable') return;
        pc.removeEventListener('signalingstatechange', retry);
        renegotiate();
      };
      pc.addEventListener('signalingstatechange', retry);
      return;
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!callRef.current?.id) return;
      socket.emit('call:signal', {
        callId: callRef.current.id,
        data: { type: 'offer', sdp: pc.localDescription }
      });
      publishFingerprint(pc);
    } catch {
      // negotiation can fail if the call ended mid-flight
    }
  }

  async function applyScreenLimits() {
    const sender = pcRef.current?.__videoSender;
    if (!sender) return;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = picker.maxBitrate();
      parameters.encodings[0].maxFramerate = picker.fps;
      parameters.degradationPreference = 'maintain-framerate';
      await sender.setParameters(parameters);
    } catch {
      // parameters can be unavailable until negotiation completes
    }
  }

  async function toggleScreen() {
    if (sharingRef.current) {
      stopScreen();
      return;
    }
    const pc = pcRef.current;
    if (!pc || !callRef.current) return;

    const choice = await picker.request();
    if (!choice) return;

    try {
      const display = await navigator.mediaDevices.getDisplayMedia(picker.constraints());
      const track = display.getVideoTracks()[0];
      if (!track) return;
      track.contentHint = 'detail';
      screenStreamRef.current = display;
      track.onended = () => stopScreen();

      let needsRenegotiate = false;
      if (pc.__videoSender) {
        await pc.__videoSender.replaceTrack(track);
      } else {
        pc.__videoSender = pc.addTrack(track, display);
        needsRenegotiate = true;
      }

      sharingRef.current = true;
      setSharing(true);
      setLocalScreen(new MediaStream([track]));
      if (callRef.current?.id) {
        socket.emit('call:signal', { callId: callRef.current.id, data: { type: 'sharing', on: true } });
      }
      if (needsRenegotiate) await renegotiate();
      await applyScreenLimits();
    } catch {
      // the user cancelled the picker
    } finally {
      if (choice !== 'native') window.cordiaDesktop?.clearDisplaySource?.().catch(() => {});
    }
  }

  async function startCall(peer) {
    if (callRef.current) {
      flashNotice('You are already in a call.');
      return;
    }
    if (!socket || !peer?.id) return;
    resetSecurity();
    update({ id: null, peer, direction: 'outgoing', status: 'outgoing', startedAt: Date.now() });
    try {
      await loadIceServers();
      await ensureMic();
    } catch {
      if (!callRef.current || callRef.current.direction !== 'outgoing') return;
      teardown();
      flashNotice('Microphone access is required to make a call.');
      return;
    }
    if (!callRef.current || callRef.current.direction !== 'outgoing') return;
    socket.emit('call:start', { userId: peer.id });
  }

  async function accept() {
    const current = callRef.current;
    if (!socket || !current || current.status !== 'incoming') return;
    try {
      await loadIceServers();
      await ensureMic();
    } catch {
      if (!callRef.current || callRef.current.id !== current.id) return;
      socket.emit('call:decline', { callId: current.id });
      teardown();
      flashNotice('Microphone access is required to accept a call.');
      return;
    }
    if (!callRef.current || callRef.current.id !== current.id) return;
    createPeer();
    update({ ...current, status: 'active', startedAt: Date.now() });
    socket.emit('call:accept', { callId: current.id });
  }

  function decline() {
    const current = callRef.current;
    if (!current) return;
    if (current.id && socket) socket.emit('call:decline', { callId: current.id });
    teardown();
  }

  function end() {
    const current = callRef.current;
    if (!current) return;
    if (current.id && socket) socket.emit('call:end', { callId: current.id });
    teardown();
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
  }

  useEffect(() => {
    if (!socket) return undefined;

    function onRinging(payload) {
      const current = callRef.current;
      if (!current || current.direction !== 'outgoing') return;
      update({
        ...current,
        id: payload.callId,
        peer: payload.peer || current.peer,
        status: 'outgoing',
        startedAt: payload.startedAt || current.startedAt
      });
    }

    function onIncoming(payload) {
      if (callRef.current) {
        socket.emit('call:decline', { callId: payload.callId });
        return;
      }
      resetSecurity();
      update({
        id: payload.callId,
        peer: payload.from,
        direction: 'incoming',
        status: 'incoming',
        startedAt: payload.startedAt || Date.now()
      });
    }

    function onAccepted(payload) {
      const current = callRef.current;
      if (!current || current.id !== payload.callId) return;
      update({
        ...current,
        peer: payload.peer || current.peer,
        status: 'active',
        startedAt: payload.startedAt || Date.now()
      });
      ensureMic()
        .then(() => sendOffer())
        .catch(() => {
          if (!callRef.current) return;
          flashNotice('Could not open your microphone.');
          if (callRef.current.id) socket.emit('call:end', { callId: callRef.current.id });
          teardown();
        });
    }

    function onHandled(payload) {
      if (callRef.current?.id === payload.callId && callRef.current.direction === 'incoming') {
        teardown();
      }
    }

    async function handleSignal(data) {
      if (!data) return;
      const pc = pcRef.current || createPeer();
      try {
        if (data.type === 'offer') {
          if (pc.signalingState !== 'stable') {
            try {
              await pc.setLocalDescription({ type: 'rollback' });
            } catch {
              // rollback is best effort
            }
          }
          await pc.setRemoteDescription(data.sdp);
          await checkBinding(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (callRef.current?.id) {
            socket.emit('call:signal', {
              callId: callRef.current.id,
              data: { type: 'answer', sdp: pc.localDescription }
            });
          }
          publishFingerprint(pc);
        } else if (data.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(data.sdp);
            await checkBinding(pc);
          }
        } else if (data.type === 'candidate') {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch {
            // candidate may arrive before the remote description
          }
        } else if (data.type === 'dtls') {
          bindingRef.current = {
            fingerprint: data.fingerprint,
            signature: data.signature,
            userId: data.userId
          };
          await checkBinding(pc);
        } else if (data.type === 'sharing') {
          setRemoteVideo(!!data.on);
        }
      } catch {
        // ignore transient negotiation errors
      }
    }

    function onSignal(payload) {
      if (!payload || callRef.current?.id !== payload.callId) return;
      handleSignal(payload.data);
    }

    function onEnded(payload) {
      const current = callRef.current;
      if (!current || current.id !== payload.callId) return;
      const peerName = current.peer?.displayName || 'They';
      teardown();
      if (payload.reason === 'declined') flashNotice(`${peerName} declined the call.`);
      else if (payload.reason === 'unanswered') flashNotice('No answer.');
      else if (payload.reason === 'cancelled') {
        flashNotice(current.direction === 'incoming' ? `Missed call from ${peerName}.` : 'Call cancelled.');
      } else if (payload.reason === 'disconnected') flashNotice('The call disconnected.');
      else flashNotice('Call ended.');
    }

    function onUnavailable(payload) {
      teardown();
      flashNotice(payload?.error || 'The call could not be started.');
    }

    socket.on('call:ringing', onRinging);
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:handled', onHandled);
    socket.on('call:signal', onSignal);
    socket.on('call:ended', onEnded);
    socket.on('call:unavailable', onUnavailable);

    return () => {
      socket.off('call:ringing', onRinging);
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:handled', onHandled);
      socket.off('call:signal', onSignal);
      socket.off('call:ended', onEnded);
      socket.off('call:unavailable', onUnavailable);
      teardown();
    };
  }, [socket]);

  return {
    call,
    remoteStream,
    remoteVideo,
    localScreen,
    sharing,
    security,
    securityNote,
    muted,
    notice,
    startCall,
    accept,
    decline,
    end,
    toggleMute,
    toggleScreen,
    screenPicker: {
      screenPickerOpen: picker.open,
      screenPickerSources: picker.sources,
      screenPickerLoading: picker.loading,
      screenPickerError: picker.error,
      screenPickerDesktop: picker.desktop,
      screenQuality: picker.quality,
      screenFps: picker.fps,
      setScreenQuality: picker.setQuality,
      setScreenFps: picker.setFps,
      chooseScreenSource: picker.choose,
      cancelScreenPicker: picker.cancel
    }
  };
}
