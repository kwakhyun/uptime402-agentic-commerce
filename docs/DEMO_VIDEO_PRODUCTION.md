# Uptime402 deterministic demo-video production

Status: the 165.021-second H.264/AAC final export was published at
`https://www.youtube.com/watch?v=jwJRfs-NRZY`. The source MP4 remains ignored;
this document is retained as the reproducible production and QA procedure.

This workflow creates a Korean-captioned and narrated 165-second,
1920x1080/30fps H.264 replay of the already completed `finalist-demo-5` run. It
contains no browser, GCP, RPC, facilitator, signing, or payment call. It must not
be described as a new live execution: every frame carries a read-only replay / no
new payment label.

## 1. Inspect the shot list

```bash
python3 scripts/build-demo-replay.py shots
```

Capture the ten requested views from the hash-pinned final UI. Use a clean,
full-screen 16:9 browser at 100% zoom. Keep the OS dock, browser devtools,
terminal, Codex, account chooser, auth tokens, Secret Manager values, raw
`PAYMENT-SIGNATURE`, and private material out of frame.

The source screenshots stay under ignored `private/demo-video-inputs/`. At least
1280x720 is enforced; 1920x1080 or 2560x1440 PNG is preferred.

## 2. Audit narration timing

On macOS, the builder uses the installed Korean `Yuna` voice. This command
generates only temporary AIFF files and checks that each narration fits its
scene:

```bash
python3 scripts/build-demo-replay.py audit-narration
```

The Korean captions remain hard-coded in the video even when narration is used.

## 3. Bind real final inputs

Copy the tracked template to the ignored work area:

```bash
mkdir -p private/demo-video-work
cp assets/demo-video/finalist-demo-5.replay.json private/demo-video-work/finalist-demo-5.final.json
```

The fresh verifier and final deployment QA have passed. The published 2026-08-03
video is bound to the capture-time UI source Git SHA
`10ca5f2ccaf2af45e2d80f6065de9c623b24e559`; this is historical video provenance,
not the current portfolio control revision (`62f9767593703863abdffa2bd24ccecab4cbd2cf`).
For an exact reproduction of the published video, set `stage: "final"`, the exact
evidence/report hashes, that capture-time SHA, and each screenshot's
`sha256:<lowercase hex>` in the private manifest. A new recording of the current UI
must instead use the current deployed control source SHA. Validate without creating
a video:

```bash
python3 scripts/build-demo-replay.py validate \
  --manifest private/demo-video-work/finalist-demo-5.final.json \
  --final
```

## 4. Build an ignored preview

Build and review an ignored candidate first. Do not pass `--final`, and do not
write to `submission/Uptime402_Demo.mp4`:

```bash
python3 scripts/build-demo-replay.py build \
  --manifest private/demo-video-work/finalist-demo-5.final.json \
  --output private/demo-video-work/Uptime402_Demo_candidate.mp4
```

The builder pads each `say` narration to its fixed scene duration, burns Korean
ASS captions and the replay label into every frame, and concatenates ten exact
scenes. It then verifies H.264, 1920x1080, yuv420p, 30fps, stereo AAC 48kHz, and
165 seconds.

## 5. Automated and manual QA

Run ffprobe directly:

```bash
ffprobe -v error -show_entries \
  format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels \
  -of json private/demo-video-work/Uptime402_Demo_candidate.mp4
```

Generate one midpoint frame per scene plus a JSON report:

```bash
python3 scripts/build-demo-replay.py qa \
  --manifest private/demo-video-work/finalist-demo-5.final.json \
  --video private/demo-video-work/Uptime402_Demo_candidate.mp4 \
  --samples-dir private/demo-video-work/qa-frames \
  --report private/demo-video-work/qa-report.json
```

Play the entire file once with sound, then inspect all ten midpoint frames. A
human must confirm:

- the final UI visibly says `DEVNET VERIFIED`;
- `READ-ONLY REPLAY`, `finalist-demo-5`, and `NO NEW PAYMENT` remain visible;
- captions and narration match the exact evidence;
- Gemini baseline/counterfactual, x402 order, Explorer/deltas, receipt/outcome,
  recovery, and both denial rows are readable;
- there is no secret, auth token, raw signed payload, terminal, Codex UI, blank
  auth window, or hidden approval interaction.

## 6. Promote only after approval

The submission path is guarded twice: it requires both `--final` and
`--overwrite`, and the private manifest must pass every final hash check.

```bash
python3 scripts/build-demo-replay.py build \
  --manifest private/demo-video-work/finalist-demo-5.final.json \
  --output submission/Uptime402_Demo.mp4 \
  --final \
  --overwrite
```

The target is 165 seconds and the hard limit is 180 seconds. Payment evidence
declares `submission/Uptime402_Demo.mp4` and `demoVideoDurationSeconds: 165`, although
it does not bind the eventual video bytes/hash. If path or declared duration changes,
regenerate the evidence/report and re-pin final UI hashes; never create a new payment
solely for the video. Promote only after full playback, audio, duration, secret-exposure,
and claim-consistency QA. The existing YouTube upload is already complete; only a
replacement upload requires separate user approval.
