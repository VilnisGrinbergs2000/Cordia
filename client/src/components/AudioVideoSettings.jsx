import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Mic, RotateCcw, Volume2 } from 'lucide-react';
import {
  audioConstraints,
  DEFAULT_AUDIO_PREFS,
  isOutputSelectionSupported,
  openCamera,
  readAudioPrefs,
  writeAudioPrefs
} from '../audioPrefs';

const CAMERA_PRESET = { width: 1280, height: 720 };

function deviceName(device, fallback) {
  return device.label || fallback;
}

function DeviceOptions({ devices, fallback, selected }) {
  const known = devices.some((device) => device.deviceId === selected);
  return (
    <>
      <option value="">System default</option>
      {selected && !known && <option value={selected}>Selected device (unavailable)</option>}
      {devices.map((device, index) => (
        <option key={device.deviceId || index} value={device.deviceId}>
          {deviceName(device, `${fallback} ${index + 1}`)}
        </option>
      ))}
    </>
  );
}

export default function AudioVideoSettings() {
  const [prefs, setPrefs] = useState(readAudioPrefs);
  const [devices, setDevices] = useState({ inputs: [], outputs: [], cameras: [] });
  const [deviceError, setDeviceError] = useState('');
  const [micError, setMicError] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraError, setCameraError] = useState('');
  const [cameraBusy, setCameraBusy] = useState(false);
  const [testingOutput, setTestingOutput] = useState(false);
  const micStreamRef = useRef(null);
  const micContextRef = useRef(null);
  const micTimerRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const cameraVideoRef = useRef(null);
  const mountedRef = useRef(true);
  const outputSupported = isOutputSelectionSupported();

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceError('This browser does not expose audio or video devices.');
      return;
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (!mountedRef.current) return;
      setDevices({
        inputs: list.filter((device) => device.kind === 'audioinput'),
        outputs: list.filter((device) => device.kind === 'audiooutput'),
        cameras: list.filter((device) => device.kind === 'videoinput')
      });
      setDeviceError('');
    } catch {
      if (mountedRef.current) setDeviceError('Could not list your audio or video devices.');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return undefined;
    mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => {
      mountedRef.current = false;
      mediaDevices.removeEventListener('devicechange', refreshDevices);
    };
  }, [refreshDevices]);

  useEffect(() => {
    let cancelled = false;
    let stream;
    let context;
    let timer;

    async function startMeter() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicError('Microphone access is not supported.');
        return;
      }
      setMicError('');
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints(prefs),
          video: false
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        micStreamRef.current = stream;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          setMicError('Live input metering is not supported in this browser.');
          return;
        }
        context = new Ctx();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.65;
        source.connect(analyser);
        if (context.state === 'suspended') context.resume().catch(() => {});
        micContextRef.current = context;
        const data = new Uint8Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let index = 0; index < data.length; index += 1) {
            const value = (data[index] - 128) / 128;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / data.length);
          const db = 20 * Math.log10(Math.max(rms, 0.0001));
          const nextLevel = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
          setMicLevel(nextLevel);
        }, 90);
        micTimerRef.current = timer;
        refreshDevices();
      } catch (error) {
        if (cancelled) return;
        setMicError(
          error?.name === 'NotAllowedError'
            ? 'Microphone permission was denied. Allow access to test your input.'
            : 'Could not open the selected microphone.'
        );
      }
    }

    startMeter();

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (micTimerRef.current === timer) micTimerRef.current = null;
      if (micContextRef.current === context) micContextRef.current = null;
      if (context) context.close().catch(() => {});
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (micStreamRef.current === stream) micStreamRef.current = null;
      setMicLevel(0);
    };
  }, [
    prefs.inputDeviceId,
    prefs.echoCancellation,
    prefs.noiseSuppression,
    prefs.autoGainControl,
    refreshDevices
  ]);

  useEffect(() => {
    const element = cameraVideoRef.current;
    if (!element) return;
    element.srcObject = cameraStream;
    if (cameraStream) element.play().catch(() => {});
  }, [cameraStream]);

  useEffect(() => {
    return () => {
      const stream = cameraStreamRef.current;
      cameraStreamRef.current = null;
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function updatePref(key, value) {
    const next = writeAudioPrefs({ [key]: value });
    setPrefs(next);
  }

  function stopCamera() {
    const stream = cameraStreamRef.current;
    cameraStreamRef.current = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
  }

  async function toggleCamera() {
    if (cameraStreamRef.current) {
      stopCamera();
      return;
    }
    setCameraBusy(true);
    setCameraError('');
    try {
      const stream = await openCamera(CAMERA_PRESET);
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStreamRef.current = stream;
      setCameraStream(stream);
      refreshDevices();
    } catch (error) {
      if (!mountedRef.current) return;
      setCameraError(
        error?.name === 'NotAllowedError'
          ? 'Camera permission was denied.'
          : 'Could not open the selected camera.'
      );
    } finally {
      if (mountedRef.current) setCameraBusy(false);
    }
  }

  async function testOutput() {
    if (testingOutput) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      setDeviceError('Audio playback is not supported in this browser.');
      return;
    }
    setTestingOutput(true);
    let context;
    try {
      context = new Ctx();
      if (prefs.outputDeviceId && typeof context.setSinkId === 'function') {
        await context.setSinkId(prefs.outputDeviceId);
      }
      if (context.state === 'suspended') await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const volume = Math.max(0.0001, (prefs.outputVolume / 100) * 0.14);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
      oscillator.frequency.setValueAtTime(520, context.currentTime);
      oscillator.frequency.setValueAtTime(660, context.currentTime + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.36);
      oscillator.onended = () => context.close().catch(() => {});
    } catch {
      if (context) context.close().catch(() => {});
      setDeviceError('Could not play the test sound through the selected output.');
    } finally {
      setTimeout(() => {
        if (mountedRef.current) setTestingOutput(false);
      }, 450);
    }
  }

  function resetPrefs() {
    stopCamera();
    const next = writeAudioPrefs(DEFAULT_AUDIO_PREFS);
    setPrefs(next);
    setCameraError('');
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Audio &amp; Video</h1>
          <p>Choose how Cordia uses your microphone, speakers, and camera.</p>
        </div>
      </div>

      <div className="av-layout">
        <div className="av-column">
          <div className="settings-group">
            <div className="settings-group-head">
              <h3>Voice input</h3>
              <p>Used when you join a voice channel or answer a call.</p>
            </div>

            <label className="field">
              <span>Microphone</span>
              <select
                value={prefs.inputDeviceId}
                onChange={(event) => updatePref('inputDeviceId', event.target.value)}
              >
                <DeviceOptions
                  devices={devices.inputs}
                  fallback="Microphone"
                  selected={prefs.inputDeviceId}
                />
              </select>
            </label>

            <div className="av-meter-block">
              <div className="av-meter-head">
                <span>
                  <Mic size={14} /> Input level
                </span>
                <small>{micLevel}%</small>
              </div>
              <div className="av-meter" aria-hidden="true">
                <span style={{ width: `${micLevel}%` }} />
              </div>
              {micError && <div className="av-error">{micError}</div>}
            </div>

            <label className="av-slider-row">
              <span>
                <strong>Input volume</strong>
                <small>{prefs.inputVolume}%</small>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                value={prefs.inputVolume}
                onChange={(event) => updatePref('inputVolume', Number(event.target.value))}
              />
            </label>

            <div className="av-toggles">
              <div className="av-toggle-row">
                <span>
                  <strong>Echo cancellation</strong>
                  <small>Reduce feedback from speakers.</small>
                </span>
                <button
                  className={`notification-switch ${prefs.echoCancellation ? 'on' : ''}`}
                  role="switch"
                  aria-checked={prefs.echoCancellation}
                  aria-label="Echo cancellation"
                  onClick={() => updatePref('echoCancellation', !prefs.echoCancellation)}
                >
                  <span />
                </button>
              </div>
              <div className="av-toggle-row">
                <span>
                  <strong>Noise suppression</strong>
                  <small>Filter background noise from your mic.</small>
                </span>
                <button
                  className={`notification-switch ${prefs.noiseSuppression ? 'on' : ''}`}
                  role="switch"
                  aria-checked={prefs.noiseSuppression}
                  aria-label="Noise suppression"
                  onClick={() => updatePref('noiseSuppression', !prefs.noiseSuppression)}
                >
                  <span />
                </button>
              </div>
              <div className="av-toggle-row">
                <span>
                  <strong>Automatic gain control</strong>
                  <small>Keep your voice at a steady level.</small>
                </span>
                <button
                  className={`notification-switch ${prefs.autoGainControl ? 'on' : ''}`}
                  role="switch"
                  aria-checked={prefs.autoGainControl}
                  aria-label="Automatic gain control"
                  onClick={() => updatePref('autoGainControl', !prefs.autoGainControl)}
                >
                  <span />
                </button>
              </div>
            </div>
          </div>

          <div className="settings-group">
            <div className="settings-group-head">
              <h3>Voice output</h3>
              <p>Choose where calls and voice channels play.</p>
            </div>

            <label className="field">
              <span>Output device</span>
              <select
                value={prefs.outputDeviceId}
                onChange={(event) => updatePref('outputDeviceId', event.target.value)}
                disabled={!outputSupported}
              >
                <DeviceOptions
                  devices={devices.outputs}
                  fallback="Speaker"
                  selected={prefs.outputDeviceId}
                />
              </select>
            </label>

            {!outputSupported && (
              <div className="av-hint">
                This browser uses the system output device. Device selection is available in the
                desktop app.
              </div>
            )}

            <label className="av-slider-row">
              <span>
                <strong>Output volume</strong>
                <small>{prefs.outputVolume}%</small>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                value={prefs.outputVolume}
                onChange={(event) => updatePref('outputVolume', Number(event.target.value))}
              />
            </label>

            <div className="av-actions">
              <button className="btn btn-ghost btn-sm" onClick={testOutput} disabled={testingOutput}>
                {testingOutput ? <Loader2 size={15} className="spin" /> : <Volume2 size={15} />}
                {testingOutput ? 'Playing…' : 'Test output'}
              </button>
            </div>
          </div>
        </div>

        <div className="av-column">
          <div className="settings-group">
            <div className="settings-group-head">
              <h3>Camera</h3>
              <p>Preview the camera Cordia will use for video.</p>
            </div>

            <label className="field">
              <span>Camera</span>
              <select
                value={prefs.cameraDeviceId}
                onChange={(event) => updatePref('cameraDeviceId', event.target.value)}
              >
                <DeviceOptions
                  devices={devices.cameras}
                  fallback="Camera"
                  selected={prefs.cameraDeviceId}
                />
              </select>
            </label>

            <div className={`av-preview ${cameraStream ? 'live' : ''}`}>
              {cameraStream ? (
                <video ref={cameraVideoRef} autoPlay playsInline muted />
              ) : (
                <span>
                  <Camera size={22} />
                  Camera preview is off
                </span>
              )}
            </div>

            <div className="av-actions">
              <button className="btn btn-ghost btn-sm" onClick={toggleCamera} disabled={cameraBusy}>
                {cameraBusy ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}
                {cameraStream ? 'Stop preview' : 'Test camera'}
              </button>
            </div>
            {cameraError && <div className="av-error">{cameraError}</div>}
          </div>

          <div className="settings-note">
            <Volume2 size={17} />
            <p>
              Changes save automatically on this device. Input and camera device changes apply
              the next time you join a call or turn on video.
            </p>
          </div>
        </div>
      </div>

      {deviceError && <div className="av-error">{deviceError}</div>}

      <div className="settings-actions">
        <button className="btn btn-ghost" onClick={resetPrefs}>
          <RotateCcw size={16} />
          Reset to defaults
        </button>
      </div>
    </section>
  );
}
