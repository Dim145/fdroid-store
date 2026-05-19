from fastapi import APIRouter

from app.api.v1 import (
    admin,
    api_keys,
    apks,
    apps,
    auth,
    categories,
    collaborators,
    feeds,
    github_sources,
    health,
    me,
    media,
    setup,
    totp,
    users,
)

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(setup.router, prefix="/setup", tags=["setup"])
api_router.include_router(me.router, prefix="/me", tags=["me"])
api_router.include_router(api_keys.router, prefix="/me/api-keys", tags=["api-keys"])
api_router.include_router(totp.router, prefix="/me/totp", tags=["totp"])
# media must be registered BEFORE apps so that /apps/{id}/icon does not match
# the apps router's catch-all /{app_ref} path parameter
api_router.include_router(media.router, prefix="/apps", tags=["media"])
api_router.include_router(collaborators.router, prefix="/apps", tags=["collaborators"])
api_router.include_router(github_sources.router, prefix="/apps", tags=["github-sources"])
api_router.include_router(apps.router, prefix="/apps", tags=["apps"])
api_router.include_router(apks.router, prefix="/apks", tags=["apks"])
api_router.include_router(categories.router, prefix="/categories", tags=["categories"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(feeds.router, prefix="/feed", tags=["feeds"])
