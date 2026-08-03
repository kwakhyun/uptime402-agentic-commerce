#!/usr/bin/env python3
"""Build and QA a deterministic, evidence-bound Uptime402 replay video.

This tool is deliberately local-only. It reads PNG/JPEG captures, the promoted
payment evidence, and (for final output) the nonce-bound verification report.
It has no network, browser, GCP, Solana, or payment code path.

The tracked manifest is a template. Final output is refused unless every input
image is hash-bound, the promoted evidence/report hashes match disk, and the
manifest stage is ``final``. By default, builds go to an ignored ``private/``
preview path and can never replace the submission video accidentally.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "assets" / "demo-video" / "finalist-demo-5.replay.json"
DEFAULT_PREVIEW = ROOT / "private" / "demo-video-work" / "Uptime402_Demo_preview.mp4"
FINAL_OUTPUT = ROOT / "submission" / "Uptime402_Demo.mp4"
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class WorkflowError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise WorkflowError(message)


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except FileNotFoundError as exc:
        fail(f"Required local command is missing: {command[0]}")
        raise AssertionError from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        fail(f"Command failed ({command[0]}): {detail[-1600:]}")
        raise AssertionError from exc


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Cannot read JSON {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"Expected a JSON object: {path}")
    return value


def repo_path(raw: Any, *, label: str, must_exist: bool = True) -> Path:
    if not isinstance(raw, str) or not raw or Path(raw).is_absolute():
        fail(f"{label} must be a non-empty repository-relative path")
    candidate = (ROOT / raw).resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        fail(f"{label} escapes the repository root: {raw}")
    if must_exist:
        if not candidate.is_file():
            fail(f"{label} is missing: {raw}")
        if (ROOT / raw).is_symlink():
            fail(f"{label} may not be a symlink: {raw}")
    return candidate


def ffprobe(path: Path) -> dict[str, Any]:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        fail(f"ffprobe returned invalid JSON for {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"ffprobe returned an invalid result for {path}")
    return value


def media_duration(path: Path) -> float:
    metadata = ffprobe(path)
    try:
        return float(metadata["format"]["duration"])
    except (KeyError, TypeError, ValueError) as exc:
        fail(f"Cannot determine media duration: {path}")
        raise AssertionError from exc


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_integer(value: Any, label: str, minimum: int = 1) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        fail(f"{label} must be an integer >= {minimum}")
    return value


def payment_for(evidence: dict[str, Any], payment_id: str) -> dict[str, Any]:
    payments = evidence.get("payments")
    if not isinstance(payments, list):
        fail("Evidence payments[] is missing")
    matches = [value for value in payments if isinstance(value, dict) and value.get("paymentId") == payment_id]
    if len(matches) != 1:
        fail(f"Evidence must contain exactly one paymentId={payment_id}")
    return matches[0]


def denial_for(evidence: dict[str, Any], reason_code: str) -> dict[str, Any]:
    denials = evidence.get("denials")
    if not isinstance(denials, list):
        fail("Evidence denials[] is missing")
    matches = [value for value in denials if isinstance(value, dict) and value.get("reasonCode") == reason_code]
    if len(matches) != 1:
        fail(f"Evidence must contain exactly one denial reasonCode={reason_code}")
    return matches[0]


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        fail(f"Evidence binding mismatch for {label}: expected {expected!r}, got {actual!r}")


def validate_evidence_bindings(manifest: dict[str, Any], *, final_mode: bool) -> None:
    evidence_path = repo_path(manifest.get("evidencePath"), label="evidencePath")
    evidence = load_json(evidence_path)
    facts = manifest.get("facts")
    if not isinstance(facts, dict):
        fail("facts must be an object")

    payment_id = require_string(facts.get("paymentId"), "facts.paymentId")
    payment = payment_for(evidence, payment_id)
    chain = payment.get("chainEvidence")
    policy = payment.get("policyEvidence")
    if not isinstance(chain, dict) or not isinstance(policy, dict):
        fail("Selected payment lacks chainEvidence or policyEvidence")

    checks = {
        "runId": manifest.get("runId"),
        "paymentId": payment.get("paymentId"),
        "txSignature": payment.get("txSignature"),
        "runBindingHash": payment.get("runBindingHash"),
        "amount": payment.get("amount"),
        "amountBaseUnits": payment.get("amountBaseUnits"),
        "finalizedSlot": chain.get("slot"),
        "payerDeltaBaseUnits": chain.get("payerDeltaBaseUnits"),
        "payeeDeltaBaseUnits": chain.get("payeeDeltaBaseUnits"),
        "budgetBeforeBaseUnits": policy.get("remainingBeforeBaseUnits"),
        "budgetAfterBaseUnits": policy.get("remainingAfterCommitBaseUnits"),
    }
    for key, actual in checks.items():
        assert_equal(actual, facts.get(key), f"facts.{key}")

    selection = evidence.get("selection")
    if not isinstance(selection, dict):
        fail("Evidence selection is missing")
    baseline = selection.get("baseline")
    counterfactual = selection.get("counterfactual")
    if not isinstance(baseline, dict) or not isinstance(counterfactual, dict):
        fail("Evidence baseline/counterfactual selection is missing")
    assert_equal(baseline.get("selectedOfferId"), facts.get("baselineOfferId"), "facts.baselineOfferId")
    assert_equal(
        counterfactual.get("selectedOfferId"),
        facts.get("counterfactualOfferId"),
        "facts.counterfactualOfferId",
    )

    for fact_name in ("overCapReasonCode", "replayReasonCode"):
        reason = require_string(facts.get(fact_name), f"facts.{fact_name}")
        denial = denial_for(evidence, reason)
        assert_equal(denial.get("transactionCreated"), False, f"{reason}.transactionCreated")
        assert_equal(denial.get("txSignature"), None, f"{reason}.txSignature")

    expected_duration = manifest.get("outputDurationSeconds")
    project = evidence.get("project")
    if not isinstance(project, dict):
        fail("Evidence project is missing")
    assert_equal(project.get("demoVideoDurationSeconds"), expected_duration, "project.demoVideoDurationSeconds")

    declared_evidence_hash = manifest.get("evidenceSha256")
    actual_evidence_hash = sha256_file(evidence_path)
    if declared_evidence_hash is not None:
        if not isinstance(declared_evidence_hash, str) or not SHA256_RE.fullmatch(declared_evidence_hash):
            fail("evidenceSha256 must be null or sha256:<64 lowercase hex>")
        assert_equal(actual_evidence_hash, declared_evidence_hash, "evidenceSha256")
    elif final_mode:
        fail("Final build requires evidenceSha256")

    report_path_raw = manifest.get("verificationReportPath")
    report_hash = manifest.get("verificationReportSha256")
    if final_mode:
        if not isinstance(report_hash, str) or not SHA256_RE.fullmatch(report_hash):
            fail("Final build requires verificationReportSha256")
        report_path = repo_path(report_path_raw, label="verificationReportPath")
        assert_equal(sha256_file(report_path), report_hash, "verificationReportSha256")
        report = load_json(report_path)
        assert_equal(report.get("evidenceSha256"), actual_evidence_hash, "verificationReport.evidenceSha256")
        report_checks = report.get("checks")
        if not isinstance(report_checks, dict) or not report_checks or any(value is not True for value in report_checks.values()):
            fail("Final verification report must contain only true checks")


def validate_manifest(
    manifest_path: Path,
    *,
    require_inputs: bool,
    final_mode: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = load_json(manifest_path)
    assert_equal(manifest.get("schemaVersion"), "1.0", "schemaVersion")
    run_id = require_string(manifest.get("runId"), "runId")
    if run_id != "finalist-demo-5":
        fail("This P0 workflow is pinned to finalist-demo-5")
    assert_equal(manifest.get("readOnlyReplay"), True, "readOnlyReplay")
    assert_equal(manifest.get("noNewPayment"), True, "noNewPayment")

    stage = require_string(manifest.get("stage"), "stage")
    if stage not in {"template", "final"}:
        fail("stage must be template or final")
    if final_mode and stage != "final":
        fail("Final output requires manifest stage=final")

    duration = require_integer(manifest.get("outputDurationSeconds"), "outputDurationSeconds")
    if duration != 165:
        fail("The finalist-demo-5 replay must be exactly 165 declared seconds")

    resolution = manifest.get("resolution")
    if not isinstance(resolution, dict):
        fail("resolution must be an object")
    assert_equal(resolution.get("width"), 1920, "resolution.width")
    assert_equal(resolution.get("height"), 1080, "resolution.height")
    assert_equal(resolution.get("fps"), 30, "resolution.fps")

    voice = manifest.get("voice")
    if not isinstance(voice, dict):
        fail("voice must be an object")
    require_string(voice.get("name"), "voice.name")
    require_integer(voice.get("rate"), "voice.rate", 100)

    scenes_raw = manifest.get("scenes")
    if not isinstance(scenes_raw, list) or len(scenes_raw) != 10:
        fail("scenes must contain exactly ten replay scenes")
    scenes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    total = 0
    for index, raw in enumerate(scenes_raw, start=1):
        if not isinstance(raw, dict):
            fail(f"scenes[{index - 1}] must be an object")
        scene_id = require_string(raw.get("id"), f"scenes[{index - 1}].id")
        if scene_id in seen_ids:
            fail(f"Duplicate scene id: {scene_id}")
        seen_ids.add(scene_id)
        seconds = require_integer(raw.get("durationSeconds"), f"{scene_id}.durationSeconds")
        total += seconds
        require_string(raw.get("image"), f"{scene_id}.image")
        require_string(raw.get("caption"), f"{scene_id}.caption")
        require_string(raw.get("narration"), f"{scene_id}.narration")
        require_string(raw.get("callout"), f"{scene_id}.callout")

        image_hash = raw.get("imageSha256")
        if image_hash is not None and (not isinstance(image_hash, str) or not SHA256_RE.fullmatch(image_hash)):
            fail(f"{scene_id}.imageSha256 must be null or sha256:<64 lowercase hex>")
        if final_mode and image_hash is None:
            fail(f"Final output requires {scene_id}.imageSha256")

        if require_inputs:
            image_path = repo_path(raw.get("image"), label=f"{scene_id}.image")
            if image_path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
                fail(f"{scene_id}.image must be PNG or JPEG")
            metadata = ffprobe(image_path)
            streams = metadata.get("streams")
            video = next(
                (value for value in streams or [] if isinstance(value, dict) and value.get("codec_type") == "video"),
                None,
            )
            if not isinstance(video, dict):
                fail(f"ffprobe found no image stream: {raw.get('image')}")
            width = video.get("width")
            height = video.get("height")
            if not isinstance(width, int) or not isinstance(height, int) or width < 1280 or height < 720:
                fail(f"{scene_id}.image must be at least 1280x720; got {width}x{height}")
            if image_path.stat().st_size < 40_000:
                fail(f"{scene_id}.image is suspiciously small; capture a real readable UI frame")
            if image_hash is not None:
                assert_equal(sha256_file(image_path), image_hash, f"{scene_id}.imageSha256")
        scenes.append(raw)

    if total != duration:
        fail(f"Scene durations sum to {total}, expected {duration}")

    if final_mode:
        source_git_sha = manifest.get("sourceGitSha")
        if not isinstance(source_git_sha, str) or not GIT_SHA_RE.fullmatch(source_git_sha):
            fail("Final output requires sourceGitSha as 40 lowercase hex characters")

    validate_evidence_bindings(manifest, final_mode=final_mode)
    return manifest, scenes


def ass_time(seconds: float) -> str:
    centiseconds = int(round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole, centis = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole:02d}.{centis:02d}"


def ass_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def render_ass(path: Path, scene: dict[str, Any], manifest: dict[str, Any]) -> None:
    duration = float(scene["durationSeconds"])
    end = ass_time(duration)
    stage = manifest["stage"]
    replay_label = (
        "READ-ONLY REPLAY · finalist-demo-5 · NO NEW PAYMENT"
        if stage == "final"
        else "TEMPLATE PREVIEW · READ-ONLY REPLAY · finalist-demo-5 · NO NEW PAYMENT"
    )
    content = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Replay,Apple SD Gothic Neo,25,&H00FFFFFF,&H00FFFFFF,&H0008111F,&HA006111F,-1,0,0,0,100,100,0,0,3,1,0,7,28,28,14,1
Style: Callout,Apple SD Gothic Neo,28,&H003DE7D0,&H003DE7D0,&H0008111F,&H7006111F,-1,0,0,0,100,100,0,0,3,1,0,9,28,28,14,1
Style: Caption,Apple SD Gothic Neo,45,&H00FFFFFF,&H00FFFFFF,&H00030A13,&H00030A13,-1,0,0,0,100,100,0,0,1,3,0,2,80,80,32,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,{end},Replay,,0,0,0,,{ass_text(replay_label)}
Dialogue: 0,0:00:00.20,{end},Callout,,0,0,0,,{ass_text(scene['callout'])}
Dialogue: 0,0:00:00.20,{end},Caption,,0,0,0,,{ass_text(scene['caption'])}
"""
    path.write_text(content, encoding="utf-8")


def make_narration(scene: dict[str, Any], manifest: dict[str, Any], output: Path) -> float:
    narration_audio = scene.get("narrationAudio")
    if narration_audio is not None:
        source = repo_path(narration_audio, label=f"{scene['id']}.narrationAudio")
        declared_hash = scene.get("narrationAudioSha256")
        if declared_hash is not None:
            assert_equal(sha256_file(source), declared_hash, f"{scene['id']}.narrationAudioSha256")
        shutil.copyfile(source, output)
    else:
        voice = manifest["voice"]
        run(
            [
                "say",
                "-v",
                str(voice["name"]),
                "-r",
                str(voice["rate"]),
                "-o",
                str(output),
                str(scene["narration"]),
            ]
        )
    duration = media_duration(output)
    scene_duration = float(scene["durationSeconds"])
    if duration > scene_duration - 0.65:
        fail(
            f"Narration for {scene['id']} is {duration:.3f}s and does not fit "
            f"inside its {scene_duration:.0f}s scene"
        )
    return duration


def render_scene(
    scene: dict[str, Any],
    manifest: dict[str, Any],
    index: int,
    workdir: Path,
) -> Path:
    image_path = repo_path(scene["image"], label=f"{scene['id']}.image")
    ass_path = workdir / f"scene-{index:02d}.ass"
    audio_path = workdir / f"scene-{index:02d}.aiff"
    video_path = workdir / f"scene-{index:02d}.mp4"
    render_ass(ass_path, scene, manifest)
    make_narration(scene, manifest, audio_path)

    seconds = float(scene["durationSeconds"])
    fade_out = max(0.0, seconds - 0.28)
    escaped_ass = str(ass_path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    video_filter = (
        "[0:v]"
        "scale=1920:900:force_original_aspect_ratio=decrease,"
        "pad=1920:920:(ow-iw)/2:(oh-ih)/2:color=0x06111f,"
        "pad=1920:1080:0:60:color=0x06111f,"
        "setsar=1,fps=30,"
        f"ass=filename='{escaped_ass}':fontsdir=/System/Library/Fonts,"
        f"fade=t=in:st=0:d=0.28,fade=t=out:st={fade_out:.2f}:d=0.28[v];"
        "[1:a]aresample=48000,"
        f"apad=pad_dur={seconds:.3f},atrim=0:{seconds:.3f},"
        f"afade=t=out:st={max(0.0, seconds - 0.35):.2f}:d=0.35[a]"
    )
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
            str(image_path),
            "-i",
            str(audio_path),
            "-filter_complex",
            video_filter,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-t",
            f"{seconds:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-profile:v",
            "high",
            "-level:v",
            "4.1",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-y",
            str(video_path),
        ]
    )
    return video_path


def stream_rate(value: Any) -> float:
    if not isinstance(value, str) or "/" not in value:
        return 0.0
    numerator, denominator = value.split("/", 1)
    try:
        return float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return 0.0


def qa_video(video_path: Path, *, expected_duration: int = 165) -> dict[str, Any]:
    metadata = ffprobe(video_path)
    streams = metadata.get("streams")
    if not isinstance(streams, list):
        fail("ffprobe did not return streams")
    video_streams = [value for value in streams if isinstance(value, dict) and value.get("codec_type") == "video"]
    audio_streams = [value for value in streams if isinstance(value, dict) and value.get("codec_type") == "audio"]
    if len(video_streams) != 1:
        fail(f"Expected one video stream, got {len(video_streams)}")
    if len(audio_streams) != 1:
        fail(f"Expected one narration audio stream, got {len(audio_streams)}")
    video = video_streams[0]
    audio = audio_streams[0]
    assert_equal(video.get("codec_name"), "h264", "video.codec_name")
    assert_equal(video.get("width"), 1920, "video.width")
    assert_equal(video.get("height"), 1080, "video.height")
    assert_equal(video.get("pix_fmt"), "yuv420p", "video.pix_fmt")
    if abs(stream_rate(video.get("avg_frame_rate")) - 30.0) > 0.01:
        fail(f"Video frame rate is not 30fps: {video.get('avg_frame_rate')}")
    assert_equal(audio.get("codec_name"), "aac", "audio.codec_name")
    assert_equal(str(audio.get("sample_rate")), "48000", "audio.sample_rate")
    if int(audio.get("channels") or 0) != 2:
        fail(f"Narration audio must be stereo; got {audio.get('channels')}")
    try:
        duration = float(metadata["format"]["duration"])
    except (KeyError, TypeError, ValueError) as exc:
        fail("Cannot determine output video duration")
        raise AssertionError from exc
    if duration > 180.0:
        fail(f"Video exceeds three minutes: {duration:.6f}s")
    if abs(duration - expected_duration) > 0.25:
        fail(f"Video duration is {duration:.6f}s; expected {expected_duration}s ±0.25s")
    if video_path.stat().st_size < 1_000_000:
        fail("Output video is suspiciously small")
    return {
        "schemaVersion": "1.0",
        "video": str(video_path),
        "sha256": sha256_file(video_path),
        "sizeBytes": video_path.stat().st_size,
        "durationSeconds": duration,
        "videoStream": {
            "codec": video.get("codec_name"),
            "width": video.get("width"),
            "height": video.get("height"),
            "pixelFormat": video.get("pix_fmt"),
            "frameRate": video.get("avg_frame_rate"),
        },
        "audioStream": {
            "codec": audio.get("codec_name"),
            "sampleRate": audio.get("sample_rate"),
            "channels": audio.get("channels"),
        },
        "automatedChecksPassed": True,
        "manualChecksRequired": [
            "all ten screenshots show the hash-pinned final UI and remain readable",
            "persistent read-only replay label is visible in every scene",
            "Korean narration/captions agree with payment-evidence.json",
            "no secret, raw payment payload, auth token, terminal, or internal Codex UI is visible",
            "Explorer, receipt, recovery, and both denial scenes are visually inspected",
        ],
    }


def extract_samples(video: Path, scenes: list[dict[str, Any]], output_dir: Path) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    elapsed = 0.0
    outputs: list[str] = []
    for index, scene in enumerate(scenes, start=1):
        timestamp = elapsed + float(scene["durationSeconds"]) / 2.0
        output = output_dir / f"{index:02d}-{scene['id']}-{timestamp:06.2f}s.png"
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-y",
                str(output),
            ]
        )
        outputs.append(str(output))
        elapsed += float(scene["durationSeconds"])
    return outputs


def concat_entry(path: Path) -> str:
    escaped = str(path).replace("'", "'\\''")
    return f"file '{escaped}'\n"


def build_video(
    manifest_path: Path,
    output: Path,
    *,
    final_mode: bool,
    overwrite: bool,
    keep_workdir: bool,
) -> None:
    output = output.resolve()
    if output == FINAL_OUTPUT.resolve() and not final_mode:
        fail("Refusing to touch submission/Uptime402_Demo.mp4 without --final")
    if final_mode and output != FINAL_OUTPUT.resolve():
        fail("--final output must be submission/Uptime402_Demo.mp4")
    if output.exists() and not overwrite:
        fail(f"Output exists; pass --overwrite only after visual QA: {output}")
    manifest, scenes = validate_manifest(manifest_path, require_inputs=True, final_mode=final_mode)
    output.parent.mkdir(parents=True, exist_ok=True)

    temporary = tempfile.mkdtemp(prefix="uptime402-demo-replay-")
    workdir = Path(temporary)
    try:
        videos = [render_scene(scene, manifest, index, workdir) for index, scene in enumerate(scenes, start=1)]
        concat_file = workdir / "concat.txt"
        concat_file.write_text(
            "".join(concat_entry(path) for path in videos),
            encoding="utf-8",
        )
        combined = workdir / "combined.mp4"
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-y",
                str(combined),
            ]
        )
        report = qa_video(combined, expected_duration=int(manifest["outputDurationSeconds"]))
        candidate = output.with_name(f".{output.name}.candidate")
        shutil.copyfile(combined, candidate)
        os.replace(candidate, output)
        report["video"] = str(output)
        report["sha256"] = sha256_file(output)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if keep_workdir:
            print(f"Kept work directory: {workdir}", file=sys.stderr)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


def print_shots(manifest_path: Path) -> None:
    manifest, scenes = validate_manifest(manifest_path, require_inputs=False, final_mode=False)
    elapsed = 0
    print(f"run={manifest['runId']} duration={manifest['outputDurationSeconds']}s stage={manifest['stage']}")
    for index, scene in enumerate(scenes, start=1):
        end = elapsed + int(scene["durationSeconds"])
        print(
            f"{index:02d}  {elapsed:03d}-{end:03d}s  {scene['id']}\n"
            f"    input: {scene['image']}\n"
            f"    shot:  {scene['shot']}\n"
            f"    callout: {scene['callout']}"
        )
        elapsed = end


def audit_narration(manifest_path: Path) -> None:
    manifest, scenes = validate_manifest(manifest_path, require_inputs=False, final_mode=False)
    with tempfile.TemporaryDirectory(prefix="uptime402-narration-audit-") as raw:
        workdir = Path(raw)
        total_audio = 0.0
        for index, scene in enumerate(scenes, start=1):
            path = workdir / f"scene-{index:02d}.aiff"
            duration = make_narration(scene, manifest, path)
            total_audio += duration
            print(
                f"PASS {scene['id']}: narration={duration:.3f}s "
                f"scene={scene['durationSeconds']}s headroom={float(scene['durationSeconds']) - duration:.3f}s"
            )
        print(f"Narration audit passed: {len(scenes)} scenes, {total_audio:.3f}s spoken audio")


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    shots = subparsers.add_parser("shots", help="Print the required screenshot sequence")
    shots.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)

    validate = subparsers.add_parser("validate", help="Validate evidence bindings and all screenshot inputs")
    validate.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    validate.add_argument("--final", action="store_true")

    narration = subparsers.add_parser("audit-narration", help="Generate temporary say audio and verify timing")
    narration.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)

    build = subparsers.add_parser("build", help="Build a local preview or guarded final MP4")
    build.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    build.add_argument("--output", type=Path, default=DEFAULT_PREVIEW)
    build.add_argument("--final", action="store_true")
    build.add_argument("--overwrite", action="store_true")
    build.add_argument("--keep-workdir", action="store_true")

    qa = subparsers.add_parser("qa", help="Run ffprobe checks and extract one midpoint frame per scene")
    qa.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    qa.add_argument("--video", type=Path, required=True)
    qa.add_argument("--samples-dir", type=Path)
    qa.add_argument("--report", type=Path)

    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    if args.command == "shots":
        print_shots(manifest_path)
    elif args.command == "validate":
        validate_manifest(manifest_path, require_inputs=True, final_mode=args.final)
        print("Replay manifest, evidence bindings, and screenshot inputs are valid.")
    elif args.command == "audit-narration":
        audit_narration(manifest_path)
    elif args.command == "build":
        build_video(
            manifest_path,
            args.output,
            final_mode=args.final,
            overwrite=args.overwrite,
            keep_workdir=args.keep_workdir,
        )
    elif args.command == "qa":
        _, scenes = validate_manifest(manifest_path, require_inputs=False, final_mode=False)
        video = args.video.resolve()
        if not video.is_file():
            fail(f"Video is missing: {video}")
        report = qa_video(video)
        if args.samples_dir:
            report["sampleFrames"] = extract_samples(video, scenes, args.samples_dir.resolve())
        if args.report:
            write_json(args.report.resolve(), report)
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except WorkflowError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
