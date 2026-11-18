import { buildMatchingPrompt, validateMatchingOutput } from "./story-writer"
import { isPlaceholderTitle } from "@/lib/title"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreFilterCandidate {
  id: string
  title: string
  summary: string
  sourceUrls: string[]
  materialTitles?: string[]
  createdAt?: Date
  score: number
}

export interface StoryMatcherDeps {
  db: {
    story: {
      findMany: (args: {
        where: {
          userId: string
          status: { in: string[] }
          createdAt: { gte: Date }
        }
        include?: { materials?: { select: { title: boolean } } }
      }) => Promise<
        Array<{
          id: string
          userId: string
          title: string
          summary: string
          sourceUrls: string[]
          status: string
          createdAt: Date
          materials?: Array<{ title: string }>
        }>
      >
    }
    inboxItem?: {
      findUnique: (args: { where: { id: string } }) => Promise<{
        id: string
        userId: string
        extractedTitle: string | null
        extractedContent: string | null
        extractedUrl: string | null
        rawText: string | null
      } | null>
    }
  }
  matchWithAI: (systemPrompt: string, userContent: string) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// Stop words (ignored when computing title overlap)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  // English
  "the", "and", "is", "for", "with", "a", "an", "of", "in", "on", "at",
  "to", "by", "or", "that", "this", "it", "as", "be", "was", "are",
  "from", "not", "but", "have", "had", "has", "its",
  // Russian
  "с", "и", "в", "на", "о", "по", "из", "за", "как", "что", "это", "для",
  "не", "но", "он", "она", "они", "все", "так", "уже", "да", "нет",
  "то", "же", "бы", "ли", "от", "до", "при", "без", "под", "над",
])

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

/**
 * Normalize a URL for exact-match comparison:
 * lowercase, strip trailing slash, strip www. prefix, strip fragment.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, "")
    const path = parsed.pathname.replace(/\/+$/, "")
    const search = parsed.search
    return `${parsed.protocol}//${host}${path}${search}`.toLowerCase()
  } catch {
    return url.toLowerCase().replace(/\/+$/, "")
  }
}

// ---------------------------------------------------------------------------
// extractVersionedEntities — product name + version extraction
// ---------------------------------------------------------------------------

/** Words that look like "Word N" but are NOT product names. */
const ENTITY_SKIP_WORDS = new Set([
  "figure", "table", "step", "chapter", "page", "version", "item",
  "part", "section", "paragraph", "example", "slide", "level",
  "рисунок", "таблица", "шаг", "пункт", "раздел", "глава", "уровень",
  // Number-context words that precede a count, a share or a date in Russian
  // prose ("около 100", "версия 2", "14 января 2026"): never a product name.
  "версия", "часть", "серия", "сезон", "номер", "релиз", "около", "свыше",
  "более", "менее", "почти", "примерно", "через", "после", "всего",
  "января", "февраля", "марта", "апреля", "мая", "июня", "июля",
  "августа", "сентября", "октября", "ноября", "декабря",
])

/** Known product qualifiers — included in the entity for disambiguation. */
const PRODUCT_QUALIFIERS = new Set([
  "pro", "max", "ultra", "mini", "lite", "flash", "nano", "plus",
  "turbo", "opus", "sonnet", "haiku", "deep", "think", "air",
  "se", "studio", "advanced", "basic", "free", "premium",
])

/**
 * Extract "versioned product names" from text.
 * Examples:
 *   "Gemini 3.1 Pro: A smarter model" → ["gemini 3.1 pro"]
 *   "Seedance 2.0 — how to get access" → ["seedance 2.0"]
 *   "Claude 5 with reasoning" → ["claude 5"]
 *
 * Returns deduplicated array of lowercase entity strings.
 */
export function extractVersionedEntities(text: string): string[] {
  // Match: ProductName <space/hyphen> Version [optional Qualifier]
  // Version can be: "3.1", "2.0", "5", "19", "3.1.2"
  // Boundaries are explicit lookarounds, not \b — Cyrillic letters are not
  // \w in JS, so \b never fires before/after a Cyrillic word (RAD-322). Same
  // pair as CYRILLIC_PROPER_NOUN_RE below. \w* inside the name is likewise
  // replaced so a multi-letter Cyrillic name is captured in full, not just
  // its first character.
  const regex =
    /(?<![A-Za-zА-Яа-яЁё0-9])([A-Za-zА-Яа-яёЁ][A-Za-zА-Яа-яёЁ0-9_]*(?:-[A-Za-zА-Яа-яёЁ][A-Za-zА-Яа-яёЁ0-9_]*)*)[\s-]+(\d+(?:\.\d+)*)(?:\s+([A-Za-zА-Яа-яёЁ][A-Za-zА-Яа-яёЁ0-9_]*))?(?![A-Za-zА-Яа-яЁё0-9])/g

  const entities: string[] = []
  let match
  while ((match = regex.exec(text)) !== null) {
    const [, name, version, qualifier] = match
    const nameLower = name.toLowerCase()

    // Skip false positives. A preposition before a number ("в 2026", "до 5",
    // "in 2025") is the commonest one, so the tokenizer's stop words apply too.
    if (ENTITY_SKIP_WORDS.has(nameLower) || STOP_WORDS.has(nameLower)) continue

    let entity = `${nameLower} ${version}`
    if (qualifier && PRODUCT_QUALIFIERS.has(qualifier.toLowerCase())) {
      entity += ` ${qualifier.toLowerCase()}`
    }
    entities.push(entity)
  }

  return [...new Set(entities)]
}

// ---------------------------------------------------------------------------
// extractKeyEntities — language-agnostic entity extraction for cross-language matching
// ---------------------------------------------------------------------------

/** Common sentence starters that are NOT proper nouns (false positives from /\b[A-Z][a-z]{2,}\b/). */
const SENTENCE_STARTER_SKIP = new Set([
  "the", "this", "that", "these", "those", "there", "their", "they",
  "what", "when", "where", "which", "while", "who", "whom", "whose",
  "how", "here", "have", "has", "had", "having", "been", "being",
  "many", "much", "most", "more", "some", "such", "several",
  "each", "every", "either", "neither", "both", "all", "any",
  "after", "before", "during", "since", "until", "about", "above",
  "below", "between", "into", "through", "under", "over",
  "also", "already", "always", "another", "because", "could",
  "does", "don", "even", "first", "from", "just", "like",
  "made", "make", "may", "might", "must", "never", "not",
  "now", "only", "other", "our", "out", "own", "per",
  "should", "still", "than", "then", "too", "very",
  "was", "were", "will", "with", "would", "yet",
  "but", "for", "and", "nor", "are", "can",
  // Common sentence starters in articles
  "according", "although", "among", "based", "despite", "earlier",
  "finally", "following", "furthermore", "however", "instead",
  "meanwhile", "moreover", "nevertheless", "overall", "perhaps",
  "previously", "recently", "regarding", "similarly", "therefore",
  "today", "tomorrow", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "monday", "january", "february",
  "march", "april", "june", "july", "august", "september",
  "october", "november", "december",
  // Short function words, now reachable since acronym tokens have a 2-char floor
  "we", "he", "she", "you", "my", "me", "him", "her", "his", "if", "do",
  "did", "so", "no", "up", "ok", "won",
])

/**
 * Russian sentence starters and generic sentence-opening nouns. Cyrillic
 * sentences capitalize their first word like English does, and the English skip
 * list cannot see them — without this set a Russian article's "Однако" or
 * "Компания" would enter the entity set and create coincidental overlaps.
 */
const RU_SENTENCE_STARTER_SKIP = new Set([
  // Pronouns / determiners
  "это", "этот", "эта", "эти", "этого", "этой", "этих", "этому", "этим",
  "тот", "та", "те", "того", "той", "тех", "такой", "такая", "такое", "такие",
  "наш", "наша", "наше", "наши", "ваш", "ваша", "ваше", "ваши",
  "мой", "моя", "моё", "мои", "свой", "своя", "своё", "свои",
  "сам", "сама", "само", "сами", "весь", "вся", "всё", "все",
  "каждый", "каждая", "каждое", "каждые", "любой", "любая", "любое", "любые",
  "другой", "другая", "другое", "другие",
  // Conjunctions / adverbs / particles
  "однако", "также", "кроме", "более", "менее", "почти", "ещё", "еще",
  "теперь", "сегодня", "вчера", "завтра", "здесь", "там", "тогда", "потом",
  "затем", "сначала", "наконец", "вообще", "конечно", "например", "поэтому",
  "потому", "поскольку", "когда", "если", "чтобы", "хотя", "пока", "ведь",
  "даже", "именно", "просто", "только", "всегда", "часто", "иногда", "редко",
  "снова", "опять", "впервые", "впрочем", "кстати", "далее", "недавно",
  "раньше", "больше", "меньше", "скорее",
  // Generic nouns that commonly open a sentence
  "компания", "компании", "разработчики", "разработчик", "разработка",
  "пользователи", "пользователь", "исследователи", "исследование",
  "учёные", "ученые", "эксперты", "эксперт", "авторы", "автор",
  "инженеры", "специалисты", "создатели", "команда", "аналитики", "журналисты",
  "новости", "дайджест", "обзор", "нейросеть", "модель", "сервис",
  "приложение", "платформа", "инструмент", "технология", "технологии",
  "анонс", "тест", "тесты", "запуск", "релиз", "обновление", "презентация",
  "разбор", "сравнение", "итоги", "мнение", "подборка", "правила", "игра", "игры",
  // Generic adjectives
  "новый", "новая", "новое", "новые", "старый", "старая", "старое", "старые",
  "первый", "первая", "первое", "первые", "второй", "вторая", "второе", "вторые",
  "последний", "последняя", "последнее", "последние", "главный", "главная",
  "главное", "главные", "лучший", "лучшая", "лучшее", "лучшие",
  "российский", "российская", "российские",
  // Months / weekdays (mirrors the English list)
  "январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август",
  "сентябрь", "октябрь", "ноябрь", "декабрь", "понедельник", "вторник",
  "среда", "четверг", "пятница", "суббота", "воскресенье",
])

/**
 * Abbreviations that carry no discriminative signal: a shared "AI" or "API" is
 * a coincidence, not a shared subject, and letting two of them satisfy the
 * 2-entity overlap would defeat the `requireSignal` cost guard for every pair
 * of unrelated AI-domain posts.
 */
const GENERIC_ACRONYM_SKIP = new Set([
  "ai", "ml", "api", "sdk", "cli", "ui", "ux", "os", "pc", "tv", "id",
  "pdf", "rss", "url", "html", "css", "sql", "json", "xml", "csv",
  "gpu", "cpu", "ram", "ceo", "cto", "ipo", "hr", "pr", "qa", "seo", "kpi",
  "imo", "btw", "fyi", "tldr", "ama", "new", "top", "best", "why", "read",
  "welcome", "go", "yes", "llm", "agi", "nlp", "rag", "tts", "stt",
  "us", "uk", "eu", "usa",
])

/**
 * Latin proper nouns / acronyms: Title-case ("Apple"), inner-capital
 * ("OpenAI", "MacBook") and lowercase-initial inner-capital brands
 * ("iOS", "iPhone", "eBPF"), all-caps 2–5 letters ("GPT", "SOTA"). Runs longer
 * than five caps letters never match the acronym branch, but short all-caps
 * tokens do — "NEW"/"TOP"/"AI" are filtered only through the skip sets above.
 * The lookarounds let "OpenAI" match as one token — `\b` cannot, because `A`
 * after `Open` is a word character and there is no boundary inside the word.
 */
const LATIN_PROPER_NOUN_RE =
  /(?<![A-Za-z0-9])([A-Z][a-z]+[A-Z][A-Za-z]*|[a-z]+[A-Z][A-Za-z]*|[A-Z]{2,5}|[A-Z][a-z]{2,})(?![A-Za-z])/g

/**
 * Cyrillic proper nouns / acronyms: Title-case ("Яндекс", "Навье"),
 * all-caps 2–5 ("ИИ", "США"). `\b` is unusable here — Cyrillic letters are not
 * `\w` in JS — so the boundaries are explicit lookarounds.
 */
const CYRILLIC_PROPER_NOUN_RE =
  /(?<![A-Za-zА-Яа-яЁё0-9])([А-ЯЁ][а-яё]+[А-ЯЁ][А-ЯЁа-яё]*|[А-ЯЁ]{2,5}|[А-ЯЁ][а-яё]{2,})(?![A-Za-zА-Яа-яЁё0-9])/g

/**
 * Extract language-agnostic "key entities" from text for cross-language matching.
 *
 * Extracts:
 * - Versioned products via extractVersionedEntities ("gemini 3.1 pro")
 * - Capitalized proper nouns (brand names, person names)
 * - Significant numbers (years, versions, stats)
 *
 * These entities overlap across languages: "Apple выпустила iOS 20" and
 * "Apple releases iOS 20" share entities ["apple", "ios", "20"].
 */
export function extractKeyEntities(text: string): Set<string> {
  const entities = new Set<string>()

  // 1. Versioned products (strongest signal)
  for (const e of extractVersionedEntities(text)) {
    entities.add(e)
  }

  // 2. Proper nouns — brands, people, acronyms, in Latin and Cyrillic scripts.
  let match
  for (const regex of [LATIN_PROPER_NOUN_RE, CYRILLIC_PROPER_NOUN_RE]) {
    regex.lastIndex = 0
    while ((match = regex.exec(text)) !== null) {
      const word = match[1].toLowerCase()
      if (
        !SENTENCE_STARTER_SKIP.has(word) &&
        !RU_SENTENCE_STARTER_SKIP.has(word) &&
        !GENERIC_ACRONYM_SKIP.has(word) &&
        !STOP_WORDS.has(word)
      ) {
        entities.add(word)
      }
    }
  }

  // 3. Significant numbers (2+ digits: years, versions, stats)
  const numberRegex = /\b(\d{2,})\b/g
  while ((match = numberRegex.exec(text)) !== null) {
    entities.add(match[1])
  }

  return entities
}

/**
 * Compute Jaccard similarity between two entity sets.
 * Returns 0 if either set is empty or if fewer than 2 entities overlap
 * (to reduce false positives from single-entity coincidences).
 */
export function entityJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  if (intersection < 2) return 0
  const union = new Set([...a, ...b]).size
  return union > 0 ? intersection / union : 0
}

// ---------------------------------------------------------------------------
// computeSimilarityScore
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity between two token sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = new Set([...a, ...b]).size
  return union > 0 ? intersection / union : 0
}

/**
 * Lightweight pre-filter scoring for a new item vs a candidate story.
 * Returns a number in [0, 1].
 *
 * Score components (4 signals):
 *   - Title: max(storyTitleJaccard, bestMaterialTitleJaccard) — weight 0.35
 *   - Content: Jaccard of content[:500] vs candidate summary — weight 0.15
 *   - Entity: Jaccard of key entities (proper nouns, numbers, products) — weight 0.40
 *   - Domain: URL domain match bonus — weight 0.10
 */
export function computeSimilarityScore(
  newItem: { title: string; content?: string | null; extractedUrl?: string | null },
  candidate: PreFilterCandidate
): number {
  // A placeholder title ("Photo from @user") describes the post's shape, not
  // its subject — every media post from one account would otherwise look
  // near-identical to every other.
  const newTitleTokens = new Set(
    isPlaceholderTitle(newItem.title) ? [] : tokenize(newItem.title)
  )

  // Title overlap: story title Jaccard
  const storyTitleJaccard = jaccardSimilarity(newTitleTokens, new Set(tokenize(candidate.title)))

  // Title overlap: best material title Jaccard (if available)
  let bestMaterialTitleJaccard = 0
  if (candidate.materialTitles && candidate.materialTitles.length > 0) {
    for (const matTitle of candidate.materialTitles) {
      if (isPlaceholderTitle(matTitle)) continue
      const score = jaccardSimilarity(newTitleTokens, new Set(tokenize(matTitle)))
      if (score > bestMaterialTitleJaccard) bestMaterialTitleJaccard = score
    }
  }

  const titleScore = Math.max(storyTitleJaccard, bestMaterialTitleJaccard)

  // Content overlap: new content[:500] vs candidate summary
  let contentScore = 0
  if (newItem.content) {
    const contentSlice = newItem.content.slice(0, 500)
    contentScore = jaccardSimilarity(
      new Set(tokenize(contentSlice)),
      new Set(tokenize(candidate.summary))
    )
  }

  // Entity overlap: language-agnostic proper nouns, numbers, products.
  // The candidate side reads the constituent material titles too (RAD-316):
  // after RAD-315 they are 120-char ledes, and omitting them left the entity
  // signal with nothing but the story title and summary. Material bodies stay
  // out on purpose — fetching content for every in-window story would multiply
  // the per-match payload, while titles are already in hand. The two candidate
  // variants are scored separately and the better one wins: joining the titles
  // into one text would grow the Jaccard union and *lower* the score of exactly
  // the material-rich stories this is meant to help.
  const newText = `${newItem.title} ${newItem.content?.slice(0, 500) ?? ""}`
  const newEntities = extractKeyEntities(newText)
  const candBaseText = `${candidate.title} ${candidate.summary}`
  const candText = candidate.materialTitles?.length
    ? `${candBaseText} ${candidate.materialTitles.join(" ")}`
    : candBaseText
  const entityScore = candText === candBaseText
    ? entityJaccard(newEntities, extractKeyEntities(candBaseText))
    : Math.max(
        entityJaccard(newEntities, extractKeyEntities(candBaseText)),
        entityJaccard(newEntities, extractKeyEntities(candText))
      )

  // Domain bonus
  let domainBonus = 0
  if (newItem.extractedUrl) {
    const newDomain = extractDomain(newItem.extractedUrl)
    if (newDomain) {
      for (const sourceUrl of candidate.sourceUrls) {
        const candidateDomain = extractDomain(sourceUrl)
        if (candidateDomain && candidateDomain === newDomain) {
          domainBonus = 1
          break
        }
      }
    }
  }

  // Weighted combination, clamped to [0, 1]
  return Math.min(1, titleScore * 0.35 + contentScore * 0.15 + entityScore * 0.40 + domainBonus * 0.10)
}

// ---------------------------------------------------------------------------
// preFilterCandidates
// ---------------------------------------------------------------------------

/**
 * Determine adaptive max candidates based on total story count.
 * Small pools pass all to AI; large pools use stricter filtering.
 */
export function getMaxCandidates(totalStories: number): number {
  if (totalStories <= 20) return totalStories
  if (totalStories <= 50) return 25
  return 15
}

/**
 * Score all candidate stories against newItem and return the top candidates
 * sorted by score descending. Uses adaptive limits based on pool size.
 *
 * When all candidates score 0 (e.g. cross-language), keeps top 5 by recency
 * as a fallback so the AI still gets a chance.
 */
export function preFilterCandidates(
  newItem: { title: string; content?: string | null; extractedUrl?: string | null },
  stories: PreFilterCandidate[],
  maxCandidates?: number
): PreFilterCandidate[] {
  if (stories.length === 0) return []

  const limit = maxCandidates ?? getMaxCandidates(stories.length)

  const scored = stories.map((s) => ({
    ...s,
    score: computeSimilarityScore(newItem, s),
  }))

  scored.sort((a, b) => b.score - a.score)

  const top = scored.slice(0, limit)

  // Zero-score fallback: if all top candidates scored 0, keep top 5 by recency
  const hasNonZero = top.some((c) => c.score > 0)
  if (!hasNonZero && scored.length > 0) {
    const byRecency = [...scored].sort((a, b) => {
      const aTime = a.createdAt?.getTime() ?? 0
      const bTime = b.createdAt?.getTime() ?? 0
      return bTime - aTime
    })
    return byRecency.slice(0, ZERO_SCORE_FALLBACK_COUNT)
  }

  return top
}

// ---------------------------------------------------------------------------
// matchItem / matchContent
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 30
const ZERO_SCORE_FALLBACK_COUNT = 5
/** Pre-filter score floor for a candidate that shares a versioned entity but would
 *  otherwise be truncated — high enough to guarantee it reaches the AI judge. */
const ENTITY_SIGNAL_SCORE = 0.5
/** How much of a new item's body the versioned-entity scan reads. Title-only was the
 *  RAD-308 bug: the materials pipeline passes rawText: null, and a Telegram post's
 *  "title" is just its first line — the product name sits hundreds of chars into the
 *  body (measured: char 288 and char 741 in the two posts that failed to merge). */
const ENTITY_SCAN_CHARS = 2000
const MATCHING_SYSTEM_PROMPT =
  "You are a deduplication engine. Respond only with valid JSON."

/** A standalone APPROVED material offered as a cluster partner (post↔post matching). */
export interface MaterialCandidate {
  id: string
  title: string
  content: string
  url: string | null
}

export type MatchType = "story" | "material" | null

export interface MatchContentOptions {
  /**
   * Standalone APPROVED materials to consider alongside existing stories.
   * When a post matches one of these (and no existing story), the caller forms
   * a NEW two-post story — so a lone post never becomes a single-material story.
   */
  candidateMaterials?: MaterialCandidate[]
  /**
   * When true, skip the AI call entirely if no candidate has a non-zero pre-filter
   * score. Real clusters share title/entity/domain signal (non-zero); this avoids
   * burning an AI call on a lone post that shares nothing — important because the
   * Group-Stories sweep re-checks every still-standalone post on each run.
   */
  requireSignal?: boolean
}

export interface MatchContentResult {
  match: string | null
  matchType: MatchType
  isNew: boolean
  reasoning: string
}

/**
 * Core matching logic — accepts content fields directly without DB lookup.
 * Matches the new item against existing STORIES and, optionally, standalone
 * MATERIALS (opts.candidateMaterials). Returns which kind of candidate matched
 * via `matchType` so the caller can either join a story or pair two posts.
 * Used by matchItem (inbox, stories-only) and by the materials pipeline.
 */
export async function matchContent(
  content: {
    title: string
    content: string
    url: string | null
    rawText: string | null
  },
  userId: string,
  deps: StoryMatcherDeps,
  opts: MatchContentOptions = {}
): Promise<MatchContentResult> {
  const { candidateMaterials = [], requireSignal = false } = opts

  // Compute the lookback date
  const since = new Date()
  since.setDate(since.getDate() - LOOKBACK_DAYS)

  // Fetch recent stories with their material titles for richer matching
  const storyRecords = await deps.db.story.findMany({
    where: {
      userId,
      status: { in: ["DRAFT", "SENT_TO_NOTION"] },
      createdAt: { gte: since },
    },
    include: { materials: { select: { title: true } } },
  })

  // Tag every candidate id by kind so we can report matchType after the AI picks one.
  const candidateType = new Map<string, "story" | "material">()
  for (const s of storyRecords) candidateType.set(s.id, "story")
  for (const m of candidateMaterials) candidateType.set(m.id, "material")

  // Early exit if no candidates at all
  if (storyRecords.length === 0 && candidateMaterials.length === 0) {
    return { match: null, matchType: null, isNew: true, reasoning: "No existing stories or materials to match against" }
  }

  // URL exact-match shortcut — the strongest deduplication signal. Stories first, then materials.
  if (content.url) {
    const normalizedNewUrl = normalizeUrl(content.url)
    for (const story of storyRecords) {
      for (const sourceUrl of story.sourceUrls) {
        if (normalizeUrl(sourceUrl) === normalizedNewUrl) {
          return { match: story.id, matchType: "story", isNew: false, reasoning: `URL exact match: ${content.url} matches story source URL` }
        }
      }
    }
    for (const mat of candidateMaterials) {
      if (mat.url && normalizeUrl(mat.url) === normalizedNewUrl) {
        return { match: mat.id, matchType: "material", isNew: false, reasoning: `URL exact match: ${content.url} matches material URL` }
      }
    }
  }

  // Versioned entity signal — a shared product+version (e.g. "Gemini 3.1 Pro") is a
  // STRONG hint that two items cover the same release, but NOT proof: the token can
  // appear incidentally in a post's body (e.g. a GPT-5 article that merely benchmarks
  // against "Sonnet 5"). So we no longer auto-merge on it. Instead we record which
  // candidates share the entity and guarantee they reach the AI below, which reads the
  // full content and makes the same-specific-event call.
  // rawText is null for every material (material-story-pipeline), so fall back to
  // the body — otherwise the rescue below can only ever see the first line.
  const newItemBody = content.rawText ?? content.content ?? ""
  const newItemText = `${content.title} ${newItemBody.slice(0, ENTITY_SCAN_CHARS)}`
  const newEntities = extractVersionedEntities(newItemText)
  const entitySignalIds = new Set<string>()
  if (newEntities.length > 0) {
    for (const story of storyRecords) {
      const materialTitlesText = (story.materials ?? []).map((m) => m.title).join(" ")
      const storyEntities = extractVersionedEntities(`${story.title} ${materialTitlesText}`)
      if (newEntities.some((e) => storyEntities.includes(e))) entitySignalIds.add(story.id)
    }
    for (const mat of candidateMaterials) {
      const matEntities = extractVersionedEntities(`${mat.title} ${mat.content.slice(0, 500)}`)
      if (newEntities.some((e) => matEntities.includes(e))) entitySignalIds.add(mat.id)
    }
  }

  // Map BOTH stories and materials to a single PreFilterCandidate list.
  const candidates: PreFilterCandidate[] = [
    ...storyRecords.map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      sourceUrls: s.sourceUrls,
      materialTitles: (s.materials ?? []).map((m) => m.title),
      createdAt: s.createdAt,
      score: 0,
    })),
    ...candidateMaterials.map((m) => ({
      id: m.id,
      title: m.title,
      summary: m.content.slice(0, 500),
      sourceUrls: m.url ? [m.url] : [],
      materialTitles: [m.title],
      score: 0,
    })),
  ]

  // Pre-filter: adaptive candidate limit based on pool size
  const topCandidates = preFilterCandidates(
    {
      title: content.title || content.rawText || "",
      content: content.content || content.rawText || "",
      extractedUrl: content.url,
    },
    candidates
  )

  // Guarantee every versioned-entity-signal candidate reaches the AI, even if the
  // adaptive pre-filter would truncate it from a large pool. The entity is a strong
  // enough hint to always warrant the AI's judgment (it just no longer force-merges).
  if (entitySignalIds.size > 0) {
    const present = new Set(topCandidates.map((c) => c.id))
    for (const c of candidates) {
      if (entitySignalIds.has(c.id) && !present.has(c.id)) {
        topCandidates.push({ ...c, score: Math.max(c.score, ENTITY_SIGNAL_SCORE) })
        present.add(c.id)
      }
    }
  }

  // Cost guard (materials pipeline): if nothing shares signal, don't spend an AI call.
  // A versioned-entity match always counts as signal; otherwise all-zero scores mean
  // preFilterCandidates fell back to recency (no real overlap) so we skip the AI.
  if (requireSignal && entitySignalIds.size === 0 && topCandidates.every((c) => c.score === 0)) {
    return { match: null, matchType: null, isNew: true, reasoning: "No candidate shares enough signal to warrant AI matching" }
  }

  // Build the AI matching prompt
  const newItemForPrompt = {
    title: content.title || content.rawText || "",
    content: content.content || content.rawText || "",
    sourceUrl: content.url ?? undefined,
  }
  const candidatesForPrompt = topCandidates.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    sourceUrls: c.sourceUrls,
    materialTitles: c.materialTitles,
  }))

  const userContent = buildMatchingPrompt(newItemForPrompt, candidatesForPrompt)

  // Call AI
  const rawAIOutput = await deps.matchWithAI(MATCHING_SYSTEM_PROMPT, userContent)

  // Validate AI output
  const validated = validateMatchingOutput(rawAIOutput)

  if (validated === null) {
    return { match: null, matchType: null, isNew: true, reasoning: "AI output invalid" }
  }

  // Resolve the matched id back to its kind. An id we never offered (hallucination)
  // is treated as no match, so the caller never acts on a phantom candidate.
  const matchType = validated.match ? candidateType.get(validated.match) ?? null : null
  if (validated.match && matchType === null) {
    return { match: null, matchType: null, isNew: true, reasoning: "AI returned an unknown candidate id" }
  }

  return {
    match: validated.match,
    matchType,
    isNew: validated.match === null,
    reasoning: validated.reasoning,
  }
}

/**
 * Full matching orchestration (spec 4.3).
 *
 * 1. Fetch the inbox item from the DB.
 * 2. Delegate to matchContent() with the item's fields.
 */
export async function matchItem(
  itemId: string,
  userId: string,
  deps: StoryMatcherDeps
): Promise<{ match: string | null; isNew: boolean; reasoning: string }> {
  // Fetch the inbox item (inboxItem dep is optional — only needed for matchItem, not matchContent)
  if (!deps.db.inboxItem) {
    return { match: null, isNew: true, reasoning: "InboxItem lookup not available" }
  }
  const inboxItem = await deps.db.inboxItem.findUnique({
    where: { id: itemId },
  })

  if (!inboxItem) {
    return { match: null, isNew: true, reasoning: "Inbox item not found" }
  }

  return matchContent(
    {
      title: inboxItem.extractedTitle ?? inboxItem.rawText ?? "",
      content: inboxItem.extractedContent ?? inboxItem.rawText ?? "",
      url: inboxItem.extractedUrl,
      rawText: inboxItem.rawText,
    },
    userId,
    deps
  )
}
