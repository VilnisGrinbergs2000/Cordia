import { useEffect } from 'react';

const STORAGE_KEY = 'cordia:audio-prefs';
export const AUDIO_PREFS_EVENT = 'cordia:audio-prefs';

export const DEFAULT_AUDIO_PREFS = Object.freeze({
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  inputVolume: 100,
  outputVolume: 100,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
});

function clampVolume(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function deviceId(value) {
  return typeof value === 'string' ? value : '';
}

export function normalizeAudioPrefs(value = {}) {
  return {
    inputDeviceId: deviceId(value.inputDeviceId),
    outputDeviceId: deviceId(value.outputDeviceId),
    cameraDeviceId: deviceId(value.cameraDeviceId),
    inputVolume: clampVolume(value.inputVolume, DEFAULT_AUDIO_PREFS.inputVolume),
    outputVolume: clampVolume(value.outputVolume, DEFAULT_AUDIO_PREFS.outputVolume),
    echoCancellation: value.echoCancellation !== false,
    noiseSuppression: value.noiseSuppression !== false,
    autoGainControl: value.autoGainControl !== false
  };
}

export function readAudioPrefs() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_PREFS };
    return normalizeAudioPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AUDIO_PREFS };
  }
}

export function writeAudioPrefs(patch) {
  const next = normalizeAudioPrefs({ ...readAudioPrefs(), ...patch });
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage can be unavailable
  }
  window.dispatchEvent(new CustomEvent(AUDIO_PREFS_EVENT, { detail: next }));
  return next;
}

export function audioConstraints(prefs = readAudioPrefs()) {
  const constraints = {
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl
  };
  if (prefs.inputDeviceId) constraints.deviceId = { exact: prefs.inputDeviceId };
  return constraints;
}

export function videoConstraints(prefs = readAudioPrefs(), preset = {}) {
  const width = preset.width || 1280;
  const height = preset.height || 720;
  const constraints = {
    width: { ideal: width },
    height: { ideal: height }
  };
  if (prefs.cameraDeviceId) constraints.deviceId = { exact: prefs.cameraDeviceId };
  return constraints;
}

export function isOutputSelectionSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.HTMLMediaElement !== 'undefined' &&
    typeof window.HTMLMediaElement.prototype.setSinkId === 'function'
  );
}

export function applyAudioOutput(element, prefs = readAudioPrefs()) {
  if (!element) return;
  const volume = Math.min(1, Math.max(0, Number(prefs.outputVolume) / 100));
  if (Number.isFinite(volume)) element.volume = volume;
  if (typeof element.setSinkId !== 'function') return;
  const target = prefs.outputDeviceId || '';
  if (element.sinkId === target) return;
  element.setSinkId(target).catch(() => {});
}

export function useAudioOutput(ref) {
  useEffect(() => {
    const apply = (event) => applyAudioOutput(ref.current, event?.detail || readAudioPrefs());
    apply();
    window.addEventListener(AUDIO_PREFS_EVENT, apply);
    return () => window.removeEventListener(AUDIO_PREFS_EVENT, apply);
  }, [ref]);
}

function fallbackProcessor(rawStream) {
  let cleaned = false;
  return {
    stream: rawStream,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rawStream?.getTracks().forEach((track) => track.stop());
    }
  };
}

export function createMicrophoneProcessor(rawStream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !rawStream?.getAudioTracks?.().length) return fallbackProcessor(rawStream);

  let context;
  let source;
  let gain;
  let destination;
  try {
    context = new Ctx();
    source = context.createMediaStreamSource(rawStream);
    gain = context.createGain();
    destination = context.createMediaStreamDestination();
    gain.gain.value = readAudioPrefs().inputVolume / 100;
    source.connect(gain);
    gain.connect(destination);
    if (context.state === 'suspended') context.resume().catch(() => {});
  } catch {
    try {
      context?.close().catch(() => {});
    } catch {
      // ignore
    }
    return fallbackProcessor(rawStream);
  }

  const stream = new MediaStream(destination.stream.getAudioTracks());
  let cleaned = false;

  function onPrefsChange(event) {
    const next = event?.detail || readAudioPrefs();
    const value = Math.min(1, Math.max(0, next.inputVolume / 100));
    try {
      gain.gain.setTargetAtTime(value, context.currentTime, 0.02);
    } catch {
      gain.gain.value = value;
    }
  }

  window.addEventListener(AUDIO_PREFS_EVENT, onPrefsChange);

  return {
    stream,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener(AUDIO_PREFS_EVENT, onPrefsChange);
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // ignore
      }
      stream.getTracks().forEach((track) => track.stop());
      rawStream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    }
  };
}

export async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is not supported.');
  }
  const prefs = readAudioPrefs();
  let rawStream;
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(prefs),
      video: false
    });
  } catch (error) {
    if (
      prefs.inputDeviceId &&
      (error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError')
    ) {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints({ ...prefs, inputDeviceId: '' }),
        video: false
      });
    } else {
      throw error;
    }
  }
  return createMicrophoneProcessor(rawStream);
}

export async function openCamera(preset) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access is not supported.');
  }
  const prefs = readAudioPrefs();
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(prefs, preset),
      audio: false
    });
  } catch (error) {
    if (
      prefs.cameraDeviceId &&
      (error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError')
    ) {
      return navigator.mediaDevices.getUserMedia({
        video: videoConstraints({ ...prefs, cameraDeviceId: '' }, preset),
        audio: false
      });
    }
    throw error;
  }
}
