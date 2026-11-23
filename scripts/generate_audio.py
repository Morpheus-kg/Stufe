#!/usr/bin/env python3
"""
Offline German audio generator for Stufe PWA using Piper TTS + ffmpeg.

Reads project card JSON files (arrays or { "cards": [...] } exports),
synthesizes WAV via standalone piper/piper.exe (or python -m piper fallback),
transcodes directly via ffmpeg to MP3 (default) or OGG, saves files into
public/audio/de/ under deterministic SHA-256 filenames, and writes
public/audio/de/manifest.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

VALID_ARTICLES = {"der", "die", "das"}
# Exact same edge-punctuation class as public/js/services/audio_player.js
_EDGE_PUNCT_RE = re.compile(
    r"^[\s.,!?;:()\[\]{}\"'„“”«»…—–-]+|[\s.,!?;:()\[\]{}\"'„“”«»…—–-]+$"
)
_QUOTES_RE = re.compile(r"[„“”«»\"]")
_APOS_RE = re.compile(r"[’`´]")
_WS_RE = re.compile(r"\s+")
_LEADING_ARTICLE_RE = re.compile(r"^(der|die|das)\s+(.+)$", re.IGNORECASE)


def normalize_audio_key(text: Any) -> str:
    """
    Canonical lookup key identical to normalizeAudioKey() in JS:
    NFC -> unify apostrophes / strip quotes -> collapse whitespace ->
    strip outer punctuation -> lowercase (preserving ß and umlauts).
    """
    if text is None:
        return ""
    s = unicodedata.normalize("NFC", str(text))
    s = _APOS_RE.sub("'", s)
    s = _QUOTES_RE.sub("", s)
    s = _WS_RE.sub(" ", s).strip()
    s = _EDGE_PUNCT_RE.sub("", s)
    s = _WS_RE.sub(" ", s).strip()
    # Use .lower() (NOT .casefold()) so 'ß' stays 'ß' matching JS .toLowerCase()
    return s.lower()


def clean_speech_text(text: Any) -> str:
    """Clean text passed to Piper TTS while preserving German capitalization/punctuation."""
    if text is None:
        return ""
    s = unicodedata.normalize("NFC", str(text))
    s = _WS_RE.sub(" ", s).strip()
    return s


def audio_hash(key: str) -> str:
    """Deterministic 16-char hex digest from canonical key."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def resolve_inputs(raw_inputs: list[str] | None, repo_root: Path) -> list[Path]:
    """Collect JSON files from explicit paths or default repo card sources."""
    paths: list[Path] = []
    if raw_inputs:
        for raw in raw_inputs:
            p = Path(raw)
            if not p.is_absolute():
                p = (repo_root / p).resolve() if not p.exists() else p.resolve()
            if p.is_dir():
                paths.extend(sorted(p.glob("*.json")))
            elif p.is_file():
                paths.append(p)
            else:
                print(f"[warn] Input not found, skipping: {raw}", file=sys.stderr)
    else:
        default_card = repo_root / "card1.json"
        if default_card.is_file():
            paths.append(default_card)
        import_dir = repo_root / "import"
        if import_dir.is_dir():
            paths.extend(sorted(import_dir.glob("*.json")))
    # Deduplicate preserving order
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in paths:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            unique.append(rp)
    return unique


def extract_cards_from_json(path: Path) -> list[dict[str, Any]]:
    """Load cards from array JSON or { cards: [...] } backup/gt-deck JSON."""
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict) and isinstance(data.get("cards"), list):
        return [x for x in data["cards"] if isinstance(x, dict)]
    return []


def collect_phrases(
    json_files: list[Path],
    include_examples: bool = True,
    include_bare_nouns: bool = True,
) -> dict[str, str]:
    """
    Return ordered mapping: normalized_key -> original_german_text_for_tts.
    Handles 'article': 'null' strings, embedded articles in term, and examples.
    """
    phrases: dict[str, str] = {}

    def add(raw: Any) -> None:
        speech = clean_speech_text(raw)
        if not speech or len(speech) < 2:
            return
        key = normalize_audio_key(speech)
        if key and key not in phrases:
            phrases[key] = speech

    for jf in json_files:
        try:
            cards = extract_cards_from_json(jf)
        except Exception as exc:
            print(f"[warn] Failed to parse {jf}: {exc}", file=sys.stderr)
            continue

        for card in cards:
            term = clean_speech_text(card.get("term"))
            if not term or len(term) < 2:
                continue

            raw_art = clean_speech_text(card.get("article")).lower()
            article = raw_art if raw_art in VALID_ARTICLES else None

            m = _LEADING_ARTICLE_RE.match(term)
            if m:
                embedded_art = m.group(1).lower()
                bare_term = m.group(2).strip()
                display = f"{article or embedded_art} {bare_term}"
                add(display)
                if include_bare_nouns and bare_term:
                    add(bare_term)
            elif article:
                add(f"{article} {term}")
                if include_bare_nouns:
                    add(term)
            else:
                add(term)

            if include_examples:
                example = clean_speech_text(card.get("example"))
                if example and len(example) >= 3:
                    add(example)

                examples_list = card.get("examples") or card.get("examples_json")
                if isinstance(examples_list, str):
                    try:
                        examples_list = json.loads(examples_list)
                    except Exception:
                        examples_list = None
                if isinstance(examples_list, list):
                    for ex in examples_list:
                        if isinstance(ex, dict) and ex.get("de"):
                            add(ex["de"])

    return phrases


def find_piper_command(explicit_bin: str | None) -> list[str]:
    """
    Locate standalone piper / piper.exe binary first (preferred on Windows + Python 3.13),
    falling back to `python -m piper` if installed.
    """
    candidates = []
    if explicit_bin:
        candidates.append(explicit_bin)
    env_bin = os.environ.get("PIPER_BIN", "").strip()
    if env_bin:
        candidates.append(env_bin)

    for cand in candidates:
        p = Path(cand)
        if p.is_file():
            return [str(p)]
        found = shutil.which(cand)
        if found:
            return [found]

    for name in ("piper", "piper.exe"):
        found = shutil.which(name)
        if found:
            return [found]

    # Fallback: python -m piper
    try:
        import importlib.util

        if importlib.util.find_spec("piper") is not None:
            return [sys.executable, "-m", "piper"]
    except Exception:
        pass

    raise FileNotFoundError(
        "Piper executable not found. Install piper binary and pass --piper-bin "
        "(or set PIPER_BIN env var / add piper.exe to PATH)."
    )


def find_ffmpeg_bin(explicit_bin: str | None) -> str:
    for cand in (explicit_bin, os.environ.get("FFMPEG_BIN", "").strip(), "ffmpeg", "ffmpeg.exe"):
        if not cand:
            continue
        p = Path(cand)
        if p.is_file():
            return str(p)
        found = shutil.which(cand)
        if found:
            return found
    raise FileNotFoundError(
        "ffmpeg not found. Install ffmpeg and add it to PATH or pass --ffmpeg-bin."
    )


def synthesize_wav(
    piper_cmd: list[str],
    model_path: Path,
    text: str,
    wav_out: Path,
    length_scale: float,
) -> None:
    cmd = [
        *piper_cmd,
        "--model",
        str(model_path),
        "--output_file",
        str(wav_out),
        "--length_scale",
        f"{length_scale:.2f}",
    ]
    proc = subprocess.run(
        cmd,
        input=(text + "\n").encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0 or not wav_out.is_file() or wav_out.stat().st_size < 64:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Piper failed (code {proc.returncode}): {err or 'empty WAV'}")


def transcode_audio(ffmpeg_bin: str, wav_in: Path, out_file: Path, fmt: str) -> None:
    if fmt == "ogg":
        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_in),
            "-ac",
            "1",
            "-codec:a",
            "libopus",
            "-b:a",
            "48k",
            "-vbr",
            "on",
            str(out_file),
        ]
    else:
        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_in),
            "-ac",
            "1",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "4",
            str(out_file),
        ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not out_file.is_file() or out_file.stat().st_size == 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg failed (code {proc.returncode}): {err}")


def load_existing_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.is_file():
        return {"entries": {}}
    try:
        with manifest_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("entries"), dict):
            return data
    except Exception:
        pass
    return {"entries": {}}


def write_manifest_atomic(manifest_path: Path, payload: dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, manifest_path)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Generate offline German Piper TTS audio assets and manifest.json for Stufe PWA."
    )
    p.add_argument(
        "--input",
        nargs="+",
        help="JSON card file(s) or directory(ies). Default: card1.json + import/*.json",
    )
    p.add_argument(
        "--model",
        default=os.environ.get("PIPER_MODEL_PATH", "models/de_DE-thorsten-high.onnx"),
        help="Path to Piper ONNX model (default: PIPER_MODEL_PATH or models/de_DE-thorsten-high.onnx)",
    )
    p.add_argument(
        "--output-dir",
        default="public/audio/de",
        help="Static output directory (default: public/audio/de)",
    )
    p.add_argument(
        "--manifest",
        default=None,
        help="Manifest JSON path (default: <output-dir>/manifest.json)",
    )
    p.add_argument(
        "--format",
        choices=("mp3", "ogg"),
        default="mp3",
        help="Output audio codec/container (default: mp3)",
    )
    p.add_argument(
        "--normal-scale",
        type=float,
        default=1.0,
        help="Piper --length_scale for normal speed (default: 1.0)",
    )
    p.add_argument(
        "--slow",
        action="store_true",
        help="Also generate slowed-down audio (--length_scale 1.2)",
    )
    p.add_argument(
        "--slow-scale",
        type=float,
        default=1.2,
        help="Piper --length_scale for slow speed (default: 1.2)",
    )
    p.add_argument(
        "--no-examples",
        action="store_true",
        help="Skip card example sentences and only synthesize terms/phrases",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Regenerate files even if they already exist",
    )
    p.add_argument(
        "--piper-bin",
        default=None,
        help="Path to piper / piper.exe executable (overrides PIPER_BIN env)",
    )
    p.add_argument(
        "--ffmpeg-bin",
        default=None,
        help="Path to ffmpeg executable (overrides FFMPEG_BIN env)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print extracted phrase count and planned filenames without running Piper/ffmpeg",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent

    out_dir = Path(args.output_dir)
    if not out_dir.is_absolute():
        out_dir = (repo_root / out_dir).resolve()
    manifest_path = Path(args.manifest) if args.manifest else (out_dir / "manifest.json")
    if not manifest_path.is_absolute():
        manifest_path = (repo_root / manifest_path).resolve()

    json_files = resolve_inputs(args.input, repo_root)
    if not json_files:
        print("[error] No input JSON card files found.", file=sys.stderr)
        return 1

    phrases = collect_phrases(json_files, include_examples=not args.no_examples)
    print(f"Loaded {len(phrases)} unique German phrases from {len(json_files)} file(s).")

    if args.dry_run:
        sample = list(phrases.items())[:10]
        for key, speech in sample:
            h = audio_hash(key)
            slow_note = f", {h}_slow.{args.format}" if args.slow else ""
            print(f"  {h}.{args.format}{slow_note}  <=  {speech!r}  (key={key!r})")
        if len(phrases) > len(sample):
            print(f"  ... and {len(phrases) - len(sample)} more")
        return 0

    model_path = Path(args.model)
    if not model_path.is_absolute():
        model_path = (repo_root / model_path).resolve() if not model_path.exists() else model_path.resolve()
    if not model_path.is_file():
        print(
            f"[error] Piper ONNX model not found: {model_path}\n"
            "Download de_DE-thorsten-high.onnx (+ .onnx.json) and pass --model or set PIPER_MODEL_PATH.",
            file=sys.stderr,
        )
        return 1

    try:
        piper_cmd = find_piper_command(args.piper_bin)
        ffmpeg_bin = find_ffmpeg_bin(args.ffmpeg_bin)
    except FileNotFoundError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    existing_manifest = load_existing_manifest(manifest_path)
    entries: dict[str, dict[str, str]] = {}
    # Retain previously recorded entries whose files still exist on disk
    for k, val in existing_manifest.get("entries", {}).items():
        if not isinstance(val, dict):
            continue
        kept: dict[str, str] = {}
        if isinstance(val.get("normal"), str) and (out_dir / val["normal"]).is_file():
            kept["normal"] = val["normal"]
        if isinstance(val.get("slow"), str) and (out_dir / val["slow"]).is_file():
            kept["slow"] = val["slow"]
        if kept:
            entries[k] = kept

    generated = 0
    skipped = 0
    failed = 0

    with tempfile.TemporaryDirectory(prefix="stufe_piper_") as tmp_dir:
        tmp_wav = Path(tmp_dir) / "out.wav"

        for idx, (key, speech) in enumerate(phrases.items(), start=1):
            digest = audio_hash(key)
            normal_name = f"{digest}.{args.format}"
            slow_name = f"{digest}_slow.{args.format}"
            entry = dict(entries.get(key, {}))

            variants: list[tuple[str, str, float]] = [("normal", normal_name, args.normal_scale)]
            if args.slow:
                variants.append(("slow", slow_name, args.slow_scale))

            for slot, filename, scale in variants:
                target = out_dir / filename
                if target.is_file() and target.stat().st_size > 0 and not args.force:
                    entry[slot] = filename
                    skipped += 1
                    continue
                try:
                    if tmp_wav.exists():
                        tmp_wav.unlink()
                    synthesize_wav(piper_cmd, model_path, speech, tmp_wav, scale)
                    transcode_audio(ffmpeg_bin, tmp_wav, target, args.format)
                    entry[slot] = filename
                    generated += 1
                except Exception as exc:
                    failed += 1
                    print(f"[error] ({idx}/{len(phrases)}) {speech!r} [{slot}]: {exc}", file=sys.stderr)

            if entry:
                entries[key] = entry

    # Compute basePath relative to public/
    public_dir = (repo_root / "public").resolve()
    try:
        rel = out_dir.relative_to(public_dir).as_posix().strip("/")
        base_path = f"/{rel}/" if rel else "/"
    except ValueError:
        base_path = "/audio/de/"

    manifest_payload = {
        "version": 1,
        "format": args.format,
        "basePath": base_path,
        "model": model_path.name,
        "entries": entries,
    }
    write_manifest_atomic(manifest_path, manifest_payload)
    print(
        f"Done. generated={generated}, skipped={skipped}, failed={failed}, "
        f"manifest={manifest_path} ({len(entries)} entries)"
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
