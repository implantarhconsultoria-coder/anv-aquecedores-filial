import os
import json
import hmac
import base64
import hashlib
from typing import Optional

import httpx
from fastapi import FastAPI, Request, HTTPException
from pydantic import BaseModel

app = FastAPI(title="ANV Product Vision")


def env(name: str) -> str:
    return os.environ.get(name, "")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def read_session(token: str) -> Optional[dict]:
    secret = env("APP_SESSION_SECRET")
    if not secret or not token:
        return None
    try:
        encoded, signature = token.split(".", 1)
        expected = b64url(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        return json.loads(b64url_decode(encoded))
    except Exception:
        return None


def require_auth(request: Request) -> dict:
    user = read_session(request.cookies.get("anv_session") or "")
    if not user:
        raise HTTPException(401, "Sessão inválida ou expirada")
    return user


class AnalyzeIn(BaseModel):
    image_data_url: str
    filename: Optional[str] = None


PROMPT = """Você é o motor de cadastro inteligente da ANV Filial Digital, operação de peças, componentes e acessórios para aquecedores a gás, com forte presença de peças Rinnai.

Analise SOMENTE o que pode ser sustentado pela imagem. Nunca invente código, modelo, dimensão, peso, tensão, material, compatibilidade ou marca.

Objetivo: preencher um cadastro de produto para posterior publicação no Mercado Livre.

Retorne EXCLUSIVAMENTE um JSON válido com esta estrutura:
{
  "product_type": "tipo genérico do item",
  "name": "nome comercial objetivo e seguro",
  "brand": null,
  "model": null,
  "material": null,
  "application": null,
  "compatibility": null,
  "description": "descrição curta baseada no que é visível",
  "technical_details": "características técnicas que são realmente observáveis",
  "suggested_category_terms": ["termo 1", "termo 2"],
  "visible_text": ["textos/códigos realmente legíveis na imagem"],
  "confidence": 0.0,
  "field_confidence": {
    "name": 0.0,
    "brand": 0.0,
    "model": 0.0,
    "material": 0.0,
    "application": 0.0,
    "compatibility": 0.0
  },
  "needs_confirmation": ["campos que não podem ser confirmados pela foto"],
  "warnings": ["qualquer alerta importante"]
}

Regras obrigatórias:
- Se Rinnai não estiver visível ou inequivocamente identificável, brand deve ser null.
- Não deduza dimensões ou peso visualmente.
- Não diga que uma peça serve em modelos específicos sem código/identificação suficiente.
- Para placa/display/painel eletrônico, diferencie placa de controle, display/interface e chicote/cabo quando visível.
- O nome deve ser bom para estoque e anúncio, mas sem promessas não verificadas.
- confidence e field_confidence variam de 0 a 1.
"""


@app.post("/{path:path}")
async def analyze(body: AnalyzeIn, request: Request, path: str = ""):
    require_auth(request)

    image = body.image_data_url.strip()
    if not image.startswith("data:image/") or ";base64," not in image:
        raise HTTPException(400, "Imagem inválida")
    if len(image) > 12_000_000:
        raise HTTPException(413, "Imagem muito grande")

    token = env("AI_GATEWAY_API_KEY") or env("VERCEL_OIDC_TOKEN")
    if not token:
        raise HTTPException(503, "IA do ANV ainda não autenticada na Vercel")

    payload = {
        "model": "openai/gpt-5-mini",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": image, "detail": "high"}},
                ],
            }
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 1400,
    }

    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                "https://ai-gateway.vercel.sh/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException:
        raise HTTPException(504, "A análise da imagem demorou além do esperado")

    if response.status_code >= 400:
        detail = response.text[:1200]
        raise HTTPException(502, {"message": "Falha ao analisar a foto", "gateway_status": response.status_code, "detail": detail})

    try:
        raw = response.json()["choices"][0]["message"]["content"]
        result = json.loads(raw)
    except Exception:
        raise HTTPException(502, "A IA respondeu em formato inválido")

    # Defesa final contra dados inventados: campos vazios continuam vazios.
    allowed = {
        "product_type", "name", "brand", "model", "material", "application",
        "compatibility", "description", "technical_details", "suggested_category_terms",
        "visible_text", "confidence", "field_confidence", "needs_confirmation", "warnings"
    }
    clean = {k: result.get(k) for k in allowed}
    clean["source"] = "image_ai"
    clean["model_used"] = "openai/gpt-5-mini"
    return clean
