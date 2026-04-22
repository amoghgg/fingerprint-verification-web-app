from django.db import models


class FingerprintTemplate(models.Model):
    """Stores a subject's enrolled fingerprint as a HOG descriptor."""
    name        = models.CharField(max_length=128, unique=True, db_index=True)
    descriptor  = models.TextField()          # JSON-encoded float array (576 values)
    image_hash  = models.CharField(max_length=32, blank=True)
    enrolled_at = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.name} (enrolled {self.enrolled_at:%Y-%m-%d})"
