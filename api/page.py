import os

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse

app = FastAPI(title="ANV Page Wrapper")


def env(name: str, fallback: str = "") -> str:
    return os.environ.get(name, fallback)


@app.get("/{path:path}", response_class=HTMLResponse)
async def page(request: Request, path: str = ""):
    mode = request.query_params.get("mode", "desktop")
    if mode not in {"desktop", "mobile"}:
        raise HTTPException(400, "Modo inválido")

    base = env("APP_BASE_URL", "https://anv-aquecedores-filial.vercel.app").rstrip("/")
    source_path = "/desktop-base" if mode == "desktop" else "/mobile-base"

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            r = await client.get(f"{base}{source_path}", headers={"User-Agent": request.headers.get("user-agent", "ANV")})
    except Exception:
        raise HTTPException(502, "Não foi possível carregar a interface ANV")

    if r.status_code != 200:
        raise HTTPException(502, f"Interface base indisponível ({r.status_code})")

    html = r.text
    script = '<script src="/smart.js?v=20261006-1" defer></script>'
    if script not in html:
        if "</body>" in html:
            html = html.replace("</body>", f"{script}</body>")
        else:
            html += script

    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "X-ANV-UI": mode,
        },
    )
