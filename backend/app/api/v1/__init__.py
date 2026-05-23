from fastapi import APIRouter

from app.api.v1 import (
    admin,
    api_keys,
    apks,
    apps,
    auth,
    backup,
    categories,
    collaborators,
    deploy_tokens,
    feeds,
    github_sources,
    health,
    me,
    media,
    proxies,
    setup,
    stats,
    totp,
    users,
    webauthn,
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
api_router.include_router(deploy_tokens.router, prefix="/apps", tags=["deploy-tokens"])
api_router.include_router(github_sources.router, prefix="/apps", tags=["github-sources"])
api_router.include_router(apps.router, prefix="/apps", tags=["apps"])
api_router.include_router(apks.router, prefix="/apks", tags=["apks"])
api_router.include_router(categories.router, prefix="/categories", tags=["categories"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(backup.router, prefix="/admin/backup", tags=["backup"])
api_router.include_router(feeds.router, prefix="/feed", tags=["feeds"])
api_router.include_router(stats.router, prefix="/stats", tags=["stats"])
api_router.include_router(webauthn.me_router, prefix="/me/webauthn", tags=["webauthn"])
api_router.include_router(webauthn.auth_router, prefix="/auth/webauthn", tags=["webauthn"])
# Source-proxy registry + per-app source binding + popup OAuth return.
# Four sibling routers in proxies.py for clean prefix separation:
#   * admin_router  — /admin/proxies          (admin CRUD)
#   * public_router — /proxies                (uploader-readable wizard catalogue)
#   * per_app_router — /apps/{id}/proxy-source (binding + manual scan)
#   * auth_router   — /auth/proxy-callback    (popup OAuth return)
api_router.include_router(proxies.admin_router, prefix="/admin/proxies", tags=["proxies"])
api_router.include_router(proxies.public_router, prefix="/proxies", tags=["proxies"])
api_router.include_router(proxies.per_app_router, prefix="/apps", tags=["proxies"])
api_router.include_router(proxies.auth_router, prefix="/auth", tags=["proxies"])
