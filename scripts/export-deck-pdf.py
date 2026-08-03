#!/usr/bin/env python3
"""Export the artifact-tool slide renders as a lossless, 16:9 PDF.

LibreOffice's headless macOS build currently drops Hangul glyphs from this deck
despite the installed fonts being declared in the PPTX. The artifact-tool render
is the visual source of truth, so this exporter places each verified PNG on a
full-bleed PDF page without synthesizing or changing slide content.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


PAGE_WIDTH = 960
PAGE_HEIGHT = 540


def slide_number(path: Path) -> int:
    try:
        return int(path.stem.rsplit("-", 1)[1])
    except (IndexError, ValueError) as exc:
        raise ValueError(f"Unexpected slide filename: {path.name}") from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slides", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    slides = sorted(args.slides.glob("slide-*.png"), key=slide_number)
    if len(slides) != 9:
        raise SystemExit(f"Expected exactly 9 rendered slides, found {len(slides)}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    pdf = Canvas(str(args.output), pagesize=(PAGE_WIDTH, PAGE_HEIGHT), pageCompression=1)
    pdf.setTitle("Uptime402 — Google Cloud x Solana AI Agentic Hackathon")
    pdf.setAuthor("Uptime402")

    for slide in slides:
        image = ImageReader(str(slide))
        width, height = image.getSize()
        if width * 9 != height * 16:
            raise SystemExit(f"Slide is not 16:9: {slide} ({width}x{height})")
        pdf.drawImage(image, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, preserveAspectRatio=True)
        pdf.showPage()

    pdf.save()


if __name__ == "__main__":
    main()
