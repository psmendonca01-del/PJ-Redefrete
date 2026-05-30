import json
import re
import sys
import tempfile
from pathlib import Path


def only_digits(value):
    return re.sub(r"\D+", "", str(value or ""))


def parse_money(value):
    clean = re.sub(r"[^\d,.-]+", "", str(value or "")).replace(".", "").replace(",", ".")
    try:
        return round(float(clean), 2)
    except ValueError:
        return None


def extract_access_key(text):
    match = re.search(r"(?:chave=|chave\s+de\s+acesso[^\d]*)(\d{50})", text, re.I)
    if match:
        return match.group(1)
    match = re.search(r"\b(\d{50})\b", text)
    return match.group(1) if match else ""


def data_from_key(key):
    if not re.fullmatch(r"\d{50}", key or ""):
        return {}
    return {
        "chave_acesso": key,
        "cnpj_emitente": key[9:23],
        "numero_nf": str(int(key[23:36] or "0")),
    }


def decode_qr(image):
    import cv2

    detector = cv2.QRCodeDetector()
    crops = [
        image,
        image[: int(image.shape[0] * 0.35), :],
        image[: int(image.shape[0] * 0.35), int(image.shape[1] * 0.55) :],
    ]
    for crop in crops:
        for scale in (1, 2, 3, 4):
            candidate = crop
            if scale > 1:
                candidate = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            data, _points, _straight = detector.detectAndDecode(candidate)
            if data:
                return data
    return ""


def read_ocr(image_path):
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception:
        return []

    engine = RapidOCR()
    result, _elapsed = engine(str(image_path))
    return [item[1] for item in (result or []) if len(item) >= 2 and item[1]]


def extract_value(text):
    normalized = "\n".join(line.strip() for line in str(text or "").splitlines() if line.strip())
    compact = re.sub(r"\s+", "", normalized)
    compact_labeled = re.search(
        r"VALORTOTALDOSERVI[ÇC]O=R[ＳS]?\$?(\d{1,3}(?:\.\d{3})*,\d{2})",
        compact,
        re.I,
    )
    if compact_labeled:
        return parse_money(compact_labeled.group(1))
    labeled = re.search(
        r"Valor\s+Liquido\s+da\s+NFS-?e[\s\S]{0,80}?(R?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2})",
        normalized,
        re.I,
    )
    if labeled:
        return parse_money(labeled.group(1))
    amounts = re.findall(r"R?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}", normalized, re.I)
    parsed = [value for value in (parse_money(amount) for amount in amounts) if value is not None]
    return parsed[-1] if parsed else None


def extract_number_from_ocr(lines):
    clean_lines = [str(line or "").strip() for line in lines if str(line or "").strip()]
    for index, line in enumerate(clean_lines):
        normalized = line.lower()
        is_number_label = (
            "numero da nota" in normalized
            or "número da nota" in normalized
            or "numero da nfs" in normalized
            or ("mero da nota" in normalized and normalized.startswith("n"))
        )
        if not is_number_label:
            continue
        for candidate in clean_lines[index + 1 : index + 12]:
            digits = only_digits(candidate)
            if 1 <= len(digits) <= 12 and re.fullmatch(r"\d+", digits):
                return str(int(digits))
    return ""


def main():
    if len(sys.argv) < 2:
        raise SystemExit("missing pdf path")

    import cv2
    import fitz

    pdf_path = Path(sys.argv[1])
    doc = fitz.open(str(pdf_path))
    page = doc[0]
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        image_path = Path(tmp.name)
    pix.save(str(image_path))

    image = cv2.imread(str(image_path))
    qr_text = decode_qr(image) if image is not None else ""
    ocr_lines = read_ocr(image_path)
    try:
        image_path.unlink(missing_ok=True)
    except Exception:
        pass

    ocr_text = "\n".join(ocr_lines)
    output = data_from_key(extract_access_key("\n".join([qr_text, ocr_text])))
    numero_ocr = extract_number_from_ocr(ocr_lines)
    value = extract_value(ocr_text)
    cnpj_match = re.search(r"\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}", ocr_text)

    if numero_ocr and not output.get("numero_nf"):
        output["numero_nf"] = numero_ocr
    if value is not None:
        output["valor_nf"] = value
    if not output.get("cnpj_emitente") and cnpj_match:
        output["cnpj_emitente"] = only_digits(cnpj_match.group(0))[:14]
    output["layout"] = "danfse-image"
    output["source"] = "qr_ocr" if output.get("chave_acesso") and value is not None else "image_fallback"

    print(json.dumps(output, ensure_ascii=True))


if __name__ == "__main__":
    main()
