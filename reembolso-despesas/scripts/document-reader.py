import json
import re
import sys
import tempfile
from pathlib import Path


def only_digits(value):
    return re.sub(r"\D+", "", str(value or ""))


def data_from_key(key):
    if not re.fullmatch(r"\d{44}", key or ""):
        return {}
    return {
        "chave_acesso": key,
        "cnpj_emitente": key[6:20],
        "modelo": key[20:22],
        "serie": str(int(key[22:25] or "0")),
        "numero_nf": str(int(key[25:34] or "0")),
        "competencia": f"20{key[2:4]}-{key[4:6]}",
    }


def extract_access_key(text):
    match = re.search(r"\b(\d{44})\b", str(text or ""))
    return match.group(1) if match else ""


def decode_qr(image):
    import cv2

    try:
        import zxingcpp

        for candidate in (
            image,
            cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE),
            cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE),
            cv2.rotate(image, cv2.ROTATE_180),
        ):
            results = zxingcpp.read_barcodes(candidate)
            for result in results:
                if result.text:
                    return result.text
    except Exception:
        pass

    detector = cv2.QRCodeDetector()
    h, w = image.shape[:2]
    min_side = min(h, w)
    center_crop = image[int(h * 0.12) : int(h * 0.88), int(w * 0.08) : int(w * 0.92)]
    crops = [
        image,
        center_crop,
        image[int(h * 0.25) :, :],
        image[int(h * 0.35) :, : int(w * 0.65)],
        image[int(h * 0.35) :, int(w * 0.35) :],
        image[: int(h * 0.8), :],
    ]

    if min_side > 900:
        resize_ratio = 900 / min_side
        crops.append(cv2.resize(image, None, fx=resize_ratio, fy=resize_ratio, interpolation=cv2.INTER_AREA))

    def normalized_variants(candidate):
        if candidate is None or not candidate.size:
            return []
        variants = [candidate]
        gray = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY)
        variants.append(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
        clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(gray)
        variants.append(cv2.cvtColor(clahe, cv2.COLOR_GRAY2BGR))
        blurred = cv2.GaussianBlur(clahe, (0, 0), 1.0)
        sharp = cv2.addWeighted(clahe, 1.6, blurred, -0.6, 0)
        variants.append(cv2.cvtColor(sharp, cv2.COLOR_GRAY2BGR))
        _, threshold = cv2.threshold(sharp, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(cv2.cvtColor(threshold, cv2.COLOR_GRAY2BGR))
        adaptive = cv2.adaptiveThreshold(
            sharp,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            41,
            7,
        )
        variants.append(cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR))
        return variants

    def try_decode(candidate):
        data, _points, _straight = detector.detectAndDecode(candidate)
        if data:
            return data
        try:
            ok, decoded, _points, _straight = detector.detectAndDecodeMulti(candidate)
            if ok:
                for item in decoded:
                    if item:
                        return item
        except Exception:
            pass
        return ""

    for crop in crops:
        for scale in (1, 2):
            candidate = crop
            if scale > 1:
                candidate = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            for prepared in normalized_variants(candidate):
                data = try_decode(prepared)
                if data:
                    return data
                for rotate_code in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
                    data = try_decode(cv2.rotate(prepared, rotate_code))
                    if data:
                        return data
    return ""


def images_from_file(file_path):
    suffix = file_path.suffix.lower()
    if suffix == ".pdf":
        import fitz

        doc = fitz.open(str(file_path))
        images = []
        for page in doc[:2]:
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                image_path = Path(tmp.name)
            pix.save(str(image_path))
            images.append(image_path)
        return images
    return [file_path]


def read_image(image_path):
    import cv2
    import numpy as np

    data = np.fromfile(str(image_path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("missing file path")

    import cv2

    file_path = Path(sys.argv[1])
    qr_text = ""
    temp_images = []
    try:
        for image_path in images_from_file(file_path):
            if image_path != file_path:
                temp_images.append(image_path)
            image = read_image(image_path)
            if image is None:
                continue
            qr_text = decode_qr(image)
            if qr_text:
                break
    finally:
        for image_path in temp_images:
            try:
                image_path.unlink(missing_ok=True)
            except Exception:
                pass

    qr_text = str(qr_text or "").lstrip("\ufeff").strip()
    key = extract_access_key(qr_text)
    output = data_from_key(key)
    output["qr_text"] = qr_text
    output["qr_url"] = qr_text if qr_text.startswith(("http://", "https://")) else ""
    output["source"] = "qr_code" if qr_text else "no_qr"
    print(json.dumps(output, ensure_ascii=True))


if __name__ == "__main__":
    main()
