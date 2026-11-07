from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

import requests

from ..retrieval.candidate_selection import ParsedTextAttributes, parse_text_attributes

if __package__:
    from ..env import load_pipeline_env
else:
    from env import load_pipeline_env

load_pipeline_env()

DEFAULT_INTENT_MODEL = "gemini-3.5-flash"
INTENT_MODEL_ENV = "GEMINI_INTENT_MODEL"
LEGACY_METADATA_MODEL_ENV = "GEMINI_METADATA_MODEL"
LEGACY_GEMINI_MODEL_ENV = "GEMINI_MODEL"

INFERENCE_PROMPT_TEMPLATE = """You are a fashion search intent analyzer.

User query: {user_query}

{image_instruction}

---

Step 1 — Identify mentioned attributes (think first):
Read the query carefully. List ONLY the attributes the user explicitly stated. Do NOT add anything the user did not say.
Ask yourself: "Did the user actually say this?" If not, exclude it.

CRITICAL — Do NOT infer attributes from the garment type name itself.
Examples of forbidden inference:
- User says "티셔츠" → do NOT add sleeve:short (user didn't mention sleeve)
- User says "치마" or "원피스" → do NOT add sex:female (user didn't mention sex)
- User says "슬렉스" → do NOT add length:long (user didn't mention length)
- User says "후드" → do NOT add sex:unisex (user didn't mention sex)
Only category1 may be derived from the garment type name. Nothing else.

Step 2 — Map to schema:
For each attribute identified in Step 1, assign a value using the schema below.

Fixed attributes (use predefined values only):
- category1: top / pants / dress / skirt
- sleeve: long / short / sleeveless  → only for tops
- length: long / half / short  → only for pants / skirt / dress
- sex: male / female / unisex
- season: spring / summer / fall / winter
- stretch: yes / no
- thickness: thin / medium / thick
- fit: slim / regular / loose / oversize

Step 3 — Output:
Respond with valid JSON only. Include ONLY the attributes from Step 1. No extras.

{{
  "<attribute>": "<value>",
  "reasoning": "한국어로, 각 속성에 대해 사용자가 실제로 말한 표현을 인용하여 설명. 사용자가 직접 말하지 않은 속성은 절대 포함하지 말 것."
}}"""

_VALUE_ALIASES = {
    ("category1", "dress"): "one-piece",
    ("fit", "oversize"): "oversized",
}

_ALLOWED_VALUES: dict[str, set[str]] = {
    "category1": {"top", "pants", "skirt", "dress", "one-piece"},
    "sex": {"male", "female", "unisex"},
    "sleeve": {"short", "long", "sleeveless"},
    "length": {"short", "half", "long"},
    "season": {"spring", "summer", "fall", "winter"},
    "stretch": {"yes", "no"},
    "thickness": {"thin", "medium", "thick"},
    "fit": {"slim", "regular", "loose", "oversized", "oversize"},
}


@dataclass(frozen=True)
class ConservativeMetadataExtraction:
    attributes: ParsedTextAttributes
    status: str
    method: str
    prompt_id: str
    raw_output: str
    error: str | None = None
    model_name: str | None = None

    def to_metadata(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "method": self.method,
            "prompt_id": self.prompt_id,
            "fields": sorted(self.attributes.to_dict()),
            "error": self.error,
            "model": self.model_name,
        }


def resolve_intent_model(model_name: str | None = None) -> str:
    return (
        model_name
        or os.getenv(INTENT_MODEL_ENV)
        or os.getenv(LEGACY_METADATA_MODEL_ENV)
        or os.getenv(LEGACY_GEMINI_MODEL_ENV)
        or DEFAULT_INTENT_MODEL
    )


class IntentExtractionModule:
    def __init__(self, api_key: str | None = None, model_name: str | None = None):
        from google import genai
        from google.genai import types

        self._types = types
        timeout_ms = int(os.getenv("GEMINI_REQUEST_TIMEOUT_MS", "60000"))
        self.client = genai.Client(
            api_key=api_key or os.getenv("GEMINI_API_KEY"),
            http_options=types.HttpOptions(timeout=timeout_ms),
        )
        self.model_name = resolve_intent_model(model_name)
        self.config = types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=1024,
            response_mime_type="application/json",
        )

    def infer(
        self,
        query: str,
        image_bytes: bytes | None = None,
        image_mime_type: str | None = None,
        image_url: str | None = None,
    ) -> dict:
        image_part = None
        if image_bytes:
            image_part = self._types.Part.from_bytes(
                data=image_bytes,
                mime_type=image_mime_type or "image/jpeg",
            )
        elif image_url:
            try:
                resp = requests.get(image_url, timeout=10)
                resp.raise_for_status()
                image_part = self._types.Part.from_bytes(
                    data=resp.content,
                    mime_type=resp.headers.get("content-type") or "image/jpeg",
                )
            except Exception:
                image_part = None

        if image_part:
            image_instruction = (
                "Reference image provided: use the image ONLY to determine the value of "
                "attributes the user explicitly mentioned in the query. Do NOT extract or add any "
                "attribute the user did not mention, even if it is clearly visible in the image."
            )
        else:
            image_instruction = "No image provided: extract attributes from the text query only."

        prompt = INFERENCE_PROMPT_TEMPLATE.format(
            user_query=query, image_instruction=image_instruction
        )

        parts = []
        if image_part:
            parts.append(image_part)
        parts.append(self._types.Part.from_text(text=prompt))
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=[self._types.Content(role="user", parts=parts)],
            config=self.config,
        )
        parsed = _parse_json(str(response.text or "").strip())
        if parsed is None:
            raise RuntimeError("Metadata response JSON parse failed.")
        return parsed


_module_cache: dict[str, IntentExtractionModule] = {}


def _get_module(model_name: str | None = None) -> IntentExtractionModule:
    resolved_model = resolve_intent_model(model_name)
    if resolved_model not in _module_cache:
        _module_cache[resolved_model] = IntentExtractionModule(model_name=resolved_model)
    return _module_cache[resolved_model]


def extract_conservative_metadata(
    query: str,
    image_bytes: bytes | None = None,
    image_mime_type: str | None = None,
    image_url: str | None = None,
    # kept for call-site compat, ignored
    client: Any = None,
    model_name: str | None = None,
) -> ConservativeMetadataExtraction:
    resolved_model = resolve_intent_model(model_name)
    try:
        try:
            module = _get_module(resolved_model)
        except TypeError:  # Backward-compatible with old test monkeypatches.
            module = _get_module()
        raw = module.infer(
            query=query,
            image_bytes=image_bytes,
            image_mime_type=image_mime_type,
            image_url=image_url,
        )
        raw_str = json.dumps(raw, ensure_ascii=False)
        attrs = _map_to_parsed_attributes(raw)
        return ConservativeMetadataExtraction(
            attributes=attrs,
            status="ok",
            method="gemini_intent_analysis",
            prompt_id="intent_analysis_v1",
            raw_output=raw_str,
            model_name=resolved_model,
        )
    except Exception as exc:
        return ConservativeMetadataExtraction(
            attributes=parse_text_attributes(query),
            status="degraded",
            method="rule_based_keyword_parser_fallback",
            prompt_id="intent_analysis_v1",
            raw_output="",
            error=str(exc),
            model_name=resolved_model,
        )


def analyze_fashion_intent(text_input: str, image_input: str | None = None) -> dict[str, str]:
    """Public API used by /analyze for conservative fashion intent extraction."""
    image_url = image_input if image_input and image_input.startswith(("http://", "https://")) else None
    image_bytes = None
    if image_input and not image_url and os.path.exists(image_input):
        with open(image_input, "rb") as image_file:
            image_bytes = image_file.read()

    extraction = extract_conservative_metadata(
        query=text_input,
        image_bytes=image_bytes,
        image_url=image_url,
    )
    return extraction.attributes.to_dict()


def _map_to_parsed_attributes(raw: dict) -> ParsedTextAttributes:
    values: dict[str, str | None] = {}
    for field in ParsedTextAttributes.__dataclass_fields__:
        values[field] = _normalize(field, raw.get(field))
    return ParsedTextAttributes(**values)


def _normalize(field: str, value: Any) -> str | None:
    if value in (None, "", "null", "none", "None", "-", []):
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    lowered = normalized.lower()
    lowered = _VALUE_ALIASES.get((field, lowered), lowered)
    if field in _ALLOWED_VALUES and lowered not in _ALLOWED_VALUES[field]:
        return None
    return lowered if field in _ALLOWED_VALUES else normalized


def _parse_json(text: str) -> dict | None:
    try:
        m = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
        if m:
            data = json.loads(m.group(1))
            return data if isinstance(data, dict) else None
        m = re.search(r"(\{.*\})", text, re.DOTALL)
        if m:
            data = json.loads(m.group(1))
            return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None
