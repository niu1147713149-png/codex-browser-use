"""Transcribe captured audio locally, retaining timeline and provenance. No network downloads."""
import argparse
import hashlib
import json
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--model', default='small', help='Cached faster-whisper model name or existing model directory')
    parser.add_argument('--language', default=None, help='Optional language code; omit for detection')
    args = parser.parse_args()
    path = Path(args.manifest).resolve(strict=True)
    manifest = json.loads(path.read_text(encoding='utf-8'))
    import av
    import numpy as np
    from faster_whisper import WhisperModel
    model = None
    output = {'provider': 'faster-whisper-local', 'model': args.model, 'status': 'machine_transcribed_unreviewed',
              'manifest_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'clips': [],
              'note': 'Speech recognition is not visual understanding; music, numbers and unclear speech require review.'}
    for clip in manifest.get('audio', []):
        media = (path.parent / clip['file']).resolve(strict=True)
        if not media.is_relative_to(path.parent):
            raise ValueError('Audio must stay within the evidence directory')
        digest = hashlib.sha256(media.read_bytes()).hexdigest()
        if digest != clip['sha256']:
            raise ValueError('Audio provenance mismatch')
        result = {'file': clip['file'], 'sha256': digest, 'mediaStart': clip['mediaStart'], 'mediaEnd': clip['mediaEnd'], 'segments': []}
        if not clip.get('timelineContinuous') or clip.get('trackMuted'):
            result['status'] = 'unusable_timeline_or_muted_track'; output['clips'].append(result); continue
        samples, energy, peak, decoded_seconds = 0, 0.0, 0.0, 0.0
        with av.open(str(media)) as container:
            for frame in container.decode(audio=0):
                data = frame.to_ndarray().astype(np.float64)
                if frame.format.name.startswith(('s16', 's32')):
                    data /= 32768 if frame.format.name.startswith('s16') else 2147483648
                samples += data.size; energy += float(np.square(data).sum()); peak = max(peak, float(np.abs(data).max(initial=0)))
                decoded_seconds += frame.samples / frame.sample_rate
        result.update(decodedSeconds=decoded_seconds, rms=(energy / max(1, samples)) ** 0.5, peak=peak)
        if not samples or peak < 0.0001:
            result['status'] = 'silent_or_blocked_audio'; output['clips'].append(result); continue
        if model is None:
            model = WhisperModel(args.model, device='cpu', compute_type='int8', local_files_only=True)
        segments, info = model.transcribe(str(media), language=args.language, vad_filter=True, beam_size=5, condition_on_previous_text=False)
        result.update(status='machine_transcribed_unreviewed', language=info.language, languageProbability=info.language_probability)
        for s in segments:
            if s.text.strip():
                result['segments'].append({'start': clip['mediaStart'] + s.start, 'end': clip['mediaStart'] + s.end,
                                           'text': s.text.strip(), 'avgLogprob': s.avg_logprob, 'noSpeechProbability': s.no_speech_prob})
        output['clips'].append(result)
        print(json.dumps({'file': clip['file'], 'segments': len(result['segments']), 'language': info.language}), flush=True)
    dest = path.parent / 'transcript.json'
    dest.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(str(dest))

if __name__ == '__main__':
    main()
