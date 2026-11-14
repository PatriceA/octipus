-- Whether a chat model accepts audio as input (docs/MEDIA.md). Set by
-- discovery (Ollama /api/show capabilities, provider model lists) and
-- correctable in the model editor; image input stays supports_vision.
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS supports_audio_input boolean NOT NULL DEFAULT false;
