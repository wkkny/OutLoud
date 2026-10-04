"""THROWAWAY: freeze the real backend; only add a selectable loopback port."""
import argparse
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import wave


def native_probe():
    import numpy as np
    import torch
    import whisper
    import sounddevice as sd
    import pypdfium2 as pdfium
    import Quartz
    from PIL import Image
    from outloud.study_uploads import prepare

    result = {"architecture": platform.machine(), "frozen": bool(getattr(sys, "frozen", False)),
              "python": sys.version, "torch": torch.__version__, "numpy": np.__version__,
              "portaudio_library": sd._libname, "portaudio_version": sd.get_portaudio_version(),
              "pdfium_version": str(pdfium.PDFIUM_INFO), "quartz_import": True}
    # Exercise native kernels and Whisper assets, without loading a model.
    assert torch.tensor([1., 2.]).sum().item() == 3
    assert np.dot(np.array([1., 2.]), np.array([1., 2.])) == 5
    with tempfile.TemporaryDirectory() as folder:
        audio = Path(folder) / "silence.wav"
        with wave.open(str(audio), "wb") as output:
            output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            output.writeframes(b"\0\0" * 16000)
        decoded = whisper.load_audio(str(audio))  # invokes our bundled FFmpeg
        assert decoded.shape == (16000,)
        result["whisper_mel_shape"] = list(whisper.log_mel_spectrogram(decoded).shape)
        tokenizer = whisper.tokenizer.get_tokenizer(False, language="en")
        assert tokenizer.decode(tokenizer.encode("Packaging probe")) == "Packaging probe"
        result["whisper_tokenizer"] = "roundtrip passed; no model loaded"
    image = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(image, format="PNG")
    images, count = prepare(image.getvalue(), None)
    assert count == 1 and images[0][2].startswith(b"\x89PNG")
    # Minimal generated PDF with a text page: no fixtures or repository files.
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    stream = b"BT /F1 12 Tf 20 100 Td (Packaging probe) Tj ET"
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    pdf = b"%PDF-1.4\n"
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf += str(index).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n"
    pdf += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    pages, count = prepare(pdf, None)
    assert count == 1 and "Packaging probe" in pages[0][1]
    # Also execute PDFium's image rendering path.
    with pdfium.PdfDocument(pdf) as document:
        page = document[0]
        bitmap = page.render(scale=1)
        assert bitmap.to_pil().size == (200, 200)
        bitmap.close()
        page.close()
    result["pdf_text_and_render"] = "passed"
    result["image_prepare"] = "passed (no OCR/model request)"
    ffmpeg = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=True)
    result["ffmpeg"] = ffmpeg.stdout.splitlines()[0]
    print(json.dumps(result, indent=2), flush=True)


def main():
    # Whisper executes `ffmpeg` by name. This is an artifact-local PATH only.
    bundled = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "bin"
    os.environ["PATH"] = str(bundled) + ":/usr/bin:/bin:/usr/sbin:/sbin"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--native-probe", action="store_true")
    args = parser.parse_args()
    if args.native_probe:
        native_probe()
        return
    if not 1024 <= args.port <= 65535:
        parser.error("Choose an unused nonprivileged --port; this spike never uses 8765 by default")
    token = os.environ.get("OUTLOUD_DESKTOP_TOKEN")
    if not token:
        parser.error("OUTLOUD_DESKTOP_TOKEN is required")
    import uvicorn
    from outloud.server import create_app

    def shutdown():
        app.state.runtime.begin_shutdown()
        server.should_exit = True

    # No runtime, Ollama client, recorder, or transcription substitutions.
    app = create_app(desktop_token=token, request_shutdown=shutdown)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port))
    server.run()


if __name__ == "__main__":
    main()
