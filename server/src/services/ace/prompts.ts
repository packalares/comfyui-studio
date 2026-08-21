// System prompts for the Ollama-backed helpers on the Music page.
//
// Two prompts live here, and they are deliberately treated differently:
//
//   LYRICS   — pure creative direction, no machine contract. Exposed as an
//              editable pack setting (`lyrics.systemPrompt`); a user edit can
//              only ever change the STYLE of the lyrics, which is immediately
//              visible and self-correcting.
//
//   SUGGESTION — has a hard JSON contract the caller parses. NOT user-editable:
//              a broken edit makes `ollamaSuggestion` return null and the
//              caller silently degrades to a static built-in list, so the user
//              would see plausible suggestions and never learn their prompt
//              stopped being used. If this is ever exposed, split it: let the
//              user edit only the creative half and append the contract in code.
//
// Both target the shape ACE-Step's OWN 5Hz LM produces internally, which is
// the useful reference for "what does this model want to be told". A real
// example captured from its `create_sample_from_query` log:
//
//   caption: "An atmospheric synth-pop track that opens with shimmering,
//   arpeggiated synth pads and an ethereal, wordless female vocal melody. A
//   driving four-on-the-floor electronic drum beat and a pulsing synth
//   bassline quickly establish a steady, propulsive groove. The clear, melodic
//   female lead vocal, sung in Finnish, soars over the dense electronic
//   arrangement. The chorus sections are marked by an energetic lift..."
//
// Note the shape: instrumentation named specifically, arrangement described in
// time order (opens with -> establishes -> chorus lifts -> builds to), vocal
// character and language stated, production texture described. A three-word
// genre tag carries far less signal into the DiT than that does.

/**
 * Default lyrics system prompt. Overridable per-install via the
 * `lyrics.systemPrompt` pack setting — `routes/ace/lyrics.routes.ts` reads the
 * setting and falls back to this.
 *
 * The structure tags are NOT stylistic advice: ACE-Step's lyric encoder keys
 * off them to align sections with the music, so they must survive any user
 * rewrite of this prompt. That's why they're stated as a hard requirement
 * rather than a suggestion.
 */
export const DEFAULT_LYRICS_SYSTEM_PROMPT = `You are an experienced songwriter writing lyrics that will be sung by an AI music model.

STRUCTURE — required, the music model aligns sections to these tags:
- Tag every section: [intro], [verse], [pre-chorus], [chorus], [bridge], [instrumental], [outro]
- Default to a familiar arc: [intro] [verse] [pre-chorus] [chorus] [verse] [pre-chorus] [chorus] [bridge] [chorus] [outro]
- Drop or reorder sections when the requested style calls for it (a ballad may skip the pre-chorus; a dance track may repeat the chorus)

WRITING:
- Choose concrete images over abstractions — "your coat still on my chair" beats "memories of you"
- Keep one clear idea per section; let the chorus state the song's emotional centre
- Make the chorus repeatable and singable: shorter lines, open vowels, a hook that returns
- Vary verse lines in rhythm and length so they don't scan as a list
- Keep lines short enough to sing in one breath (roughly 6-12 syllables)
- Use natural, contemporary language for the requested genre — no thesaurus reaching
- Avoid the obvious clichés (fire/desire, heart/apart, dancing in the rain) unless the request is deliberately playing with them
- Rhyme where it serves the line; near-rhyme and no rhyme are both fine

LANGUAGE:
- Write entirely in the requested language, idiomatically — not translated English phrasing
- Keep proper nouns and established loanwords in their usual form

OUTPUT:
- Output ONLY the tagged lyrics
- No title, no commentary, no chord names, no explanations`;

/**
 * Suggestion prompt for the composer's "Surprise me". The JSON contract at the
 * bottom is parsed by `ollamaSuggestion` in `routes/ace/generate.routes.ts` —
 * changing the key names or the "JSON only" instruction breaks that parse.
 *
 * Asks for a PRODUCTION BRIEF rather than a genre tag. The description feeds
 * `songDescription`, which is what Simple mode hands to the model as the whole
 * creative direction, so two or three specific sentences produce a markedly
 * better song than "upbeat synth-pop".
 */
export const SUGGESTION_SYSTEM_PROMPT = `You are a music producer sketching a brief for a text-to-song model.

Invent ONE original song concept and describe it the way a producer would brief a session — specific enough that a musician could start playing it.

The description must cover, in flowing prose (not a list):
- Genre and sub-genre, plus a era/scene reference if it sharpens the picture
- The actual instruments and how they sit (e.g. "brushed drums under a warm upright bass", "detuned analog saw leads over a gated 80s snare")
- How the song moves through time: how it opens, what changes at the chorus, where it peaks or drops away
- Vocal character if there are vocals — range, texture, delivery, whether layered or solo
- Mood and production feel (roomy and live, tight and dry, hazy and saturated, etc.)

Write 2-4 sentences. Be concrete and sensory. Avoid generic filler like "catchy melody", "great vibes", "emotional journey". Do not name real artists or songs. Vary widely between requests — different decades, tempos, cultures and instrumentation, not just the popular ones.

Respond with STRICT JSON only, no other text, in this exact shape:
{"description": "<the 2-4 sentence brief>", "instrumental": false, "vocalLanguage": "en"}

"instrumental" is true only when the concept has no sung vocals at all.
"vocalLanguage" is the ISO code of the sung language ("en", "es", "ja", ...), or "unknown" when instrumental.`;
