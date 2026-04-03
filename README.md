# Fingerprint Verification Web App

A browser-based fingerprint enrollment and verification system that runs entirely from the device camera — no hardware scanner required. Uses TensorFlow.js for real-time thumb detection, OpenCV.js for image enhancement in-browser, and integrates with the BioPass ID API for production-level fingerprint matching.

Built and tested on iPhone 13 front camera. Works on desktop webcam as well.

## How it works

1. User opens the app on any device with a camera
2. TensorFlow.js Handpose model detects when a thumb is held up to the camera
3. App auto-captures the frame (or user captures manually via button or spacebar)
4. OpenCV.js applies CLAHE contrast enhancement and sharpening in-browser — no server round-trip for image processing
5. Enhanced image is base64-encoded and sent to the Django backend
6. Backend forwards to BioPass ID API in either **Enroll** or **Verify** mode
7. Verification result is returned with match outcome and efficiency score

## Features

- Real-time thumb detection via TensorFlow.js Handpose
- Auto-capture on thumb detection or manual capture
- In-browser image enhancement (CLAHE + sharpening) via OpenCV.js
- Enroll and Verify modes with distinct flows
- Front-camera support for mobile
- Works without fingerprint hardware (no MFS110 sensor required)
- JSON payloads with unique CustomID per user

## Stack

| | |
|---|---|
| Frontend | HTML, JavaScript, TensorFlow.js, OpenCV.js |
| Backend | Django, Django REST Framework |
| Biometric API | BioPass ID |
| Transport | Base64 over REST |

## Running locally

```bash
cd backend
pip install -r requirements.txt
python manage.py runserver
```

Open `frontend/index.html` in a browser (or serve it via the Django static files setup).

For production use, configure your BioPass ID API credentials in the Django settings:

```
BIOPASS_API_URL=https://...
BIOPASS_API_KEY=your_key
```

## Notes on accuracy

Camera-based fingerprint capture is not equivalent to optical or capacitive sensor capture in terms of minutiae extraction accuracy. This system is designed for scenarios where dedicated hardware isn't available — it works well for low-to-medium security use cases and as a proof of concept for browser-native biometrics.
