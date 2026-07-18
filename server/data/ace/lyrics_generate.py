"""Lyrics generation using Llama Song Stream 3B via llama-cpp-python."""
import sys
import json
import os


def generate(model_path, genre="", language="english", topic="", mood="", structure=""):
    from llama_cpp import Llama

    SYSTEM_PROMPT = """You are a professional songwriter. Generate song lyrics based on the user's request.

Rules:
- Use structure tags: [verse], [chorus], [pre-chorus], [bridge], [outro], [intro], [instrumental]
- Write naturally flowing lyrics that match the requested genre and mood
- Each section should be clearly tagged
- Chorus should be catchy and repeatable
- Keep verses story-driven
- Match the requested language
- Output ONLY the lyrics with tags, no explanations"""

    model = Llama(
        model_path=model_path, n_ctx=4096, n_threads=4, n_gpu_layers=0, verbose=False
    )

    parts = []
    if genre:
        parts.append(f"Genre: {genre}")
    if language:
        parts.append(f"Language: {language}")
    if mood:
        parts.append(f"Mood: {mood}")
    if topic:
        parts.append(f"Topic: {topic}")
    if structure:
        parts.append(f"Structure: {structure}")

    user_prompt = (
        "Write song lyrics with the following specifications:\n" + "\n".join(parts)
    )

    response = model.create_chat_completion(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=2048,
        temperature=0.8,
        top_p=0.9,
    )

    return response["choices"][0]["message"]["content"].strip()


def generate_full(model_path, description=""):
    """Generate all song fields from a description."""
    from llama_cpp import Llama

    SYSTEM_PROMPT = """You are a professional songwriter and music producer. Given a description, generate a complete song specification.

You MUST respond with valid JSON only, no other text. Use this exact format:
{
  "style": "detailed genre and style description",
  "lyrics": "full lyrics with [verse], [chorus], [bridge] tags",
  "bpm": 120,
  "key": "C minor",
  "timeSignature": "4",
  "language": "en",
  "instrumental": false,
  "mood": "energetic"
}

Rules for lyrics:
- Use structure tags: [verse], [chorus], [pre-chorus], [bridge], [outro], [intro]
- Write naturally flowing lyrics
- Chorus should be catchy and repeatable
- If the description suggests instrumental, set instrumental to true and lyrics to "[Instrumental]"
"""

    model = Llama(
        model_path=model_path, n_ctx=4096, n_threads=4, n_gpu_layers=0, verbose=False
    )

    response = model.create_chat_completion(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Create a complete song based on this description: {description}",
            },
        ],
        max_tokens=2048,
        temperature=0.8,
        top_p=0.9,
    )

    text = response["choices"][0]["message"]["content"].strip()

    # Try to parse JSON
    try:
        # Find JSON in response
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(text[start:end])
    except Exception:
        pass

    # Fallback: return as lyrics only
    return {"lyrics": text, "style": description}


def download_model(repo_id, filename, dest_dir):
    """Download a GGUF model from HuggingFace."""
    from huggingface_hub import hf_hub_download

    path = hf_hub_download(
        repo_id=repo_id, filename=filename, local_dir=dest_dir, resume_download=True
    )
    return path


if __name__ == "__main__":
    cmd = json.loads(sys.argv[1])
    action = cmd.get("action")

    if action == "generate":
        result = generate(
            model_path=cmd["model_path"],
            genre=cmd.get("genre", ""),
            language=cmd.get("language", "english"),
            topic=cmd.get("topic", ""),
            mood=cmd.get("mood", ""),
            structure=cmd.get("structure", ""),
        )
        print(json.dumps({"lyrics": result}))

    elif action == "generate_full":
        result = generate_full(
            model_path=cmd["model_path"],
            description=cmd.get("description", ""),
        )
        print(json.dumps(result))

    elif action == "generate_style":
        from llama_cpp import Llama
        model = Llama(model_path=cmd["model_path"], n_ctx=4096, n_threads=4, n_gpu_layers=0, verbose=False)
        genre = cmd.get("genre", "")
        prompt = "Generate a creative music production style description"
        if genre:
            prompt += f" for {genre} music"
        response = model.create_chat_completion(
            messages=[
                {"role": "system", "content": "You are a music production expert. Generate a detailed music production style description using comma-separated tags describing: genre, sub-genre, instruments, production techniques, sonic qualities, tempo feel. Be specific and creative. Include real instrument names, effects, and production terms. Output ONLY the style description, nothing else. Example: cinematic hip-hop, 90s boom bap, deep sub bass, dusty jazz piano, muted trumpet stabs, chopped vinyl samples, live drum breaks, punchy rimshots, tape saturation"},
                {"role": "user", "content": prompt},
            ],
            max_tokens=256,
            temperature=0.95,
            top_p=0.9,
        )
        text = response["choices"][0]["message"]["content"].strip()
        print(json.dumps({"style": text}))

    elif action == "download":
        path = download_model(
            repo_id=cmd["repo_id"],
            filename=cmd["filename"],
            dest_dir=cmd["dest_dir"],
        )
        print(json.dumps({"path": path}))

    elif action == "check":
        # Check if model file exists
        exists = os.path.isfile(cmd.get("model_path", ""))
        print(json.dumps({"exists": exists}))
