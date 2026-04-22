import base64
import hashlib
import json
import logging
import os

import numpy as np
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from io import BytesIO
from PIL import Image

from .models import FingerprintTemplate

logger = logging.getLogger(__name__)

# ── BioPass ID (optional) ──────────────────────────────────────────────────
BIOPASS_KEY        = os.getenv("BIOPASS_API_KEY", "")
BIOPASS_ENROLL_URL = "https://api.biopassid.com/multibiometrics/enroll"
BIOPASS_VERIFY_URL = "https://api.biopassid.com/multibiometrics/verify"

# ── Local matching ─────────────────────────────────────────────────────────
MATCH_THRESHOLD = 0.68   # cosine similarity
HOG_SIZE        = 128
HOG_CELL        = 16
HOG_BINS        = 9


def _b64_to_gray(b64: str) -> np.ndarray:
    """Decode base64 PNG/JPEG, convert to grayscale 128×128 float array."""
    img_bytes = base64.b64decode(b64)
    img = Image.open(BytesIO(img_bytes)).convert("L").resize((HOG_SIZE, HOG_SIZE))
    return np.array(img, dtype=np.float32)


def _extract_hog(gray: np.ndarray) -> np.ndarray:
    """
    Simplified HOG descriptor matching the browser implementation.
    128×128 input → 8×8 grid of 16×16 cells → 9 orientation bins → 576-dim vector.
    """
    cells = HOG_SIZE // HOG_CELL  # 8
    desc  = []

    for cy in range(cells):
        for cx in range(cells):
            patch = gray[cy * HOG_CELL:(cy + 1) * HOG_CELL,
                         cx * HOG_CELL:(cx + 1) * HOG_CELL]
            gx  = np.gradient(patch, axis=1)
            gy  = np.gradient(patch, axis=0)
            mag = np.sqrt(gx ** 2 + gy ** 2)
            ang = (np.arctan2(gy, gx) * 180.0 / np.pi + 180.0) % 180.0
            hist, _ = np.histogram(ang, bins=HOG_BINS, range=(0, 180), weights=mag)
            desc.extend(hist.tolist())

    arr  = np.array(desc, dtype=np.float32)
    norm = np.linalg.norm(arr) + 1e-6
    return arr / norm


def _cosine_sim(a: list, b: np.ndarray) -> float:
    return float(np.dot(np.array(a, dtype=np.float32), b))


# ── Views ──────────────────────────────────────────────────────────────────

@csrf_exempt
def verify_fingerprint(request):
    if request.method != "POST":
        return JsonResponse({"error": "POST only"}, status=405)

    try:
        data        = json.loads(request.body)
        fingerprint = data.get("fingerprint", "").strip()
        name        = (data.get("name") or "anonymous").strip().lower()
        mode        = data.get("mode", "enroll")

        if not fingerprint:
            return JsonResponse({"error": "No fingerprint provided"}, status=400)

        gray       = _b64_to_gray(fingerprint)
        descriptor = _extract_hog(gray)
        img_hash   = hashlib.sha256(fingerprint.encode()).hexdigest()[:24]

        # ── Enroll ────────────────────────────────────────────────
        if mode == "enroll":
            FingerprintTemplate.objects.update_or_create(
                name=name,
                defaults={
                    "descriptor": json.dumps(descriptor.tolist()),
                    "image_hash": img_hash,
                },
            )
            logger.info("Enrolled subject: %s", name)
            return JsonResponse({
                "enrolled": True,
                "name": name,
                "score": 100,
                "reason": f'Subject "{name}" enrolled successfully',
            })

        # ── Verify ────────────────────────────────────────────────
        try:
            template = FingerprintTemplate.objects.get(name=name)
        except FingerprintTemplate.DoesNotExist:
            return JsonResponse({
                "matched": False,
                "score": 0,
                "reason": f'Subject "{name}" is not enrolled',
            })

        stored  = json.loads(template.descriptor)
        sim     = _cosine_sim(stored, descriptor)
        score   = round(max(0.0, min(1.0, sim)) * 100)
        matched = sim >= MATCH_THRESHOLD

        # Optionally call BioPass ID if the key is configured
        if BIOPASS_KEY:
            try:
                import requests as req
                payload = {
                    "Person": {
                        "CustomID": name,
                        "Fingers":  [{"Finger-1": fingerprint}],
                    }
                }
                headers = {
                    "Content-Type":               "application/json",
                    "Ocp-Apim-Subscription-Key":  BIOPASS_KEY,
                }
                url  = BIOPASS_VERIFY_URL
                resp = req.post(url, headers=headers, json=payload, timeout=8)
                if resp.ok:
                    bp = resp.json()
                    matched = bp.get("Person", {}).get("Match", matched)
                    bp_score = bp.get("Person", {}).get("Score")
                    if bp_score is not None:
                        score = int(bp_score)
            except Exception as exc:
                logger.warning("BioPass ID call failed: %s", exc)

        reason = (
            f"Fingerprint verified — similarity {score}%"
            if matched else
            f"No match — similarity too low ({score}%)"
        )
        logger.info("Verify %s → matched=%s score=%s", name, matched, score)
        return JsonResponse({"matched": matched, "score": score, "reason": reason})

    except Exception as exc:
        logger.exception("verify_fingerprint error")
        return JsonResponse({"error": str(exc)}, status=500)
