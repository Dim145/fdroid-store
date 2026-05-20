from __future__ import annotations

from functools import lru_cache

from app.core.config import settings
from app.storage.base import Storage
from app.storage.local import LocalStorage
from app.storage.s3 import s3_storage_from_settings


@lru_cache(maxsize=1)
def get_storage() -> Storage:
    if settings.storage_backend == "s3":
        return s3_storage_from_settings()
    return LocalStorage(settings.local_storage_path)
