import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import { countCharInString } from 'src/utils/stringUtils.js'
import {
  DIFF_TIMEOUT_MS,
  getPatchForDisplay,
  getPatchFromContents,
} from '../../utils/diff.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  convertLeadingTabsToSpaces,
  readFileSyncCached,
  stripLineNumberPrefix,
} from '../../utils/file.js'
import type { EditInput, FileEdit } from './types.js'

// Line-level char-overlap threshold for suggesting similar lines in error messages.
const LINE_SIMILARITY_THRESHOLD = 0.5

// Claude can't output curly quotes, so we define them as constants here for Claude to use
// in the code. We do this because we normalize curly quotes to straight quotes
// when applying edits.
export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

/**
 * Normalizes quotes in a string by converting curly quotes to straight quotes
 * @param str The string to normalize
 * @returns The string with all curly quotes replaced by straight quotes
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * Strips trailing whitespace from each line in a string while preserving line endings
 * @param str The string to process
 * @returns The string with trailing whitespace removed from each line
 */
export function stripTrailingWhitespace(str: string): string {
  // Handle different line endings: CRLF, LF, CR
  // Use a regex that matches line endings and captures them
  const lines = str.split(/(\r\n|\n|\r)/)

  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
      if (i % 2 === 0) {
        // Even indices are line content
        result += part.replace(/\s+$/, '')
      } else {
        // Odd indices are line endings
        result += part
      }
    }
  }

  return result
}

/**
 * Finds the actual string in the file content that matches the search string.
 *
 * Applies escalating fallback heuristics when an exact match fails:
 *   0. Exact substring match
 *   1. Curly-quote → straight-quote normalization
 *   2. Read-tool line-number prefix stripping (model accidentally included "123\t")
 *   3. Whitespace tolerance — trailing spaces per line, surrounding blank lines
 *   4. Indentation normalization — tabs ↔ spaces
 *
 * Returns { actualString, failReason? }. failReason carries diagnostics for
 * friendly error messages when every level fails.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): { actualString: string | null; failReason?: string; warnings?: string[] } {
  // Level 0: Exact match.
  // When old_string has surplus surrounding blank lines (copy-paste artifact
  // from Read output), includes() matches but over-consumes real blank lines
  // in the file (e.g. "foo\n\n" eats the separator between functions). Prefer
  // the tightest version that still matches as a unique instance.
  if (fileContent.includes(searchString)) {
    const refined = trimSurplusSurroundingBlankLines(searchString, fileContent)
    if (refined) {
      return {
        actualString: refined,
        warnings: [
          'Surrounding blank lines were trimmed from old_string to avoid consuming real file content.',
        ],
      }
    }
    return { actualString: searchString }
  }

  // Level 1: Quote normalization
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const quoteIdx = normalizedFile.indexOf(normalizedSearch)
  if (quoteIdx !== -1) {
    return {
      actualString: fileContent.substring(
        quoteIdx,
        quoteIdx + searchString.length,
      ),
    }
  }

  // Level 2: Line-number prefix stripping.
  // Models sometimes copy "123\tcontent" from Read output into old_string.
  const strippedSearch = stripLineNumberPrefixes(searchString)
  if (strippedSearch !== searchString && fileContent.includes(strippedSearch)) {
    return {
      actualString: strippedSearch,
      warnings: [
        'Line-number prefixes from Read tool output were stripped from old_string before matching.',
      ],
    }
  }

  // Level 3a: Trailing-whitespace tolerance on individual lines.
  const trimmedLineSearch = stripTrailingWhitespace(searchString)
  if (
    trimmedLineSearch !== searchString &&
    fileContent.includes(trimmedLineSearch)
  ) {
    return {
      actualString: trimmedLineSearch,
      warnings: [
        'Trailing whitespace was removed from old_string lines to match the file.',
      ],
    }
  }

  // Level 3b: Surrounding-blank-line tolerance.
  // Model may have included extra leading/trailing newlines from Read output
  // that aren't part of the actual file content. Strip and retry.
  const unblankedSearch = searchString.replace(/^\n+/, '').replace(/\n+$/, '')
  if (
    unblankedSearch !== searchString &&
    unblankedSearch.length > 0 &&
    fileContent.includes(unblankedSearch)
  ) {
    return {
      actualString: unblankedSearch,
      warnings: [
        'Leading or trailing blank lines were removed from old_string before matching.',
      ],
    }
  }

  // Level 3c: Combined — trim lines AND strip surrounding blanks.
  if (trimmedLineSearch !== searchString && unblankedSearch !== searchString) {
    const combined = stripTrailingWhitespace(unblankedSearch)
    if (combined !== searchString && fileContent.includes(combined)) {
      return {
        actualString: combined,
        warnings: [
          'Trailing whitespace and surrounding blank lines were normalized in old_string to match the file.',
        ],
      }
    }
    const ubTrimmed = trimmedLineSearch
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
    if (ubTrimmed !== searchString && fileContent.includes(ubTrimmed)) {
      return {
        actualString: ubTrimmed,
        warnings: [
          'Trailing whitespace and surrounding blank lines were normalized in old_string to match the file.',
        ],
      }
    }
  }

  // Level 4: Indentation normalization (tabs ↔ spaces)
  const indentResult = tryIndentationNormalizedMatch(fileContent, searchString)
  if (indentResult !== null) {
    const warning =
      'The indentation in old_string was normalized before matching — the file uses a different indentation style. The file\'s existing indentation was preserved in the edit. Verify that the resulting code has correct indentation.'
    return {
      actualString: indentResult,
      warnings: [warning],
    }
  }

  // All levels exhausted — build diagnostics for the error message
  return {
    actualString: null,
    failReason: buildMatchFailReason(searchString, fileContent),
  }
}

// -- Level 0 refinement -------------------------------------------------------

/**
 * When old_string starts or ends with newlines, the raw includes() match may
 * consume real blank lines that belong to the file rather than to the edit.
 * Walk inward one character at a time; return the tightest variant that still
 * matches as a unique instance.
 */
function trimSurplusSurroundingBlankLines(
  searchString: string,
  fileContent: string,
): string | null {
  // Only bother when there are actually surrounding newlines.
  if (!searchString.startsWith('\n') && !searchString.endsWith('\n')) {
    return null
  }

  let best: string | null = null
  let current = searchString

  // Strip one leading newline at a time.
  let leading = 0
  while (current.startsWith('\n')) {
    const candidate = current.slice(1)
    if (candidate.length === 0) break
    // Count occurrences before and after — want the same unique match.
    const before = fileContent.split(current).length - 1
    const after = fileContent.split(candidate).length - 1
    // Accept only if the tighter match is still present and doesn't explode
    // into more matches (which would happen if candidate is too short/generic).
    if (after > 0 && after <= before) {
      current = candidate
      best = current
    } else {
      break
    }
    leading++
  }

  // Strip one trailing newline at a time.
  let trailing = 0
  while (current.endsWith('\n')) {
    const candidate = current.slice(0, -1)
    if (candidate.length === 0) break
    const before = fileContent.split(current).length - 1
    const after = fileContent.split(candidate).length - 1
    if (after > 0 && after <= before) {
      current = candidate
      best = current
    } else {
      break
    }
    trailing++
  }

  return leading > 0 || trailing > 0 ? best : null
}

// -- Level 2 helpers ----------------------------------------------------------

function stripLineNumberPrefixes(str: string): string {
  return str
    .split('\n')
    .map(line => stripLineNumberPrefix(line))
    .join('\n')
}

// -- Level 3 helpers ----------------------------------------------------------

function tryWhitespaceTolerantMatch(
  fileContent: string,
  searchString: string,
): string | null {
  // 3a: Strip trailing whitespace from each line (model may have kept trailing
  //     spaces the editor stripped or vice versa).
  const trimmedSearch = stripTrailingWhitespace(searchString)
  if (trimmedSearch !== searchString && fileContent.includes(trimmedSearch)) {
    return trimmedSearch
  }

  // 3b: Strip surrounding blank lines (model may have included an extra leading
  //     or trailing newline that isn't part of the file content).
  const unblankedSearch = searchString.replace(/^\n+/, '').replace(/\n+$/, '')
  if (
    unblankedSearch !== searchString &&
    unblankedSearch.length > 0 &&
    fileContent.includes(unblankedSearch)
  ) {
    return unblankedSearch
  }

  // 3c: Combined — trim lines then strip surrounding blanks.
  if (trimmedSearch !== searchString && unblankedSearch !== searchString) {
    const combined = stripTrailingWhitespace(unblankedSearch)
    if (combined !== searchString && fileContent.includes(combined)) {
      return combined
    }
    // Also try unblanked version of trimmed
    const ubTrimmed = trimmedSearch.replace(/^\n+/, '').replace(/\n+$/, '')
    if (ubTrimmed !== searchString && fileContent.includes(ubTrimmed)) {
      return ubTrimmed
    }
  }

  return null
}

// -- Level 4 helpers ----------------------------------------------------------

function tryIndentationNormalizedMatch(
  fileContent: string,
  searchString: string,
): string | null {
  // 4a: Search has tabs but file might have spaces.
  const tabNormalizedSearch = searchString.replace(/\t/g, '  ')
  if (tabNormalizedSearch !== searchString) {
    const tabNormalizedFile = fileContent.replace(/\t/g, '  ')
    const idx = tabNormalizedFile.indexOf(tabNormalizedSearch)
    if (idx !== -1) {
      return mapNormalizedPositionBack(
        fileContent,
        tabNormalizedFile,
        idx,
        tabNormalizedSearch.length,
      )
    }
  }

  // 4b: Search has spaces but file has tabs (reverse of 4a).
  const tabNormalizedFile = fileContent.replace(/\t/g, '  ')
  const idx = tabNormalizedFile.indexOf(searchString)
  if (idx !== -1) {
    return mapNormalizedPositionBack(
      fileContent,
      tabNormalizedFile,
      idx,
      searchString.length,
    )
  }

  // 4c: Leading-whitespace-agnostic match.
  // When the model copied a line from Read output with different indentation
  // (e.g. spaces in old_string vs tabs in the file, or mismatched indent width),
  // strip all leading whitespace and compare only the content part.
  const wsAgnosticResult = tryWsAgnosticMatch(fileContent, searchString)
  if (wsAgnosticResult !== null) {
    return wsAgnosticResult
  }

  return null
}

// -- Level 4c helper ---------------------------------------------------------

/**
 * Try to match searchString against fileContent by stripping all leading
 * whitespace from every line and comparing only the content.
 *
 * This handles cases where:
 * - The model used spaces but the file uses tabs (with different widths)
 * - The model guessed the wrong indentation level entirely
 * - The file was reformatted (e.g. 2-space → 4-space indent)
 *
 * Returns the matched substring from the actual file content, or null.
 */
function tryWsAgnosticMatch(
  fileContent: string,
  searchString: string,
): string | null {
  const searchLines = searchString.split('\n')
  const fileLines = fileContent.split('\n')

  if (searchLines.length > fileLines.length) return null

  // Strip leading whitespace from each line
  const strippedSearch = searchLines.map(l => l.replace(/^\s+/, ''))
  const strippedFile = fileLines.map(l => l.replace(/^\s+/, ''))

  // Join with newline and search for consecutive line matches
  const strippedSearchStr = strippedSearch.join('\n')
  const strippedFileStr = strippedFile.join('\n')

  const pos = strippedFileStr.indexOf(strippedSearchStr)
  if (pos === -1) return null

  // Count how many lines precede the match position
  const prefix = strippedFileStr.slice(0, pos)
  const startLineNum = prefix.length === 0 ? 0 : prefix.split('\n').length - 1

  // Extract the actual (un-stripped) file lines
  const actualLines = fileLines.slice(
    startLineNum,
    startLineNum + searchLines.length,
  )
  if (actualLines.length !== searchLines.length) return null

  // Safety check: verify the stripped content of our match matches
  const actualStripped = actualLines.map(l => l.replace(/^\s+/, ''))
  if (actualStripped.join('\n') !== strippedSearchStr) return null

  return actualLines.join('\n')
}

/**
 * Given a position in a tab→"  "-normalized version of `original`, return the
 * corresponding substring of `original` that covers `searchLength` characters
 * in the normalized space.
 */
function mapNormalizedPositionBack(
  original: string,
  normalized: string,
  normalizedPos: number,
  searchLength: number,
): string | null {
  // Walk to the start position.
  let origIdx = 0
  let normIdx = 0
  while (normIdx < normalizedPos && origIdx < original.length) {
    normIdx += original[origIdx] === '\t' ? 2 : 1
    origIdx++
  }
  if (normIdx !== normalizedPos) return null

  const startIdx = origIdx

  // Walk the search length in normalized space.
  let remaining = searchLength
  while (remaining > 0 && origIdx < original.length) {
    remaining -= original[origIdx] === '\t' ? 2 : 1
    origIdx++
  }
  // Allow a 1-char slop from the final newline — models sometimes omit it.
  if (remaining > 1) return null

  return original.substring(startIdx, origIdx)
}

// -- Diagnostic helpers for friendly error messages ---------------------------

/**
 * Build a human-readable explanation of _why_ findActualString failed, used in
 * the errorCode 8 (string not found) message.
 */
function buildMatchFailReason(
  searchString: string,
  fileContent: string,
): string {
  const reasons: string[] = []

  // Line-number prefix pattern: "   123→" or "123\t" at the start of a line.
  if (/^\s*\d+[\t→]/.test(searchString.split('\n')[0] ?? '')) {
    reasons.push(
      `- The old_string appears to contain **line number prefixes** from Read tool output (e.g. "123→" or "123\\t"). Remove these prefixes — only the actual file content (after the prefix) belongs in old_string.`,
    )
  }

  // Leading / trailing whitespace on the whole string.
  if (searchString !== searchString.trim()) {
    reasons.push(
      `- old_string has **leading or trailing whitespace** that may not match the file. Try trimming it.`,
    )
    if (searchString.length !== searchString.trimStart().length) {
      const extra = searchString.length - searchString.trimStart().length
      reasons.push(`  (${extra} leading whitespace character(s) detected)`)
    }
    if (searchString.length !== searchString.trimEnd().length) {
      const extra = searchString.length - searchString.trimEnd().length
      reasons.push(`  (${extra} trailing whitespace character(s) detected)`)
    }
  }

  // Trailing whitespace on individual lines.
  const searchLines = searchString.split('\n')
  const trailingLines = searchLines.filter(
    (l, i) =>
      l.length > 0 && l !== l.trimEnd() && !(i === searchLines.length - 1 && l === ''),
  )
  if (trailingLines.length > 0) {
    reasons.push(
      `- **Trailing spaces** detected on ${trailingLines.length} line(s) in old_string. The file may not have these.`,
    )
  }

  // Find similar lines in the file for debugging.
  const similar = findSimilarLinesInFile(searchString, fileContent)
  if (similar) {
    reasons.push(similar)
  }

  return reasons.length > 0
    ? `Possible causes:\n${reasons.join('\n')}`
    : ''
}

/**
 * For each non-empty line in searchString (up to 3), find the most
 * character-overlap-similar line in the file and report it as a suggestion.
 */
function findSimilarLinesInFile(
  searchString: string,
  fileContent: string,
): string | null {
  const searchLines = searchString
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
  if (searchLines.length === 0) return null

  const fileLines = fileContent.split('\n')
  const matches: string[] = []

  for (const searchLine of searchLines.slice(0, 3)) {
    let bestScore = 0
    let bestLine = ''
    for (const fileLine of fileLines) {
      if (fileLine.trim().length === 0) continue
      const score = lineOverlapSimilarity(searchLine, fileLine)
      if (score > bestScore && score >= LINE_SIMILARITY_THRESHOLD) {
        bestScore = score
        bestLine = fileLine
      }
    }
    if (bestLine) {
      const pct = Math.round(bestScore * 100)
      const searchPreview =
        searchLine.length > 40
          ? searchLine.slice(0, 37) + '...'
          : searchLine
      matches.push(
        `  \`${bestLine.trim()}\` (${pct}% match for \`${searchPreview}\`)`,
      )
    }
  }

  if (matches.length > 0) {
    return (
      `- **Similar lines** found in the file:\n${matches.slice(0, 3).join('\n')}\n` +
      `  If one of these matches your intent, use it as old_string.`
    )
  }

  return null
}

/** Jaccard-style character-set overlap between two strings. */
function lineOverlapSimilarity(a: string, b: string): number {
  const aNorm = a.trim()
  const bNorm = b.trim()
  if (aNorm === bNorm) return 1.0
  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.85

  const aSet = new Set(aNorm)
  const bSet = new Set(bNorm)
  let overlap = 0
  for (const ch of aSet) {
    if (bSet.has(ch)) overlap++
  }
  const union = new Set([...aSet, ...bSet]).size
  return union > 0 ? overlap / union : 0
}

// -- Staleness diff helper (used by FileEditTool errorCode 7) ----------------

/**
 * Compute a short, human-readable summary of changes between the cached
 * (pre-read) content and the current on-disk content. Capped at 5 hunks /
 * 20 lines so the error message stays digestible.
 *
 * Must be try-catch safe; an exception here would replace the friendly
 * errorCode 7 with a crash, defeating the whole purpose.
 */
export function getStalenessDiffSummary(
  originalContent: string,
  currentContent: string,
): string {
  try {
    // Route through getPatchFromContents (from diff.ts) to ensure & and $
    // are escaped before calling the diff library — raw structuredPatch
    // chokes on unescaped ampersands (diff.ts:29-31).
    const hunks = getPatchFromContents({
      filePath: '',
      oldContent: originalContent,
      newContent: currentContent,
    })

    if (hunks.length === 0) {
      return '(no hunks — file may only differ in whitespace)'
    }

    const MAX_HUNKS = 5
    const MAX_LINES = 20

    const allLines: string[] = []
    for (const hunk of hunks.slice(0, MAX_HUNKS)) {
      allLines.push(
        `@@ ${hunk.oldStart},${hunk.oldLines} → ${hunk.newStart},${hunk.newLines} @@`,
      )
      for (const line of hunk.lines) {
        allLines.push(line)
      }
    }

    if (hunks.length > MAX_HUNKS || allLines.length > MAX_LINES) {
      const truncated = allLines.slice(0, MAX_LINES)
      const extraHunks = hunks.length - MAX_HUNKS
      const omitted =
        allLines.length - MAX_LINES + extraHunks * 4
      return (
        truncated.join('\n') +
        `\n... (${omitted} more diff lines omitted)`
      )
    }

    return allLines.join('\n')
  } catch {
    return '(unable to compute diff — re-read the file and retry)'
  }
}

/**
 * When old_string matched via quote normalization (curly quotes in file,
 * straight quotes from model), apply the same curly quote style to new_string
 * so the edit preserves the file's typography.
 *
 * Uses a simple open/close heuristic: a quote character preceded by whitespace,
 * start of string, or opening punctuation is treated as an opening quote;
 * otherwise it's a closing quote.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // If they're the same, no normalization happened
  if (oldString === actualOldString) {
    return newString
  }

  // Detect which curly quote types were in the file
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }

  let result = newString

  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }

  return result
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true
  }
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em dash
    prev === '\u2013' // en dash
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // Don't convert apostrophes in contractions (e.g., "don't", "it's")
      // An apostrophe between two letters is a contraction, not a quote
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        // Apostrophe in a contraction — use right single curly quote
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * Transform edits to ensure replace_all always has a boolean value
 * @param edits Array of edits with optional replace_all
 * @returns Array of edits with replace_all guaranteed to be boolean
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)

  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

/**
 * Applies an edit to a file and returns the patch and updated file.
 * Does not write the file to disk.
 */
export function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
  replaceAll = false,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return getPatchForEdits({
    filePath,
    fileContents,
    edits: [
      { old_string: oldString, new_string: newString, replace_all: replaceAll },
    ],
  })
}

/**
 * Applies a list of edits to a file and returns the patch and updated file.
 * Does not write the file to disk.
 *
 * NOTE: The returned patch is to be used for display purposes only - it has spaces instead of tabs
 */
export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  let updatedFile = fileContents
  const appliedNewStrings: string[] = []

  // Special case for empty files.
  if (
    !fileContents &&
    edits.length === 1 &&
    edits[0] &&
    edits[0].old_string === '' &&
    edits[0].new_string === ''
  ) {
    const patch = getPatchForDisplay({
      filePath,
      fileContents,
      edits: [
        {
          old_string: fileContents,
          new_string: updatedFile,
          replace_all: false,
        },
      ],
    })
    return { patch, updatedFile: '' }
  }

  // Apply each edit and check if it actually changes the file
  for (const edit of edits) {
    // Strip trailing newlines from old_string before checking
    const oldStringToCheck = edit.old_string.replace(/\n+$/, '')

    // Check if old_string is a substring of any previously applied new_string
    for (const previousNewString of appliedNewStrings) {
      if (
        oldStringToCheck !== '' &&
        previousNewString.includes(oldStringToCheck)
      ) {
        throw new Error(
          'Cannot edit file: old_string is a substring of a new_string from a previous edit.',
        )
      }
    }

    const previousContent = updatedFile
    updatedFile =
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(
            updatedFile,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )

    // If this edit didn't change anything, throw an error
    if (updatedFile === previousContent) {
      throw new Error('String not found in file. Failed to apply edit.')
    }

    // Track the new string that was applied
    appliedNewStrings.push(edit.new_string)
  }

  if (updatedFile === fileContents) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }

  // We already have before/after content, so call getPatchFromContents directly.
  // Previously this went through getPatchForDisplay with edits=[{old:fileContents,new:updatedFile}],
  // which transforms fileContents twice (once as preparedFileContents, again as escapedOldString
  // inside the reduce) and runs a no-op full-content .replace(). This saves ~20% on large files.
  const patch = getPatchFromContents({
    filePath,
    oldContent: convertLeadingTabsToSpaces(fileContents),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  })

  return { patch, updatedFile }
}

// Cap on edited_text_file attachment snippets. Format-on-save of a large file
// previously injected the entire file per turn (observed max 16.1KB, ~14K
// tokens/session). 8KB preserves meaningful context while bounding worst case.
const DIFF_SNIPPET_MAX_BYTES = 8192

/**
 * Used for attachments, to show snippets when files change.
 *
 * TODO: Unify this with the other snippet logic.
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
    {
      context: 8,
      timeout: DIFF_TIMEOUT_MS,
    },
  )

  if (!patch) {
    return ''
  }

  const full = patch.hunks
    .map(_ => ({
      startLine: _.oldStart,
      content: _.lines
        // Filter out deleted lines AND diff metadata lines
        .filter(_ => !_.startsWith('-') && !_.startsWith('\\'))
        .map(_ => _.slice(1))
        .join('\n'),
    }))
    .map(addLineNumbers)
    .join('\n...\n')

  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

  // Truncate at the last line boundary that fits within the cap.
  // Marker format matches BashTool/utils.ts.
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}

const CONTEXT_LINES = 4

/**
 * Gets a snippet from a file showing the context around a patch with line numbers.
 * @param originalFile The original file content before applying the patch
 * @param patch The diff hunks to use for determining snippet location
 * @param newFile The file content after applying the patch
 * @returns The snippet text with line numbers and the starting line number
 */
export function getSnippetForPatch(
  patch: StructuredPatchHunk[],
  newFile: string,
): { formattedSnippet: string; startLine: number } {
  if (patch.length === 0) {
    // No changes, return empty snippet
    return { formattedSnippet: '', startLine: 1 }
  }

  // Find the first and last changed lines across all hunks
  let minLine = Infinity
  let maxLine = -Infinity

  for (const hunk of patch) {
    if (hunk.oldStart < minLine) {
      minLine = hunk.oldStart
    }
    // For the end line, we need to consider the new lines count since we're showing the new file
    const hunkEnd = hunk.oldStart + (hunk.newLines || 0) - 1
    if (hunkEnd > maxLine) {
      maxLine = hunkEnd
    }
  }

  // Calculate the range with context
  const startLine = Math.max(1, minLine - CONTEXT_LINES)
  const endLine = maxLine + CONTEXT_LINES

  // Split the new file into lines and get the snippet
  const fileLines = newFile.split(/\r?\n/)
  const snippetLines = fileLines.slice(startLine - 1, endLine)
  const snippet = snippetLines.join('\n')

  // Add line numbers
  const formattedSnippet = addLineNumbers({
    content: snippet,
    startLine,
  })

  return { formattedSnippet, startLine }
}

/**
 * Gets a snippet from a file showing the context around a single edit.
 * This is a convenience function that uses the original algorithm.
 * @param originalFile The original file content
 * @param oldString The text to replace
 * @param newString The text to replace it with
 * @param contextLines The number of lines to show before and after the change
 * @returns The snippet and the starting line number
 */
export function getSnippet(
  originalFile: string,
  oldString: string,
  newString: string,
  contextLines: number = 4,
): { snippet: string; startLine: number } {
  // Use the original algorithm from FileEditTool.tsx
  const before = originalFile.split(oldString)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
  const newFileLines = applyEditToFile(
    originalFile,
    oldString,
    newString,
  ).split(/\r?\n/)

  // Calculate the start and end line numbers for the snippet
  const startLine = Math.max(0, replacementLine - contextLines)
  const endLine =
    replacementLine + contextLines + newString.split(/\r?\n/).length

  // Get snippet
  const snippetLines = newFileLines.slice(startLine, endLine)
  const snippet = snippetLines.join('\n')

  return { snippet, startLine: startLine + 1 }
}

export function getEditsForPatch(patch: StructuredPatchHunk[]): FileEdit[] {
  return patch.map(hunk => {
    // Extract the changes from this hunk
    const contextLines: string[] = []
    const oldLines: string[] = []
    const newLines: string[] = []

    // Parse each line and categorize it
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        // Context line - appears in both versions
        contextLines.push(line.slice(1))
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith('-')) {
        // Deleted line - only in old version
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        // Added line - only in new version
        newLines.push(line.slice(1))
      }
    }

    return {
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
      replace_all: false,
    }
  })
}

/**
 * Contains replacements to de-sanitize strings from Claude
 * Since Claude can't see any of these strings (sanitized in the API)
 * It'll output the sanitized versions in the edit response
 */
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

/**
 * Normalizes a match string by applying specific replacements
 * This helps handle when exact matches fail due to formatting differences
 * @returns The normalized string and which replacements were applied
 */
function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)

    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

/**
 * Normalize the input for the FileEditTool
 * If the string to replace is not found in the file, try with a normalized version
 * Returns the normalized input if successful, or the original input if not
 */
export function normalizeFileEditInput({
  file_path,
  edits,
}: {
  file_path: string
  edits: EditInput[]
}): {
  file_path: string
  edits: EditInput[]
} {
  if (edits.length === 0) {
    return { file_path, edits }
  }

  // Markdown uses two trailing spaces as a hard line break — stripping would
  // silently change semantics. Skip stripTrailingWhitespace for .md/.mdx.
  const isMarkdown = /\.(md|mdx)$/i.test(file_path)

  try {
    const fullPath = expandPath(file_path)

    // Use cached file read to avoid redundant I/O operations.
    // If the file doesn't exist, readFileSyncCached throws ENOENT which the
    // catch below handles by returning the original input (no TOCTOU pre-check).
    const fileContent = readFileSyncCached(fullPath)

    return {
      file_path,
      edits: edits.map(({ old_string, new_string, replace_all }) => {
        const normalizedNewString = isMarkdown
          ? new_string
          : stripTrailingWhitespace(new_string)

        // If exact string match works, keep it as is
        if (fileContent.includes(old_string)) {
          return {
            old_string,
            new_string: normalizedNewString,
            replace_all,
          }
        }

        // Try de-sanitize string if exact match fails
        const { result: desanitizedOldString, appliedReplacements } =
          desanitizeMatchString(old_string)

        if (fileContent.includes(desanitizedOldString)) {
          // Apply the same exact replacements to new_string
          let desanitizedNewString = normalizedNewString
          for (const { from, to } of appliedReplacements) {
            desanitizedNewString = desanitizedNewString.replaceAll(from, to)
          }

          return {
            old_string: desanitizedOldString,
            new_string: desanitizedNewString,
            replace_all,
          }
        }

        return {
          old_string,
          new_string: normalizedNewString,
          replace_all,
        }
      }),
    }
  } catch (error) {
    // If there's any error reading the file, just return original input.
    // ENOENT is expected when the file doesn't exist yet (e.g., new file).
    if (!isENOENT(error)) {
      logError(error)
    }
  }

  return { file_path, edits }
}

/**
 * Compare two sets of edits to determine if they are equivalent
 * by applying both sets to the original content and comparing results.
 * This handles cases where edits might be different but produce the same outcome.
 */
export function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean {
  // Fast path: check if edits are literally identical
  if (
    edits1.length === edits2.length &&
    edits1.every((edit1, index) => {
      const edit2 = edits2[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // Try applying both sets of edits
  let result1: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error1: string | null = null
  let result2: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error2: string | null = null

  try {
    result1 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits1,
    })
  } catch (e) {
    error1 = errorMessage(e)
  }

  try {
    result2 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits2,
    })
  } catch (e) {
    error2 = errorMessage(e)
  }

  // If both threw errors, they're equal only if the errors are the same
  if (error1 !== null && error2 !== null) {
    // Normalize error messages for comparison
    return error1 === error2
  }

  // If one threw an error and the other didn't, they're not equal
  if (error1 !== null || error2 !== null) {
    return false
  }

  // Both succeeded - compare the results
  return result1!.updatedFile === result2!.updatedFile
}

/**
 * Unified function to check if two file edit inputs are equivalent.
 * Handles file edits (FileEditTool).
 */
export function areFileEditsInputsEquivalent(
  input1: {
    file_path: string
    edits: FileEdit[]
  },
  input2: {
    file_path: string
    edits: FileEdit[]
  },
): boolean {
  // Fast path: different files
  if (input1.file_path !== input2.file_path) {
    return false
  }

  // Fast path: literal equality
  if (
    input1.edits.length === input2.edits.length &&
    input1.edits.every((edit1, index) => {
      const edit2 = input2.edits[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // Semantic comparison (requires file read). If the file doesn't exist,
  // compare against empty content (no TOCTOU pre-check).
  let fileContent = ''
  try {
    fileContent = readFileSyncCached(input1.file_path)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }

  return areFileEditsEquivalent(input1.edits, input2.edits, fileContent)
}
