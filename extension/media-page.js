// Fixed operations injected into the extension's isolated world; never page-supplied code.
export async function mediaPage(action, args = {}) {
  try {
    const state = globalThis.__codexBrowserUseMediaV1 ||= { token: crypto.randomUUID(), nodes: new WeakMap(), refs: new Map(), recording: null };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const finite = n => Number.isFinite(n) ? n : null;
    const ranges = r => Array.from({ length: Math.min(r.length, 20) }, (_, i) => [r.start(i), r.end(i)]);
    const valid = e => e?.node.deref()?.isConnected && e.node.deref().currentSrc === e.source && e.generation === e.identity.generation;
    const describe = (el, mediaRef) => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { mediaRef, kind: el.tagName.toLowerCase(), currentTime: finite(el.currentTime), duration: finite(el.duration),
        live: el.duration === Infinity, paused: el.paused, ended: el.ended, seeking: el.seeking, readyState: el.readyState,
        playbackRate: el.playbackRate, muted: el.muted, volume: el.volume, protected: Boolean(el.mediaKeys),
        width: el.videoWidth || 0, height: el.videoHeight || 0,
        visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height }, seekable: ranges(el.seekable), buffered: ranges(el.buffered),
        error: el.error ? { code: el.error.code } : null,
        textTracks: [...el.textTracks].slice(0, 20).map(t => ({ kind: t.kind, label: t.label, language: t.language, mode: t.mode })) };
    };
    const info = j => ({ recordingId: j.id, mediaRef: j.mediaRef, status: j.status, reason: j.reason,
      mediaStart: j.start, mediaEnd: j.end ?? j.el.currentTime, requestedSeconds: j.seconds,
      wallSeconds: ((j.stoppedAt || performance.now()) - j.startedAt) / 1000, timelineContinuous: j.continuous,
      trackMuted: j.mutedSeconds > 0.5, mutedSecondsDuringCapture: j.mutedSeconds, bytes: j.bytes, mimeType: j.recorder.mimeType,
      source: 'selected-media-element-audio', pageUrl: j.pageUrl, title: j.title });
    if (action === 'cleanup') {
      const job = state.recording;
      if (job) { job.stop('released', false); await job.done; state.recording = null; }
      state.refs.clear();
      return { ok: true, value: { stopped: Boolean(job) } };
    }
    if (action === 'list') {
      const nodes = [];
      const visit = root => {
        for (const node of root.querySelectorAll('*')) {
          if (node.matches('video,audio')) nodes.push(node);
          if (node.shadowRoot) visit(node.shadowRoot);
          if (nodes.length >= 50) break;
        }
      };
      visit(document);
      for (const [ref, e] of state.refs) if (!valid(e)) state.refs.delete(ref);
      const media = nodes.slice(0, 50).map(el => {
        let identity = state.nodes.get(el);
        if (!identity) {
          identity = { generation: 0 }; state.nodes.set(el, identity);
          for (const name of ['emptied', 'loadstart']) el.addEventListener(name, () => { identity.generation++; }, { passive: true });
        }
        let entry = [...state.refs.values()].find(e => e.node.deref() === el && valid(e));
        if (!entry) {
          const ref = `${state.token}:m${crypto.randomUUID()}`;
          entry = { ref, node: new WeakRef(el), source: el.currentSrc, identity, generation: identity.generation };
          state.refs.set(ref, entry);
        }
        return describe(el, entry.ref);
      });
      return { ok: true, value: { documentToken: state.token, title: document.title, url: location.href, media } };
    }
    if (action === 'audio' && args.action !== 'start') {
      const j = state.recording;
      if (!j || j.id !== args.recordingId || j.mediaRef !== args.mediaRef) throw new Error('Unknown recording for this media reference');
      if (args.action === 'stop' || args.action === 'discard') { j.stop('stopped', true); await j.done; }
      if (args.action === 'discard') { state.recording = null; return { ok: true, value: { discarded: j.id } }; }
      if (args.action === 'read') {
        if (['recording', 'stopping'].includes(j.status)) throw new Error('Recording is still active; inspect status or stop before reading');
        if (j.failure) throw new Error(j.failure);
        const blob = new Blob(j.chunks, { type: j.recorder.mimeType });
        if (!blob.size) throw new Error('No audio bytes captured; do not treat this as silence or a transcript');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        return { ok: true, value: { ...info(j), data } };
      }
      if (args.action !== 'status') throw new Error('Unsupported recording action');
      return { ok: true, value: info(j) };
    }
    const entry = state.refs.get(args.mediaRef);
    if (!valid(entry)) throw new Error('STALE_MEDIA: Media source or document changed. Call browser_media again.');
    const el = entry.node.deref();
    const ensure = () => {
      if (!valid(entry)) throw new Error('STALE_MEDIA: Media source changed during operation');
      if (args._expiresAt && Date.now() >= args._expiresAt) throw new Error('Media operation expired; inspect playback before retrying');
    };
    const seek = async time => {
      if (['recording', 'stopping'].includes(state.recording?.status)) throw new Error('Stop audio recording before seeking; seeking would invalidate its timeline');
      if (!Number.isFinite(time) || time < 0 || (Number.isFinite(el.duration) && time >= el.duration)) throw new Error('Seek time is outside media duration');
      if (!ranges(el.seekable).some(([a, b]) => time >= a - 0.01 && time <= b)) throw new Error('Requested time is not seekable yet');
      el.pause(); el.currentTime = time;
      const until = Date.now() + 8000;
      do {
        ensure();
        if (!el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - time) < 0.35) return;
        await sleep(50);
      } while (Date.now() < until);
      throw new Error('Seek was sent but not confirmed; inspect playback before retrying');
    };
    if (action === 'control') {
      if (args.action === 'seek') await seek(args.time);
      else if (args.action === 'pause') el.pause();
      else if (args.action === 'play') await Promise.race([el.play(), sleep(8000).then(() => { throw new Error('Play was requested but not confirmed'); })]);
      else throw new Error('Unsupported media control');
      ensure();
      return { ok: true, value: { status: 'confirmed', ...describe(el, entry.ref) } };
    }
    if (el.mediaKeys) throw new Error('Protected media capture is unavailable; no DRM bypass is provided');
    if (action === 'frame') {
      if (args.time !== undefined) await seek(args.time);
      ensure();
      if (el.tagName !== 'VIDEO' || el.readyState < 2 || !el.videoWidth) throw new Error('No decoded video frame is ready');
      const before = el.currentTime, scale = Math.min(1, (args.maxWidth || 1280) / el.videoWidth, 2160 / el.videoHeight);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(el.videoWidth * scale)); canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
      canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
      try {
        const data = canvas.toDataURL('image/jpeg', (args.quality || 80) / 100).split(',')[1];
        if (data.length > 8 * 1024 * 1024) throw new Error('Frame too large; reduce maxWidth or quality');
        return { ok: true, value: { data, mimeType: 'image/jpeg', width: canvas.width, height: canvas.height,
          mediaRef: entry.ref, mediaTime: before, mediaTimeAfter: el.currentTime, duration: finite(el.duration),
          source: 'decoded-video-frame', capturedAt: new Date().toISOString(), pageUrl: location.href, title: document.title,
          note: 'A sampled frame is not continuous viewing. Player overlays and external subtitles are not included.' } };
      } catch (error) {
        if (error.name !== 'SecurityError') throw error;
        throw new Error('FRAME_CORS_BLOCKED: Browser prevents pixel extraction. Use browser_screenshot on the visible player and report timestamp/overlays separately.');
      }
    }
    if (action !== 'audio' || args.action !== 'start') throw new Error('Unsupported media operation');
    if (state.recording) throw new Error('Read/discard the previous recording before starting another in this frame');
    if (el.paused || el.ended || el.seeking || el.readyState < 2) throw new Error('Play the selected media and wait for data before recording its audio');
    if (el.playbackRate !== 1) throw new Error('Audio timeline capture requires playback speed 1');
    if (!el.captureStream || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot capture this media element audio');
    const stream = el.captureStream(), tracks = stream.getAudioTracks();
    if (!tracks.length) { stream.getTracks().forEach(t => t.stop()); throw new Error('AUDIO_UNAVAILABLE: No capturable audio track. Do not infer silence.'); }
    let recorder;
    try { recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 }); }
    catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
    const j = { id: crypto.randomUUID(), mediaRef: args.mediaRef, el, tracks, recorder, start: el.currentTime, seconds: args.durationSeconds ?? 20,
      startedAt: performance.now(), chunks: [], bytes: 0, mutedSeconds: 0, status: 'recording', continuous: true, pageUrl: location.href, title: document.title };
    const listeners = [];
    const on = (name, fn) => { el.addEventListener(name, fn); listeners.push([name, fn]); };
    j.done = new Promise(resolve => { j.resolve = resolve; });
    j.finish = () => {
      if (['complete', 'interrupted'].includes(j.status)) return;
      clearTimeout(j.stopDeadline);
      stream.getTracks().forEach(t => t.stop());
      j.status = j.continuous && !j.failure ? 'complete' : 'interrupted'; j.resolve();
    };
    j.stop = (reason, continuous) => {
      if (j.status !== 'recording') return;
      j.status = 'stopping'; j.reason = reason; j.continuous = continuous;
      j.end = continuous ? el.currentTime : (j.lastTime ?? j.start); j.stoppedAt = performance.now(); clearInterval(j.timer); clearTimeout(j.deadline);
      for (const [name, fn] of listeners) el.removeEventListener(name, fn);
      if (recorder.state !== 'inactive') {
        j.stopDeadline = setTimeout(() => { j.failure = 'Recorder did not flush within two seconds'; j.continuous = false; j.finish(); }, 2000);
        recorder.stop();
      } else j.finish();
    };
    recorder.ondataavailable = event => {
      j.bytes += event.data.size;
      if (j.bytes <= 2 * 1024 * 1024) j.chunks.push(event.data);
      else { j.failure = 'Audio exceeded capture memory budget'; j.stop('size_limit', false); }
    };
    recorder.onerror = () => { j.failure = 'Audio capture failed or browser access was restricted'; j.stop('error', false); };
    recorder.onstop = () => {
      if (j.status === 'recording') j.stop('track_ended', false);
      j.finish();
    };
    for (const name of ['seeking', 'emptied', 'loadstart', 'ratechange']) on(name, () => j.stop(name, false));
    on('pause', () => j.stop(el.ended ? 'ended' : 'paused', el.ended)); on('ended', () => j.stop('ended', true));
    let last = j.start; j.lastTime = last;
    j.timer = setInterval(() => {
      const now = el.currentTime;
      // Tracks become muted at normal EOF. Only observe muting during active playback.
      if (!el.ended && !el.paused && el.readyState >= 2 && tracks.some(t => t.muted)) j.mutedSeconds += 0.1;
      if (!valid(entry) || now < last - 0.1 || now - last > 1.5) { j.stop('source_or_timeline_changed', false); return; }
      last = now; j.lastTime = now; if (now - j.start >= j.seconds) j.stop('duration', true);
    }, 100);
    j.deadline = setTimeout(() => j.stop('wall_timeout', false), (j.seconds + 8) * 1000);
    try { recorder.start(500); state.recording = j; }
    catch (error) { j.stop('start_failed', false); stream.getTracks().forEach(t => t.stop()); throw error; }
    return { ok: true, value: info(j) };
  } catch (error) { return { ok: false, error: error.message }; }
}
