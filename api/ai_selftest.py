import os
import httpx
from fastapi import FastAPI, HTTPException

app = FastAPI(title="ANV AI Selftest")

SELFTEST_KEY = "anv-vision-20261006-7qN4P2"

@app.get("/{path:path}")
async def selftest(path: str = "", key: str = ""):
    if key != SELFTEST_KEY:
        raise HTTPException(404, "Not found")
    token = os.environ.get("AI_GATEWAY_API_KEY") or os.environ.get("VERCEL_OIDC_TOKEN")
    if not token:
        return {"ok": False, "stage": "auth", "reason": "no_gateway_token"}
    payload = {
        "model": "openai/gpt-5-mini",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Observe a imagem e responda somente JSON válido: {\"image_seen\":true,\"what\":\"descrição curta\"}"},
                {"type": "image_url", "image_url": {"url": "https://assets.vercel.com/image/upload/v1662130559/nextjs/Icon_light_background.png", "detail": "low"}}
            ]
        }],
        "response_format": {"type": "json_object"},
        "max_tokens": 150
    }
    try:
        async with httpx.AsyncClient(timeout=35) as client:
            r = await client.post("https://ai-gateway.vercel.sh/v1/chat/completions", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, json=payload)
    except Exception as e:
        return {"ok": False, "stage": "request", "reason": type(e).__name__}
    if r.status_code >= 400:
        return {"ok": False, "stage": "gateway", "status": r.status_code, "detail": r.text[:500]}
    try:
        content = r.json()["choices"][0]["message"]["content"]
    except Exception:
        return {"ok": False, "stage": "parse", "status": r.status_code}
    return {"ok": True, "stage": "complete", "model": "openai/gpt-5-mini", "vision_response": content[:500]}
